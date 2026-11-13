import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { buildSpawnCommand, describeCommand, runCommand } from "../tool.js";

let directory: string;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "pi-supabase-tools-runner-"));
});

after(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("command construction", () => {
  test("appends literal arguments to a fixed prefix", () => {
    assert.deepEqual(
      buildSpawnCommand(["npx", "supabase"], ["db", "query", "select 1; rm -rf /"]),
      ["npx", ["supabase", "db", "query", "select 1; rm -rf /"]],
    );
  });

  test("supports a standalone binary prefix", () => {
    assert.deepEqual(
      buildSpawnCommand(["/opt/homebrew/bin/supabase"], ["status"]),
      ["/opt/homebrew/bin/supabase", ["status"]],
    );
  });

  test("rejects invalid inputs", () => {
    assert.throws(() => buildSpawnCommand([], []), /non-empty array/);
    assert.throws(() => buildSpawnCommand(["deno", "test"], "bad" as never), /args/);
  });

  test("describes commands without changing execution arguments", () => {
    assert.equal(
      describeCommand(["deno", "test"], ["--filter", "creates a row"]),
      "deno test --filter \"creates a row\"",
    );
  });
});

describe("direct process execution", () => {
  test("uses configured prefix, cwd, environment, and streams output", async () => {
    const script = join(directory, "inspect.mjs");
    await writeFile(script, [
      "console.log(process.cwd());",
      "console.log(process.env.TEST_VALUE);",
      "console.log(JSON.stringify(process.argv.slice(2)));",
    ].join("\n"), "utf-8");
    const updates: string[] = [];

    const result = await runCommand({
      prefix: [process.execPath, script, "prefix-value"],
      args: ["literal value", "; rm -rf /"],
      cwd: directory,
      environment: { ...process.env, TEST_VALUE: "configured" },
      timeout: 5,
    }, {
      signal: undefined,
      onUpdate: (update) => updates.push(update.content[0].text),
    });

    assert.match(result.content[0].text, new RegExp(directory));
    assert.match(result.content[0].text, /configured/);
    assert.match(result.content[0].text, /\["prefix-value","literal value","; rm -rf \/"\]/);
    assert.ok(updates.length > 0);
    assert.equal(result.details?.exitCode, 0);
  });

  test("delivers empty stdin EOF before command completion", async () => {
    const marker = join(directory, "stdin-eof-created");
    const script = join(directory, "read-stdin.mjs");
    await writeFile(script, [
      'import { writeFile } from "node:fs/promises";',
      // Like migration new: create a file, consume piped input, then report success.
      'await writeFile(process.argv[2], "created");',
      'let bytes = 0;',
      'for await (const chunk of process.stdin) bytes += chunk.length;',
      'console.log(`stdin bytes: ${bytes}`);',
      'console.error("stderr after EOF");',
    ].join("\n"), "utf-8");
    const updates: string[] = [];

    const result = await runCommand({
      prefix: [process.execPath, script],
      args: [marker],
      cwd: directory,
      environment: process.env,
      timeout: 2,
    }, {
      signal: undefined,
      onUpdate: (update) => updates.push(update.content[0].text),
    });

    assert.equal(await readFile(marker, "utf-8"), "created");
    assert.equal(result.details?.exitCode, 0);
    assert.match(result.content[0].text, /stdin bytes: 0/);
    assert.match(result.content[0].text, /stderr after EOF/);
    assert.ok(updates.some((update) => update.includes("stdin bytes: 0")));
  });

  test("rejects with output when a command exits unsuccessfully", async () => {
    const script = join(directory, "fail.mjs");
    await writeFile(script, "console.error('failure detail'); process.exit(7);\n", "utf-8");
    await assert.rejects(
      runCommand({
        prefix: [process.execPath, script],
        args: [],
        cwd: directory,
        environment: process.env,
        timeout: 5,
      }, { signal: undefined }),
      /exit code 7[\s\S]*failure detail/,
    );
  });

  test("redacts injected values from success, updates, and failures", async () => {
    const secret = "profile-secret-value";
    const successScript = join(directory, "repeat-secret.mjs");
    await writeFile(successScript, "console.log(process.env.PROFILE_SECRET);\n", "utf-8");
    const updates: string[] = [];
    const success = await runCommand({
      prefix: [process.execPath, successScript],
      args: [],
      cwd: directory,
      environment: { ...process.env, PROFILE_SECRET: secret },
      timeout: 5,
      redactValues: [secret],
    }, {
      signal: undefined,
      onUpdate: (update) => updates.push(update.content[0].text),
    });
    assert.equal(success.content[0].text, "[REDACTED]\n");
    assert.ok(updates.every((update) => !update.includes(secret)));

    const failScript = join(directory, "fail-secret.mjs");
    await writeFile(failScript, "console.error(process.env.PROFILE_SECRET); process.exit(4);\n", "utf-8");
    await assert.rejects(
      runCommand({
        prefix: [process.execPath, failScript],
        args: [],
        cwd: directory,
        environment: { ...process.env, PROFILE_SECRET: secret },
        timeout: 5,
        redactValues: [secret],
        streamOutput: false,
      }, { signal: undefined }),
      (error: Error) => !error.message.includes(secret) && error.message.includes("[REDACTED]"),
    );

    const unicodeSecret = "🔐profile-secret";
    const splitScript = join(directory, "split-secret.mjs");
    await writeFile(splitScript, [
      "const value = Buffer.from(process.env.PROFILE_SECRET);",
      "process.stdout.write(value.subarray(0, 1));",
      "setTimeout(() => process.stdout.write(value.subarray(1)), 10);",
    ].join("\n"), "utf-8");
    const split = await runCommand({
      prefix: [process.execPath, splitScript],
      args: [],
      cwd: directory,
      environment: { ...process.env, PROFILE_SECRET: unicodeSecret },
      timeout: 5,
      redactValues: [unicodeSecret],
      streamOutput: false,
    }, { signal: undefined });
    assert.equal(split.content[0].text, "[REDACTED]");
  });

  test("sanitizes synchronous process validation failures", async () => {
    const secret = "prefix\0TOPSECRETsuffix";
    await assert.rejects(
      runCommand({
        prefix: [process.execPath, "-e", "console.log('never')"],
        args: [],
        cwd: directory,
        environment: { ...process.env, INVALID_VALUE: secret },
        timeout: 5,
      }, { signal: undefined }),
      (error: Error) =>
        !error.message.includes("TOPSECRET") &&
        !error.message.includes(secret) &&
        error.message.includes("invalid process configuration"),
    );
  });

  test("bounds retained success and failure output to the documented tail", async () => {
    const script = join(directory, "large-output.mjs");
    await writeFile(script, [
      'for (let index = 0; index < 3000; index += 1) console.log(`${index}:${"x".repeat(40)}`);',
      'if (process.argv[2] === "fail") process.exit(6);',
    ].join("\n"), "utf-8");
    const result = await runCommand({
      prefix: [process.execPath, script],
      args: [],
      cwd: directory,
      environment: process.env,
      timeout: 5,
    }, { signal: undefined });
    assert.equal(result.details?.outputTruncated, true);
    assert.ok(Buffer.byteLength(result.content[0].text) <= 50 * 1024);
    assert.ok(result.content[0].text.split("\n").length <= 2000);
    assert.match(result.content[0].text, /^\[output truncated/);
    assert.match(result.content[0].text, /2999:/);
    assert.doesNotMatch(result.content[0].text, /\n0:/);

    await assert.rejects(
      runCommand({
        prefix: [process.execPath, script],
        args: ["fail"],
        cwd: directory,
        environment: process.env,
        timeout: 5,
      }, { signal: undefined }),
      (error: Error) =>
        Buffer.byteLength(error.message) < 51 * 1024 &&
        error.message.includes("[output truncated") &&
        error.message.includes("2999:"),
    );
  });

  test("redacts a repeated value larger than the retained output bound", async () => {
    const script = join(directory, "large-secret.mjs");
    const secret = "s".repeat(60 * 1024);
    await writeFile(script, "process.stdout.write(process.env.LARGE_SECRET);\n", "utf-8");
    const result = await runCommand({
      prefix: [process.execPath, script],
      args: [],
      cwd: directory,
      environment: { ...process.env, LARGE_SECRET: secret },
      timeout: 5,
      redactValues: [secret],
      streamOutput: false,
    }, { signal: undefined });
    assert.equal(result.content[0].text, "[REDACTED]");
  });

  test("terminates the command process tree after the configured timeout", async () => {
    const marker = join(directory, "timed-out-descendant-output");
    const script = join(directory, "wait-tree.mjs");
    const descendantCode =
      `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "survived"), 900);`;
    await writeFile(script, [
      'import { spawn } from "node:child_process";',
      `spawn(process.execPath, ["-e", ${JSON.stringify(descendantCode)}], { stdio: "inherit" });`,
      'setInterval(() => {}, 1000);',
    ].join("\n"), "utf-8");
    const started = Date.now();
    await assert.rejects(
      runCommand({
        prefix: [process.execPath, script],
        args: [],
        cwd: directory,
        environment: process.env,
        timeout: 0.2,
      }, { signal: undefined }),
      /timed out/,
    );
    assert.ok(Date.now() - started < 700, "timeout must settle after terminating descendants");
    await new Promise((resolve) => setTimeout(resolve, 800));
    await assert.rejects(access(marker));
  });

  test("uses a bounded timeout fallback for escaped command descendants", async () => {
    const script = join(directory, "wait-escaped.mjs");
    await writeFile(script, [
      'import { spawn } from "node:child_process";',
      'const descendant = spawn(process.execPath, ["-e", "setTimeout(() => {}, 2500)"], {',
      '  detached: true, stdio: "inherit",',
      '});',
      'descendant.unref();',
      'setInterval(() => {}, 1000);',
    ].join("\n"), "utf-8");
    const started = Date.now();
    await assert.rejects(
      runCommand({
        prefix: [process.execPath, script],
        args: [],
        cwd: directory,
        environment: process.env,
        timeout: 0.2,
      }, { signal: undefined }),
      /timed out/,
    );
    assert.ok(Date.now() - started < 1_500, "timeout must have a bounded settlement fallback");
  });
});
