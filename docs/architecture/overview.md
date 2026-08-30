# Architecture overview

**Status:** Current

**Subsystem:** Initial local agent workspace

**Last verified:** 2026-08-29

Pi Web Workspace is a local-first React application backed by a loopback-only
Fastify process. The server owns request-integrity policy, SQLite metadata,
local filesystem and Git access, PTYs, runtime coordination, and the Pi SDK
adapter. It intentionally does not authenticate local clients.
The browser receives only parsed DTOs and opaque application identifiers.

## Repository shape

| Area                      | Responsibility                                                                          | Technology                                       |
| ------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `apps/web/`               | Route-owned workspace UI, parsed API clients, Markdown, workspace panel, and terminal   | React, React Router, TanStack Query, xterm, Vite |
| `apps/server/`            | Request policy, metadata, APIs, live events, project coordination, files, Git, and PTYs | Fastify, Drizzle, SQLite, WebSocket, node-pty    |
| `packages/contracts/`     | Executable wire schemas and inferred DTO types                                          | Zod                                              |
| `packages/agent-runtime/` | SDK-neutral persistent-session and run interfaces                                       | TypeScript                                       |
| `packages/pi-adapter/`    | Pi session discovery/opening, transcript translation, and live runtime ownership        | Pi SDK 0.84.2                                    |
| `packages/codex-adapter/` | Codex session discovery/opening, transcript translation, and live runtime ownership     | Codex app-server protocol (Codex CLI 0.149.0)    |

Dependency direction remains:

