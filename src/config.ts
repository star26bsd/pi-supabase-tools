import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type {
  BlockedCommand,
  ConfigContext,
  DenoTestEnvironmentProfile,
  ResolvedConfig,
  SupabaseToolsConfig,
} from "./types.js";

const CONFIG_DIR_NAME = ".pi";
const CONFIG_FILE_NAME = "supabase-tools.json";

const DEFAULT_CONFIG: ResolvedConfig = {
  pathPrepend: [],
  environment: {},
  commands: {
    supabaseCli: ["npx", "supabase"],
    denoTest: ["deno", "test"],
    denoCache: ["deno", "cache"],
  },
  workingDirectory: "supabase",
  destructiveDbOps: "ask",
  stateFile: ".pi/supabase-tools-state.json",
  blockedCommands: [],
  denoTestEnvironmentProfiles: {},
  defaultTimeout: 120,
};

const TOP_LEVEL_KEYS = new Set([
  "pathPrepend",
  "environment",
  "commands",
  "workingDirectory",
  "destructiveDbOps",
  "stateFile",
  "blockedCommands",
  "denoTestEnvironmentProfiles",
  "functionsServe",
  "typeGeneration",
]);
const COMMAND_KEYS = new Set(["supabaseCli", "denoTest", "denoCache"]);

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireNonEmptyString(value: unknown, location: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ConfigurationError(`${location} must be a non-empty string`);
  }
  return value;
}

function validateStringArray(value: unknown, location: string, allowEmpty = true): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    const qualifier = allowEmpty ? "an array" : "a non-empty array";
    throw new ConfigurationError(`${location} must be ${qualifier} of non-empty strings`);
  }
  return value.map((entry, index) => requireNonEmptyString(entry, `${location}[${index}]`));
}

const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function validateDenoTestEnvironmentProfiles(
  value: unknown,
  location: string,
): Record<string, DenoTestEnvironmentProfile> {
  if (!isRecord(value)) {
    throw new ConfigurationError(`${location} must be an object`);
  }

  const profiles: Record<string, DenoTestEnvironmentProfile> = Object.create(null);
  for (const [name, entry] of Object.entries(value)) {
    const profileLocation = `${location}.${name}`;
    if (!PROFILE_NAME.test(name)) {
      throw new ConfigurationError(`${location} profile name '${name}' is invalid`);
    }
    if (!isRecord(entry)) {
      throw new ConfigurationError(`${profileLocation} must be an object`);
    }
    for (const key of Object.keys(entry)) {
      if (key !== "source" && key !== "variables") {
        throw new ConfigurationError(`${profileLocation} has unknown property '${key}'`);
      }
    }
    if (entry.source !== "supabaseStatus") {
      throw new ConfigurationError(`${profileLocation}.source must be 'supabaseStatus'`);
    }
    if (!isRecord(entry.variables) || Object.keys(entry.variables).length === 0) {
      throw new ConfigurationError(`${profileLocation}.variables must be a non-empty object`);
    }

    const variables: Record<string, string> = Object.create(null);
    const targets = new Set<string>();
    for (const [sourceName, targetValue] of Object.entries(entry.variables)) {
      if (!ENVIRONMENT_NAME.test(sourceName)) {
        throw new ConfigurationError(`${profileLocation}.variables source '${sourceName}' is invalid`);
      }
      if (typeof targetValue !== "string" || !ENVIRONMENT_NAME.test(targetValue)) {
        throw new ConfigurationError(`${profileLocation}.variables.${sourceName} must be an environment variable name`);
      }
      if (targets.has(targetValue)) {
        throw new ConfigurationError(`${profileLocation}.variables has duplicate target '${targetValue}'`);
      }
      targets.add(targetValue);
      variables[sourceName] = targetValue;
    }
    profiles[name] = { source: "supabaseStatus", variables };
  }
  return profiles;
}

function validateBlockedCommands(value: unknown, location: string): BlockedCommand[] {
  if (!Array.isArray(value)) {
    throw new ConfigurationError(`${location} must be an array`);
  }

  return value.map((entry, index) => {
    const itemLocation = `${location}[${index}]`;
    if (!isRecord(entry)) {
      throw new ConfigurationError(`${itemLocation} must be an object`);
    }
    for (const key of Object.keys(entry)) {
      if (key !== "prefix" && key !== "reason") {
        throw new ConfigurationError(`${itemLocation} has unknown property '${key}'`);
      }
    }
    return {
      prefix: validateStringArray(entry.prefix, `${itemLocation}.prefix`, false),
      reason: requireNonEmptyString(entry.reason, `${itemLocation}.reason`),
    };
  });
}

