/**
 * Direct process execution shared by the focused tools.
 */

import { StringDecoder } from "node:string_decoder";
import {
  PROCESS_SETTLEMENT_GRACE_MS,
  spawnInProcessGroup,
  terminateProcessTree,
} from "./process-supervisor.js";
import type { AgentToolResult } from "./types.js";

export interface RunContext {
  signal: AbortSignal | undefined;
  onUpdate?: (partialResult: AgentToolResult) => void;
  /** Internal type-capture sink. Synchronous writes finish before returning.
   * Capture withholds both streams from diagnostics and model updates. */
  stdoutCapture?: (chunk: Buffer) => void;
}

export class CommandExecutionError extends Error {
  constructor(readonly reason: "start" | "abort" | "timeout" | "exit" | "capture" | "stream", message: string) {
    super(message);
  }
}

export interface CommandInvocation {
  prefix: string[];
  args: string[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
  timeout: number;
  redactValues?: string[];
  streamOutput?: boolean;
}

export function buildSpawnCommand(
  prefix: string[],
  args: string[],
): [string, string[]] {
  if (!Array.isArray(prefix) || prefix.length === 0) {
    throw new TypeError("command prefix must be a non-empty array");
  }
  if (!Array.isArray(args)) throw new TypeError("args must be an array");
  return [prefix[0], [...prefix.slice(1), ...args]];
}

function quoteForDisplay(arg: string): string {
  return /^[A-Za-z0-9_./:=@+-]+$/.test(arg) ? arg : JSON.stringify(arg);
}

export function describeCommand(prefix: string[], args: string[]): string {
  return [...prefix, ...args].map(quoteForDisplay).join(" ");
}

const OUTPUT_LIMIT_BYTES = 50 * 1024;
const OUTPUT_LIMIT_LINES = 2000;
const TRUNCATION_NOTICE = "[output truncated to last 50 KiB / 2000 lines]\n";

class BoundedOutput {
  private value = "";
  truncated = false;

  append(chunk: string) {
    this.value += chunk;
    const maximumBytes = OUTPUT_LIMIT_BYTES - Buffer.byteLength(TRUNCATION_NOTICE);
    if (Buffer.byteLength(this.value) > maximumBytes) {
      this.truncated = true;
      this.value = this.value.slice(Math.max(0, this.value.length - maximumBytes));
      while (Buffer.byteLength(this.value) > maximumBytes) this.value = this.value.slice(1);
    }

    const lines = this.value.split("\n");
    const maximumLines = OUTPUT_LIMIT_LINES - 1;
    if (lines.length > maximumLines) {
      this.truncated = true;
      this.value = lines.slice(-maximumLines).join("\n");
    }
  }

  text(): string {
    return this.truncated ? TRUNCATION_NOTICE + this.value : this.value;
  }
}

class StreamingRedactor {
  private pending = "";
  private readonly values: string[];
  private readonly maximumLength: number;

  constructor(values: string[]) {
    this.values = [...new Set(values.filter((value) => value.length > 0))]
      .sort((left, right) => right.length - left.length);
    this.maximumLength = this.values[0]?.length ?? 0;
  }

  private consumeOne(): string {
    const match = this.values.find((value) => this.pending.startsWith(value));
    if (match) {
      this.pending = this.pending.slice(match.length);
      return "[REDACTED]";
    }
    const character = this.pending[0];
    this.pending = this.pending.slice(1);
    return character;
  }

  push(chunk: string): string {
    if (this.maximumLength === 0) return chunk;
    this.pending += chunk;
    let output = "";
    while (this.pending.length >= this.maximumLength) output += this.consumeOne();
    return output;
  }

