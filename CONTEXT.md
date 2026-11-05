# Pi Supabase Tools

This context defines the language for granting focused Pi sessions controlled access to Supabase capabilities without granting general shell execution.

## Language

**Supabase session**:
A visible, named Pi session focused on operating and verifying a Supabase project through explicitly granted tools.
_Avoid_: Supabase agent, Supabase worker, subagent

**Local operation**:
An operation whose effects are confined to the local Supabase development stack and local project files; it does not mutate a hosted Supabase project.
_Avoid_: Safe operation, offline operation

**Remote mutation**:
An operation that changes a hosted Supabase project, its data, configuration, secrets, functions, or infrastructure.
_Avoid_: Production operation, deploy command

**Supabase CLI tool**:
The model-facing module that grants a **Supabase session** host execution through a user-configured Supabase CLI command prefix without granting general shell execution.
_Avoid_: Supabase Bash, supabase_bash

**Supabase CLI operation**:
Any invocation provided by the Supabase CLI, passed through the **Supabase CLI tool** as literal arguments. It may be a **local operation** or a **remote mutation**.
_Avoid_: Supabase Bash command, allowed command

**Deno test tool**:
The model-facing module that grants a **Supabase session** host execution through a user-configured, permission-bounded `deno test` command prefix without granting arbitrary Deno or shell execution. It may select a trusted named environment profile, but never accepts raw environment values.
_Avoid_: Deno CLI, verification tool

**Deno cache tool**:
The model-facing module that grants a **Supabase session** focused import and cache preflight through a user-configured, fixed `deno cache` command prefix without granting arbitrary Deno or shell execution.
_Avoid_: Deno CLI, dependency shell

**Functions serve tool**:
The model-facing module that starts, inspects, and stops one trusted-configured, Pi-session-owned `supabase functions serve` process for a project. It reports lifecycle metadata, never service output or function health.
_Avoid_: Functions daemon, service broker, log viewer

**Type capture tool**:
The model-facing module that captures complete raw stdout from a trusted-configured local TypeScript generation into one bounded, private, session-owned file for handoff to a filesystem-capable consumer.
_Avoid_: Generic artifact platform, generator/check runner, npm runner

**Type artifact**:
A complete stdout file identified by an opaque release handle, readable path, byte count and digest. Capture completion does not establish TypeScript validity. The consumer owns validation and installation/checking; the Supabase session releases the file after consumption.
_Avoid_: Validated types, permanent generated file

## Example dialogue

**Developer:** Can the Supabase session reset the local database?

**Maintainer:** Yes. The tool exposes Supabase CLI operations through a fixed executable and literal arguments.

**Developer:** Does it reject remote mutations such as function deployment?

**Maintainer:** No. The Supabase CLI interface remains complete. Whether a remote mutation can succeed depends on the credentials and configuration granted to the Supabase session.

**Developer:** How does the Supabase session run Edge Function tests if the Supabase CLI has no test command for them?

**Maintainer:** It uses the Deno test tool, which exposes `deno test` but not arbitrary Deno commands.
