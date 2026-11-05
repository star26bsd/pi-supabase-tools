/**
 * Shared types for pi-supabase-tools.
 */

export type DestructiveMode = "ask" | "yes" | "no";

export interface BlockedCommand {
  prefix: string[];
  reason: string;
}

export interface CommandsConfig {
  supabaseCli?: string[];
  denoTest?: string[];
  denoCache?: string[];
}

export interface DenoTestEnvironmentProfile {
  source: "supabaseStatus";
  variables: Record<string, string>;
}

export interface FunctionsServeConfig {
  args: string[];
}

export interface TypeGenerationConfig {
  schemas: string[];
}

export interface SupabaseToolsConfig {
  pathPrepend?: string[];
  environment?: Record<string, string | null>;
  commands?: CommandsConfig;
  workingDirectory?: string;
  destructiveDbOps?: DestructiveMode;
  stateFile?: string;
  blockedCommands?: BlockedCommand[];
  denoTestEnvironmentProfiles?: Record<string, DenoTestEnvironmentProfile>;
  functionsServe?: FunctionsServeConfig;
  typeGeneration?: TypeGenerationConfig;
}

export interface ResolvedConfig {
  pathPrepend: string[];
  environment: Record<string, string | null>;
  commands: {
    supabaseCli: string[];
    denoTest: string[];
    denoCache: string[];
  };
  workingDirectory: string;
  destructiveDbOps: DestructiveMode;
  stateFile: string;
  blockedCommands: BlockedCommand[];
  denoTestEnvironmentProfiles: Record<string, DenoTestEnvironmentProfile>;
  functionsServe?: FunctionsServeConfig;
  typeGeneration?: TypeGenerationConfig;
  defaultTimeout: number;
}

export interface ConfigContext {
  cwd: string;
  projectTrusted: boolean;
  homeDirectory?: string;
}

export interface PendingRequest {
  id: string;
  command: string;
  args: string[];
  createdTstamp: string;
  parentQuestion: string;
}

export interface ApprovalRecord {
  id: string;
  command: string;
  args: string[];
  approvedTstamp: string;
}

export interface StateFile {
  mode: DestructiveMode;
  pendingRequests: PendingRequest[];
  approvals: ApprovalRecord[];
}

export interface AgentToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown> | undefined;
  isError?: boolean;
}

export interface PiUI {
  setStatus: (key: string, text: string | undefined) => void;
  notify: (message: string, level?: "info" | "warning" | "error") => void;
  select: (title: string, options: string[]) => Promise<string | undefined>;
}

export interface PiContext {
  cwd: string;
  ui: PiUI;
  isProjectTrusted: () => boolean;
  isIdle?: () => boolean;
}
