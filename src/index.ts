/**
 * pi-supabase-tools — focused Supabase tools for Pi.
 */

import { existsSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { findBlockedCommand, findDenoPermissionArgument } from "./command-policy.js";
import { buildChildEnvironment, loadConfig } from "./config.js";
import { acquireDenoTestEnvironment } from "./environment-profile.js";
import { FunctionsServeManager } from "./functions-serve.js";
import {
  checkDestructive,
  defaultState,
  ensureState,
  isDestructive,
  readState,
  updateStatusBar,
  withAutomationFlags,
  writeState,
} from "./destructive-gate.js";
import { runCommand } from "./tool.js";
import { TypeCaptureManager } from "./type-capture.js";
import type {
  AgentToolResult,
  ApprovalRecord,
  PendingRequest,
  PiContext,
  ResolvedConfig,
  StateFile,
} from "./types.js";

let TypeboxType: typeof import("typebox").Type | undefined;
async function getType() {
  if (!TypeboxType) TypeboxType = (await import("typebox")).Type;
  return TypeboxType;
}

function resolveConfig(ctx: PiContext): ResolvedConfig {
  return loadConfig({
    cwd: ctx.cwd,
    projectTrusted: ctx.isProjectTrusted(),
  });
}

function resolveFromProject(cwd: string, configuredPath: string): string {
  return isAbsolute(configuredPath) ? configuredPath : resolve(cwd, configuredPath);
}

function executionDirectory(ctx: PiContext, config: ResolvedConfig): string {
  const directory = resolveFromProject(ctx.cwd, config.workingDirectory);
  if (!existsSync(directory)) {
    throw new Error(
      `Configured workingDirectory does not exist: ${directory}. ` +
      "Set workingDirectory in supabase-tools.json relative to the Pi project root.",
    );
  }
  if (!statSync(directory).isDirectory()) {
    throw new Error(`Configured workingDirectory is not a directory: ${directory}`);
  }
  return directory;
}

function statePath(ctx: PiContext, config: ResolvedConfig): string {
  return resolveFromProject(ctx.cwd, config.stateFile);
}

function blockedCommandResult(
  args: string[],
  config: ResolvedConfig,
): AgentToolResult | undefined {
  const blocked = findBlockedCommand(args, config.blockedCommands);
  if (!blocked) return undefined;
  const command = args.join(" ");
  return {
    content: [{
      type: "text",
      text: `Supabase CLI command '${command}' is blocked by configuration: ${blocked.reason}\n`,
    }],
    details: {
      action: "blocked_by_configuration",
      command,
      prefix: blocked.prefix,
      reason: blocked.reason,
    },
    isError: true,
  };
}

function approveRequest(
  state: StateFile,
  request: PendingRequest,
): StateFile {
  const approval: ApprovalRecord = {
    id: request.id,
    command: request.command,
    args: request.args,
    approvedTstamp: new Date().toISOString(),
  };
  return {
    ...state,
    pendingRequests: state.pendingRequests.filter((entry) => entry.id !== request.id),
    approvals: [...state.approvals, approval],
  };
}

export default async function supabaseTools(pi: ExtensionAPI) {
  const T = await getType();
  const functionsServeManager = new FunctionsServeManager();
  const typeCaptureManager = new TypeCaptureManager();
  const parameters = T.Object({
    args: T.Array(T.String(), {
      description: "Literal arguments appended to the configured command prefix",
    }),
    timeout: T.Optional(T.Integer({
      minimum: 1,
      description: "Timeout in seconds (default: 120)",
    })),
  });
  const denoTestParameters = T.Object({
    args: T.Array(T.String(), {
      description: "Literal arguments appended to the configured Deno test prefix",
    }),
    environmentProfile: T.Optional(T.String({
      description: "Exact name of a configured Deno test environment profile",
    })),
    timeout: T.Optional(T.Integer({
      minimum: 1,
      description: "Timeout in seconds (default: 120)",
    })),
  });
  const denoCacheParameters = T.Object({
    args: T.Array(T.String(), {
      minItems: 1,
      description: "One or more literal import/cache arguments appended to the configured Deno cache prefix",
    }),
    timeout: T.Optional(T.Integer({
      minimum: 1,
      maximum: 300,
      description: "Timeout in seconds (default: 120; maximum: 300)",
    })),
  });

  pi.registerTool({
    name: "supabase_functions_serve",
    label: "Supabase Functions Serve",
    description:
      "Start, inspect, or stop the session-owned Supabase Edge Functions service using trusted configuration.",
    promptSnippet: "Manage the trusted session-owned Supabase Edge Functions service",
    promptGuidelines: [
      "Use supabase_functions_serve to manage the configured long-lived Edge Functions service; do not use supabase_cli for that lifecycle.",
      "Treat a running result as listener readiness, not proof that any particular function is healthy.",
    ],
    parameters: T.Object({
      action: T.String({
        enum: ["start", "status", "stop"],
        description: "Lifecycle action for the session-owned functions service",
      }),
    }),
    executionMode: "sequential",
    async execute(
      _id: string,
      params: { action: "start" | "status" | "stop" },
      signal: AbortSignal | undefined,
      _onUpdate: ((partialResult: AgentToolResult) => void) | undefined,
      rawContext: unknown,
    ) {
      const ctx = rawContext as PiContext;
      const controller = functionsServeManager.controller(ctx.cwd);
      if (params.action === "status") return controller.status();
      if (params.action === "stop") return controller.stop();
      if (!ctx.isProjectTrusted()) {
        throw new Error("Supabase functions serve startup failed: project_untrusted");
      }
      const config = resolveConfig(ctx);
      if (!config.functionsServe) {
        throw new Error("Supabase functions serve startup failed: not_enabled_by_configuration");
      }
      return controller.start({
        prefix: config.commands.supabaseCli,
        args: config.functionsServe.args,
        cwd: executionDirectory(ctx, config),
        environment: buildChildEnvironment(config),
        timeoutSeconds: config.defaultTimeout,
        blockedCommands: config.blockedCommands,
      }, signal);
    },
  });

  pi.registerTool({
    name: "supabase_types",
    label: "Supabase Types",
    description: "Capture complete local TypeScript generation into one private session-owned artifact (10 MiB maximum), or release it after consumption. No generated source is returned in chat.",
    promptSnippet: "Capture and release complete local Supabase TypeScript generation artifacts",
    promptGuidelines: [
      "Use supabase_types only for trusted-configured local type generation; hand its complete artifact to a filesystem-capable consumer for validation and installation.",
      "Release supabase_types artifacts only after the consumer acknowledges consumption; capture again for a fresh check. Consume before session shutdown or reload.",
      "supabase_types capture success does not mean valid TypeScript or a successful generated-types check.",
    ],
    parameters: T.Object({
      action: T.String({ enum: ["capture", "release"] }),
      artifactId: T.Optional(T.String({ description: "Opaque ID returned by capture, required only for release" })),
    }, { additionalProperties: false }),
    executionMode: "sequential",
    async execute(
      _id: string,
      params: { action: "capture" | "release"; artifactId?: string },
      signal: AbortSignal | undefined,
      _onUpdate: ((partialResult: AgentToolResult) => void) | undefined,
      rawContext: unknown,
    ) {
      // Validate here too: extension hooks may mutate arguments after schema validation.
      if (!params || Object.keys(params).some((key) => key !== "action" && key !== "artifactId")) {
        throw new Error("Supabase types: invalid arguments");
      }
      if (params.action === "release" && typeof params.artifactId === "string") {
        return typeCaptureManager.release(params.artifactId);
      }
      if (params.action !== "capture" || params.artifactId !== undefined) {
        throw new Error("Supabase types: use capture, or release with an artifactId");
      }
      const ctx = rawContext as PiContext;
      if (!ctx.isProjectTrusted()) throw new Error("Supabase types: project_untrusted");
      const config = resolveConfig(ctx);
      if (!config.typeGeneration) throw new Error("Supabase types: not_enabled_by_configuration");
      const args = ["gen", "types", "--local", "--lang", "typescript", "--schema", config.typeGeneration.schemas.join(",")];
      if (findBlockedCommand(args, config.blockedCommands)) {
        throw new Error("Supabase types: blocked_by_configuration (gen types)");
      }
      // This fixed read-only operation is not classified as destructive. Do not add
      // automation/output-format flags: stdout is the raw generated source.
      return typeCaptureManager.capture({
        prefix: config.commands.supabaseCli,
        args,
        cwd: executionDirectory(ctx, config),
        environment: buildChildEnvironment(config),
        timeout: config.defaultTimeout,
      }, signal);
    },
  });

  pi.registerTool({
    name: "supabase_cli",
    label: "Supabase CLI",
    description:
      "Run any Supabase CLI operation through the user-configured command prefix. " +
      "Pass only literal Supabase CLI arguments; no shell syntax is interpreted.",
    promptSnippet: "Run Supabase CLI operations through a configured direct process interface",
    promptGuidelines: [
      "Use supabase_cli instead of requesting unsandboxed Bash for Supabase CLI operations.",
      "Discover unfamiliar Supabase CLI syntax with --help rather than guessing flags.",
      "Run local SQL through `supabase db query --local`; do not search for psql or another direct SQL client.",
      "Treat destructive approval or configured-command refusals as stop conditions.",
    ],
    parameters,
    executionMode: "sequential",
    async execute(
      _id: string,
      params: { args: string[]; timeout?: number },
      signal: AbortSignal | undefined,
      onUpdate: ((partialResult: AgentToolResult) => void) | undefined,
      rawContext: unknown,
    ) {
      const ctx = rawContext as PiContext;
      const config = resolveConfig(ctx);
      const blocked = blockedCommandResult(params.args, config);
      if (blocked) return blocked;

      const effectiveArgs = withAutomationFlags(params.args);
      const gateStatePath = statePath(ctx, config);
      if (isDestructive(effectiveArgs)) {
        ensureState(gateStatePath, config.destructiveDbOps);
      }
      const destructiveRefusal = checkDestructive(effectiveArgs, {
        statePath: gateStatePath,
        commandPrefix: config.commands.supabaseCli,
      });
      if (destructiveRefusal) return destructiveRefusal;

      return runCommand({
        prefix: config.commands.supabaseCli,
        args: effectiveArgs,
        cwd: executionDirectory(ctx, config),
        environment: buildChildEnvironment(config),
        timeout: params.timeout ?? config.defaultTimeout,
      }, { signal, onUpdate });
    },
  });

  pi.registerTool({
    name: "deno_test",
    label: "Deno Test",
    description:
      "Run Edge Function tests through the user-configured fixed `deno test` command prefix. " +
      "Agent arguments cannot increase Deno permissions.",
    promptSnippet: "Run Supabase Edge Function tests through a permission-bounded deno test interface",
    promptGuidelines: [
      "Use deno_test only for Edge Function tests that the Supabase CLI cannot run.",
      "Deno permissions are granted only by trusted supabase-tools.json configuration; do not request permission flags in tool arguments.",
      "Select only a configured environment profile name; never pass raw environment values.",
    ],
    parameters: denoTestParameters,
    executionMode: "sequential",
    async execute(
      _id: string,
      params: { args: string[]; environmentProfile?: string; timeout?: number },
      signal: AbortSignal | undefined,
      onUpdate: ((partialResult: AgentToolResult) => void) | undefined,
      rawContext: unknown,
    ) {
      const ctx = rawContext as PiContext;
      const config = resolveConfig(ctx);
      const permissionArgument = findDenoPermissionArgument(params.args);
      if (permissionArgument) {
        return {
          content: [{
            type: "text",
            text:
              `Deno permission argument '${permissionArgument}' is blocked. ` +
              "Grant required permissions in commands.denoTest within trusted supabase-tools.json configuration.\n",
          }],
          details: {
            action: "deno_permission_blocked",
            argument: permissionArgument,
          },
          isError: true,
        };
      }

      const cwd = executionDirectory(ctx, config);
      const baseEnvironment = buildChildEnvironment(config);
      const acquired = params.environmentProfile === undefined
        ? undefined
        : await acquireDenoTestEnvironment(
          params.environmentProfile,
          config,
          cwd,
          baseEnvironment,
          signal,
        );

      return runCommand({
        prefix: config.commands.denoTest,
        args: params.args,
        cwd,
        environment: acquired?.environment ?? baseEnvironment,
        timeout: params.timeout ?? config.defaultTimeout,
        redactValues: acquired?.redactedValues,
        streamOutput: acquired === undefined,
      }, { signal, onUpdate });
    },
  });

  pi.registerTool({
    name: "deno_cache",
    label: "Deno Cache",
    description:
      "Cache and preflight Deno imports through the user-configured fixed `deno cache` command prefix. " +
      "Agent arguments cannot increase Deno permissions or select another Deno subcommand.",
    promptSnippet: "Cache and preflight Supabase Edge Function imports through a bounded deno cache interface",
    promptGuidelines: [
      "Use deno_cache for import resolution and cache preflight, not for tests or arbitrary Deno commands.",
      "Deno permissions are granted only by trusted supabase-tools.json configuration; do not request permission flags in tool arguments.",
      "Provide at least one import specifier, source file, or cache option; a bare argument separator is refused.",
    ],
    parameters: denoCacheParameters,
    executionMode: "sequential",
    async execute(
      _id: string,
      params: { args: string[]; timeout?: number },
      signal: AbortSignal | undefined,
      onUpdate: ((partialResult: AgentToolResult) => void) | undefined,
      rawContext: unknown,
    ) {
      const ctx = rawContext as PiContext;
      const config = resolveConfig(ctx);
      if (params.args.length === 0 || (params.args.length === 1 && params.args[0] === "--")) {
        return {
          content: [{ type: "text", text: "deno_cache requires a cache target or option; a bare '--' is blocked.\n" }],
          details: { action: "deno_cache_arguments_blocked" },
          isError: true,
        };
      }

      const permissionArgument = findDenoPermissionArgument(params.args);
      if (permissionArgument) {
        return {
          content: [{
            type: "text",
            text:
              `Deno permission argument '${permissionArgument}' is blocked. ` +
              "Grant required permissions in commands.denoCache within trusted supabase-tools.json configuration.\n",
          }],
          details: { action: "deno_permission_blocked", argument: permissionArgument },
          isError: true,
        };
      }

      const timeout = params.timeout ?? config.defaultTimeout;
      if (!Number.isInteger(timeout) || timeout < 1 || timeout > 300) {
        return {
          content: [{ type: "text", text: "deno_cache timeout must be an integer from 1 through 300 seconds.\n" }],
          details: { action: "deno_cache_timeout_blocked" },
          isError: true,
        };
      }

      return runCommand({
        prefix: config.commands.denoCache,
        args: params.args,
        cwd: executionDirectory(ctx, config),
        environment: buildChildEnvironment(config),
        timeout,
      }, { signal, onUpdate });
    },
  });

  pi.registerCommand("destructive-db", {
    description: "Manage destructive database operation mode, approvals, and status",
    handler: async (rawArgs: string, rawContext: unknown) => {
      const ctx = rawContext as PiContext;
      let config: ResolvedConfig;
      try {
        config = resolveConfig(ctx);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        return;
      }

      const gateStatePath = statePath(ctx, config);
      const state = ensureState(gateStatePath, config.destructiveDbOps);
      const args = rawArgs.trim().split(/\s+/).filter(Boolean);
      const subcommand = args[0];

      if (!subcommand || subcommand === "mode") {
        const choice = await ctx.ui.select("Destructive DB Mode", ["ask", "yes", "no"]);
        if (!choice) return;
        const nextState: StateFile = { ...state, mode: choice as "ask" | "yes" | "no" };
        writeState(nextState, gateStatePath);
        updateStatusBar(nextState, ctx.ui);
        return;
      }

      if (subcommand === "yes" || subcommand === "no" || subcommand === "ask") {
        const nextState: StateFile = { ...state, mode: subcommand };
        writeState(nextState, gateStatePath);
        updateStatusBar(nextState, ctx.ui);
        return;
      }

      if (subcommand === "status") {
        const lines = [
          `Mode: ${state.mode}`,
          `Pending requests: ${state.pendingRequests.length}`,
          ...state.pendingRequests.map((request) => `  - [${request.id}] ${request.command}`),
          `Approvals: ${state.approvals.length}`,
          ...state.approvals.map((approval) => `  - [${approval.id}] ${approval.command}`),
        ];
        updateStatusBar(state, ctx.ui);
        ctx.ui.notify(`Destructive DB Status: ${lines.join("\n")}`);
        return;
      }

      if (subcommand === "approve") {
        const requestId = args[1];
        const request = requestId
          ? state.pendingRequests.find((entry) => entry.id === requestId)
          : state.pendingRequests[0];
        if (!request) {
          ctx.ui.notify(
            requestId ? `No pending request with ID '${requestId}'` : "No pending requests to approve",
            requestId ? "error" : "info",
          );
          return;
        }

        const nextState = approveRequest(state, request);
        writeState(nextState, gateStatePath);
        updateStatusBar(nextState, ctx.ui);
        ctx.ui.notify(`Approved: ${request.command}`, "info");
        const message =
          `Approved destructive DB request ${request.id} (${request.command}). ` +
          "Continue by rerunning the approved command now.";
        if (ctx.isIdle && !ctx.isIdle()) {
          pi.sendUserMessage(message, { deliverAs: "followUp" });
        } else {
          pi.sendUserMessage(message);
        }
        return;
      }

      if (subcommand === "clear") {
        const nextState: StateFile = { ...state, pendingRequests: [], approvals: [] };
        writeState(nextState, gateStatePath);
        updateStatusBar(nextState, ctx.ui);
        ctx.ui.notify("All pending requests and approvals cleared", "info");
        return;
      }

      ctx.ui.notify("Usage: /destructive-db [mode|status|approve [id]|clear]");
    },
  });

  pi.on("session_shutdown", async () => {
    // Start both cleanups even if either reports a failure.
    const cleanup = await Promise.allSettled([
      functionsServeManager.shutdown(), typeCaptureManager.shutdown(),
    ]);
    for (const outcome of cleanup) if (outcome.status === "rejected") throw outcome.reason;
  });

  pi.on("session_start", async (_event: unknown, rawContext: unknown) => {
    const ctx = rawContext as PiContext;
    try {
      const config = resolveConfig(ctx);
      const gateStatePath = statePath(ctx, config);
      const state = existsSync(gateStatePath)
        ? readState(gateStatePath)
        : defaultState(config.destructiveDbOps);
      updateStatusBar(state, ctx.ui);
    } catch (error) {
      ctx.ui.setStatus("db-ops", "DB: config error");
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    }
  });
}
