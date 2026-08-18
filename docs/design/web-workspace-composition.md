# Web workspace composition

**Status:** Approved

**Subsystem:** Browser routing, data flow, rendering, responsive layout, and accessibility

**Last verified:** 2026-08-15

**Related documents:** [Initial agent workspace](../product-specs/initial-workspace.md), [initial workspace execution plan](../exec-plans/active/2026-08-15-initial-agent-workspace.md), [live events and idempotency](live-events-and-idempotency.md), and [Parse, Don't Validate](../architecture/data-boundaries.md)

## Decision summary

Use React Router for route-owned project/thread selection, TanStack Query for parsed HTTP server state and invalidation, and a small application-owned live-event reducer for snapshot/stream projections. Do not add a separate global state framework. Use `react-markdown` with raw HTML disabled, `remark-gfm`, a maintained syntax highlighter, and `@xterm/xterm` plus its fit addon.

The browser parses every HTTP response and WebSocket frame with schemas from `@pi-web/contracts`; generated/static TypeScript types alone are not trusted.

## Routing and state ownership

Canonical routes are:

- `/` — project list/empty state;
- `/projects/:projectId` — server-resolved fallback to that project's last-opened thread;
- `/projects/:projectId/new` — route-owned inline new-chat configuration and first prompt; and
- `/projects/:projectId/threads/:threadId` — selected thread.

Route params are parsed before requests. The route is the only selected-thread authority, so separate tabs remain independent. Server metadata stores project expansion and last-opened thread. TanStack Query owns fetch lifecycle for projects, thread snapshots, files, and Git data; mutations use explicit idempotency keys and invalidate/update only related keys.

A per-thread live reducer applies parsed snapshots and epoch/sequence events. It never becomes durable truth and replaces itself on snapshot reset. Transcript pages have one active owner: a bidirectional TanStack window of at most five 100-item pages. Switching threads releases those pages after recording only a transient follow-latest or stable-item/offset/resume-cursor bookmark. React keys use stable message/tool/event IDs, not array positions.

Versioned localStorage is limited to safe device UI preferences and drafts:

- inspector open tab/width and sidebar width;
- collapsed activity/display preferences; and
- unsent composer draft per opaque thread ID.

Malformed or unknown-version local values are discarded explicitly. Project/thread selection, unread state, runs, and transcripts are never sourced from localStorage.

## Component structure

- `app/`: router, providers, and fatal shell errors; there is no authentication/bootstrap boundary.
- `api/`: relative HTTP client, response parsers, error mapping, idempotency helpers, and live client.
- `features/projects`: project tree, server-owned native Browse registration,
  remove/expand/unavailable states. The browser never receives or constructs the
  selected absolute project path.
- `features/threads`: route loader, thread list/rename, bounded transcript page
  ownership, per-thread viewport bookmarks, live following, activity rendering,
  plus the Codex-style project/location/start-state/branch new-chat
  toolbar. Clean worktree is the default; include-local and direct-checkout use
  are explicit and the environment slot is omitted.
- `features/runs`: composer, direct active-run steering, stop, status, trust disclosure, and streaming reducer.
- `features/inspector`: resizable shell and Changes/Files/Terminal tabs.
- `components`: reusable buttons, dialogs, split panes, status icons, error/empty states, and Markdown/code renderer.

Feature components receive DTOs/actions rather than importing transport details directly.

## Rendering and content safety

- `react-markdown` renders Markdown with `remark-gfm`; raw HTML support is not enabled.
- Links allow only explicit safe schemes, external links use safe `rel`, and images/data URLs are disabled unless separately specified.
- Fenced code uses a maintained browser highlighter with language fallback and bounded input. Unknown language renders escaped plain code.
- Command, tool, Git, file, error, and terminal labels are React text nodes, never `dangerouslySetInnerHTML`.
- Terminal escape sequences are handled only by xterm inside the terminal surface, not interpreted as page HTML.

## Layout and responsive behavior

Desktop uses CSS grid with project/thread sidebar, selected-thread center, and inspector. Sidebar/inspector widths are pointer- and keyboard-resizable within documented min/max values. The inspector is collapsed initially unless an inspector target is selected.

Below the approved narrow breakpoint, the center remains primary and sidebar/inspector become modal drawers with focus trapping, Escape close, focus restoration, backdrop semantics, and no hidden focusable content. Composer remains near the viewport bottom without covering transcript content.

The conversation viewport first opens at latest, follows appended and in-place
stream growth only while near that edge, preserves a stable reading anchor after
scroll-away or older-page prepend, and offers a keyboard-accessible Jump to
latest action. The visual baseline is dark, compact, restrained, and honors
`prefers-reduced-motion`. Color tokens are CSS custom properties and status is never conveyed by color alone.

## Accessibility behavior

- Semantic navigation/main/aside regions and heading hierarchy.
- Every running, failed, interrupted, completed, and unread state has visible text/icon plus an accessible name.
- The direct-execution trust disclosure is visible and associated with agent controls.
- Streaming/status updates use restrained live regions; token deltas do not spam announcements.
- Dialogs/drawers manage initial focus, tab containment, Escape, and restoration.
- Resizers support keyboard increments and expose current/min/max values.
- Tool/activity disclosure controls use native button/expanded semantics.

## Test stack and strategy

- Vitest with jsdom for browser tests.
- React Testing Library, `@testing-library/user-event`, and `@testing-library/jest-dom` for behavior.
- `axe-core` integration for focused accessibility regressions, while retaining manual semantics review.
- Playwright for routes, two contexts, responsive drawers, streaming/reconnect, restart, clipboard behavior where supported, and terminal mounting.
- Mock Service Worker is not required initially: component tests inject typed feature clients, while integration/E2E exercise the real Fastify boundary. Add it only if request-level browser tests demonstrate a gap.

Tests query by role/name/state rather than class names or implementation details. Fake timers are limited to deterministic completion flashes/reconnect backoff and are always restored.

## Alternatives considered

- **A single global store for server, route, and stream state:** rejected because it recreates selection conflicts and obscures authoritative ownership.
- **Browser reads native Pi files:** rejected by security and package boundaries.
- **Browser directory input or File System Access picker:** rejected because web
  pickers do not provide the server-visible absolute native path. The
  loopback server instead owns macOS and Windows chooser
  invocation and combines selection with registration.
- **Trust `response.json()` through a TypeScript cast:** rejected; contracts must parse at runtime.
- **Enable raw Markdown HTML then sanitize broadly:** rejected for the initial release; disabling raw HTML is simpler and safer.
- **Build a terminal emulator:** rejected in favor of xterm's maintained terminal behavior.
- **Snapshot-heavy DOM tests:** rejected because they do not prove routing, focus, authorization errors, or interaction semantics.

## Failure and recovery

There is no bootstrap or re-authentication screen. A malformed server response/frame becomes a scoped protocol error and triggers snapshot recovery where possible. Deleted/missing route IDs render not-found/recovery states. Inspector failures do not replace the transcript. A terminal failure leaves Files/Changes usable. Error boundaries are scoped by route/inspector rather than making unrelated projects unavailable.

## Required tests

- Response/frame parser execution, malformed values, stable errors, credential-free initial rendering, idempotent retry, and snapshot reset.
- Project-only fallback, deep-link refresh, deleted/mismatched route IDs, and two independent tabs.
- Add/remove/expand/rename/order/unread/status UI behavior.
- Composer multiline, direct active-run steering, stop, draft restoration, direct-execution disclosure, and streaming de-duplication.
- Markdown XSS/dangerous URL/raw HTML, code fallback, huge bounded output, and disclosure controls.
- Desktop resize bounds/persistence; narrow drawers/focus/Escape/restoration; reduced motion.
- Automated accessibility checks and explicit role/name/live-region/resizer assertions.
- Changes/Files errors and limits, clipboard actions, xterm attach/resize/restart/terminate, and stale terminal recovery.
