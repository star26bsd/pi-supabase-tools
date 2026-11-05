import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, before, describe, test } from "node:test";
import {
  buildChildEnvironment,
  ConfigurationError,
  loadConfig,
  mergeConfig,
  validateConfig,
} from "../config.js";

let root: string;
let home: string;
let project: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-supabase-tools-config-"));
  home = join(root, "home");
  project = join(root, "project");
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  mkdirSync(join(project, ".pi"), { recursive: true });
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeJson(path: string, value: unknown) {
  writeFileSync(path, JSON.stringify(value), "utf-8");
}

describe("configuration validation", () => {
  test("rejects unknown and malformed properties", () => {
    assert.throws(
      () => validateConfig({ typo: true }, "config.json"),
      ConfigurationError,
    );
    assert.throws(
      () => validateConfig({ commands: { supabaseCli: [] } }, "config.json"),
      /non-empty array/,
    );
    assert.throws(
      () => validateConfig({ environment: { TOKEN: 42 } }, "config.json"),
      /strings or null/,
    );
    assert.throws(
      () => validateConfig({ blockedCommands: [{ prefix: [], reason: "No" }] }, "config.json"),
      /non-empty array/,
    );
    assert.throws(
      () => validateConfig({ functionsServe: {} }, "config.json"),
      /functionsServe.args/,
    );
    assert.throws(
      () => validateConfig({ functionsServe: { args: [], extra: true } }, "config.json"),
      /unknown property/,
    );
    assert.throws(
      () => validateConfig({ denoTestEnvironmentProfiles: { "bad name": {} } }, "config.json"),
      /profile name/,
    );
    assert.throws(
      () => validateConfig({
        denoTestEnvironmentProfiles: {
          local: { source: "supabaseStatus", variables: { API_URL: "SAME", ANON_KEY: "SAME" } },
        },
      }, "config.json"),
      /duplicate target/,
    );
  });

  test("accepts the declarative interface", () => {
    assert.deepEqual(validateConfig({
      pathPrepend: ["~/.deno/bin"],
      environment: { DENO_DIR: "/tmp/cache", TOKEN: null },
      commands: {
        supabaseCli: ["/opt/homebrew/bin/supabase"],
        denoTest: ["deno", "test", "--allow-read=."],
        denoCache: ["deno", "cache", "--allow-import=jsr.io"],
      },
      workingDirectory: "supabase",
      destructiveDbOps: "ask",
      stateFile: ".pi/supabase-tools-state.json",
      blockedCommands: [{ prefix: ["db", "diff"], reason: "Use PG-Delta" }],
      functionsServe: { args: [] },
      denoTestEnvironmentProfiles: {
        local: {
          source: "supabaseStatus",
          variables: { API_URL: "SUPABASE_URL", ANON_KEY: "SUPABASE_ANON_KEY" },
        },
      },
    }, "config.json").destructiveDbOps, "ask");
  });
});

