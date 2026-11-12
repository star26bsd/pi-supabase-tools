# Future Work

This file records deferred candidates, not commitments for the first usable `pi-supabase-tools` release.

## Package distribution

- Publish `pi-supabase-tools` to npm.
- Add the `pi-package` keyword for automatic inclusion in the Pi package gallery.
- Retain GitHub/git installation as an alternative.
- Add optional gallery image or video metadata.

## Pi package conformance

- Move Pi-provided imports such as `typebox` and `@earendil-works/pi-coding-agent` to `peerDependencies` as required by Pi package guidance.
- Audit tool errors against Pi's throw-to-signal-error contract.
- Audit timeout and cancellation handling for complete process-tree cleanup on every supported platform.
- Validate interactive, print, JSON, and RPC mode behavior.

## Functions service recovery

- Recovery after SIGKILL, host failure, or power loss is deliberately deferred; do not add PID files, process discovery, external adoption, locks, leases, or cross-session coordination without a separately designed ownership model.
- Reverify live listener readiness and real runtime/artifact cleanup when upgrading the consuming CLI/stack. [2.111.0/2.122.1 source and fixture evidence](CLI-COMPATIBILITY.md) does not replace that integration gate.

## Distribution verification

- Add clean-install smoke tests for npm and git package sources.
- Add macOS, Linux, and WSL2 verification coverage.
- Document the process for renaming or transferring the GitHub repository.