```text
apps/web -> packages/contracts
apps/server -> packages/contracts + packages/agent-runtime + packages/pi-adapter + packages/codex-adapter
packages/pi-adapter -> packages/agent-runtime + packages/contracts + Pi SDK
packages/codex-adapter -> packages/agent-runtime + packages/contracts + codex app-server
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
thread archive timestamps, while migrations v4-v7 add durable thread-creation
operations, managed worktrees, nullable thread/worktree associations, recovery
identities, transfer tokens, and prompt-dispatch recovery without performing Git
operations. Migration v8 records each thread's immutable agent backend and
widens native-session uniqueness to include that backend. Migration v9 permits
several threads to share one managed worktree, adds durable same-worktree
continuation operations and pending first-prompt titles, and persists the
managed-worktree run lease. Migration v10 extends continuation recovery through
title generation, prompt dispatch, and run attachment so server allocation can
wait for the pending pane's first task.
`MetadataStore` opens
`metadata.sqlite` under `PI_WEB_STATE_DIR` or
`~/.pi/web-workspace`, enables foreign keys and WAL, parses every selected row,
and interrupts unfinished runs during restart reconciliation.

Projects retain a canonical path only in server storage. Removal is a soft
metadata operation and never deletes workspace or native agent files. Threads
point to an opaque runtime session UUID plus an immutable `pi` or `codex`
discriminator; full transcripts stay in each backend's native history.
Archiving an inactive thread is likewise metadata-only: active queries and
unread aggregates exclude it while its thread, run, receipt, and native history
remain retained.

## Runtime and live data flow

`WorkspaceService` resolves project/thread ownership and owns open runtime
instances. `ThreadExecutionContextResolver` constructs the trusted cwd for each
thread from either the registered checkout or a verified managed worktree.
The server holds a `RuntimeRegistry` mapping a thread's persisted `runtime`
discriminator (`pi` | `codex`) to the adapter that runs it, so both backends
coexist in one project and the browser never learns backend internals. A
backend absent from the registry is not installed on this machine, which is an
ordinary recoverable state rather than an error.

`@pi-web/pi-adapter` resolves stored session UUIDs through a fresh Pi listing for
that execution root before opening private native paths. A bounded tool-free Pi
model call may summarize the first prompt for the initial thread/worktree name;
an explicit naming-model override takes precedence, otherwise the call uses the
project's configured default Pi model. Deterministic local naming is the
non-blocking fallback. Prompt preflight acceptance precedes atomic run/receipt
creation. Text-only prompt commands retain their strict JSON representation.
Image-bearing start, continuation, prompt, and steer commands use route-bounded
multipart bodies: the server detects JPEG/PNG/WebP bytes and dimensions, hashes
ordered source content for idempotency, and passes SDK-neutral image input to
the selected adapter. Pi checks model/settings capability, bounds concurrent
worker-backed resizing, and supplies flat multimodal image blocks; native Pi
JSONL remains their durable store. Codex resolves model capability through
app-server, revalidates source bytes, stores private content-addressed files
beneath the configured Codex state root, and supplies ordered `localImage`
items. Only exact thread-owned Codex paths project back to opaque transcript
image references. A thread-level in-process preflight lease and
SQLite partial unique index prevent simultaneous runs in one thread. Threads
that explicitly share one managed worktree through `/new` also share an
in-process preflight lease and persisted running-run constraint; distinct
worktrees and Local checkout threads retain independent concurrency. Shared
sessions use the registered working directory; isolated sessions use their own
worktree. A panel tab and a terminal resolve the same root as the agent
session of the thread the tab was opened against. Project removal first
fences new prompt acceptance, then interrupts or cancels already-started
running and preflight work before soft-removing its metadata.

An idempotent archive command rejects in-process prompt preflight and persisted
running work, atomically updates the project's active-thread fallback, then
releases any inactive open runtime. Archived IDs are rejected by normal
snapshot, prompt, steering, rename, and viewed routes. HTTP snapshots
reconstructed from native history plus run metadata are authoritative, but
carry only a fixed-limit latest transcript page. Opaque runtime-owned cursors
fetch older pages; responses are capped at 100 items with a 1 MiB target, and
one individually schema-bounded oversized item may travel alone. Pi pages are
packed from its SDK projection. Codex pages combine app-server messages with
tool activity read backward from the one confined rollout file named by
`thread/read`; sequential older requests continue the reverse scan, and
private-format failure degrades to message-only pages. `LiveBroker` adds
process-epoch, monotonic sequence events and a bounded replay ring for
Origin-permitted WebSocket subscribers. Browser queries invalidate and replace
the bounded latest snapshot after events or replay gaps; browser stream state is
never durable truth.

## File, Git, and terminal boundaries

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
scope and a bounded replay buffer. (Several terminals per scope is WSP-07 and
is not implemented yet.) Shared threads map to the project scope;
isolated threads map to their worktree scope. The separate terminal WebSocket parses all attach,
input, resize, restart, and terminate frames. PTYs are process-local and are
disposed at shutdown.

## Browser composition

The route is the selected-thread authority:

- `/`
- `/projects/:projectId`
- `/projects/:projectId/new`
- `/projects/:projectId/threads/:threadId`
- `/projects/:projectId/threads/:threadId/new`

TanStack Query owns parsed server state. The project sidebar uses one Browse
control backed by a request-policy-protected browse-and-register mutation;
selected canonical paths never enter browser state or wire responses. New chat
uses an inline project, execution-location, starting-state, and branch toolbar
above the first prompt. In an idle managed-worktree chat, exact `/new` is
consumed by the application after a read-only server preflight and replaces the
invoking pane with a parsed, device-local pending continuation; it creates no
thread or agent session and is never sent to the source backend. Workspace
layout v3 persists that pending source binding and its draft/creation identity.
The first real prompt revalidates the worktree and recovery-safely creates the
titled thread, blank session on the inherited backend, prompt, and run at the
same verified root without copying conversation context. Worktree and clean-start are the safe defaults;
local-change transfer and direct checkout use are explicit. The workspace
renders a nested project and thread sidebar, a bounded Markdown transcript with
an explicit Load earlier action and a five-page/500-row window, direct
active-run steering and stop controls, direct-execution disclosure, the
**workspace panel**, and responsive drawers.

The workspace panel replaces the fixed `Changes | Files | Terminal` inspector
(the term "inspector" is retired). It is a docked column holding a binary
tiling tree of **tab groups**, each with its own tab strip; a tab is a durable
view carrying the `(project, thread, execution scope)` context it was opened
against, so focusing a different chat pane never retargets, reorders, or
closes one. Each tab body is mounted once per TAB rather than per group and is
moved between groups, so a split — or the promotion that follows a group
closing — keeps a running terminal's process and every scroll position. The
panel uses a reduced-motion-aware slide to close and reopen, is resizable with
a pointer or keyboard, and collapses to a docked rail. Its outer docked edge
is the one place in the surface that carries elevation rather than a hairline.
Thread rows expose a hover/focus Archive icon and an
accessible right-click/keyboard Rename and Archive menu. Run and unread signals
sit beside the thread title with icon-only visible presentation and accessible
labels. Local storage is limited to unsent per-thread drafts and the parsed,
device-local panel record: its width, its tree, every group's tab list and
active tab, and each tab's own restorable state.

Every HTTP response and WebSocket frame is parsed with contracts. A composer
accepts up to four bounded JPEG/PNG/WebP images by pane-scoped drop, explicit
clipboard paste, or an accessible file picker; pending files remain page-memory
only and image-bearing commands retain them on failure. Native or adapter-owned
user images project as opaque content-addressed refs and load on demand through
an authorized project/thread route. This typed attachment renderer is separate
from Markdown: raw Markdown HTML and arbitrary Markdown images remain disabled;
terminal escape handling is confined to xterm.
