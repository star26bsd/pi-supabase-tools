import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import supabaseTools from "../index.js";
import { cliV2Contracts } from "./fixtures/cli-v2-contracts.js";

let root: string;
let tools: Map<string, any>;
let commands: Map<string, any>;
let sentMessages: string[];
let eventHandlers: Map<string, (...args: any[]) => Promise<void>>;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-supabase-tools-extension-"));
  mkdirSync(join(root, ".pi"), { recursive: true });
  const script = join(root, "print-args.mjs");
  const descendantOutput = join(root, "descendant-secret-output");
  const descendantReady = join(root, "descendant-test-ready");
  const descendantCode =
    `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(descendantOutput)}, process.env.TEST_KEY), 500);`;
  await writeFile(script, [
    'import { spawn } from "node:child_process";',
    'import { existsSync, writeFileSync } from "node:fs";',
    'const args = process.argv.slice(2);',
    'if (args[0] === "supabase-prefix" && args[1] === "functions" && args[2] === "serve") {',
    '  console.error("PRIVATE-SERVICE-BYTE Serving functions on http://127.0.0.1:54321");',
    '  process.on("SIGTERM", () => process.exit(0));',
    '  setInterval(() => {}, 1000);',
    '} else if (args[0] === "supabase-prefix" && args[1] === "status" && args[2] === "-o" && args[3] === "env") {',
    '  if (process.env.CONTRACT_STDOUT) {',
    '    if (args.length !== 4) process.exit(8);',
    '    process.stdout.write(process.env.CONTRACT_STDOUT);',
    '    process.stderr.write(process.env.CONTRACT_STDERR);',
    '    process.exit(0);',
    '  }',
    `  if (existsSync(${JSON.stringify(join(root, "nul-status-mode"))})) console.log('API_URL="prefix\\u0000TOPSECRETsuffix"');`,
    '  else console.log(\'API_URL="http://local.test"\');',
    '  console.log(\'ANON_KEY="profile-secret-key"\');',
    '} else {',
    `  if (existsSync(${JSON.stringify(join(root, "descendant-test-mode"))})) {`,
    `    spawn(process.execPath, ["-e", ${JSON.stringify(descendantCode)}], { stdio: "inherit", env: process.env });`,
    `    writeFileSync(${JSON.stringify(descendantReady)}, "ready");`,
    '    setInterval(() => {}, 1000);',
    `  } else if (existsSync(${JSON.stringify(join(root, "large-output-mode"))})) process.stdout.write("x".repeat(61 * 1024));`,
    '  else {',
    '    console.log(JSON.stringify(args));',
    '    if (process.env.TEST_URL) console.log(`${process.env.TEST_URL} ${process.env.TEST_KEY}`);',
    '    if (process.env.CONTRACT_STDOUT) {',
    '      if (process.env.JWT_SECRET || process.env.LINKED_PROJECT_REF || process.env.SERVICE_ROLE_KEY) throw new Error("unmapped status variable injected");',
    '      console.error(process.env.TEST_KEY);',
    '      process.exitCode = Number(process.env.TEST_EXIT_CODE);',
    '    }',
    '  }',
    '}',
  ].join("\n"), "utf-8");
  await writeFile(join(root, ".pi", "supabase-tools.json"), JSON.stringify({
    commands: {
      supabaseCli: [process.execPath, script, "supabase-prefix"],
      denoTest: [process.execPath, script, "--allow-read=.", "deno-prefix"],
      denoCache: [process.execPath, script, "cache-prefix"],
    },
    workingDirectory: ".",
    destructiveDbOps: "yes",
    blockedCommands: [{ prefix: ["db", "diff"], reason: "Use declarative sync" }],
    functionsServe: { args: ["--fixture-flag"] },
    denoTestEnvironmentProfiles: {
      local: {
        source: "supabaseStatus",
        variables: { API_URL: "TEST_URL", ANON_KEY: "TEST_KEY" },
      },
    },
  }), "utf-8");

  tools = new Map();
  commands = new Map();
  sentMessages = [];
  eventHandlers = new Map();
  const mockPi = {
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
    registerCommand(name: string, command: any) {
      commands.set(name, command);
    },
    on(name: string, handler: (...args: any[]) => Promise<void>) {
      eventHandlers.set(name, handler);
    },
    sendUserMessage(message: string) {
      sentMessages.push(message);
    },
  };
  await supabaseTools(mockPi as never);
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

