import assert from "node:assert/strict";
import { access, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import {
  FunctionsServeController,
  type FunctionsServeInvocation,
} from "../functions-serve.js";
import { cliV2Contracts } from "./fixtures/cli-v2-contracts.js";

let directory: string;
let script: string;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "pi-supabase-tools-functions-serve-"));
  script = join(directory, "serve-fixture.mjs");
  await writeFile(script, [
    'import { spawn } from "node:child_process";',
    'import { writeFileSync } from "node:fs";',
    'const mode = process.env.SERVE_MODE;',
    'writeFileSync(process.env.INSPECT_FILE, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env: process.env.EXACT_ENV }));',
    'if (mode === "early") { console.error("PRIVATE-EARLY"); process.exit(7); }',
    'if (mode !== "silent") {',
    '  const marker = Buffer.from(process.env.LISTENER ?? "🔐 \\u001b[32m[2026-01-01T00:00:00Z] Serving functions on http://127.0.0.1:54321\\u001b[0m\\n");',
    '  const stream = mode === "stderr" ? process.stderr : process.stdout;',
    '  stream.write(marker.subarray(0, 1));',
    '  setTimeout(() => stream.write(marker.subarray(1, 19)), 5);',
    '  setTimeout(() => stream.write(marker.subarray(19, 47)), 10);',
    '  setTimeout(() => stream.write(marker.subarray(47)), 15);',
    '}',
    'if (mode === "spontaneous") setTimeout(() => { console.error("PRIVATE-CLOSE"); process.exit(9); }, 30);',
    'if (mode === "descendant") {',
    '  const descendant = spawn(process.execPath, ["-e", "setTimeout(() => {}, 2000)"], { detached: true, stdio: "inherit" });',
    '  descendant.unref();',
    '}',
    'process.on("SIGTERM", () => {',
    '  if (mode === "ignore-term") return;',
    '  writeFileSync(process.env.TERM_FILE, "term");',
    '  setTimeout(() => process.exit(0), 15);',
    '});',
    'setInterval(() => {}, 1000);',
  ].join("\n"));
});

after(async () => {
  await rm(directory, { recursive: true, force: true });
});

function invocation(mode = "stdout"): FunctionsServeInvocation {
  return {
    prefix: [process.execPath, script, "trusted-prefix"],
    args: ["--fixture-arg", "literal value"],
    cwd: directory,
    environment: {
      ...process.env,
      SERVE_MODE: mode,
      EXACT_ENV: "configured-value",
      INSPECT_FILE: join(directory, `inspect-${mode}.json`),
      TERM_FILE: join(directory, `term-${mode}`),
    },
    timeoutSeconds: 1,
    blockedCommands: [],
  };
}

async function eventually(predicate: () => Promise<boolean>) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition did not become true");
}

function serialized(value: unknown): string {
  return JSON.stringify(value);
}

function assertNoPrivateOutput(value: unknown) {
  assert.doesNotMatch(serialized(value), /PRIVATE|Serving functions|127\.0\.0\.1|🔐/);
}

function exposedError(error: Error): Record<string, unknown> {
  return Object.fromEntries(
    Object.getOwnPropertyNames(error).map((name) => [name, (error as unknown as Record<string, unknown>)[name]]),
  );
}

