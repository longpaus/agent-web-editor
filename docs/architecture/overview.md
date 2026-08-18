# Architecture overview

**Status:** Current

**Subsystem:** Initial local agent workspace

**Last verified:** 2026-08-16

Pi Web Workspace is a local-first React application backed by a loopback-only
Fastify process. The server owns request-integrity policy, SQLite metadata,
local filesystem and Git access, PTYs, runtime coordination, and the Pi SDK
adapter. It intentionally does not authenticate local clients.
The browser receives only parsed DTOs and opaque application identifiers.

## Repository shape

| Area                      | Responsibility                                                                          | Technology                                       |
| ------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `apps/web/`               | Route-owned workspace UI, parsed API clients, Markdown, inspector, and terminal         | React, React Router, TanStack Query, xterm, Vite |
| `apps/server/`            | Request policy, metadata, APIs, live events, project coordination, files, Git, and PTYs | Fastify, Drizzle, SQLite, WebSocket, node-pty    |
| `packages/contracts/`     | Executable wire schemas and inferred DTO types                                          | Zod                                              |
| `packages/agent-runtime/` | SDK-neutral persistent-session and run interfaces                                       | TypeScript                                       |
| `packages/pi-adapter/`    | Pi session discovery/opening, transcript translation, and live runtime ownership        | Pi SDK 0.84.2                                    |

Dependency direction remains:

```text
apps/web -> packages/contracts
apps/server -> packages/contracts + packages/agent-runtime + packages/pi-adapter
packages/pi-adapter -> packages/agent-runtime + packages/contracts + Pi SDK
packages/agent-runtime -> packages/contracts
packages/contracts -> no workspace package
```

## Server composition and startup

`apps/server/src/main.ts` parses configuration, constructs the application, and
is the only module that binds a listener. `buildServer()` remains injectable for
test-owned stores, runtimes, clocks, and PTYs.

The configured host is always `127.0.0.1`. `--port` takes precedence over
`PI_WEB_PORT`, with `3001` as the default. Project registration can invoke an
injectable server-owned native directory chooser: `/usr/bin/osascript` on macOS
or PowerShell with WinForms on Windows. Commands run without a shell, and their
bounded JSON output is parsed into either cancellation or an absolute native
path before existing canonicalization and access checks. Startup prints a plain loopback URL. Product APIs and WebSockets require no
client credential or cookie. Every HTTP request requires an exact configured
Host; mutations additionally require an exact configured browser Origin and
`X-Pi-Web-Request: 1`, while WebSocket upgrades require exact Host and Origin
headers. Any same-machine process can forge these headers and access the server;
that exposure is deliberate under the no-authentication local workflow.

Production serves `apps/web/dist` from the same Fastify origin. Development uses
the loopback Vite server at `PI_WEB_DEV_PORT` (default `5173`) and proxies
relative `/api` HTTP and WebSocket traffic. The root `.env.local` file can retain
local backend, frontend, and state-directory settings.

## Persistence and project organization

`apps/server/src/db/schema.ts` owns the Drizzle relational schema. Committed
migrations create projects, threads, runs, command receipts, and ownership
constraints; migration v2 replaces the original project-wide running-run index
with a partial one-running-run-per-thread index. Migration v3 adds nullable
thread archive timestamps, while migrations v4-v6 add durable thread-creation
operations, managed worktrees, nullable thread/worktree associations, recovery
identities, and transfer tokens without performing Git operations.
`MetadataStore` opens
`metadata.sqlite` under `PI_WEB_STATE_DIR` or
`~/.pi/web-workspace`, enables foreign keys and WAL, parses every selected row,
and interrupts unfinished runs during restart reconciliation.

Projects retain a canonical path only in server storage. Removal is a soft
metadata operation and never deletes workspace or Pi files. Threads point to an
opaque Pi session UUID; full transcripts stay in native Pi JSONL. Archiving an
inactive thread is likewise metadata-only: active queries and unread aggregates
exclude it while its thread, run, receipt, and Pi history remain retained.

## Runtime and live data flow