async function waitForFile(path: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await access(path).then(() => true, () => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for fixture file: ${path}`);
}

function exposedError(error: Error): Record<string, unknown> {
  return Object.fromEntries(
    Object.getOwnPropertyNames(error).map((name) => [name, (error as unknown as Record<string, unknown>)[name]]),
  );
}

function context() {
  return {
    cwd: root,
    isProjectTrusted: () => true,
    ui: {
      setStatus() {},
      notify() {},
      select: async () => undefined,
    },
  };
}

describe("registered tools", () => {
  test("registers the clean breaking tool names", () => {
    assert.deepEqual([...tools.keys()], [
      "supabase_functions_serve", "supabase_types", "supabase_cli", "deno_test", "deno_cache",
    ]);
    assert.equal(tools.has("supabase_bash"), false);
    assert.deepEqual(
      tools.get("supabase_functions_serve").parameters.properties.action.enum,
      ["start", "status", "stop"],
    );
    assert.equal(tools.get("supabase_functions_serve").parameters.properties.action.type, "string");
  });

  test("runs Supabase arguments after the configured prefix", async () => {
    const result = await tools.get("supabase_cli").execute(
      "call",
      { args: ["status"] },
      undefined,
      undefined,
      context(),
    );
    assert.match(result.content[0].text, /supabase-prefix/);
    assert.match(result.content[0].text, /status/);
    assert.match(result.content[0].text, /--agent/);
    assert.equal(
      existsSync(join(root, ".pi", "supabase-tools-state.json")),
      false,
      "read-only commands should not create gate state",
    );
  });

  test("refuses configured blocked commands without spawning", async () => {
    const result = await tools.get("supabase_cli").execute(
      "call",
      { args: ["db", "diff", "--local"] },
      undefined,
      undefined,
      context(),
    );
    assert.equal(result.details.action, "blocked_by_configuration");
    assert.match(result.content[0].text, /Use declarative sync/);
  });

  test("allows configured Deno permissions but rejects session escalation", async () => {
    const allowed = await tools.get("deno_test").execute(
      "call",
      { args: ["functions/example/index.test.ts"] },
      undefined,
      undefined,
      context(),
    );
    assert.match(allowed.content[0].text, /--allow-read=\./);
    assert.match(allowed.content[0].text, /functions\/example\/index\.test\.ts/);

    const refused = await tools.get("deno_test").execute(
      "call",
      { args: ["--allow-net", "functions/example/index.test.ts"] },
      undefined,
      undefined,
      context(),
    );
    assert.equal(refused.details.action, "deno_permission_blocked");
  });

  test("runs Deno cache arguments after its fixed configured prefix", async () => {
    const result = await tools.get("deno_cache").execute(
      "call",
      { args: ["--reload", "functions/example/index.ts"] },
      undefined,
      undefined,
      context(),
    );
    assert.match(result.content[0].text, /cache-prefix/);
    assert.match(result.content[0].text, /--reload/);
    assert.match(result.content[0].text, /functions\/example\/index\.ts/);
  });

  test("blocks Deno cache permission, empty, and excessive-timeout escalation", async () => {
    for (const args of [["--allow-import=evil.test", "mod.ts"], ["-A", "mod.ts"]]) {
      const result = await tools.get("deno_cache").execute(
        "call", { args }, undefined, undefined, context(),
      );
      assert.equal(result.details.action, "deno_permission_blocked");
    }
    for (const args of [[], ["--"]]) {
      const result = await tools.get("deno_cache").execute(
        "call", { args }, undefined, undefined, context(),
      );
      assert.equal(result.details.action, "deno_cache_arguments_blocked");
    }
    const timeout = await tools.get("deno_cache").execute(
      "call", { args: ["mod.ts"], timeout: 301 }, undefined, undefined, context(),
    );
    assert.equal(timeout.details.action, "deno_cache_timeout_blocked");
  });

  test("acquires a configured Deno environment profile and redacts repeated values", async () => {
    const updates: string[] = [];
    const result = await tools.get("deno_test").execute(
      "call",
      { args: ["functions/example/index.test.ts"], environmentProfile: "local" },
      undefined,
      (update: any) => updates.push(update.content[0].text),
      context(),
    );
    assert.equal(updates.length, 0, "profile-backed tests must not stream output");
    assert.doesNotMatch(result.content[0].text, /http:\/\/local\.test|profile-secret-key/);
    assert.match(result.content[0].text, /\[REDACTED\] \[REDACTED\]/);

    await assert.rejects(
      tools.get("deno_test").execute(
        "call",
        { args: ["functions/example/index.test.ts"], environmentProfile: "unknown" },
        undefined,
        undefined,
        context(),
      ),
      /Unknown Deno test environment profile 'unknown'/,
    );
  });

  for (const contract of cliV2Contracts) {
    test(`CLI ${contract.version}: status diagnostics stay private and mapped values are redacted on success/failure`, async () => {
      const configPath = join(root, ".pi", "supabase-tools.json");
      const original = await readFile(configPath, "utf-8");
      try {
        for (const exitCode of [0, 7]) {
          const config = JSON.parse(original);
          config.environment = {
            CONTRACT_STDOUT: contract.statusStdout,
            CONTRACT_STDERR: contract.statusStderr,
            TEST_EXIT_CODE: String(exitCode),
            JWT_SECRET: null, LINKED_PROJECT_REF: null, SERVICE_ROLE_KEY: null,
          };
          await writeFile(configPath, JSON.stringify(config));
          const updates: unknown[] = [];
          const execution = tools.get("deno_test").execute(
            "call", { args: ["contract.test.ts"], environmentProfile: "local" }, undefined,
            (update: unknown) => updates.push(update), context(),
          );
          const assertPrivate = (value: unknown) => {
            const text = JSON.stringify(value);
            assert.match(text, /\[REDACTED\] \[REDACTED\]/);
            assert.doesNotMatch(text, /synthetic-|127\.0\.0\.1|Stopped services|deprecated|unmapped status variable/);
          };
          if (exitCode === 0) {
            const result = await execution;
            assert.equal(result.details.exitCode, 0);
            assertPrivate(result);
          } else {
            await assert.rejects(execution, (error: Error) => {
              assert.match(error.message, /exit code 7/);
              assertPrivate(exposedError(error));
              return true;
            });
          }
          assert.deepEqual(updates, []);
        }
      } finally {
        await writeFile(configPath, original);
      }
    });
  }

  test("rejects acquired NUL values without exposing them through process launch", async () => {
    const marker = join(root, "nul-status-mode");
    await writeFile(marker, "enabled");
    try {
      await assert.rejects(
        tools.get("deno_test").execute(
          "call",
          { args: ["functions/example/index.test.ts"], environmentProfile: "local" },
          undefined,
          undefined,
          context(),
        ),
        (error: Error) => !error.message.includes("TOPSECRET") && /malformed data/.test(error.message),
      );
    } finally {
      await rm(marker, { force: true });
    }
  });

  test("bounds retained output for profile-backed tests", async () => {
    const marker = join(root, "large-output-mode");
    await writeFile(marker, "enabled");
    try {
      const result = await tools.get("deno_test").execute(
        "call",
        { args: ["functions/example/index.test.ts"], environmentProfile: "local" },
        undefined,
        undefined,
        context(),
      );
      assert.ok(Buffer.byteLength(result.content[0].text) <= 50 * 1024);
      assert.match(result.content[0].text, /^\[output truncated/);
      assert.equal(result.details.outputTruncated, true);
    } finally {
      await rm(marker, { force: true });
    }
  });

  test("aborting a profile-backed test terminates descendants with inherited values", async () => {
    const mode = join(root, "descendant-test-mode");
    const ready = join(root, "descendant-test-ready");
    const output = join(root, "descendant-secret-output");
    await writeFile(mode, "enabled");
    const controller = new AbortController();
    try {
      const execution = tools.get("deno_test").execute(
        "call",
        { args: ["functions/example/index.test.ts"], environmentProfile: "local" },
        controller.signal,
        undefined,
        context(),
      );
      await waitForFile(ready);
      const started = Date.now();
      controller.abort();
      await assert.rejects(execution, /Command aborted/);
      assert.ok(Date.now() - started < 700, "abort must settle after terminating the process tree");
      await new Promise((resolve) => setTimeout(resolve, 650));
      assert.equal(existsSync(output), false, "descendant must not retain and write the injected value");
    } finally {
      await Promise.all([mode, ready, output].map((path) => rm(path, { force: true })));
    }
  });

  test("refuses disabled functions serve startup without spawning or leaking configuration", async () => {
    const configPath = join(root, ".pi", "supabase-tools.json");
    const validText = await import("node:fs/promises").then(({ readFile }) => readFile(configPath, "utf-8"));
    const disabled = JSON.parse(validText);
    delete disabled.functionsServe;
    const spawnMarker = join(root, "disabled-functions-serve-spawned");
    const configSentinel = "PRIVATE-DISABLED-CONFIG-Serving functions on 127.0.0.1";
    disabled.commands.supabaseCli = [
      process.execPath,
      "-e",
      `require("node:fs").writeFileSync(${JSON.stringify(spawnMarker)}, "spawned")`,
      configSentinel,
    ];
    disabled.environment = {
      ...(disabled.environment ?? {}),
      DISABLED_SENTINEL: configSentinel,
    };
    await writeFile(configPath, JSON.stringify(disabled), "utf-8");
    try {
      await assert.rejects(
        tools.get("supabase_functions_serve").execute(
          "call", { action: "start" }, undefined, undefined, context(),
        ),
        (error: Error) => {
          const exposure = exposedError(error);
          const complete = JSON.stringify({ exposure, enumerable: { ...error }, serialized: JSON.stringify(error) });
          return (
            error.message.includes("not_enabled_by_configuration") &&
            !complete.includes(configSentinel) &&
            !complete.includes("Serving functions on") &&
            !complete.includes("127.0.0.1")
          );
        },
      );
      await assert.rejects(access(spawnMarker));
    } finally {
      await writeFile(configPath, validText, "utf-8");
    }
  });

  test("manages functions serve without leaking output and survives config mutation", async () => {
    const tool = tools.get("supabase_functions_serve");
    const updates: unknown[] = [];
    const start = await tool.execute(
      "call", { action: "start" }, undefined, (update: unknown) => updates.push(update), context(),
    );
    assert.equal(start.details.phase, "running");
    assert.equal(updates.length, 0);
    assert.doesNotMatch(JSON.stringify(start), /PRIVATE-SERVICE-BYTE|127\.0\.0\.1/);

    const configPath = join(root, ".pi", "supabase-tools.json");
    const valid = await import("node:fs/promises").then(({ readFile }) => readFile(configPath, "utf-8"));
    await writeFile(configPath, "{ malformed", "utf-8");
    try {
      const status = await tool.execute("call", { action: "status" }, undefined, undefined, context());
      assert.equal(status.details.phase, "running");
      const stop = await tool.execute("call", { action: "stop" }, undefined, undefined, context());
      assert.equal(stop.details.phase, "stopped");
      assert.equal(stop.details.lastExit.cleanup, "confirmed");
      assert.doesNotMatch(JSON.stringify([status, stop]), /PRIVATE-SERVICE-BYTE|127\.0\.0\.1/);
    } finally {
      await writeFile(configPath, valid, "utf-8");
    }
  });

  test("refuses untrusted functions serve startup and cleans up on session shutdown", async () => {
    const tool = tools.get("supabase_functions_serve");
    await assert.rejects(
      tool.execute("call", { action: "start" }, undefined, undefined, {
        ...context(), isProjectTrusted: () => false,
      }),
      /project_untrusted/,
    );

    await tool.execute("call", { action: "start" }, undefined, undefined, context());
    await eventHandlers.get("session_shutdown")?.({}, context());
    const status = await tool.execute("call", { action: "status" }, undefined, undefined, context());
    assert.equal(status.details.phase, "stopped");
  });

  test("completes the destructive approval workflow", async () => {
    const command = commands.get("destructive-db");
    await command.handler("ask", context());

    const refusal = await tools.get("supabase_cli").execute(
      "call",
      { args: ["db", "reset", "--local"] },
      undefined,
      undefined,
      context(),
    );
    assert.equal(refusal.details.action, "approval_required");

    await command.handler(`approve ${refusal.details.requestId}`, context());
    assert.match(sentMessages.at(-1) ?? "", /rerunning the approved command/);

    const allowed = await tools.get("supabase_cli").execute(
      "call",
      { args: ["db", "reset", "--local"] },
      undefined,
      undefined,
      context(),
    );
    assert.match(allowed.content[0].text, /--yes/);
    assert.deepEqual(JSON.parse(allowed.content[0].text.trim()), [
      "supabase-prefix", "db", "reset", "--local", "--agent", "yes", "--yes",
    ]);

    // Approval is one-shot; automation flags cannot grant authority on retry.
    const retry = await tools.get("supabase_cli").execute(
      "call", { args: ["db", "reset", "--local", "--agent", "yes", "--yes"] },
      undefined, undefined, context(),
    );
    assert.equal(retry.details.action, "approval_required");
    await command.handler("no", context());
    const denied = await tools.get("supabase_cli").execute(
      "call", { args: ["db", "reset", "--local", "--yes"] },
      undefined, undefined, context(),
    );
    assert.equal(denied.details.action, "blocked");
  });

  test("fails closed when trusted project configuration becomes malformed", async () => {
    const configPath = join(root, ".pi", "supabase-tools.json");
    const valid = await import("node:fs/promises").then(({ readFile }) => readFile(configPath, "utf-8"));
    await writeFile(configPath, "{ malformed", "utf-8");
    try {
      await assert.rejects(
        tools.get("supabase_cli").execute(
          "call",
          { args: ["status"] },
          undefined,
          undefined,
          context(),
        ),
        /Cannot parse/,
      );
    } finally {
      await writeFile(configPath, valid, "utf-8");
    }
  });
});