describe("functions serve lifecycle", () => {
  for (const contract of cliV2Contracts) {
    test(`CLI ${contract.version}: split listener on either stream, graceful cleanup and restart`, async () => {
      for (const stream of ["stdout", "stderr"]) {
        const controller = new FunctionsServeController({ stopGraceMs: 300 });
        const value = invocation(stream);
        // ANSI, UTF-8 and timestamp prefixes are transport stress, not a captured CLI transcript.
        value.environment.LISTENER = `🔐 \u001b[32m[2026-01-01T00:00:00Z] ${contract.listener}\u001b[0m`;
        try {
          for (let run = 0; run < 2; run += 1) {
            await rm(value.environment.TERM_FILE!, { force: true });
            const start = await controller.start(value);
            assert.equal(start.details?.phase, "running");
            assertNoPrivateOutput(start);
            assert.equal((await controller.status()).details?.phase, "running");
            const stop = await controller.stop();
            assert.equal(stop.details?.phase, "stopped");
            assert.equal((stop.details?.lastExit as any).cleanup, "confirmed");
            assertNoPrivateOutput(stop);
            await access(value.environment.TERM_FILE!);
          }
        } finally {
          await controller.shutdown();
        }
      }
    });

    test(`CLI ${contract.version}: no listener means timeout; early exit and abort stay private`, async () => {
      for (const mode of ["early", "silent", "abort"]) {
        const controller = new FunctionsServeController({ stopGraceMs: 300 });
        const value = invocation(mode === "early" ? "early" : "silent");
        value.environment.LISTENER = contract.listener;
        // Timeout must allow the fixture to boot, so we also verify its TERM cleanup.
        value.timeoutSeconds = mode === "silent" ? 0.3 : 2;
        const abort = new AbortController();
        try {
          await rm(value.environment.INSPECT_FILE!, { force: true });
          await rm(value.environment.TERM_FILE!, { force: true });
          const start = controller.start(value, abort.signal);
          const rejection = assert.rejects(start, (error: Error) => {
            assert.match(error.message, mode === "early" ? /early_exit/ : mode === "silent" ? /timeout/ : /abort/);
            assertNoPrivateOutput(exposedError(error));
            return true;
          });
          if (mode === "abort") {
            await eventually(async () => access(value.environment.INSPECT_FILE!).then(() => true, () => false));
            abort.abort();
          }
          await rejection;
          const status = await controller.status();
          assert.equal(status.details?.phase, "stopped");
          assertNoPrivateOutput(status);
          if (mode !== "early") {
            assert.equal((status.details?.lastExit as any).cleanup, "confirmed");
            await access(value.environment.TERM_FILE!);
          }
        } finally {
          await controller.shutdown();
        }
      }
    });
  }

  test("uses exact trusted argv, cwd, and environment and recognizes split ANSI UTF-8 markers on either stream", async () => {
    for (const mode of ["stdout", "stderr"]) {
      const controller = new FunctionsServeController({ stopGraceMs: 100 });
      try {
        const start = await controller.start(invocation(mode));
        assert.equal(start.details?.phase, "running");
        assertNoPrivateOutput(start);
        const inspect = JSON.parse(await readFile(join(directory, `inspect-${mode}.json`), "utf-8"));
        assert.deepEqual(inspect.argv, [
          "trusted-prefix", "functions", "serve", "--fixture-arg", "literal value",
        ]);
        assert.equal(inspect.cwd, await realpath(directory));
        assert.equal(inspect.env, "configured-value");
        const stop = await controller.stop();
        assert.equal((stop.details?.lastExit as any).cleanup, "confirmed");
        assertNoPrivateOutput(stop);
        await access(join(directory, `term-${mode}`));
      } finally {
        await controller.shutdown();
      }
    }
  });

  test("is idempotent and reports spontaneous exit without service output", async () => {
    const controller = new FunctionsServeController({ stopGraceMs: 100 });
    const first = await controller.start(invocation("spontaneous"));
    const second = await controller.start(invocation("spontaneous"));
    assert.equal(second.details?.startedAt, first.details?.startedAt);
    await eventually(async () => (await controller.status()).details?.phase === "stopped");
    const status = await controller.status();
    assert.equal((status.details?.lastExit as any).exitCode, 9);
    assertNoPrivateOutput(status);
    const stopped = await controller.stop();
    assert.equal(stopped.details?.phase, "stopped");
  });

  test("fails privately on early exit, timeout, abort, and blocked configuration", async () => {
    const scenarios: Array<[string, () => Promise<unknown>, RegExp]> = [
      ["early", () => new FunctionsServeController({ stopGraceMs: 30 }).start(invocation("early")), /early_exit/],
      ["timeout", () => {
        const value = invocation("silent");
        value.timeoutSeconds = 0.03;
        return new FunctionsServeController({ stopGraceMs: 30 }).start(value);
      }, /timeout/],
    ];
    for (const [, run, expected] of scenarios) {
      await assert.rejects(run(), (error: Error) => expected.test(error.message) && !/PRIVATE|Serving functions/.test(error.message));
    }

    const blockedController = new FunctionsServeController();
    const blocked = invocation("blocked-private");
    const trustedArg = "PRIVATE-TRUSTED-ARG-Serving functions on sentinel";
    const trustedReason = "PRIVATE-BLOCKED-REASON-127.0.0.1";
    blocked.args = [trustedArg];
    blocked.blockedCommands = [{ prefix: ["functions", "serve"], reason: trustedReason }];
    await assert.rejects(blockedController.start(blocked), (error: Error) => {
      const exposure = exposedError(error);
      const complete = JSON.stringify({ exposure, enumerable: { ...error }, serialized: JSON.stringify(error) });
      return (
        error.message.includes("blocked_by_configuration") &&
        (exposure.details as any)?.reason === "blocked_by_configuration" &&
        !complete.includes(trustedArg) &&
        !complete.includes(trustedReason) &&
        !complete.includes("Serving functions on") &&
        !complete.includes("127.0.0.1")
      );
    });
    await assert.rejects(access(join(directory, "inspect-blocked-private.json")));

    const controller = new FunctionsServeController({ stopGraceMs: 30 });
    const abort = new AbortController();
    const value = invocation("silent");
    const starting = controller.start(value, abort.signal);
    abort.abort();
    await assert.rejects(starting, /abort/);
    assert.equal((await controller.status()).details?.phase, "stopped");
  });

  test("settles a missing executable promptly and returns to stopped", async () => {
    const controller = new FunctionsServeController();
    const value = invocation();
    value.prefix = [join(directory, "missing-supabase-executable")];
    const started = Date.now();
    await assert.rejects(
      controller.start(value),
      (error: Error) => /spawn_error/.test(error.message) && !error.message.includes(value.prefix[0]),
    );
    assert.ok(Date.now() - started < 500, "async spawn failure must settle promptly");
    const status = await controller.status();
    assert.equal(status.details?.phase, "stopped");
    assertNoPrivateOutput(status);
  });

  test("shutdown interrupts startup and is idempotent", async () => {
    const controller = new FunctionsServeController({ stopGraceMs: 30 });
    const starting = controller.start(invocation("silent"));
    await eventually(async () => access(join(directory, "inspect-silent.json")).then(() => true, () => false));
    const shutdown = controller.shutdown();
    await assert.rejects(starting, /shutdown/);
    await shutdown;
    await controller.shutdown();
    assert.equal((await controller.status()).details?.phase, "stopped");
  });

  test("uses TERM before KILL and honestly reports forced cleanup", async () => {
    const graceful = new FunctionsServeController({ stopGraceMs: 100, settlementGraceMs: 100 });
    await graceful.start(invocation("descendant"));
    const started = Date.now();
    const gracefulStop = await graceful.stop();
    assert.ok(Date.now() - started < 500, "descendant-held stdio must settle boundedly");
    assert.equal(
      (gracefulStop.details?.lastExit as any).cleanup,
      "cleanup_unconfirmed",
      "leader exit without process-chain close must not confirm cleanup",
    );

    const forced = new FunctionsServeController({ stopGraceMs: 20, settlementGraceMs: 100 });
    await forced.start(invocation("ignore-term"));
    const forcedStop = await forced.stop();
    const exit = forcedStop.details?.lastExit as any;
    assert.equal(exit.cleanup, "cleanup_unconfirmed");
    assert.equal(exit.signal, "SIGKILL");
    assertNoPrivateOutput(forcedStop);
  });
});
