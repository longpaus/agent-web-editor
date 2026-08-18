# Live events and idempotency

**Status:** Approved

**Subsystem:** Browser commands, authoritative snapshots, streaming, and reconnection

**Last verified:** 2026-08-15

**Related documents:** [Initial agent workspace](../product-specs/initial-workspace.md), [initial workspace execution plan](../exec-plans/active/2026-08-15-initial-agent-workspace.md), and [Parse, Don't Validate](../architecture/data-boundaries.md)

## Decision summary

Use credential-free JSON HTTP endpoints for snapshots and commands and one credential-free WebSocket for live thread subscriptions. Exact Host checks apply to HTTP; browser mutations and WebSocket upgrades retain the configured Origin/CSRF policy. Terminal traffic uses a separate WebSocket and protocol. Every mutation carries a database-backed idempotency key. Live thread events have an in-memory epoch and monotonic sequence; reconnect either replays a bounded contiguous suffix or instructs the browser to replace state from an authoritative snapshot.

Live events are not durable transcript storage. Pi history plus application metadata reconstructs the truth.

## Command protocol and idempotency

- Prompt, steer, stop, viewed, rename, and project/thread mutations are HTTP commands with Zod-parsed bodies.
- The browser generates a UUID idempotency key per user action and reuses it on transport retry.
- The server hashes the parsed canonical operation and stores the key, operation, hash, and accepted result reference in `command_receipts` transactionally with the mutation.
- Same key and same hash returns the prior response. Same key with another operation/payload returns 409. Concurrent requests serialize on the unique key.
- A transport timeout never tells the browser to mint a replacement key; it queries/retries the original.

For a prompt, the coordinator reserves the key while Pi preflight runs, buffers events, and finalizes the receipt/run only on acceptance. Rejection records a rejected outcome or clears the short reservation according to the persistence implementation, but can never leave an executable prompt with no durable identity.

## Snapshot and event shapes

A thread snapshot contains:

- thread/project display metadata and capabilities;
- a parsed count/byte-bounded latest native transcript page and current bounded
  streaming projection;
- current and last run records;
- unread/viewed metadata;
- `epoch` and `highWaterSequence`; and
- scoped unavailable/corrupt diagnostics.

Each live event contains `version`, `threadId`, `epoch`, positive integer `sequence`, event ID, event type, and parsed payload. Event types are application-owned and discriminated; SDK event names are not the wire contract.

## Subscription race and replay

Each live thread coordinator is an actor/serialized queue:

1. Apply the WebSocket Host/Origin policy and parse a subscribe command.
2. Add the connection as paused so newly emitted events are buffered for it.
3. In the same coordinator queue, capture the adapter/application snapshot and current high-water sequence.
4. Send the snapshot, then buffered events with a greater sequence, then mark the subscriber live.

The coordinator keeps a bounded ring buffer per active thread (recommended maximum: 1,000 events and 1 MiB, whichever comes first). A client reconnecting with matching epoch and a contiguous available cursor receives replay. A different epoch, future cursor, expired gap, or server restart receives `snapshot_required`; the client obtains/replaces with a fresh snapshot.

Duplicate events are harmless: the browser reducer keys by epoch/sequence and stable message/tool IDs. Out-of-order or gapped events trigger a snapshot rather than speculative reordering.

## Backpressure and lifecycle

- WebSocket frames have fixed byte limits and parsed protocol versions.
- Heartbeats detect dead peers. A slow client is disconnected once its bounded send queue is exceeded; agent execution continues.
- Subscription does not own runtime lifetime. Closing a tab does not stop a run.
- The server unsubscribes/disposes listeners on thread runtime replacement and shutdown.
- Reopening after restart gets a new epoch and a reconstructed snapshot.

## Browser behavior

- Route selection determines which thread snapshot is displayed; each tab owns its route and subscription.
- Query/cache state is transient. Only the active thread retains a contiguous
  five-page transcript window. Inactive visited threads retain a tiny
  follow-or-anchor bookmark, not transcript pages; durable selection fallback
  comes from server project metadata.
- Streaming projections update and follow the viewport only near latest. While
  reading older history, page-free run metadata refreshes and incoming content
  does not move the anchor. Snapshot refreshes are coalesced and fixed-ID stream
  updates do not trigger full transcript refetches.
- Submitting from an active thread steers its current run immediately. Text left unsent remains a versioned local draft; there is no wait mode, hidden durable queue, or Pi follow-up queue.
- Opening a completed result sends an idempotent viewed command only after that result is rendered as the selected thread. A completion that arrives while already selected is acknowledged without durable unread.

## Alternatives considered

- **SSE only:** simple receive path, but terminal still needs WebSocket and a thread WebSocket gives explicit parsed subscribe/replay control.
- **All commands over WebSocket:** rejected because HTTP idempotency, status handling, injection tests, and request limits are clearer for mutations.
- **Persist every stream delta:** rejected because the application database must not duplicate Pi history and partial deltas are not authoritative history.
- **Trust browser transcript/reducer state:** rejected on reconnect/restart.
- **Unbounded replay:** rejected for memory and slow-client safety.
- **Durable queued “wait” prompts:** not required by the specification and would add unnecessary cancellation and restart semantics.

## Failure and recovery

Malformed frames close the subscription with a stable protocol error. An
expired event cursor or stale authenticated history/resume cursor resets from a
bounded latest snapshot. Snapshot failure is scoped to its thread and displayed; no partial browser cache is promoted to authoritative. Duplicate command retries return stored outcomes. Restart changes epochs, interrupts non-reconnectable runs, and reconstructs without resubmitting prompts.

## Required tests

- Receipt retry, conflicting reuse, concurrent duplicate, process restart, and timeout-after-acceptance.
- Prompt preflight buffering and receipt/run atomicity.
- Subscribe/snapshot race, event during snapshot, monotonic sequence, duplicate/out-of-order/gap, matching/different epoch, ring overflow, and runtime replacement.
- Slow consumer, heartbeat, malformed/oversized frame, unpermitted Origin or unknown-thread subscription, and listener cleanup.
- Reducer idempotency when snapshot/replay is applied twice.
- Two independent browser contexts, reconnect during streaming/completion, already-viewing completion, direct active-run steering, and local draft behavior.
