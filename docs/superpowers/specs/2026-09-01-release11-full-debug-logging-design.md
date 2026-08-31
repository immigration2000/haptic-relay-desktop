# Release 11 Always-On Full Debug Logging Design

## Goal

Make Release 11 capture the complete local hardware/relay diagnostic timeline, including every 30 Hz motion sample, so an intermittent disconnect can be reconstructed from one exported JSON log.

## Scope

- Bump the desktop package from Demo 10 to Demo 11.
- Keep diagnostic capture always enabled; do not add a user-facing debug toggle.
- Persist every diagnostic event emitted by the main process and every hardware motion sample without the current one-second aggregation.
- Preserve the existing in-memory UI log limit and sensitive-data allowlist.
- Keep diagnostics local to the desktop; no upload or relay-server forwarding is added.
- Keep motion, emergency-stop, disconnect, and shutdown sequencing independent of logging success.

## Record Contract

The JSONL envelope remains `{ schemaVersion, timestamp, sessionId, level, source, event, data }`, but the diagnostic format advances from schema `1` to schema `2` because motion records are now individual samples.

Each hardware motion attempt is written as one `hardware-motion-sample` record with:

- `outcome`: `completed`, `dropped`, or `failed`;
- normalized `position` and `intensity` when available;
- the exact trimmed T-Code `command` when a serial write was attempted;
- write `durationMs` when available;
- a bounded `reason` and `timeout` flag when it failed or was dropped.

Non-motion diagnostic events (profile, probe, test, stop, port state, serial errors, relay lifecycle, settings, and application events) remain individual records. Persistent records are not deduplicated by the UI's one-second `addLog` suppression. The in-memory UI list stays bounded at its existing size.

## Storage and Rotation

Release 11 defaults are `16 MiB` per file and `16` total files, including the active file, for a maximum of `256 MiB` per desktop profile. Rotation is atomic and line-aware using the existing generation scheme (`haptic-relay.jsonl` plus `.1` through `.15`). A single record larger than the file limit is still written as one complete line after rotation.

The metadata returned by the existing export path reports schema `2`, `16 MiB`, and `16` files. Existing schema-1 files are not rewritten or uploaded; they remain readable as historical local artifacts.

## Complete Event Routing

`routeHardwareDiagnostic` sends each hardware sample directly to a new unaggregated store method. It must not call the old summary bucket. The store also receives a sanitized `app-log` record for every `addLog` invocation after initialization, including relay and protection lifecycle messages. The original structured hardware diagnostic record remains the source of exact command/timing fields.

To avoid recursion, diagnostic-store failures are reported to stderr and at most one in-memory `persistent-log-disabled` entry; that failure entry is not written back into the disabled store. Logging is observational and never blocks serial writes, safety stops, room exit, or application shutdown. Shutdown still performs the existing bounded flush.

## Privacy and Safety

- The existing `DIAGNOSTIC_DATA_FIELDS` allowlist remains authoritative and is extended only for the explicit sanitized `details` field used by app-log records.
- Passwords, tokens, authorization headers, cookies, URL query strings, and arbitrary renderer payloads are never persisted.
- Exact commands and normalized motion values are local diagnostics, not device acknowledgements; the UI wording remains unchanged.
- The 30 Hz latest-value queue and all hardware safety gates remain unchanged.
- Rotation bounds are enforced before every append, so repeated motion cannot grow storage without limit.

## Export and User Workflow

The existing **로그 → 내보내기** action continues to export the bounded in-memory entries plus diagnostic metadata. It does not copy the entire rotated JSONL set into the export file, preventing an accidental multi-hundred-megabyte export. The UI export remains a compact incident summary; the raw files under Electron `userData/logs` are the complete trace to attach for debugging.

## Verification

Automated tests cover:

- one raw motion record per completed, dropped, and failed sample;
- no summary aggregation or sample loss across second boundaries;
- app/relay/protection log routing without duplicate recursion;
- exact command, timestamp, duration, outcome, and reason fields;
- schema-2 metadata and `16 × 16 MiB` default rotation bounds;
- complete JSON lines and correct generation ordering during rotation;
- logging failure disabling only persistence while motion/safety calls continue;
- shutdown flush persisting the final sample before `session-ended`;
- sensitive-data filtering and unchanged export payload shape;
- package version `0.1.1-demo.11` and all existing motion, hardware, security, and UI gates.

Release acceptance first reproduces the disconnect with no person or load in the mechanism, the power switch reachable, and the known COM port. The tester records the exact time of the rapid `0% ↔ 100%` intensity-100 movement, then sends the raw rotated JSONL files and the compact exported JSON. No automatic upload is performed.

## Rejected Alternatives

- **Keep one-second motion summaries:** rejected because the exact last command and timing needed to explain an intermittent COM disconnect are lost.
- **Upload diagnostics to AWS automatically:** rejected because it expands privacy and operational scope; logs remain local and user-exported.
- **Unlimited files or no rotation:** rejected because 30 Hz capture would eventually exhaust the user's disk.
- **Capture arbitrary renderer/console data:** rejected because it can include credentials or unrelated personal content; the existing main-process allowlist is safer.
