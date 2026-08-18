# Scalable conversation history

**Status:** Completed

**Plan version:** 4

**Technical approval:** Approved by the user on 2026-08-16 for plan version 4

**Subsystem:** Shared transcript contracts, Pi history translation, thread snapshots/live refresh, and browser conversation viewport

**Affected paths or contracts:** `packages/contracts/src/**`, `packages/agent-runtime/src/**`, `packages/pi-adapter/src/**`, `apps/server/src/app.ts`, `apps/server/src/domain/**`, `apps/web/src/api/**`, `apps/web/src/components/**`, `apps/web/src/App.tsx`, `apps/web/src/styles.css`, focused tests and current component/design documentation

**Governing specification:** [Scalable conversation history current version 2](../../product-specs/scalable-conversation-history.md)

**Related documents or issue:** [Initial agent workspace](../../product-specs/initial-workspace.md), [architecture overview](../../architecture/overview.md), [web workspace composition](../../design/web-workspace-composition.md), [live events and idempotency](../../design/live-events-and-idempotency.md), [runtime and Pi adapter](../../design/runtime-and-pi-adapter.md), and [Parse, Don't Validate](../../architecture/data-boundaries.md)

**Implementation worktree:** Pi Web Workspace task worktree on `pi/in-this-system-when-the-user-clicks-d95929cd`

**Last updated:** 2026-08-16

## Working specification and approval context

The governing [Scalable conversation history v2](../../product-specs/scalable-conversation-history.md) contract is Current with no open product questions. It extends, but does not replace, the initial workspace's persistent-thread and authoritative-native-history contract. It is independently specified because progressive history navigation and bounded viewport behavior have their own lifecycle, acceptance criteria, failure modes, and reader entry point.

The user explicitly approved product specification version 1 and technical plan version 1 on 2026-08-16. Later review produced material architecture-only plan versions 2 and 3, invalidating the earlier technical approval. The newly requested behavior now restores each thread's prior in-tab reading position instead of always opening a switched thread at latest. That was a material product and technical revision, so all earlier product and technical approvals were invalidated. The user explicitly approved specification version 2 and plan version 4 on 2026-08-16; implementation is now active.

## Purpose and user-visible outcome

A long thread first opens at its latest content without sending or rendering its complete history. Within the current tab, switching back to a thread restores its prior reading anchor, unless it was left following the agent; followed threads reopen at the current latest output. The user can page backward through all retained active-branch history without viewport jumps, return directly to current work, and continue following live output unless they deliberately scroll away. The conversation scrollbar becomes less visually prominent without being hidden.

The implementation bounds browser wire, query-cache, Markdown, layout, and DOM work. Pi JSONL remains authoritative and unchanged.

## Requirement traceability

| Spec requirement                                                                                                                | Technical consequence                                                                                                                                                                                             | Verification                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`SCH-01`](../../product-specs/scalable-conversation-history.md#sch-01--resume-each-thread-at-its-own-reading-position)         | Keep a tiny in-memory follow-or-anchor bookmark per visited thread; include a resumable opaque page cursor so only the active thread owns transcript pages, then restore its stable item and offset before paint. | Component tests for first mount, latest-follow return, older-anchor return after page-cache disposal, stale reset, empty history, and DOM order.                 |
| [`SCH-02`](../../product-specs/scalable-conversation-history.md#sch-02--follow-live-work-without-taking-control-from-the-user)  | Track a near-bottom state, coalesce bounded parsed latest-page refreshes only while following, observe in-place content growth, preserve anchors while away, and expose a return-to-latest control.               | Geometry-controlled component tests for appended and growing pinned updates, scroll-away, distinct following/away live paths, return action, and reduced motion. |
| [`SCH-03`](../../product-specs/scalable-conversation-history.md#sch-03--progressive-access-to-complete-retained-history)        | Add opaque bidirectional transcript cursors, bounded page APIs, explicit older/newer controls, stale-cursor reset, and anchor-preserving prepend.                                                                 | Contract, adapter, server, component, and E2E paging/recovery tests over multi-page and changed-branch fixtures.                                                 |
| [`SCH-04`](../../product-specs/scalable-conversation-history.md#sch-04--bound-browser-work-independently-of-total-chat-length)  | Enforce server-owned item/byte page limits and one transcript-only, five-page contiguous browser working window; avoid a virtualizer unless structural profiling disproves the bound.                             | Deterministic 10,000-item and live-refresh tests asserting page ownership, query-window/DOM-row ceilings, and contiguity plus recorded browser profiling.        |
| [`SCH-05`](../../product-specs/scalable-conversation-history.md#sch-05--preserve-authoritative-live-and-recovery-semantics)     | Keep pages as transient Pi projections, coalesce pinned latest-page or away page-free metadata refreshes, deduplicate by stable item ID, and reset incompatible windows.                                          | Replay/gap/restart tests, append-during-old-page tests, duplicate overlap tests, and native-fixture byte equality.                                               |
| [`SCH-06`](../../product-specs/scalable-conversation-history.md#sch-06--use-a-restrained-but-discoverable-transcript-scrollbar) | Scope thin transparent-track scrollbar CSS to `.transcript` with stronger hover/interaction colors and no smooth scrolling dependency.                                                                            | Browser/manual visual checks in Chromium plus CSS scope assertions and narrow-layout smoke coverage.                                                             |

## Current behavior and affected invariants

The current thread route requests `ThreadSnapshotSchema` version 1. Its `transcript` field accepts up to 100,000 complete items. `WorkspaceService.snapshot()` opens the runtime and requests a complete `RuntimeSnapshot`; `packages/pi-adapter` calls `SessionManager.getBranch()`, translates the complete active path, and returns one array. The browser executes the complete shared parser, filters blank assistant messages, maps every remaining item to React/Markdown/activity DOM, starts at scroll position zero, invalidates the same snapshot after every recognized live frame, and also polls every 15 seconds. TanStack Query can additionally retain complete inactive-thread snapshots until normal query garbage collection, so rapid thread switching can multiply transcript memory.

Existing partial protections are not sufficient for long chats: tool detail bodies mount only when expanded, stable item IDs are React keys, and individual contract fields are bounded, but network, Zod parsing, query memory, Markdown construction, and row count still scale with total transcript length.

The following invariants must remain true:

- Pi native session history is the complete durable transcript source of truth; no full transcript is copied into SQLite or localStorage.
- The displayed transcript is the current active Pi branch in chronological order, including existing tool-call/result pairing and compaction diagnostics.
- Browser routes and opaque application IDs continue to enforce project/thread ownership; no canonical project path or native session path enters browser contracts.
- Snapshot/live state is transient and replaceable after an epoch change, sequence gap, stale cursor, or server restart.
- Markdown remains safe, tool details remain collapsed by default, and status is not conveyed only by color.
- Other scroll surfaces, run coordination, persistence schema, inspector, and terminal behavior are unchanged.

## Scope, non-goals, assumptions, and unresolved technical decisions

### In scope

- A versioned paged transcript wire contract and server-owned page limits.
- An SDK-neutral page request/response contract and Pi-adapter cursor/index ownership.
- A latest transcript page embedded in an authoritative thread snapshot plus page-free run/liveness metadata and read-only history-page endpoints.
- Append-stable, branch-sensitive opaque cursors and safe stale-cursor recovery.
- A bounded bidirectional TanStack Query page window with older/newer controls.
- Latest-edge initial positioning, polite live following, anchor-preserving prepend, and return-to-latest behavior.
- Coalesced ordinary-event refreshes: a bounded parsed latest-page refresh while pinned, and a page-free run/liveness metadata refresh while a reader is away from latest.
- Transcript-only scrollbar styling.
- Contract, adapter, domain, component, structural-performance, and E2E regression coverage.

### Non-goals

- Database schema or metadata migration.
- Full-text history search, browser-side indexing, or rendering unloaded pages for browser Find.
- Pi branch navigation, native compaction changes, native session deletion, or history rewriting.
- Scroll-position synchronization across full reloads, browser restarts, tabs, or devices.
- A custom virtualizer or new virtualization dependency in the first implementation. A bounded page window caps mounted rows without variable-height measurement complexity.
- Eliminating Pi's in-memory `SessionManager` load of its native file. This plan prevents total history from crossing into the browser and avoids repeated unchanged translation; changing Pi's native loading model is outside the adapter's supported API.
- Provider-backed or writable tests against user sessions.

### Assumptions and fixed plan-v4 choices

- Initial and subsequent pages contain at most 100 display items and target at most 1 MiB of serialized UTF-8 item payload. If the next single schema-bounded item exceeds the byte target, it is returned alone so forward progress is guaranteed.
- Only the active thread retains transcript pages, with at most five contiguous pages in its transcript infinite-query cache. On thread exit the browser records a tiny follow-or-anchor bookmark, then cancels and removes that thread's transcript-page query. Previously visited thread count therefore does not multiply transcript payload memory.
- A bookmark is either `following-latest` or a stable item ID, its viewport offset, and the opaque resumable cursor for the page containing it. Bookmarks live in one application-owned in-memory map for the current tab only; scroll events do not write local storage or server state.
- Page items remain chronological. Each page has opaque bounded base64url older, newer, and resumable cursors as applicable; the browser never constructs or interprets their decoded representation.
- The adapter token contains a version, cursor purpose, page boundaries, and active-branch prefix fingerprint plus an HMAC from a runtime-local random key. The key and native session identity are never encoded. Appending to the branch keeps a resume or older cursor valid; changing history at or before its represented page makes it stale, and runtime replacement invalidates prior tokens.
- A stale cursor returns a stable scoped conflict. The browser discards the incompatible page window, gets the latest authoritative snapshot, and announces the reset without guessing.
- Explicit “Load earlier messages” and, when needed, “Load newer messages” controls are preferred over an automatic top sentinel in this revision. They are deterministic, accessible, and avoid accidental request loops during anchor correction. “Jump to latest” resets directly to the current latest page.
- “Near latest” uses a small exported/tested pixel threshold rather than exact equality, accommodating fractional layout and browser rounding.
- A first visit or full tab reload has no bookmark and opens latest. A `following-latest` bookmark also fetches current latest. An anchor bookmark seeds the active page window through its resumable cursor and restores the saved item and offset; a stale cursor or missing anchor atomically resets to latest with a scoped notice.
- No material technical question remains open.

## Technical approach

### Shared contracts and HTTP shape

Introduce a bounded `TranscriptCursorSchema` and `TranscriptPageSchema` in `@pi-web/contracts`. A page contains chronological `items`, nullable `olderCursor` and `newerCursor`, an opaque `resumeCursor`, and `atLatest`. The resume cursor identifies a compatible page without exposing or trusting an item ID supplied by the browser. The client cannot submit a page size or byte limit.

Bump the thread snapshot wire discriminator to version 2 and replace its complete transcript array with a latest `transcriptPage`. At the browser HTTP boundary, parse that response once, split its trusted page-free route/run metadata projection from `transcriptPage`, and transfer the parsed page only into the transcript infinite-query window for initial load, a pinned live refresh, or an authoritative latest reset. The raw snapshot response and any projection containing `TranscriptPage` values are never retained in a TanStack snapshot/metadata query. Browser and server are one deployable and migrate together; version 1 malformed/stale responses fail at the existing browser parser rather than being guessed into v2.

Add a page-free read-only metadata endpoint or query under the owned thread resource for current run, completion, epoch, and new-activity state. Its shared schema must contain no `TranscriptPage` or transcript items. This is the ordinary-event and 15-second fallback refresh path while a reader is away from latest; it reports state without fetching or caching a latest page.

Add a read-only endpoint under the owned thread resource:

```text
GET /api/projects/:projectId/threads/:threadId/transcript?cursor=<opaque>&direction=older|newer|resume
```

The route parses path IDs, strict query shape, cursor syntax/length, and direction before ownership lookup. It returns only a `TranscriptPageSchema`. `resume` returns the compatible page represented by a server-issued resume cursor and is used only to reconstruct transient viewport state after the prior active page window has been released. Missing cursor/direction, mismatched cursor purpose, unknown fields, malformed base64url, stale boundaries, unknown resources, and cross-thread tokens receive stable non-sensitive errors. Cursor semantics are parsed again by the adapter that constructed them.

### SDK-neutral runtime and Pi adapter

Replace the complete-snapshot-only runtime surface with bounded transcript operations:

- `snapshot(pageLimits)` returns the latest page plus SDK-neutral diagnostics;
- `transcriptPage(parsedRequest, pageLimits)` returns an older/newer page or a typed stale-cursor failure.

Limits are trusted server configuration values, not browser input. Fakes implement the same contract and must prove they do not return over-limit arrays.

Inside `packages/pi-adapter`, extract transcript translation into an adapter-owned index that preserves existing entry parsing, item IDs, tool-call/result pairing, active-branch order, diagnostics, and source-entry relationships. `SessionManager.getBranch()` remains the supported source. Cache the parsed translated index while the ordered source path is unchanged; incrementally extend it when the current path is a strict append and rebuild it when the branch diverges. Retain pending tool-call state so an appended result can replace its paired activity without duplication. Dispose the cache with the runtime.

`message_update` is an explicitly mutable exception to the unchanged-order rule. At the Pi-event boundary, parse and normalize each event through the existing adapter-owned event schemas before it can affect transcript state. For the active runtime, retain one bounded typed in-progress projection for the fixed `streaming-assistant` identity. Each successfully parsed update replaces that projection with the newest schema-bounded translated item; it does not mutate or duplicate the authoritative translated native-history index. A malformed update produces the existing typed adapter diagnostic and leaves the prior trusted projection unchanged. Clear the projection on settlement, runtime disposal, authoritative reset, and final persisted-message reconciliation. The completed translated index remains the sole authoritative history projection; this mutable projection is not a second unbounded transcript cache.

Page packing walks the translated index in the requested direction and stops before either the 100-item limit or 1 MiB target, except that one schema-bounded oversized item is allowed alone. Every returned page also receives a resumable page token. A runtime-local cryptographically random key authenticates each cursor's version, purpose, boundaries, and digest of the active source-prefix through those boundaries. The adapter performs strict decode/schema parse, timing-safe HMAC verification, boundary lookup, and prefix verification before returning a trusted page. Runtime replacement intentionally invalidates old cursors. No native path, raw entry, session UUID, or signing key is encoded or returned.

### Server snapshots, live events, and refresh pressure

`WorkspaceService.snapshot()` requests only the latest page and combines it with the existing project/thread/run/capability/epoch metadata. A new history method performs the same project/thread authorization, opens the thread-owned runtime, and delegates the trusted page request. It never marks completion viewed and never writes metadata. Runtime opening is single-flight per thread: callers join one pending-open owner, and only that owner may publish its successfully opened, subscribed runtime. A rejected opening clears only its matching pending entry so a later request can retry. `disposeThread()` and service close cancel a matching pending opening; if it resolves late, it is unsubscribed/disposed instead of being published, and its callers receive the scoped lifecycle failure. This preserves runtime-local cursor validity across concurrent snapshot and history-page requests.

Keep the existing live event broker and authoritative snapshot recovery model. In the browser, parse every frame as today and coalesce ordinary-event refreshes so each mode has at most one in-flight refresh and one trailing refresh for events that arrive during it. Where a live frame carries the typed in-progress transcript projection, parse its envelope first and then parse the payload with `TranscriptItemSchema`; invalid payloads are a scoped protocol failure and never enter transcript state. While pinned, admit only that parsed bounded projection and the parsed bounded authoritative latest snapshot through the transcript-window reducer, then retain near-bottom positioning. The reducer owns the one five-page contiguous transcript window and may replace its single in-progress projection; it never creates a second transcript-page cache owner. While away from latest, it does not change visible rows for a live projection or latest-page refresh: refresh only page-free run/completion metadata, preserve the visible old page window and anchor, and set new activity. The 15-second fallback uses that same page-free metadata query while away from latest. Older page queries are immutable projections and are not refetched on each live event.

An authoritative parsed latest page reconciles final output before rendering: remove or replace the transient `streaming-assistant` projection with its persisted stable item, apply the existing stable-ID deduplication, and never leave both rows visible. A scoped parse or refresh failure preserves the prior bounded window and projection and surfaces the existing recoverable refresh state. Settlement, disposal, and authoritative reset clear the projection as described above.

The pinned latest refresh may admit its parsed page only through the transcript-window reducer. It never creates a second transcript-page cache owner and preserves the five-page contiguous window invariant. When the viewport is not at latest, a live event completes only the page-free current-run/liveness refresh, leaving its rows and anchor unchanged; it never transfers a transcript page until Jump to latest or another stated recovery path. `snapshot_required`, epoch replacement, stale history, and an explicit Jump to latest fetch an authoritative latest snapshot and atomically replace the transcript window with its contiguous latest page.

### Browser page state and rendering

Extract the conversation transcript from `App.tsx` into a focused feature/component with its own tests. Give the application shell a small viewport-bookmark owner keyed by parsed opaque thread ID. Seed a bidirectional `useInfiniteQuery` from either the parsed latest snapshot page or a parsed resume-page response, without caching either page under any other query key; deduplicate overlapping items by stable ID, reject contradictory duplicates, and retain at most five contiguous pages. Latest resets and Jump to latest atomically replace this one window rather than combining old and latest pages. Page eviction must preserve the cursor needed to reload the dropped direction.

On transcript cleanup, synchronously read the viewport once. Save `following-latest` when the viewport is near the edge; otherwise save the topmost visible stable item, its finite offset from the viewport top, and that item's containing page resume cursor. Then cancel and remove the inactive transcript-page query. Do not persist raw scroll pixels, pages, or transcript content. Re-entry uses the bookmark to choose latest or resume as defined above. Updating the bookmark is tied to follow-mode threshold changes, page transitions, and cleanup—not every scroll pixel.

Render no more than the configured five-page/500-item working set plus bounded diagnostics/live projection. Do not add virtualization initially: variable-height Markdown and expandable tool rows make measurement and accessibility more complex, while the page-window ceiling already provides a deterministic DOM bound. Record a decision to revisit only if profiling the bounded fixture still shows unacceptable layout or Markdown cost.

Use `useLayoutEffect`, a transcript element ref, and stable `data-transcript-item-id` row markers for four distinct operations:

1. on first render with no bookmark, or with a `following-latest` bookmark, set `scrollTop` to the latest edge before paint;
2. on re-entry with an anchor bookmark, render its resume page and restore the stable item at the saved viewport offset before paint;
3. while following latest, keep the edge visible after appended or updated content; use a transcript-content `ResizeObserver` and one coalesced animation-frame correction so growth inside the streaming row also follows without layout thrash;
4. when prepending an older page, preserve the visible anchor using a stable item element plus pre/post layout offsets, with scroll-height delta as a tested fallback.

A passive scroll handler updates follow mode. It does not set React state for every pixel; only threshold crossings update visible controls. Programmatic corrections are distinguished from user scroll-away. “Jump to latest” resets the page query to the authoritative latest page, positions the edge, records `following-latest`, and resumes following. Page loading/error/end controls use buttons and restrained status announcements.

### Scrollbar styling

Apply `scrollbar-width`/`scrollbar-color` and WebKit scrollbar pseudo-elements only to `.transcript`. Use a transparent track, thin rounded low-contrast thumb, and stronger hover/active or focus-within thumb. Do not set `display: none`, do not affect code block/inspector/terminal scrollbars, and do not add smooth scrolling. Existing reduced-motion behavior therefore remains valid.

## Implementation milestones

### Milestone 1 — contracts and bounded runtime page model

1. Add failing shared-schema tests for valid latest/older/newer/resume pages, strict cursor-purpose/direction parsing, item and cursor limits, malformed versions, unknown keys, and oversized arrays.
2. Add failing fake-runtime contract tests proving latest and directional pages are bounded and stale cursors are typed failures.
3. Implement snapshot v2, transcript page/cursor schemas, SDK-neutral page types, and fake support.
4. Run contract/runtime typechecks and tests before touching Pi or HTTP composition.

### Milestone 2 — Pi adapter index, paging, and cursors

1. Add controlled v1-v3/branch/compaction/tool fixtures with more than one page.
2. Write red tests for chronological latest pages, older/newer traversal, resume of every page shape, no gaps/duplicates at page boundaries, item/byte packing, one oversized item, tool pair straddling a source boundary, append-stable older/resume cursors, divergent-branch stale cursors, malformed/forged/wrong-purpose tokens, cache reuse, append extension, rebuild, and disposal. Add several same-entry `message_update` fixtures with unchanged branch order proving the newest bounded `streaming-assistant` projection replaces the prior content, malformed events become typed diagnostics, settlement and disposal clear the projection, and final history translation contains no duplicate transient item.
3. Extract the translator/index without changing existing small-session output, then implement packing, opaque cursor construction/parsing, and the adapter-owned mutable streaming projection.
4. Verify native fixture bytes are unchanged and no path/session identifier enters returned DTOs or diagnostics.

### Milestone 3 — server snapshot/history API and refresh behavior

1. Add failing domain and Fastify tests for bounded latest snapshots, directional history, page-free run/liveness metadata, ownership, removed/unavailable threads, malformed query/token, stale conflict, safe errors, and no viewed-state mutation. Use a deferred runtime open to prove concurrent snapshot and history-page requests perform exactly one open and that the snapshot cursor remains accepted by the page request; also prove rejected opens clear their pending entry for retry and disposal/close during an open disposes the late session without publishing it.
2. Implement the version-2 snapshot composition and read-only transcript and page-free metadata endpoints.
3. Add broker/browser-client tests for coalesced ordinary-event refreshes: while pinned, one in-flight bounded latest refresh plus one trailing refresh parses and projects the latest response before reducer admission, and multiple same-entry live payloads parsed with `TranscriptItemSchema` replace the bounded in-progress projection with edge-following. Prove malformed payloads are rejected at the live-client boundary, the projection is cleared on settlement/disposal, an authoritative final snapshot reconciles it without a duplicate row, and the five-page window remains contiguous. While away, one in-flight plus one trailing page-free metadata refresh confirms its parsed shape cannot contain transcript pages and confirms older page keys are not invalidated by token bursts.
4. Run server integration tests using only generated sessions/temp state.

### Milestone 4 — bounded browser history and viewport behavior

1. Extract the transcript component and add geometry-controlled tests before behavior changes.
2. Implement first-open latest positioning, in-tab per-thread follow-or-anchor bookmarks, resume-page restoration, near-bottom following (including in-place streaming growth), scroll-away protection, and return-to-latest.
3. Add the single-active-thread bidirectional five-page query window, explicit older/newer controls, ID deduplication, stale reset, atomic latest-window replacement, anchor-preserving prepend/eviction, and inactive-query disposal.
4. Add scoped thin scrollbar CSS and verify other scroll surfaces retain their styles.
5. Cover loading/error/end announcements, keyboard operation, empty threads, reduced motion, and narrow layouts. For a following latest window, deliver a coalesced ordinary-event burst containing several parsed same-entry live projections and assert newest bounded content and in-place row growth stay visible, one in-flight plus one trailing latest refresh occurs, final snapshot reconciliation has no duplication, and at most five contiguous pages are owned. Switch away and back from both follow and old-reading modes; assert current latest for the former, exact stable-item offset restoration for the latter after inactive-query disposal, and scoped latest reset for a stale bookmark. Mount a contiguous five-page old-history window, deliver a live event through a completed metadata refresh, and assert exactly five cached transcript pages, cursor adjacency/contiguity, unchanged visible rows/anchor, a new-activity indication, and no transcript page or live projection enters metadata-query data. Also assert Jump to latest replaces that window with one contiguous latest window instead of retaining both.

### Milestone 5 — structural performance, E2E, and durable documentation

1. Generate a deterministic 10,000-item mixed transcript without provider credentials or user files.
2. Assert latest/history responses stay within page bounds; only the active thread's transcript infinite-query cache retains transcript pages; that cache never retains more than five contiguous pages; switching across many threads does not retain inactive transcript pages; and the transcript mounts no more than 500 item rows plus bounded controls/diagnostics.
3. Exercise first-open-at-latest, followed-thread return to new latest output, reading-anchor return after cache disposal, multiple older pages, page eviction/reload, live activity while reading old history, jump-to-latest, reconnect reset, and stale paging/restoration recovery in Playwright.
4. Record a Chromium performance profile for initial long-chat open and live update; use it diagnostically, not as a hardware-dependent CI threshold.
5. Update architecture, web/runtime/Pi component guides, and the two affected design documents to describe implemented pagination, cursor recovery, bounded browser state, and remaining native SessionManager limits.
6. Promote the approved specification only after all acceptance evidence passes, complete/archive this plan, and update both indexes.

## Untrusted-data-boundary analysis

| Source and raw representation                         | Entry/read point                                                   | Runtime parser                                                                                                                              | Trusted output and guarantees                                                                                                                                  | Failure behavior                                                                                                      | Boundary tests                                                                                                                                                                                  |
| ----------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Route project/thread IDs and transcript query strings | Fastify history route                                              | shared branded ID, strict older/newer/resume direction, and bounded cursor query schemas                                                    | known query shape for one syntactically valid owned resource request                                                                                           | 400 for malformed; 404 for unknown/cross-owned resource                                                               | missing, duplicate, unknown keys, bad direction, overlong/non-base64 cursor, unknown and cross-thread IDs                                                                                       |
| Opaque cursor text returned later by a browser        | Pi adapter page method after route parsing                         | base64url decoder, versioned internal Zod schema, timing-safe runtime-local HMAC verification, purpose/boundary lookup, prefix verification | cursor was constructed by this runtime for its requested purpose and a still-compatible active-branch page or boundary                                         | typed malformed or stale failure; no index guessing                                                                   | valid older/newer/resume, forged payload/signature, wrong version/runtime/purpose, missing boundary, append, branch divergence                                                                  |
| Native `SessionManager.getBranch()` entries           | Pi adapter index construction/extension                            | existing versioned entry/message/tool parsers plus explicit source-index constructors                                                       | chronological translated active-branch items with stable IDs and source relationships                                                                          | omit malformed supported entries with bounded diagnostic or fail scoped session when identity invariants break        | v1-v3, compaction, branch, custom, malformed, duplicate IDs, tool result before/after page boundary                                                                                             |
| Pi `message_update` event payload                     | Pi adapter runtime event handler                                   | existing adapter-owned event parser, then the existing bounded message/item translators                                                     | one latest bounded typed `streaming-assistant` projection separate from authoritative completed history                                                        | typed adapter diagnostic; preserve prior trusted projection; never cache raw event data                               | repeated same-entry updates with unchanged order, malformed/wrong-type payload, bounded replacement, settlement, disposal, reset, and final persisted-message reconciliation                    |
| Page limits from server composition                   | runtime/adapter call                                               | startup-owned positive integer/byte limit constructors or module constants                                                                  | finite trusted limits unavailable to browser control                                                                                                           | fail startup/test construction; never coerce browser values                                                           | zero, negative, non-integer, excessive config if made configurable; browser cannot override                                                                                                     |
| Adapter-generated transcript page                     | server service boundary                                            | `TranscriptPageSchema.parse` before response                                                                                                | bounded chronological DTO with parsed cursors and item fields                                                                                                  | scoped adapter/protocol failure; do not return partial malformed page                                                 | oversized item arrays, contradictory cursors, duplicate IDs, invalid item, byte packing edge                                                                                                    |
| HTTP snapshot JSON                                    | browser snapshot API client                                        | shared snapshot-v2 schema, followed immediately by a constructor that splits page-free route/run metadata from the parsed latest page       | page-free metadata query data plus one parsed latest page transferred only into the transcript window for initial load, pinned refresh, or authoritative reset | scoped protocol error; preserve the existing transcript window and recover to latest when possible                    | valid, v1/unknown version, malformed cursor/item, oversized arrays, missing fields, pinned-event projection, and no page retained in metadata data                                              |
| HTTP page JSON                                        | browser history API client                                         | shared transcript-page schema                                                                                                               | parsed page admitted only through the contiguous transcript-window reducer                                                                                     | scoped protocol error and recovery to latest when possible                                                            | valid, malformed cursor/item, oversized arrays, missing fields, overlap, and cursor adjacency                                                                                                   |
| HTTP run/liveness metadata JSON                       | browser metadata API client                                        | strict page-free shared metadata schema                                                                                                     | parsed run/completion/epoch/new-activity data with no transcript items or pages                                                                                | scoped protocol error; retain existing transcript window                                                              | valid, malformed/missing/unknown fields, live refresh while reading history, and transcript-page rejection                                                                                      |
| Live WebSocket frames and unknown payload             | browser live client                                                | existing envelope parser, then `TranscriptItemSchema` for the consumed transcript live payload                                              | known epoch/sequence/event category and, only when valid, one bounded typed in-progress projection for reducer admission                                       | ignore malformed envelope per protocol; surface scoped malformed transcript payload; never trust raw payload          | burst, duplicate, malformed envelope/payload, gap, reset, reconnect, pinned updates, away-mode non-interference, and final reconciliation                                                       |
| Browser scroll geometry and transient bookmark        | transcript DOM reads during layout, threshold changes, and cleanup | finite-number normalization, near-edge predicate, stable rendered-item lookup, and application-owned bookmark constructor                   | either `following-latest` or a parsed thread-keyed stable item/finite offset/server-issued resume cursor; no transcript content                                | fall back to latest on missing item, malformed geometry, or stale resume; no persisted or server write effect         | zero-height jsdom, fractional values, negative/NaN test doubles, resize, cleanup, followed return, anchor return, stale cursor, prepended page                                                  |
| TanStack cached pages and live projection             | merge/render boundary after parsed HTTP/live                       | active-thread-only page-window reducer keyed by stable item ID and cursor adjacency; page-free metadata projection constructor              | one contiguous bounded active window of at most five pages plus at most one parsed in-progress projection, with no inactive or second-key transcript pages     | discard/reset incompatible window and surface scoped notice; retain prior active window/projection on refresh failure | overlap, contradictory duplicate, missing adjacency, eviction both directions, repeated following updates, away-mode non-interference, thread cleanup, final reconciliation, and Jump to latest |

No database row, environment variable, filesystem path, or new durable serialization is introduced. Persisted Pi data remains untrusted on every adapter read.

## Touched-legacy-code analysis

- `ThreadSnapshotSchema` v1 and `OpenRuntimeSession.snapshot()` currently imply a complete transcript. Characterize small-session output before replacing them; migrate every fake, adapter, server, and browser caller in one branch rather than adding an unchecked optional second shape.
- `transcriptFromManager()` currently performs full active-branch translation and tool pairing in one pass. Extract that logic under existing fixture tests first. Preserve output IDs/order/diagnostics exactly for histories that fit one page; page boundaries must not duplicate separate tool call and result rows.
- `useLive()` currently validates only the live envelope and invalidates queries for each frame. Preserve authoritative snapshot recovery and sequence ownership while adding coalescing; do not promote unknown payload to transcript truth.
- `Transcript` currently lives in `App.tsx`, renders chronological items directly, and owns no viewport state. Preserve Markdown safety, activity semantics, empty state, stable keys, and project display-path behavior while extracting it. Keep thread bookmarks in one small shell-owned feature store rather than module globals, DOM nodes, TanStack metadata queries, or persisted transcript state.
- The transcript's `overflow: auto` participates in the center flex layout on desktop and narrow screens. Preserve `min-height: 0`, composer visibility, and drawer behavior; style only its scrollbar.
- No public external client compatibility or independent browser/server deployment is promised. Nonetheless, use a snapshot version bump so stale bundles fail explicitly instead of accepting a partially compatible response.

Unrelated App decomposition, global state changes, generic list frameworks, and inspector/terminal styling remain out of scope.

## Verification

Focused red-green commands:

```sh
pnpm vitest run packages/contracts
pnpm vitest run packages/agent-runtime
pnpm vitest run packages/pi-adapter
pnpm vitest run apps/server/src/domain apps/server/src/app.test.ts
pnpm vitest run apps/web
```

The focused Pi-adapter and agent-runtime runs must include the repeated same-entry `message_update`, malformed event payload, settlement, disposal, and final persisted-message reconciliation cases. The server and web runs must include parsed live-payload admission after envelope parsing, multiple following updates, in-place streaming growth, followed-thread and anchor-thread return, inactive-page disposal, five-page contiguous ownership, near-bottom following, away-mode non-interference, stale-bookmark reset, and final-row deduplication.

Package and repository gates:

```sh
pnpm --filter @pi-web/contracts typecheck
pnpm --filter @pi-web/agent-runtime typecheck
pnpm --filter @pi-web/pi-adapter typecheck
pnpm --filter @pi-web/server typecheck
pnpm --filter @pi-web/web typecheck
pnpm check
pnpm test:e2e
```

Recorded browser verification uses the deterministic fake runtime and generated 10,000-item history. It checks desktop and narrow viewports, keyboard controls, first-open latest positioning, followed-thread return to current output, anchor restoration after inactive-page disposal, older/newer paging, live follow/scroll-away, stale reset, active-query and DOM row bounds, and transcript-only scrollbar appearance. No configured `.env` database, user project, native user session, provider credential, or production host is read or written.

## Compatibility, deployment, migration, recovery, and rollback

- Browser/server/contracts deploy together. Snapshot version 2 intentionally rejects a stale version-1 peer with a scoped protocol error; there is no compatibility shim that would restore an unbounded transcript.
- No SQLite migration or native Pi migration occurs. Native JSONL bytes remain unchanged.
- Existing session versions and active-branch semantics remain adapter-owned. Pagination cursors are ephemeral and may be discarded across server restart, runtime replacement, branch divergence, or rollback.
- Paging and resume-cursor failures recover by discarding browser page and bookmark state and obtaining the latest authoritative snapshot. They never delete or rewrite history.
- Rollback restores the version-1 complete-snapshot behavior in code only; no persisted data needs rollback. Because that behavior is the original performance risk, rollback is operationally safe but not a long-chat optimization.
- Deployment does not require restarting or updating the hosted app during implementation. Any later host update must use the dedicated `update-pi-web-host` skill and explicit host state verification.

## Progress

- [x] Inspected the screenshot and current transcript component/styles.
- [x] Read the repository workflow, architecture, product index, active plan, browser/live/runtime designs, component guides, source, contracts, tests, and current snapshot path.
- [x] Confirmed current long-chat work is unbounded across adapter translation, HTTP/browser parsing, query state, and DOM, with only per-item/schema and collapsed-tool-detail protections.
- [x] Read the pinned Pi 0.84.2 SDK/session documentation and `SessionManager` declarations/implementation relevant to active-branch entries and stable IDs.
- [x] Created the isolated `feat/scalable-conversation-history` worktree branch.
- [x] Drafted and indexed specification version 1 and plan version 1.
- [x] Received explicit user approval for scalable conversation history specification version 1 on 2026-08-16.
- [x] Received explicit user approval for scalable conversation history plan version 1 on 2026-08-16.
- [x] Classified the post-approval cache-ownership and live-refresh redesign as material architecture-only work; created plan version 2 in Draft and invalidated version-1 technical approval.
- [x] Classified the mutable `message_update` cache exception, typed live-projection admission, and final reconciliation as a material technical-plan revision; created plan version 3 in Draft and invalidated plan-version-2 technical approval without changing product specification version 1.
- [x] Revised the product behavior to remember a per-thread in-tab follow-or-anchor position while keeping transcript page ownership bounded to the active thread.
- [x] Created Draft specification version 2 and Draft technical plan version 4; earlier product and technical approvals are invalidated.
- [x] Obtained explicit user approval for product specification version 2 and technical plan version 4 on 2026-08-16.
- [x] Implemented versioned bounded page/cursor/snapshot and page-free metadata contracts.
- [x] Implemented adapter paging, authenticated stale-safe cursors, unchanged-history reuse, and one bounded streaming projection.
- [x] Implemented single-flight runtime opening plus snapshot, metadata, and strict history endpoints.
- [x] Implemented the five-page active browser window, transient per-thread bookmarks, resume restoration, live following, scroll-away protection, Jump to latest, and scoped scrollbar styling.
- [x] Added contract, adapter, server, geometry-controlled browser, 10,000-item structural, and Chromium E2E coverage.
- [x] Verified formatting, lint, typecheck, build, 182 unit/integration tests, documentation checks, and two Playwright scenarios.

## Discoveries and blockers

- Pi `SessionManager` loads and owns the native entry tree and exposes stable entry IDs plus `getBranch()`/`getLeafId()`. The supported SDK does not offer backward page reads from disk. This plan therefore bounds all browser work and caches/reuses adapter translation, but does not claim that opening a native session consumes memory independent of native file length.
- The current browser ignores live payload content and invalidates the complete snapshot for every recognized frame. The replacement coalesces a parsed bounded latest-page refresh while pinned and a page-free metadata refresh while away from latest, preserving authoritative recovery without a second transcript reducer or a second transcript-page cache owner.
- Pi emits repeated `message_update` events for the stable `streaming-assistant` item without changing active-branch order. The adapter's unchanged-order cache therefore requires its own parsed, bounded mutable projection that is replaced on each update and reconciled away before a persisted final row renders.
- Item-count limits alone are insufficient because transcript fields are individually large. Page packing therefore uses count and serialized-byte targets with a one-item progress exception.
- Variable-height virtualization is not required to establish a hard DOM ceiling when the browser retains only five pages. Deferring it avoids dynamic measurement, browser-find, focus, and expanded-tool complexity.
- No implementation blocker or unresolved product/technical decision remains. Product specification v2 and technical plan v4 are approved, so implementation may proceed.

## Decision and revision log

- 2026-08-16: Classified long-chat scalability as Plan lane because it changes shared wire/runtime contracts and durable user-visible history behavior.
- 2026-08-16: Created a separate scalable-conversation-history capability rather than revising the still-in-progress initial-workspace proposal; the new capability has an independent lifecycle and governs progressive history navigation/performance.
- 2026-08-16: Chose bounded bidirectional pages and a five-page browser window before virtualization.
- 2026-08-16: Chose explicit page controls for v1 to keep loading and scroll anchoring accessible and deterministic.
- 2026-08-16: Chose adapter-owned append-stable, branch-sensitive opaque cursors and no native-history persistence changes.
- 2026-08-16: Created plan version 1 in Draft; product and technical approvals were pending.
- 2026-08-16: The user explicitly approved product specification version 1 and technical plan version 1; the plan moved to Ready.
- 2026-08-16: After review, classified the cache-ownership and pinned-versus-away live-refresh redesign as material architecture-only work: transcript pages have one owner, the five-page contiguous transcript window; ordinary live refresh parses a bounded latest-page projection while pinned and uses page-free parsed metadata while away, with authoritative latest reset paths replacing that window atomically. Created plan version 2, returned it to Draft, and invalidated version-1 technical approval; product specification version 1 remains approved and this entry does not approve plan version 2.
- 2026-08-16: After review, found that repeated fixed-ID Pi `message_update` events can change streaming content without an append or branch divergence. Created plan version 3 in Draft: the adapter parses and replaces one bounded in-progress projection, the browser parses a transcript payload after its live envelope and admits it only while pinned, and final authoritative history removes or replaces the projection before rendering the persisted row. This is a material technical-plan revision that invalidates plan-version-2 technical approval only; product specification version 1 remains approved and this entry does not approve plan version 3.
- 2026-08-16: The user requested that switching threads restore each thread's last reading position, while threads left following the agent return to the current latest output. Created product specification version 2 and plan version 4 in Draft. Plan v4 adds a transient follow-or-anchor bookmark, resumable page cursors, active-thread-only transcript-page ownership, cache-independent anchor restoration, and streaming-row growth observation. This material product and architecture revision invalidated specification-v1 approval and all earlier technical approvals.
- 2026-08-16: The user explicitly approved product specification version 2 and technical plan version 4 and requested TDD implementation; the plan moved to Active.

## Final outcomes

Completed on 2026-08-16. Thread snapshots now carry only a bounded latest page;
older, newer, and cache-independent resume navigation use runtime-local
authenticated cursors. The browser owns no more than five active pages, releases
inactive transcript queries, and remembers only a transient per-thread
follow-or-anchor bookmark. Fixed-ID live projections update without transcript
refetches, followed content remains at the latest edge, and scroll-away readers
retain their anchor with an accessible Jump to latest action.

A deterministic 10,000-item adapter fixture and Chromium scenario verify a
100-item initial response and 500-row active DOM ceiling. Pi `SessionManager`
still owns and loads the complete native branch, and changed branches rebuild
the adapter translation index; those server-side SDK constraints remain the
explicit residual limitation.
