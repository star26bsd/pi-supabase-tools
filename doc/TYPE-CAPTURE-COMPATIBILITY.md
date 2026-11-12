# Type capture: CLI 2.111.0 and 2.122.1

## Claim and evidence boundary

`supabase_types` transports complete raw TypeScript stdout. It does not parse schemas,
validate TypeScript, strip diagnostics, format source, or compare a consumer's files.
The new tests exercise **constructed version-grounded output** through the registered
tool and a disposable filesystem consumer. They do not run either CLI binary, access
Docker/a database, or establish live compatibility with DMNG's actual schema.

Both CLI versions remain supported by the unchanged capture implementation. In
particular, `ComputedFields` is ordinary source text: no new tool parameter, parser,
permission, or output rewrite is needed.

## Upstream provenance (inspected 2026-11-12)

### CLI 2.111.0

CLI commit [`ae89b16c7e0e472c849d89c947513872b3c537f5`](https://github.com/supabase/cli/tree/ae89b16c7e0e472c849d89c947513872b3c537f5):

- [`apps/cli/src/legacy/commands/gen/types/types.handler.ts`](https://github.com/supabase/cli/blob/ae89b16c7e0e472c849d89c947513872b3c537f5/apps/cli/src/legacy/commands/gen/types/types.handler.ts): local generation runs pg-meta, forwarding stdout/stderr separately. `Connecting to ...` is stderr. Linked metadata can select a different pg-meta image; do not infer every local installation's output from the default catalog.
- [`apps/cli-go/pkg/config/templates/Dockerfile`](https://github.com/supabase/cli/blob/ae89b16c7e0e472c849d89c947513872b3c537f5/apps/cli-go/pkg/config/templates/Dockerfile): default pg-meta image is `supabase/postgres-meta:v0.96.6`.
- That pg-meta tag resolves to [`f21a4da30484c6146a6ac4a3f260d992e7330bf1`](https://github.com/supabase/postgres-meta/blob/f21a4da30484c6146a6ac4a3f260d992e7330bf1/src/server/templates/typescript.ts). Its TypeScript template emits `Json`, `Database`, table/view `Row`, write shapes, relationships and function args; it has no `ComputedFields` member.

### CLI 2.122.1

CLI commit [`da77bb42e068f9c6217496b286843591ce850ccf`](https://github.com/supabase/cli/tree/da77bb42e068f9c6217496b286843591ce850ccf):

- [`apps/cli/src/commands/gen/types/types.handler.ts`](https://github.com/supabase/cli/blob/da77bb42e068f9c6217496b286843591ce850ccf/apps/cli/src/commands/gen/types/types.handler.ts), `runGenerate`: in-process generation writes types with `output.raw(types)`; connection and `Generated TypeScript is unformatted. Format it with: ...` diagnostics go to stderr.
- [`apps/cli/package.json`](https://github.com/supabase/cli/blob/da77bb42e068f9c6217496b286843591ce850ccf/apps/cli/package.json) pins `@supabase/typegen` **0.3.1**. CLI 2.120.0 introduced `ComputedFields` with typegen 0.2.2, but that is not the dependency version shipped in 2.122.1.
- The npm 0.3.1 package's `gitHead` is SDK commit [`c44ee0bd587a55477257fe6d0e926aefca829742`](https://github.com/supabase/sdk/tree/c44ee0bd587a55477257fe6d0e926aefca829742). Its [`packages/postgrest-typegen/src/generation/typescript.ts`](https://github.com/supabase/sdk/blob/c44ee0bd587a55477257fe6d0e926aefca829742/packages/postgrest-typegen/src/generation/typescript.ts) and [parity output](https://github.com/supabase/sdk/blob/c44ee0bd587a55477257fe6d0e926aefca829742/packages/postgrest-typegen/test/parity/expected/typescript.txt) establish table/view `ComputedFields` (`never` or a field-name union), and named relation-row arguments using `Omit<Row, ComputedFields>`.

## Constructed fixtures and regressions

`src/test/fixtures/types-2.111.0.txt` and `types-2.122.1.txt` are small, hand-constructed
TypeScript schema excerpts informed by those templates, **not captured generator output
or complete upstream golden files**. They use synthetic `api.contacts`, a read-only
view, a named row argument, and a Unicode identifier. The newer excerpt includes both
nonempty and `never` computed-field cases. They omit unrelated generated helpers and
use compact formatting. The test adds an extra terminal LF and splits Unicode bytes to
stress byte preservation, not to assert exact upstream formatting.

`src/test/types-tool.test.ts` runs each excerpt through the real registered tool with a
Node producer using the fixed trusted generation arguments. The producer supplies
representative stderr diagnostics plus a synthetic private sentinel. The test asserts:

- Exact raw bytes, byte count and SHA-256, including split UTF-8 and terminal LF.
- Only compact artifact metadata is returned; no source/diagnostic content or updates.
- Capture A → TypeScript compiler validation and atomic disposable-target installation
  → acknowledgement/release → fresh B → equal non-writing comparison → release.
- Fresh C contains changed valid source; comparison fails without changing the installed
  target, and C is released after consumption. A new invocation marker and unique IDs
  prove B/C are fresh executions, not rechecks of A.
- Invalid source can still be completely captured. The consumer rejects it before
  replacing the target, then acknowledges consumption and releases it. `complete: true`
  is never interpreted as validity.

The consumer is a test-only helper, not a new package API or a copy/import of DMNG's
generator. TypeScript is already a development dependency. No database or production
configuration/data changes are required, and there is no application copy/i18n impact.
Existing `type-capture.test.ts` and registered-tool tests remain responsible for generic
10 MiB bounds, authority, failures, cancellation, process settlement and cleanup; this
slice does not duplicate their full matrix.

Run `npm run check` for type-check plus the complete suite. Tests have no network,
Supabase CLI, Deno, or shared-stack prerequisites.

## Live acceptance and release coordination

[DMNG #1467](https://github.com/ikigaido-org/dmng/issues/1467) must still execute real
2.122.1 local generation through trusted `supabase_types`, hand off its complete artifact
to DMNG's existing `generate-api-types.mjs --input` consumer, validate/install, acknowledge
and release, then capture **again** for the non-writing check and release after consumption.
Review actual `ComputedFields`/other generator churn, run generator tests, generated-types
comparison, frontend type-check and relevant tests. Verify cleanup even after a failed
consumer check. Do not print credentials or claim fixtures establish live generation.

This slice changes tests/documentation only: **no runtime fix or new runtime pin is
required relative to v0.4.0**. Issue [#6](https://github.com/star26bsd/pi-supabase-tools/issues/6)
independently owns serving/status/gating compatibility. If publishing the cumulative
compatibility evidence, release **v0.4.1 only after both slices merge and pass combined
verification**, and give DMNG that actual tag/revision; a planned tag is not a release.
The consuming CLI upgrade waits for both issues' evidence and its own live gate. CLI v3,
experimental/native stack modes and global CLI upgrades remain out of scope.