  flush(): string {
    let output = "";
    while (this.pending.length > 0) output += this.consumeOne();
    return output;
  }
}

export function redactOutput(output: string, values: string[]): string {
  const redactor = new StreamingRedactor(values);
  return redactor.push(output) + redactor.flush();
}

function processStartError(command: string, cwd: string, error: unknown): Error {
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
  const reason = code === "ENOENT"
    ? "configured executable was not found"
    : code === "ERR_INVALID_ARG_VALUE" || code === undefined
      ? "invalid process configuration"
      : `process error ${code}`;
  return new Error(`Unable to start '${command}' in '${cwd}': ${reason}`);
}

export function runCommand(
  invocation: CommandInvocation,
  context: RunContext,
): Promise<AgentToolResult> {
  const {
    prefix,
    args,
    cwd,
    environment,
    timeout,
    redactValues = [],
    streamOutput = true,
  } = invocation;
  const { signal, onUpdate, stdoutCapture } = context;
  if (stdoutCapture && redactValues.length > 0) {
    throw new Error("Profile-backed output cannot be captured");
  }
  const failure = (reason: CommandExecutionError["reason"], message: string) =>
    new CommandExecutionError(reason, stdoutCapture ? `Type generation process failed: ${reason}` : message);
  const [binary, spawnArgs] = buildSpawnCommand(prefix, args);
  const command = describeCommand(prefix, args);

  if (signal?.aborted) {
    return Promise.reject(failure("abort", `Command aborted before execution: ${command}`));
  }

  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawnInProcessGroup>;
    try {
      child = spawnInProcessGroup(binary, spawnArgs, {
        shell: false,
        cwd,
        env: environment,
      });
    } catch (error) {
      reject(failure("start", processStartError(command, cwd, error).message));
      return;
    }

    const boundedOutput = new BoundedOutput();
    const stdoutRedactor = new StreamingRedactor(redactValues);
    const stderrRedactor = new StreamingRedactor(redactValues);
    const stdoutDecoder = new StringDecoder("utf-8");
    const stderrDecoder = new StringDecoder("utf-8");
    let redactorsFlushed = false;
    type Termination = "abort" | "timeout" | "capture" | "stream";
    let termination: Termination | undefined;
    let settled = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let settlementHandle: ReturnType<typeof setTimeout> | undefined;

    const flushRedactors = () => {
      if (redactorsFlushed) return;
      redactorsFlushed = true;
      boundedOutput.append(stdoutRedactor.push(stdoutDecoder.end()) + stdoutRedactor.flush());
      boundedOutput.append(stderrRedactor.push(stderrDecoder.end()) + stderrRedactor.flush());
    };
    const output = () => boundedOutput.text();
    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (settlementHandle) clearTimeout(settlementHandle);
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    };
    const terminationError = (reason: Termination) => failure(reason,
      reason === "abort" ? `Command aborted: ${command}`
        : reason === "timeout" ? `Command timed out after ${timeout} seconds: ${command}`
          : `Command ${reason} failed: ${command}`);
    const stop = (reason: Termination) => {
      if (termination || settled) return;
      termination = reason;
      terminateProcessTree(child);
      settlementHandle = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();
        rejectOnce(terminationError(reason));
      }, PROCESS_SETTLEMENT_GRACE_MS);
      settlementHandle.unref();
    };

    const onAbort = () => stop("abort");

    const appendOutput = (redactor: StreamingRedactor, decoder: StringDecoder, chunk: Buffer) => {
      boundedOutput.append(redactor.push(decoder.write(chunk)));
      if (streamOutput) {
        onUpdate?.({
          content: [{ type: "text", text: output() }],
          details: undefined,
        });
      }
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      if (settled || termination) return;
      if (stdoutCapture) {
        try { stdoutCapture(chunk); } catch { stop("capture"); }
      } else {
        appendOutput(stdoutRedactor, stdoutDecoder, chunk);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (!settled && !termination && !stdoutCapture) appendOutput(stderrRedactor, stderrDecoder, chunk);
    });
    child.stdout?.on("error", () => stop("stream"));
    child.stderr?.on("error", () => stop("stream"));

    child.once("error", (error) => {
      rejectOnce(termination ? terminationError(termination) : failure("start", processStartError(command, cwd, error).message));
    });

    child.once("close", (code, closeSignal) => {
      if (settled) return;
      if (termination) {
        rejectOnce(terminationError(termination));
        return;
      }
      if (stdoutCapture && (!child.stdout?.readableEnded || !child.stderr?.readableEnded)) {
        rejectOnce(failure("stream", "Type generation streams did not complete"));
        return;
      }
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (settlementHandle) clearTimeout(settlementHandle);
      signal?.removeEventListener("abort", onAbort);
      flushRedactors();
      if ((code ?? 1) !== 0) {
        const suffix = output().length > 0 ? `\n${output()}` : "";
        reject(
          failure("exit",
            `Command failed with exit code ${code ?? "unknown"}${closeSignal ? ` (${closeSignal})` : ""}: ${command}${suffix}`,
          ),
        );
        return;
      }

      resolve({
        content: [{ type: "text", text: output() }],
        details: {
          command,
          cwd,
          exitCode: code ?? 0,
          outputTruncated: boundedOutput.truncated,
        },
      });
    });

    signal?.addEventListener("abort", onAbort, { once: true });

    if (timeout > 0) {
      timeoutHandle = setTimeout(() => stop("timeout"), timeout * 1000);
    }
    // Cancellation can race with spawn and listener installation.
    if (signal?.aborted) onAbort();
  });
}
