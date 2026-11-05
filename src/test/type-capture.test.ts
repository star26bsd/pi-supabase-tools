import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import fs, { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { TYPE_ARTIFACT_LIMIT, TypeCaptureManager } from "../type-capture.js";

const invocation = (source: string) => ({
  prefix: [process.execPath, "-e", source, "--"],
  args: ["gen", "types", "--local", "--lang", "typescript", "--schema", "public"],
  cwd: process.cwd(), environment: process.env, timeout: 5,
});

for (const [name, body] of [
  ["byte cap only", "x".repeat(60 * 1024)],
  ["line cap only", "x\n".repeat(2500)],
  ["both caps", ("x".repeat(40) + "\n").repeat(2500)],
]) {
  test(`captures complete raw stdout beyond ${name}`, async () => {
    const manager = new TypeCaptureManager();
    const expected = Buffer.from(`FIRST\n${body}\n🔐LAST\n\n`);
    const source = `const b = Buffer.from(${JSON.stringify(expected.toString())});
      process.stderr.write("PRIVATE-STDERR");
      const split = b.indexOf(Buffer.from("🔐")) + 1;
      process.stdout.write(b.subarray(0, split));
      setTimeout(() => process.stdout.write(b.subarray(split)), 10);`;
    try {
      const result = await manager.capture(invocation(source));
      const artifact = result.details!;
      assert.equal(artifact.complete, true);
      assert.deepEqual(readFileSync(artifact.path as string), expected);
      assert.equal(artifact.bytes, expected.length);
      assert.equal(artifact.sha256, createHash("sha256").update(expected).digest("hex"));
      assert.equal(statSync(artifact.path as string).mode & 0o777, 0o600);
      assert.equal(statSync(dirname(artifact.path as string)).mode & 0o777, 0o700);
      assert.doesNotMatch(JSON.stringify(result), /PRIVATE-STDERR|FIRST|LAST/);
      await manager.release(artifact.artifactId as string);
      assert.equal(existsSync(artifact.path as string), false);
    } finally {
      await manager.shutdown();
    }
  });
}

test("enforces the exact 10 MiB bound without retaining overflow", async (t) => {
  const manager = new TypeCaptureManager();
  const directories: string[] = [];
  const mkdtemp = fs.mkdtempSync;
  t.mock.method(fs, "mkdtempSync", (...args: Parameters<typeof mkdtemp>) => {
    const path = mkdtemp(...args) as string;
    directories.push(path);
    return path;
  });
  try {
    const good = await manager.capture(invocation(`process.stdout.write(Buffer.alloc(${TYPE_ARTIFACT_LIMIT}, 65))`));
    assert.equal(good.details!.bytes, TYPE_ARTIFACT_LIMIT);
    assert.equal(statSync(good.details!.path as string).size, TYPE_ARTIFACT_LIMIT);
    await manager.release(good.details!.artifactId as string);
    await assert.rejects(manager.capture(invocation(`process.stdout.write(Buffer.alloc(${TYPE_ARTIFACT_LIMIT + 1}, 65))`)), /artifact_limit_exceeded/);
    assert.ok(directories.every((directory) => !existsSync(directory)));
  } finally { await manager.shutdown(); }
});

test("refuses concurrent capture/release, retains until explicit release, and isolates sessions", async () => {
  const first = new TypeCaptureManager();
  const second = new TypeCaptureManager();
  try {
    const pending = first.capture(invocation('setTimeout(() => console.log("first"), 40)'));
    await assert.rejects(first.capture(invocation('console.log("never")')), /capture_in_progress/);
    await assert.rejects(first.release("anything"), /capture_in_progress/);
    const a = (await pending).details!;
    const b = (await second.capture(invocation('console.log("second")'))).details!;
    await assert.rejects(first.capture(invocation('console.log("never")')), /artifact_retained/);
    for (const id of [b.artifactId, a.path, "../source.ts", "", "unknown"]) {
      await assert.rejects(first.release(id as string), /unknown_artifact/);
      assert.equal(existsSync(a.path as string), true);
      assert.equal(existsSync(b.path as string), true);
    }
    await first.release(a.artifactId as string);
    await assert.rejects(first.release(a.artifactId as string), /unknown_artifact/);
    assert.equal(existsSync(b.path as string), true);
    const fresh = (await first.capture(invocation('console.log("fresh")'))).details!;
    assert.notEqual(fresh.artifactId, a.artifactId);
    assert.notEqual(fresh.path, a.path);
    await first.shutdown();
    await first.shutdown();
    assert.equal(existsSync(fresh.path as string), false);
    await assert.rejects(first.capture(invocation("")), /session_shutdown/);
  } finally { await Promise.all([first.shutdown(), second.shutdown()]); }
});

test("pre-abort allocates no storage; nonzero exit and missing executable remove partial files privately", async (t) => {
  const manager = new TypeCaptureManager();
  const directories: string[] = [];
  const mkdtemp = fs.mkdtempSync;
  t.mock.method(fs, "mkdtempSync", (...args: Parameters<typeof mkdtemp>) => {
    const path = mkdtemp(...args) as string;
    directories.push(path);
    return path;
  });
  try {
    await assert.rejects(manager.capture(invocation(""), AbortSignal.abort()), /abort/);
    assert.equal(directories.length, 0);
    const source = 'process.stdout.write("PRIVATE-PARTIAL"); process.stderr.write("SECRET-STDERR"); process.exitCode = 7;';
    await assert.rejects(manager.capture(invocation(source)), (error: Error) => {
      assert.match(error.message, /exit/);
      assert.doesNotMatch(JSON.stringify(Object.getOwnPropertyDescriptors(error)), /PRIVATE-PARTIAL|SECRET-STDERR/);
      return true;
    });
    await assert.rejects(manager.capture({ ...invocation(""), prefix: ["/nonexistent/SECRET-EXECUTABLE"] }), (error: Error) => {
      assert.match(error.message, /start/);
      assert.doesNotMatch(error.message, /SECRET-EXECUTABLE/);
      return true;
    });
    assert.ok(directories.every((directory) => !existsSync(directory)));
  } finally { await manager.shutdown(); }
});

test("mid-stream abort and shutdown settle and clean up", async (t) => {
  const manager = new TypeCaptureManager();
  const controller = new AbortController();
  const write = fs.writeSync;
  let captured = false;
  t.mock.method(fs, "writeSync", (...args: Parameters<typeof write>) => {
    const count = Reflect.apply(write, fs, args);
    captured = true;
    controller.abort();
    return count;
  });
  await assert.rejects(manager.capture(invocation('console.log("partial"); setInterval(() => {}, 1000)'), controller.signal), /abort/);
  assert.equal(captured, true);
  t.mock.restoreAll();
  const pending = manager.capture(invocation('setInterval(() => {}, 1000)'));
  const rejection = assert.rejects(pending, /abort/);
  await manager.shutdown();
  await rejection;
});

test("waits for descendant-held stdout rather than publishing on parent exit", async () => {
  const manager = new TypeCaptureManager();
  const source = `const { spawn } = require("node:child_process");
    spawn(process.execPath, ["-e", 'setTimeout(() => process.stdout.write("LAST"), 100)'], { stdio: "inherit" }).unref();
    process.stdout.write("FIRST");`;
  try {
    const artifact = (await manager.capture(invocation(source))).details!;
    assert.equal(readFileSync(artifact.path as string, "utf8"), "FIRSTLAST");
  } finally { await manager.shutdown(); }
});

test("timeout kills ordinary descendants and bounds escaped-descendant stdio settlement", async () => {
  const manager = new TypeCaptureManager();
  const root = fs.mkdtempSync(join(tmpdir(), "pi-types-descendant-test-"));
  const marker = join(root, "survived");
  const child = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "survived"), 600);`;
  try {
    await assert.rejects(manager.capture({ ...invocation(`require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(child)}], { stdio: "inherit" }); setInterval(() => {}, 1000);`), timeout: 0.15 }), /timeout/);
    await new Promise((resolve) => setTimeout(resolve, 650));
    assert.equal(existsSync(marker), false);
    const started = Date.now();
    await assert.rejects(manager.capture({ ...invocation('require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 2500)"], { detached: true, stdio: "inherit" }).unref();'), timeout: 0.15 }), /timeout/);
    assert.ok(Date.now() - started < 2000);
  } finally {
    await manager.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const operation of ["openSync", "writeSync", "fsyncSync", "closeSync"] as const) {
  test(`${operation} failure never publishes an artifact or leaks error data`, async (t) => {
    const manager = new TypeCaptureManager();
    const original = fs[operation];
    t.mock.method(fs, operation, (...args: unknown[]) => {
      // Simulate a reported close failure without leaking a real descriptor in the test.
      if (operation === "closeSync") Reflect.apply(original, fs, args);
      throw new Error("SECRET-FILESYSTEM-ERROR");
    });
    await assert.rejects(manager.capture(invocation('console.log("partial")')), (error: Error) => {
      assert.doesNotMatch(JSON.stringify(Object.getOwnPropertyDescriptors(error)), /SECRET-FILESYSTEM-ERROR/);
      assert.match(error.message, /storage_create|file_write_failed|file_completion|file_close_unconfirmed/);
      return true;
    });
    t.mock.restoreAll();
    if (operation === "closeSync") {
      await assert.rejects(manager.capture(invocation("")), /file_close_unconfirmed/);
      await assert.rejects(manager.shutdown(), /file_close_unconfirmed/);
    } else {
      const artifact = (await manager.capture(invocation('console.log("retry")'))).details!;
      assert.equal(readFileSync(artifact.path as string, "utf8"), "retry\n");
      await manager.shutdown();
    }
  });
}

test("handles partial writes and zero-byte writes", async (t) => {
  const manager = new TypeCaptureManager();
  const write = fs.writeSync;
  t.mock.method(fs, "writeSync", (fd: number, buffer: Buffer, offset: number) => write(fd, buffer, offset, 1));
  try {
    const artifact = (await manager.capture(invocation('process.stdout.write("🔐test")'))).details!;
    assert.equal(readFileSync(artifact.path as string, "utf8"), "🔐test");
    await manager.release(artifact.artifactId as string);
    t.mock.restoreAll();
    t.mock.method(fs, "writeSync", () => 0);
    await assert.rejects(manager.capture(invocation('console.log("test")')), /file_write_failed/);
  } finally { t.mock.restoreAll(); await manager.shutdown(); }
});

test("cleanup failures retain ownership, refuse new capture, and allow release retry", async (t) => {
  const manager = new TypeCaptureManager();
  const artifact = (await manager.capture(invocation('console.log("retained")'))).details!;
  t.mock.method(fs, "unlinkSync", () => { throw new Error("SECRET-CLEANUP"); });
  await assert.rejects(manager.release(artifact.artifactId as string), /cleanup_unconfirmed/);
  assert.equal(existsSync(artifact.path as string), true);
  await assert.rejects(manager.capture(invocation("")), /artifact_retained/);
  t.mock.restoreAll();
  await manager.release(artifact.artifactId as string);
  assert.equal(existsSync(artifact.path as string), false);
  await manager.shutdown();
});

test("stream errors terminate capture without publishing source or diagnostics", async (t) => {
  const manager = new TypeCaptureManager();
  const spawn = childProcess.spawn;
  t.mock.method(childProcess, "spawn", (...args: Parameters<typeof spawn>) => {
    const child = Reflect.apply(spawn, childProcess, args);
    child.stdout!.once("data", () => child.stdout!.emit("error", new Error("SECRET-STREAM")));
    return child;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(manager.capture(invocation('console.log("partial"); setInterval(() => {}, 1000)')), (error: Error) => {
      assert.match(error.message, /stream/);
      assert.doesNotMatch(error.message, /SECRET-STREAM|partial/);
      return true;
    });
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await manager.shutdown();
  }
});

test("failed capture cleanup reports its owned directory and shutdown retries it", async (t) => {
  const manager = new TypeCaptureManager();
  const remove = t.mock.method(fs, "rmdirSync", () => { throw new Error("SECRET-CLEANUP"); });
  await assert.rejects(manager.capture(invocation('process.exitCode = 7;')), (error: Error) => {
    assert.match(error.message, /exit; cleanup_unconfirmed at .*pi-supabase-types-/);
    assert.doesNotMatch(error.message, /SECRET-CLEANUP/);
    return true;
  });
  await assert.rejects(manager.capture(invocation("")), /artifact_retained/);
  remove.mock.restore();
  await manager.shutdown();
});

test("release removes a substituted symlink, never its target", async () => {
  const manager = new TypeCaptureManager();
  const other = new TypeCaptureManager();
  try {
    const a = (await manager.capture(invocation('console.log("a")'))).details!;
    const b = (await other.capture(invocation('console.log("b")'))).details!;
    fs.unlinkSync(a.path as string);
    fs.symlinkSync(b.path as string, a.path as string);
    await manager.release(a.artifactId as string);
    assert.equal(readFileSync(b.path as string, "utf8"), "b\n");
  } finally { await Promise.all([manager.shutdown(), other.shutdown()]); }
});
