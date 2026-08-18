# Scalable conversation history

**Current version:** 2

**Proposed version:** None

**Proposal status:** None

**Implementation status:** Current

**Product approval:** Not applicable — no proposed revision

**Subsystem:** Conversation history loading, navigation, and viewport behavior

**Last verified:** 2026-08-16

**Related ExecPlans:** [Scalable conversation history](../exec-plans/completed/2026-08-16-scalable-conversation-history.md)

**Related specifications:** [Initial agent workspace](initial-workspace.md)

## Purpose

Long-running agent threads can contain thousands of messages, tool activities,
and large outputs. Opening such a thread must take the user directly to recent
work without transferring, parsing, and mounting the complete history in the
browser. Older retained history must remain reachable without reversing its
chronological or semantic order.

This capability owns conversation-history presentation and navigation as an
independent extension of the initial workspace. Native Pi history remains the
authoritative durable source; this capability does not create another transcript
store or alter native sessions.

## Current contract (v2)

Conversation history is a bounded view over authoritative native Pi history.
The first view opens at latest, in-tab thread switching restores a transient
follow-or-anchor bookmark, older retained history is available through explicit
paging, and only one bounded active transcript window is retained in the
browser.

### SCH-01 — Resume each thread at its own reading position

The first opening or a full browser reload of a non-empty thread places the
conversation viewport at its latest edge before the user has to scroll. When the
user switches between threads within the current browser tab, each thread
instead resumes its own prior viewport state:

- a thread left while following the latest edge reopens at the current latest
  edge, including agent output that arrived while it was not selected; and
- a thread left while reading older content restores the same visible item and
  offset without being moved by newer output.

The remembered state is transient browser UI state, not transcript data. It is
not synchronized across tabs or devices and need not survive closing or fully
reloading the tab. If its history position is no longer compatible with the
active native branch or current server runtime, the application visibly resets
to the authoritative latest edge rather than guessing.

Items remain in chronological document and accessibility order; the application
does not reverse the transcript to produce this behavior. An empty thread
continues to show its empty state.

### SCH-02 — Follow live work without taking control from the user

While the viewport is at or near the latest edge, appended or updated live
content remains visible automatically. This includes growth of an in-progress
agent message, not only insertion of a new row. Once the user scrolls away to
read older content, incoming content must not move that reading position. The
interface then provides a clear, keyboard-accessible way to return to the latest
content; using it resumes live following and updates that thread's remembered
state.

Loading older content, refreshing a background page, receiving live events, and
restoring a remembered thread position must not cause an unrelated viewport
jump.

### SCH-03 — Progressive access to complete retained history

The initial thread view contains a bounded latest page rather than the complete
transcript. If older active-branch history exists, the user can request it in
bounded pages through a clearly labeled control. Prepending a page preserves the
previously visible reading anchor. The UI distinguishes loading, the oldest
available history, and a scoped failure with retry.

All displayable history retained on the current native Pi branch remains
reachable through repeated paging. The browser may evict distant pages to keep
its working set bounded, but it must offer a way to page toward them again or
return directly to the latest edge. Paging never deletes, rewrites, compacts, or
silently marks native history as viewed.

If native branch history changes so that a paging position is no longer valid,
the application must not combine incompatible pages. It visibly resets to an
authoritative latest page and allows the user to resume navigation.

### SCH-04 — Bound browser work independently of total chat length

Initial and live-refresh transcript responses are bounded by both item count and
display payload size. The browser retains and mounts only a bounded contiguous
page window, so the amount of transcript data in query state and the number of
Markdown/activity rows in the DOM do not grow with the thread's total retained
history merely because the thread was opened.

A single schema-bounded item may exceed the normal page target and is returned
alone so paging cannot become stuck. Existing content-safety and per-item bounds
continue to apply. Tool details remain collapsed until requested.

A deterministic 10,000-item mixed-history fixture must demonstrate that initial
wire items, cached transcript pages, and mounted transcript rows stay within the
configured bounds. Wall-clock timings may be recorded during manual profiling,
but hardware-dependent timing thresholds are not a product requirement.

### SCH-05 — Preserve authoritative live and recovery semantics

Pagination is a view over native Pi history, not a new durable source. Stable
item identities prevent duplicates when pages overlap or live snapshots are
retried. Reconnection, an event gap, server restart, or a stale paging position
replaces affected browser projections from authoritative server data without
resubmitting work or duplicating transcript entries.

When the user is reading an older page window, live activity may update a
latest-content indicator without forcing the old window to refetch or move.
Returning to latest obtains the current authoritative latest page.

### SCH-06 — Use a restrained but discoverable transcript scrollbar

Only the conversation viewport receives the subdued scrollbar treatment. Its
track is unobtrusive and its thumb is thinner and lower contrast at rest, while
remaining discoverable through increased contrast on hover or interaction. The
scrollbar is not completely hidden, and code blocks, inspector views, and the
terminal retain their own appropriate scrolling affordances.

## Acceptance criteria

1. First opening or fully reloading a long thread shows its latest content
   without manual scrolling while preserving chronological DOM order.
2. Switching away and back restores that thread's visible item and offset when
   it was left in reading mode; a thread left in follow mode instead shows the
   current latest agent output.
3. Live output and in-place streaming growth follow while the user is near the
   latest edge; scrolling upward prevents subsequent updates from moving the
   viewport, and an accessible return-to-latest control restores following.
4. Requesting an older page preserves the previously visible item and clearly
   reports loading, end-of-history, and retryable failure states.
5. Repeated older/newer paging can reach every displayable item on the active
   native branch without modifying the native session.
6. A stale or branch-incompatible paging or restoration cursor produces a
   scoped latest-edge reset rather than duplicate, missing-without-notice, or
   mixed-branch rows.
7. With a deterministic 10,000-item history, the initial response, active
   browser page window, and mounted transcript rows remain within documented
   implementation bounds independent of the total item count and previously
   visited thread count.
8. Live updates and reconnect recovery refresh only the bounded latest
   projection and do not repeatedly transfer the complete retained history.
9. The transcript scrollbar is visually quieter at rest and remains visible on
   hover or interaction on supported browsers; other scroll surfaces are
   unchanged.
10. Malformed, oversized, stale, unknown-thread, and cross-thread paging or
    restoration values fail through parsed boundaries with safe scoped errors
    and no native path or session identifier disclosure.

## Non-goals

- Reversing transcript or accessibility order
- Full-history search or browser Find support for unloaded pages
- Remembering an exact transcript scroll position across full tab reloads,
  browser restarts, tabs, or devices
- Pi session-tree navigation or displaying abandoned branches
- Copying the complete transcript into application metadata or browser storage
- Changing Pi compaction, retention, deletion, or native JSONL formats
- Removing existing per-item content limits or eagerly expanding large tool details
- A generic virtual-list framework when bounded pages satisfy the measured DOM limit
- A hardware-specific startup-time guarantee

## Open product questions

None. The current behavior uses a transient per-thread follow-or-anchor
bookmark, a bounded latest page, explicit progressive history controls, one
bounded active browser page window, polite live following, and a visible
return-to-latest action.
