# Pi adapter

Concrete adapter for `@earendil-works/pi-coding-agent` 0.84.2.

The adapter uses a bounded tool-free lightweight-model request to suggest a
first-prompt title when an authenticated same-provider model is available. It
also discovers sessions for a canonical execution root, returns path-free
session descriptors, resolves stored UUIDs through a fresh authorized listing,
opens/creates native persistent sessions, indexes and reuses unchanged translated active history, incrementally extends
strict appends, rebuilds divergent branches, and serves count/byte-bounded
latest, directional, and
resume pages through runtime-local authenticated opaque cursors, projects one
bounded in-progress assistant update, translates live Pi events into SDK-neutral
DTOs, and owns prompt preflight, steering, abort, and
runtime disposal. New blank sessions are atomically materialized from narrowly
parsed `SessionManager` state because Pi SDK 0.84.2 otherwise delays its first
JSONL write until an assistant message exists.

`PI_CODING_AGENT_DIR`, when set, must be an absolute path. The adapter
normalizes it once during runtime construction; when absent it uses Pi's
`~/.pi/agent` default. Invalid values fail before native session discovery or
opening.

Only this package imports the Pi SDK. Native paths and raw SDK values do not
cross its public contract. Pi's normal resources, project trust, enabled tools,
and direct execution behavior remain authoritative; the application does not
add an approval hook or sandbox.