export function validateConfig(value: unknown, source: string): SupabaseToolsConfig {
  if (!isRecord(value)) {
    throw new ConfigurationError(`${source} must contain a JSON object`);
  }

  for (const key of Object.keys(value)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      throw new ConfigurationError(`${source} has unknown property '${key}'`);
    }
  }

  const config: SupabaseToolsConfig = {};

  if (value.pathPrepend !== undefined) {
    config.pathPrepend = validateStringArray(value.pathPrepend, `${source}.pathPrepend`);
  }

  if (value.environment !== undefined) {
    if (!isRecord(value.environment)) {
      throw new ConfigurationError(`${source}.environment must be an object`);
    }
    config.environment = Object.create(null) as Record<string, string | null>;
    for (const [key, entry] of Object.entries(value.environment)) {
      if (key.length === 0 || (typeof entry !== "string" && entry !== null)) {
        throw new ConfigurationError(
          `${source}.environment values must be strings or null`,
        );
      }
      config.environment[key] = entry;
    }
  }

  if (value.commands !== undefined) {
    if (!isRecord(value.commands)) {
      throw new ConfigurationError(`${source}.commands must be an object`);
    }
    for (const key of Object.keys(value.commands)) {
      if (!COMMAND_KEYS.has(key)) {
        throw new ConfigurationError(`${source}.commands has unknown property '${key}'`);
      }
    }
    config.commands = {};
    if (value.commands.supabaseCli !== undefined) {
      config.commands.supabaseCli = validateStringArray(
        value.commands.supabaseCli,
        `${source}.commands.supabaseCli`,
        false,
      );
    }
    if (value.commands.denoTest !== undefined) {
      config.commands.denoTest = validateStringArray(
        value.commands.denoTest,
        `${source}.commands.denoTest`,
        false,
      );
    }
    if (value.commands.denoCache !== undefined) {
      config.commands.denoCache = validateStringArray(
        value.commands.denoCache,
        `${source}.commands.denoCache`,
        false,
      );
    }
  }

  if (value.workingDirectory !== undefined) {
    config.workingDirectory = requireNonEmptyString(
      value.workingDirectory,
      `${source}.workingDirectory`,
    );
  }

  if (value.destructiveDbOps !== undefined) {
    if (!(["ask", "yes", "no"] as unknown[]).includes(value.destructiveDbOps)) {
      throw new ConfigurationError(
        `${source}.destructiveDbOps must be 'ask', 'yes', or 'no'`,
      );
    }
    config.destructiveDbOps = value.destructiveDbOps as "ask" | "yes" | "no";
  }

  if (value.stateFile !== undefined) {
    config.stateFile = requireNonEmptyString(value.stateFile, `${source}.stateFile`);
  }

  if (value.blockedCommands !== undefined) {
    config.blockedCommands = validateBlockedCommands(
      value.blockedCommands,
      `${source}.blockedCommands`,
    );
  }

  if (value.denoTestEnvironmentProfiles !== undefined) {
    config.denoTestEnvironmentProfiles = validateDenoTestEnvironmentProfiles(
      value.denoTestEnvironmentProfiles,
      `${source}.denoTestEnvironmentProfiles`,
    );
  }

  if (value.functionsServe !== undefined) {
    if (!isRecord(value.functionsServe)) {
      throw new ConfigurationError(`${source}.functionsServe must be an object`);
    }
    for (const key of Object.keys(value.functionsServe)) {
      if (key !== "args") {
        throw new ConfigurationError(`${source}.functionsServe has unknown property '${key}'`);
      }
    }
    config.functionsServe = {
      args: validateStringArray(value.functionsServe.args, `${source}.functionsServe.args`),
    };
  }

  if (value.typeGeneration !== undefined) {
    const location = `${source}.typeGeneration`;
    if (!isRecord(value.typeGeneration)) {
      throw new ConfigurationError(`${location} must be an object`);
    }
    for (const key of Object.keys(value.typeGeneration)) {
      if (key !== "schemas") throw new ConfigurationError(`${location} has unknown property '${key}'`);
    }
    const schemas = validateStringArray(value.typeGeneration.schemas, `${location}.schemas`, false);
    // A conservative PostgreSQL identifier subset; no CLI flags, delimiters or NUL.
    if (schemas.some((schema) => !/^[A-Za-z_][A-Za-z0-9_$]{0,62}$/.test(schema))) {
      throw new ConfigurationError(`${location}.schemas must contain simple PostgreSQL identifiers (1-63 ASCII characters)`);
    }
    if (new Set(schemas).size !== schemas.length) {
      throw new ConfigurationError(`${location}.schemas must not contain duplicates`);
    }
    config.typeGeneration = { schemas };
  }

  return config;
}

