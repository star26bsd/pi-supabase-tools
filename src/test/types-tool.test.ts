import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import supabaseTools from "../index.js";

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-types-tool-test-"));
  mkdirSync(join(root, ".pi"));
  mkdirSync(join(root, "work"));
  const marker = join(root, "spawned.json");
  const source = join(root, "source.txt");
  const script = join(root, "generate.mjs");
  writeFileSync(source, "FIRST\n" + "x".repeat(60 * 1024) + "\nLAST\n");
  writeFileSync(script, `import { readFileSync, writeFileSync } from "node:fs";
    writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), env: process.env.TYPE_TEST }));
    process.stderr.write("SECRET-STDERR");
    process.stdout.write(readFileSync(${JSON.stringify(source)}));`);
  const config = {
    workingDirectory: "work",
    commands: { supabaseCli: [process.execPath, script] },
    environment: { TYPE_TEST: "SECRET-CONFIG" },
    typeGeneration: { schemas: ["public", "api"] },
  };
  const configPath = join(root, ".pi", "supabase-tools.json");
  writeFileSync(configPath, JSON.stringify(config));
  const tools = new Map<string, any>();
  const events = new Map<string, any>();
  await supabaseTools({
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerCommand() {},
    on(name: string, handler: any) { events.set(name, handler); },
  } as never);
  const context = { cwd: root, isProjectTrusted: () => true };
  const updates: unknown[] = [];
  const tool = tools.get("supabase_types");
  const call = (params: unknown, ctx = context, signal?: AbortSignal) => tool.execute(
    "test", params, signal, (update: unknown) => updates.push(update), ctx,
  );
  const shutdown = () => events.get("session_shutdown")({}, context);
  return { root, marker, source, config, configPath, context, updates, tool, call, shutdown,
    async cleanup() { await shutdown(); rmSync(root, { recursive: true, force: true }); },
  };
}

test("registered capture uses only trusted argv/cwd/environment and fresh executions, with compact metadata", async () => {
  const f = await fixture();
  try {
    assert.deepEqual(Object.keys(f.tool.parameters.properties), ["action", "artifactId"]);
    assert.equal(f.tool.parameters.additionalProperties, false);
    const first = await f.call({ action: "capture" });
    const a = first.details;
    assert.equal(a.complete, true);
    assert.deepEqual(Object.keys(a).sort(), ["artifactId", "bytes", "complete", "path", "sha256"]);
    assert.deepEqual(readFileSync(a.path), readFileSync(f.source));
    assert.ok(Buffer.byteLength(JSON.stringify(first)) < 2048);
    assert.doesNotMatch(JSON.stringify(first), /SECRET-|FIRST|LAST|supabaseCli/);
    assert.deepEqual(f.updates, []);
    assert.deepEqual(JSON.parse(readFileSync(f.marker, "utf8")), {
      args: ["gen", "types", "--local", "--lang", "typescript", "--schema", "public,api"],
      cwd: realpathSync(join(f.root, "work")), env: "SECRET-CONFIG",
    });
    await assert.rejects(f.call({ action: "capture" }), /artifact_retained/);
    await f.call({ action: "release", artifactId: a.artifactId });
    rmSync(f.marker);
    writeFileSync(f.source, "fresh output\n");
    const b = (await f.call({ action: "capture" })).details;
    assert.equal(existsSync(f.marker), true, "second capture must actually execute the producer");
    assert.notEqual(a.artifactId, b.artifactId);
    assert.notEqual(a.sha256, b.sha256);
    assert.equal(readFileSync(b.path, "utf8"), "fresh output\n");
    // Release is tied to owned state, not current project configuration or trust.
    writeFileSync(f.configPath, "{ invalid");
    await f.call({ action: "release", artifactId: b.artifactId }, { ...f.context, isProjectTrusted: () => false });
    assert.equal(existsSync(b.path), false);
  } finally { await f.cleanup(); }
});

test("denies missing/invalid/untrusted/blocked capture and model-selected capabilities before spawn", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.call({ action: "capture" }, { ...f.context, isProjectTrusted: () => false }), /project_untrusted/);
    for (const params of [
      { action: "status" }, { action: "release" }, { action: "capture", artifactId: "path" },
      { action: "capture", args: ["status", "-o", "env"] },
      { action: "capture", args: ["functions", "serve"] },
      { action: "capture", environmentProfile: "local" },
      { action: "capture", schemas: ["other"] },
      { action: "capture", path: "/tmp/escape.ts" },
      { action: "capture", environment: { SECRET: "injected" } },
      { action: "capture", timeout: 999 },
    ]) await assert.rejects(f.call(params), /invalid arguments|use capture/);
    const { typeGeneration: _enabled, ...disabled } = f.config;
    writeFileSync(f.configPath, JSON.stringify(disabled));
    await assert.rejects(f.call({ action: "capture" }), /not_enabled_by_configuration/);
    writeFileSync(f.configPath, JSON.stringify({ ...f.config, typeGeneration: { schemas: [] } }));
    await assert.rejects(f.call({ action: "capture" }), /schemas/);
    writeFileSync(f.configPath, "{ malformed");
    await assert.rejects(f.call({ action: "capture" }), /Cannot parse/);
    writeFileSync(f.configPath, JSON.stringify({ ...f.config, blockedCommands: [{ prefix: ["gen", "types"], reason: "denied" }] }));
    await assert.rejects(f.call({ action: "capture" }), /blocked_by_configuration/);
    assert.equal(existsSync(f.marker), false);
  } finally { await f.cleanup(); }
});

test("registered shutdown removes retained source and refuses further use of the old manager", async () => {
  const f = await fixture();
  try {
    const artifact = (await f.call({ action: "capture" })).details;
    await f.shutdown();
    assert.equal(existsSync(artifact.path), false);
    await assert.rejects(f.call({ action: "capture" }), /session_shutdown/);
  } finally { await f.cleanup(); }
});