`WorkspaceService` resolves project/thread ownership and owns open runtime
instances. `ThreadExecutionContextResolver` constructs the trusted cwd for each
thread from either the registered checkout or a verified managed worktree.
`@pi-web/pi-adapter` resolves stored session UUIDs through a fresh Pi listing for
that execution root before opening private native paths. A bounded tool-free Pi
model call may summarize the first prompt for the initial thread/worktree name;
deterministic local naming is the non-blocking fallback. Prompt
preflight acceptance precedes atomic run/receipt creation. A thread-level
in-process preflight lease and SQLite partial unique index prevent simultaneous
runs in one thread while allowing independent Pi sessions in distinct threads
of the same project to run concurrently. Shared sessions use the registered working directory; isolated sessions use
their own worktree. Each thread's inspector and terminal resolve the same root
as its Pi session. Project removal first
fences new prompt acceptance, then interrupts or cancels already-started
running and preflight work before soft-removing its metadata.

An idempotent archive command rejects in-process prompt preflight and persisted
running work, atomically updates the project's active-thread fallback, then
releases any inactive open runtime. Archived IDs are rejected by normal
snapshot, prompt, steering, rename, and viewed routes. HTTP snapshots reconstructed from native history plus run metadata are
authoritative and contain only a count/byte-bounded latest transcript page.
Owned read-only history endpoints serve authenticated opaque older, newer, and
resume cursors; a page-free metadata endpoint updates readers that are away from
latest. Runtime opening is single-flight per thread so concurrent snapshot and
history requests share cursor ownership. `LiveBroker` adds process-epoch,
monotonic sequence events and a
bounded replay ring for Origin-permitted WebSocket subscribers. Browser queries
invalidate and replace snapshots after events or replay gaps; browser stream
state is never durable truth.

## Inspector and terminal boundaries

Thread-view file APIs accept project/thread IDs and strict workspace-relative
paths. Existing targets
are resolved with `realpath` and checked against the canonical root before
opening. Tree/search and preview output is bounded and `.git` is excluded.

Git is spawned directly without a shell and status is parsed from porcelain v2
NUL records. Diffs are bounded and identified as current thread-workspace state.
`GitWorktreeManager` creates app-namespaced branches under the private state
directory, verifies repository/commit identity, and applies an explicitly
reviewed staged/unstaged/untracked snapshot without mutating the source checkout.
Clean creation never transfers source changes.

`ProjectTerminalManager` lazily owns one node-pty process per active execution
scope and a bounded replay buffer. Shared threads map to the project scope;
isolated threads map to their worktree scope. The separate terminal WebSocket parses all attach,
input, resize, restart, and terminate frames. PTYs are process-local and are
disposed at shutdown.

## Browser composition

The route is the selected-thread authority:

- `/`
- `/projects/:projectId`
- `/projects/:projectId/new`
- `/projects/:projectId/threads/:threadId`

TanStack Query owns parsed server state. The project sidebar uses one Browse
control backed by a request-policy-protected browse-and-register mutation;
selected canonical paths never enter browser state or wire responses. New chat
uses an inline project, execution-location, starting-state, and branch toolbar
above the first prompt. Worktree and clean-start are the safe defaults;
local-change transfer and direct checkout use are explicit. The workspace renders a nested project and thread sidebar, a chronological
Markdown transcript with at most five active 100-item pages, direct active-run
steering and stop controls, direct-execution disclosure,
Files/Changes/Terminal inspector, and
responsive drawers. The desktop inspector uses a reduced-motion-aware slide to
close and reopen and can be resized with a pointer or keyboard; a versioned local
preference restores its visibility, selected tab, and width. Thread rows expose a hover/focus Archive icon and an
accessible right-click/keyboard Rename and Archive menu. Run and unread signals
sit beside the thread title with icon-only visible presentation and accessible
labels. Local storage is limited to unsent per-thread drafts and parsed, device-local
inspector layout preferences. Conversation viewport state is transient: each
visited thread keeps only a follow-latest or stable-item/offset/resume-cursor
bookmark in the current tab. The active thread alone owns transcript pages;
stream growth follows near the latest edge, scroll-away preserves the reading
anchor, and Jump to latest replaces the active window authoritatively.

Every HTTP response and WebSocket frame is parsed with contracts. Raw Markdown
HTML and images are disabled; terminal escape handling is confined to xterm.
