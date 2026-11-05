import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandExecutionError, runCommand } from "./tool.js";
import type { CommandInvocation } from "./tool.js";
import type { AgentToolResult } from "./types.js";

export const TYPE_ARTIFACT_LIMIT = 10 * 1024 * 1024;

function failure(reason: string): Error {
  return new Error(`Supabase type capture failed: ${reason}`);
}

function result(details: Record<string, unknown>): AgentToolResult {
  return { content: [{ type: "text", text: JSON.stringify(details) }], details };
}

/** One slot per extension session, not per project. No persisted registry or eviction. */
export class TypeCaptureManager {
  private owned?: { directory: string; path: string; artifactId: string };
  private running?: Promise<AgentToolResult>;
  private abort?: AbortController;
  private closing = false;
  private closeUnconfirmed = false;

  capture(invocation: CommandInvocation, signal?: AbortSignal): Promise<AgentToolResult> {
    if (this.closing) return Promise.reject(failure("session_shutdown"));
    if (this.running) return Promise.reject(failure("capture_in_progress"));
    if (this.closeUnconfirmed) return Promise.reject(failure("file_close_unconfirmed; restart session"));
    if (this.owned) return Promise.reject(failure("artifact_retained; consume and release it first"));
    if (signal?.aborted) return Promise.reject(failure("abort"));
    this.abort = new AbortController();
    const combined = signal ? AbortSignal.any([signal, this.abort.signal]) : this.abort.signal;
    this.running = this.run(invocation, combined).finally(() => {
      this.running = undefined;
      this.abort = undefined;
    });
    return this.running;
  }

  private async run(invocation: CommandInvocation, signal: AbortSignal): Promise<AgentToolResult> {
    let fd: number | undefined;
    let phase = "storage_create";
    let captureFailure: string | undefined;
    const close = () => {
      if (fd === undefined) return;
      const descriptor = fd;
      fd = undefined; // Never retry an ambiguous close on a potentially reused descriptor.
      try { fs.closeSync(descriptor); } catch {
        this.closeUnconfirmed = true;
        throw failure("file_close_unconfirmed");
      }
    };
    try {
      const directory = fs.mkdtempSync(join(tmpdir(), "pi-supabase-types-"));
      this.owned = { directory, path: join(directory, "source.ts"), artifactId: randomUUID() };
      fs.chmodSync(directory, 0o700);
      fd = fs.openSync(this.owned.path, "wx", 0o600);
      fs.fchmodSync(fd, 0o600);
      let bytes = 0;
      const digest = createHash("sha256");
      phase = "process";
      await runCommand(invocation, {
        signal,
        stdoutCapture: (chunk) => {
          if (bytes + chunk.length > TYPE_ARTIFACT_LIMIT) {
            captureFailure = "artifact_limit_exceeded (10 MiB)";
            throw failure(captureFailure);
          }
          try {
            // Small pipe chunks, written synchronously: no unbounded queue or pending
            // writes at process close, and no decoding/re-encoding of source bytes.
            let offset = 0;
            while (offset < chunk.length) {
              const written = fs.writeSync(fd!, chunk, offset, chunk.length - offset);
              if (written === 0) throw failure("zero_byte_write");
              offset += written;
            }
            bytes += chunk.length;
            digest.update(chunk);
          } catch {
            captureFailure = "file_write_failed";
            throw failure(captureFailure);
          }
        },
      });
      phase = "file_completion";
      if (signal.aborted) throw new CommandExecutionError("abort", "Type generation aborted");
      fs.fsyncSync(fd);
      close();
      if (signal.aborted) throw new CommandExecutionError("abort", "Type generation aborted");
      return result({
        complete: true,
        artifactId: this.owned.artifactId,
        path: this.owned.path,
        bytes,
        sha256: digest.digest("hex"),
      });
    } catch (error) {
      let reason = captureFailure ?? (error instanceof CommandExecutionError ? error.reason : phase);
      try { close(); } catch { /* Report the latched close uncertainty below. */ }
      if (this.closeUnconfirmed) reason = "file_close_unconfirmed";
      try { this.cleanup(); } catch {
        throw failure(`${reason}; cleanup_unconfirmed at ${this.owned?.directory}`);
      }
      throw failure(reason);
    }
  }

  private cleanup(): void {
    if (!this.owned) return;
    try { fs.unlinkSync(this.owned.path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    // No recursive removal and no caller-supplied paths. Unexpected contents are
    // an error, not permission to delete unrelated files or traverse symlinks.
    fs.rmdirSync(this.owned.directory);
    this.owned = undefined;
  }

  async release(artifactId: string): Promise<AgentToolResult> {
    if (this.running) throw failure("capture_in_progress");
    if (!this.owned || artifactId !== this.owned.artifactId) throw failure("unknown_artifact");
    try { this.cleanup(); } catch {
      throw failure(`cleanup_unconfirmed at ${this.owned?.directory}; retry release`);
    }
    return result({ released: true, artifactId });
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    this.abort?.abort();
    await this.running?.catch(() => undefined);
    try { this.cleanup(); } catch {
      throw failure(`cleanup_unconfirmed at ${this.owned?.directory}`);
    }
    if (this.closeUnconfirmed) throw failure("file_close_unconfirmed");
  }
}
