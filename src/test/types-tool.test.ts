import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import ts from "typescript";
import supabaseTools from "../index.js";

async function fixture(initialOutput = "FIRST\n" + "x".repeat(60 * 1024) + "\nLAST\n", diagnostics = "SECRET-STDERR") {
  const root = mkdtempSync(join(tmpdir(), "pi-types-tool-test-"));
  mkdirSync(join(root, ".pi"));
  mkdirSync(join(root, "work"));
  const marker = join(root, "spawned.json");
  const source = join(root, "source.txt");
  const script = join(root, "generate.mjs");
  writeFileSync(source, initialOutput);
  writeFileSync(script, `import { readFileSync, writeFileSync } from "node:fs";
    writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), env: process.env.TYPE_TEST }));
    process.stderr.write(${JSON.stringify(diagnostics)});
    const bytes = readFileSync(${JSON.stringify(source)});
    const unicode = bytes.indexOf(Buffer.from("ï"));
    const split = unicode >= 0 ? unicode + 1 : 5;
    process.stdout.write(bytes.subarray(0, split));
    setTimeout(() => process.stdout.write(bytes.subarray(split)), 5);`);
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

// Disposable consumer only: the package transports bytes, never validates/rewrites types.
// Do not import a consuming project's generator or install this helper as a tool.
function consumeTypes(path: string, target: string, check: boolean): boolean {
  const program = ts.createProgram([path], {
    noEmit: true, strict: true, types: [], skipLibCheck: true, target: ts.ScriptTarget.ES2022,
  });
  assert.equal(ts.getPreEmitDiagnostics(program).length, 0, "consumer rejects invalid TypeScript");
  const source = readFileSync(path, "utf8");
  assert.match(source, /export type Database =/);
  const canonical = source.replace(/\n+$/, "") + "\n";
  if (check) return readFileSync(target, "utf8") === canonical;
  const temporary = `${target}.tmp`;
  try {
    writeFileSync(temporary, canonical);
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
  return true;
}

for (const version of ["2.111.0", "2.122.1"]) {
  test(`CLI ${version}: private byte-exact capture and consumer install/release/fresh check`, async () => {
    // Constructed schema excerpts, not real database output; see doc/TYPE-CAPTURE-COMPATIBILITY.md.
    const source = readFileSync(new URL(`./fixtures/types-${version}.txt`, import.meta.url), "utf8") + "\n";
    const diagnostics = "Connecting to 127.0.0.1 54322\n"
      + (version === "2.122.1"
        ? "Generated TypeScript is unformatted. Format it with:\n  npx oxfmt <generated-file.ts>\n"
        : "")
      + "PRIVATE-SYNTHETIC-DIAGNOSTIC\n";
    const f = await fixture(source, diagnostics);
    const target = join(f.root, "installed.ts");
    const captures: string[] = [];
    async function capture(expected: string) {
      rmSync(f.marker, { force: true });
      const result = await f.call({ action: "capture" });
      const artifact = result.details;
      assert.equal(existsSync(f.marker), true, "every capture must execute the producer again");
      assert.deepEqual(Object.keys(artifact).sort(), ["artifactId", "bytes", "complete", "path", "sha256"]);
      assert.equal(artifact.complete, true);
      assert.equal(artifact.bytes, Buffer.byteLength(expected));
      assert.equal(artifact.sha256, createHash("sha256").update(expected).digest("hex"));
      assert.deepEqual(readFileSync(artifact.path), Buffer.from(expected));
      assert.equal(captures.includes(artifact.artifactId), false);
      captures.push(artifact.artifactId);
      assert.deepEqual(f.updates, []);
      assert.doesNotMatch(JSON.stringify(result), /export type|ComputedFields|naïve_label|PRIVATE|Connecting to|unformatted/);
      return artifact;
    }
    async function release(artifact: { artifactId: string; path: string }) {
      await f.call({ action: "release", artifactId: artifact.artifactId });
      assert.equal(existsSync(artifact.path), false);
    }
    try {
      const a = await capture(source);
      assert.equal(source.includes("ComputedFields"), version === "2.122.1");
      // Capture preserves the two terminal LF bytes; only the consumer canonicalizes.
      assert.ok(source.endsWith("\n\n"));
      assert.equal(consumeTypes(a.path, target, false), true);
      const installed = readFileSync(target);
      assert.equal(installed.toString(), source.replace(/\n+$/, "") + "\n");
      await assert.rejects(f.call({ action: "capture" }), /artifact_retained/);
      await release(a); // Consumer acknowledged successful installation.

      const b = await capture(source);
      assert.notEqual(b.path, a.path);
      assert.equal(b.sha256, a.sha256);
      assert.equal(consumeTypes(b.path, target, true), true);
      assert.deepEqual(readFileSync(target), installed);
      await release(b); // Consumer acknowledged matching fresh check.

      const changed = source.replace("id: number", "id: string");
      writeFileSync(f.source, changed);
      const c = await capture(changed);
      assert.notEqual(c.sha256, a.sha256);
      assert.equal(consumeTypes(c.path, target, true), false);
      assert.deepEqual(readFileSync(target), installed, "mismatch must not rewrite the target");
      await release(c); // Failed comparison still consumed its artifact.

      const invalid = "export type Database = {\n";
      writeFileSync(f.source, invalid);
      const d = await capture(invalid);
      assert.throws(() => consumeTypes(d.path, target, false), /consumer rejects invalid TypeScript/);
      assert.deepEqual(readFileSync(target), installed, "invalid input must not rewrite the target");
      await release(d); // complete:true is not validation; rejected source is still released.
    } finally {
      await f.cleanup();
    }
  });
}