describe("configuration discovery and merge", () => {
  test("uses defaults when files are absent", () => {
    const isolatedHome = join(root, "empty-home");
    const isolatedProject = join(root, "empty-project");
    const config = loadConfig({
      cwd: isolatedProject,
      projectTrusted: true,
      homeDirectory: isolatedHome,
    });
    assert.deepEqual(config.commands.supabaseCli, ["npx", "supabase"]);
    assert.deepEqual(config.commands.denoTest, ["deno", "test"]);
    assert.deepEqual(config.commands.denoCache, ["deno", "cache"]);
    assert.equal(config.workingDirectory, "supabase");
    assert.equal(config.destructiveDbOps, "ask");
    assert.equal(config.functionsServe, undefined);
  });

  test("project values override global values and additive values preserve order", () => {
    writeJson(join(home, ".pi", "agent", "supabase-tools.json"), {
      pathPrepend: ["~/global-bin"],
      environment: { SHARED: "global", GLOBAL: "yes" },
      commands: {
        supabaseCli: ["global-supabase"],
        denoTest: ["global-deno", "test"],
        denoCache: ["global-deno", "cache"],
      },
      workingDirectory: "global-supabase",
      blockedCommands: [{ prefix: ["db", "diff"], reason: "Global policy" }],
      functionsServe: { args: ["--global"] },
      denoTestEnvironmentProfiles: {
        inherited: { source: "supabaseStatus", variables: { API_URL: "URL" } },
        replaced: { source: "supabaseStatus", variables: { OLD: "OLD" } },
      },
    });
    writeJson(join(project, ".pi", "supabase-tools.json"), {
      pathPrepend: ["project-bin"],
      environment: { SHARED: "project", GLOBAL: null },
      commands: { supabaseCli: ["project-supabase"] },
      workingDirectory: "supabase",
      blockedCommands: [{ prefix: ["stop"], reason: "Project policy" }],
      functionsServe: { args: [] },
      denoTestEnvironmentProfiles: {
        replaced: { source: "supabaseStatus", variables: { NEW: "NEW" } },
      },
    });

    const config = loadConfig({
      cwd: project,
      projectTrusted: true,
      homeDirectory: home,
    });
    assert.deepEqual(config.pathPrepend, ["project-bin", join(home, "global-bin")]);
    assert.deepEqual(config.environment, {
      SHARED: "project",
      GLOBAL: null,
    });
    assert.deepEqual(config.commands.supabaseCli, ["project-supabase"]);
    assert.deepEqual(config.commands.denoTest, ["global-deno", "test"]);
    assert.deepEqual(config.commands.denoCache, ["global-deno", "cache"]);
    assert.equal(config.workingDirectory, "supabase");
    assert.deepEqual(config.functionsServe, { args: [] });
    assert.deepEqual(config.blockedCommands.map((rule) => rule.prefix), [
      ["db", "diff"],
      ["stop"],
    ]);
    assert.deepEqual(Object.keys(config.denoTestEnvironmentProfiles), ["inherited", "replaced"]);
    assert.deepEqual({ ...config.denoTestEnvironmentProfiles.replaced.variables }, { NEW: "NEW" });
  });

  test("ignores project configuration when the project is untrusted", () => {
    writeFileSync(join(project, ".pi", "supabase-tools.json"), "{ invalid", "utf-8");
    const config = loadConfig({
      cwd: project,
      projectTrusted: false,
      homeDirectory: join(root, "empty-untrusted-home"),
    });
    assert.deepEqual(config.commands.supabaseCli, ["npx", "supabase"]);
  });

  test("fails closed for a malformed discovered file", () => {
    assert.throws(
      () => loadConfig({
        cwd: project,
        projectTrusted: true,
        homeDirectory: join(root, "empty-malformed-home"),
      }),
      /Cannot parse/,
    );
  });

  test("expands a configured standalone binary", () => {
    const config = mergeConfig({
      commands: { supabaseCli: ["~/bin/supabase"] },
    }, undefined, "/users/test");
    assert.deepEqual(config.commands.supabaseCli, ["/users/test/bin/supabase"]);
  });
});

describe("type generation configuration", () => {
  test("is disabled by default and project object replaces global object", () => {
    assert.equal(mergeConfig(undefined, undefined).typeGeneration, undefined);
    assert.deepEqual(mergeConfig({ typeGeneration: { schemas: ["public"] } }, undefined).typeGeneration, { schemas: ["public"] });
    assert.deepEqual(mergeConfig(
      { typeGeneration: { schemas: ["public", "old"] } },
      { typeGeneration: { schemas: ["api"] } },
    ).typeGeneration, { schemas: ["api"] });
  });

  test("validates the complete narrow object and conservative schema identifiers", () => {
    for (const value of [null, [], {}, { schemas: [] }, { schemas: "public" },
      { schemas: ["public"], args: [] }, { schemas: ["public", "public"] },
      ...["", "--linked", "public,private", "public\\0", "a b", "a".repeat(64), '"quoted"'].map((schema) => ({ schemas: [schema] })),
    ]) {
      assert.throws(() => validateConfig({ typeGeneration: value }, "test"), ConfigurationError);
    }
    assert.deepEqual(validateConfig({ typeGeneration: { schemas: ["public", "My_API$1"] } }, "test").typeGeneration,
      { schemas: ["public", "My_API$1"] });
  });

  test("untrusted project cannot enable capture and invalid global config fails closed", () => {
    const isolatedHome = join(root, "types-home");
    const isolatedProject = join(root, "types-project");
    mkdirSync(join(isolatedHome, ".pi", "agent"), { recursive: true });
    mkdirSync(join(isolatedProject, ".pi"), { recursive: true });
    writeJson(join(isolatedProject, ".pi", "supabase-tools.json"), { typeGeneration: { schemas: ["api"] } });
    assert.equal(loadConfig({ cwd: isolatedProject, homeDirectory: isolatedHome, projectTrusted: false }).typeGeneration, undefined);
    writeJson(join(isolatedHome, ".pi", "agent", "supabase-tools.json"), { typeGeneration: { schemas: [] } });
    assert.throws(() => loadConfig({ cwd: isolatedProject, homeDirectory: isolatedHome, projectTrusted: true }), ConfigurationError);
  });
});

describe("child environment", () => {
  test("inherits, overrides, removes, and prepends PATH", () => {
    const config = mergeConfig({
      pathPrepend: ["/custom/bin"],
      environment: { KEEP: "overridden", REMOVE: null },
    }, undefined, home);
    const environment = buildChildEnvironment(config, {
      PATH: "/inherited/bin",
      KEEP: "inherited",
      REMOVE: "secret",
    });
    assert.equal(environment.PATH, ["/custom/bin", "/inherited/bin"].join(delimiter));
    assert.equal(environment.KEEP, "overridden");
    assert.equal(environment.REMOVE, undefined);
  });
});
