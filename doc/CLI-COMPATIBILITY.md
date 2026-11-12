# Supabase CLI v2 compatibility evidence

## Scope and provenance

This package keeps the CLI 2.111.0 baseline and adds **source/fixture-based** coverage for
2.122.1's non-experimental Docker stack. These tests run Node child-process stand-ins,
not either CLI binary, Docker, or a database. They do not certify a live upgraded stack,
function health, or actual container/secret-file cleanup.

Upstream source inspected on 2026-11-12:

- [2.111.0](https://github.com/supabase/cli/tree/ae89b16c7e0e472c849d89c947513872b3c537f5), commit `ae89b16c7e0e472c849d89c947513872b3c537f5`.
- [2.122.1](https://github.com/supabase/cli/tree/da77bb42e068f9c6217496b286843591ce850ccf), commit `da77bb42e068f9c6217496b286843591ce850ccf`.

Paths below are relative to `apps/cli/src/` at those immutable revisions.
`src/test/fixtures/cli-v2-contracts.ts` constructs only the relevant output shape;
it is **not a captured transcript**. All credential-like values, project names,
container suffixes and URLs are synthetic. ANSI, timestamp, UTF-8, chunk boundaries,
exit codes and shortened test timeouts are transport/lifecycle stress inputs, not
claims about default upstream formatting or installed service versions.

| Contract | 2.111.0 source | 2.122.1 source | Evidence |
| --- | --- | --- | --- |
| Listener ready | `shared/functions/serve.main.ts`, `GENERIC_FUNCTION_SERVE_MESSAGE` and `onListen` | Same path/symbols | Both emit `Serving functions on http://127.0.0.1:${HOST_PORT}/functions/v1/<function-name>` from the listener callback. Node fixtures exercise split ANSI/UTF-8 text on either stream, stop and restart. |
| Stream forwarding and cleanup | `legacy/commands/functions/serve/serve.handler.ts`; `shared/functions/serve.ts` | `commands/functions/serve/serve.handler.ts`; `shared/functions/serve.ts` | Non-experimental handler uses shared serving; runtime stdout/stderr are forwarded and scoped finalizers remove the runtime and staged artifacts. Tests exercise TERM handling, forced KILL, absent readiness, early exit, abort and shutdown. Real runtime cleanup still needs live verification. |
| Private `status -o env` | `legacy/commands/status/status.handler.ts`; `legacy/shared/legacy-go-output.encoders.ts` | `commands/status/status.handler.ts`; `command-internal/go-output.encoders.ts` | Explicit env output takes precedence over agent JSON. Assignments go to stdout; stopped-service diagnostics go to stderr. Keep strict stdout parsing; do not silently skip malformed assignments or mix streams. |
| New status metadata | Not emitted by this handler | `command-internal/linked-state.ts`, `linkedStateGoFields`; `command-internal/status-values.ts`, `deprecatedStatusFieldWarning` | New linked metadata and `MAILPIT_URL` are ordinary unconfigured assignments; the `INBUCKET_URL` deprecation warning is stderr. Fixtures prove unconfigured values are not injected and diagnostics remain private. |
| Automation/gating | `shared/cli/agent-output.ts` | Same path | `--agent yes` remains recognized. Existing gate tests cover destructive-command recognition and canonicalization; registered-tool tests prove approval is one-shot, `--yes` cannot bypass ask/no, and approved reset receives exactly one automation-flag pair. These are tool-policy regressions, not real reset tests. |

The experimental stack is excluded. In 2.122.1, `commands/functions/serve/serve.handler.ts`
branches to `serve.stack.handler.ts` for that backend. It has different text/stream-json
contracts (`Serving Functions at ...`), and upstream
[#7027](https://github.com/supabase/cli/pull/7027) changes its agent default to stream-json.
That is not a reason to rewrite the non-experimental listener parser. CLI v3, native
runtime, global CLI upgrades and per-worktree stacks are outside this claim.

## Verification and consuming rollout

Run `npm run check` (type-check and complete automated suite). `functions-serve.test.ts`
owns controller transport and lifecycle coverage; `environment-profile.test.ts` owns
strict decoding, acquisition failure/overflow/cancellation; `index.test.ts` exercises
version-grounded status through the registered Deno tool, including redaction of exact
mapped values on successful and failed test execution. Existing destructive gate,
configuration, permissions and output-bound tests remain required.

[DMNG #1467](https://github.com/ikigaido-org/dmng/issues/1467) owns live acceptance after
exclusive shared-stack ownership and data preservation are arranged:

1. Record the exact CLI/package revision and actual service versions; retain non-experimental mode.
2. Start/status/stop and restart the trusted functions lifecycle; exercise startup abort and
   bounded graceful shutdown. Inspect owned runtime/artifact cleanup without exposing secrets.
   `running` is listener readiness only; invoke representative served functions separately.
3. Acquire status values through the private configured profile and verify representative
   Auth, REST/RPC, Storage and Realtime behavior. Do not print status credentials.
4. Verify destructive refusal/approval through the real gate and perform the consuming
   issue's database/reset/convergence/type-generation checks. Fixture passes cannot replace them.

No production implementation changed for issue #6: v0.4.0's runtime remains unchanged,
so this slice does not require a new consumer runtime pin. The evidence is delivered in
its reviewed commit. Type-capture compatibility is separately tracked by
[#8](https://github.com/star26bsd/pi-supabase-tools/issues/8). If distributing a new
version containing both slices, use one cumulative **v0.4.1** release after both merge
and pass verification; do not claim v0.4.0 includes these new tests or that a proposed
release already exists. Any runtime fix discovered in #8 must be included in the
release selected by DMNG before its upgrade.