function readConfigFile(path: string): SupabaseToolsConfig | undefined {
  if (!existsSync(path)) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigurationError(`Cannot parse ${path}: ${message}`);
  }
  return validateConfig(parsed, path);
}

function expandHome(value: string, homeDirectory: string): string {
  if (value === "~") return homeDirectory;
  if (value.startsWith("~/")) return join(homeDirectory, value.slice(2));
  return value;
}

function expandCommand(command: string[], homeDirectory: string): string[] {
  return command.map((entry, index) => index === 0 ? expandHome(entry, homeDirectory) : entry);
}

export function mergeConfig(
  globalConfig: SupabaseToolsConfig | undefined,
  projectConfig: SupabaseToolsConfig | undefined,
  homeDirectory = homedir(),
): ResolvedConfig {
  const globalCommands = globalConfig?.commands ?? {};
  const projectCommands = projectConfig?.commands ?? {};

  return {
    pathPrepend: [
      ...(projectConfig?.pathPrepend ?? []),
      ...(globalConfig?.pathPrepend ?? []),
    ].map((entry) => expandHome(entry, homeDirectory)),
    environment: {
      ...(globalConfig?.environment ?? {}),
      ...(projectConfig?.environment ?? {}),
    },
    commands: {
      supabaseCli: expandCommand(
        projectCommands.supabaseCli ?? globalCommands.supabaseCli ?? DEFAULT_CONFIG.commands.supabaseCli,
        homeDirectory,
      ),
      denoTest: expandCommand(
        projectCommands.denoTest ?? globalCommands.denoTest ?? DEFAULT_CONFIG.commands.denoTest,
        homeDirectory,
      ),
      denoCache: expandCommand(
        projectCommands.denoCache ?? globalCommands.denoCache ?? DEFAULT_CONFIG.commands.denoCache,
        homeDirectory,
      ),
    },
    workingDirectory:
      projectConfig?.workingDirectory ??
      globalConfig?.workingDirectory ??
      DEFAULT_CONFIG.workingDirectory,
    destructiveDbOps:
      projectConfig?.destructiveDbOps ??
      globalConfig?.destructiveDbOps ??
      DEFAULT_CONFIG.destructiveDbOps,
    stateFile:
      projectConfig?.stateFile ?? globalConfig?.stateFile ?? DEFAULT_CONFIG.stateFile,
    blockedCommands: [
      ...(globalConfig?.blockedCommands ?? []),
      ...(projectConfig?.blockedCommands ?? []),
    ],
    denoTestEnvironmentProfiles: Object.assign(
      Object.create(null) as Record<string, DenoTestEnvironmentProfile>,
      globalConfig?.denoTestEnvironmentProfiles ?? {},
      projectConfig?.denoTestEnvironmentProfiles ?? {},
    ),
    functionsServe: projectConfig?.functionsServe ?? globalConfig?.functionsServe,
    typeGeneration: projectConfig?.typeGeneration ?? globalConfig?.typeGeneration,
    defaultTimeout: DEFAULT_CONFIG.defaultTimeout,
  };
}

export function loadConfig(context: ConfigContext): ResolvedConfig {
  const homeDirectory = context.homeDirectory ?? homedir();
  const globalPath = join(homeDirectory, CONFIG_DIR_NAME, "agent", CONFIG_FILE_NAME);
  const projectPath = join(context.cwd, CONFIG_DIR_NAME, CONFIG_FILE_NAME);
  const globalConfig = readConfigFile(globalPath);
  const projectConfig = context.projectTrusted ? readConfigFile(projectPath) : undefined;
  return mergeConfig(globalConfig, projectConfig, homeDirectory);
}

export function buildChildEnvironment(
  config: ResolvedConfig,
  inherited: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...inherited };

  for (const [key, value] of Object.entries(config.environment)) {
    if (value === null) delete environment[key];
    else environment[key] = value;
  }

  if (config.pathPrepend.length > 0) {
    const currentPath = environment.PATH;
    environment.PATH = [
      ...config.pathPrepend,
      ...(currentPath ? [currentPath] : []),
    ].join(delimiter);
  }

  return environment;
}
