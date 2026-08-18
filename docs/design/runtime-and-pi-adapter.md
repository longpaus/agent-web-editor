# Runtime and Pi adapter

**Status:** Approved

**Subsystem:** Agent runtime abstraction, Pi sessions, runs, tools, and trust

**Last verified:** 2026-08-16

**Related documents:** [Initial agent workspace](../product-specs/initial-workspace.md), [initial workspace execution plan](../exec-plans/active/2026-08-15-initial-agent-workspace.md), and [Parse, Don't Validate](../architecture/data-boundaries.md)

## Decision summary

Match Pi's current direct-execution behavior. The initial web workspace does not add command approval cards, policy classification, approval state, or a blocking tool hook. Pi's enabled tools execute immediately with the server user's normal permissions, and Pi's native project-trust behavior governs project-local resources. The browser prominently states that execution is not sandboxed.

The server owns live SDK-neutral runtimes while `packages/pi-adapter` exclusively owns Pi SDK objects. Application threads store a Pi session UUID; the adapter resolves it against the authorized project and keeps native session paths server-private.

## SDK-neutral contract

`packages/agent-runtime` defines:

- discover/create/open persistent sessions by opaque runtime-session ID;
- obtain an authoritative SDK-neutral bounded latest transcript page and
  authenticated directional/resume pages;
- submit a prompt with distinct preflight acceptance and eventual settlement;
- steer an active run, stop it, and dispose runtime ownership;
- subscribe to normalized message/tool/lifecycle events; and
- return typed unavailable, malformed, unauthorized, busy, rejected, provider, tool, and interrupted failures.

No Pi class, event, content block, path, or generic SDK type crosses the adapter boundary. The interface should remain extensible through new versions, but it does not include speculative approval or reviewer-agent methods.

## Pi sessions and import

- New threads use `SessionManager.create(canonicalProjectPath)` and record the resulting Pi session UUID. Pi SDK 0.84.2 normally defers its first JSONL write until an assistant message exists, so the adapter validates the new manager's public header, initial session-info entry, UUID, cwd, and target path, then atomically materializes that initial JSONL with exclusive creation. This makes an unprompted application thread reopenable after a server restart without overwriting an existing native session.
- Discovery uses `SessionManager.list(canonicalProjectPath)`. The adapter parses descriptors, confirms cwd ownership, and omits native paths from returned DTOs.
- Opening resolves the stored UUID against a fresh authorized listing before passing the private path to Pi.
- Import adds application metadata pointing to that UUID without opening for rewrite, renaming, or copying JSONL.
- Snapshot translation supports documented v1-v3 sessions, active branches,
  compaction, model/thinking changes, messages, tool results, bash execution,
  and safe custom entries. Translation is reused while the ordered native branch
  is unchanged and rebuilt on append/divergence. Pages contain at most 100 items
  and target 1 MiB, with a one-item progress exception. Runtime-local HMAC
  cursors preserve append-compatible older/resume positions and reject forged,
  cross-runtime, wrong-purpose, or divergent positions. Malformed/unsupported
  data produces a thread-scoped adapter diagnostic.

## Pi resources, trust, and tools

- Use Pi SDK's normal `ModelRuntime`, settings, resource loading, built-in tools, and project-trust rules rather than creating a second policy system.
- The trusted thread execution root is Pi's cwd: the registered checkout for a
  shared thread or its verified managed worktree for an isolated thread.
- Native project trust decides whether project-local settings, extensions, skills, and packages load. The adapter surfaces trust/resource diagnostics safely when Pi does not load them.
- Enabled tools follow Pi's current defaults/configuration. The application neither broadens nor wraps them with approval logic.
- Global/project Pi extensions can execute according to Pi's trust model and may register or replace tools. This is disclosed as part of direct Pi behavior.
- Commands, reads, writes, and tool calls may access outside the project when Pi and the operating system permit it.

The UI displays command/tool input, cwd, bounded output, exit/error state, and a persistent concise warning that agent actions use the user's permissions without application approval or OS sandboxing.

## Prompt-derived naming

Before a new thread session is created, the adapter may make one tool-free,
non-persistent `ModelRuntime.completeSimple()` request containing only the first
prompt and fixed title instructions. `PI_WEB_NAMING_MODEL` explicitly selects a
model; automatic selection stays within Pi's configured default provider and
requires a lower-cost authenticated model. Output is bounded and parsed as one
short text title. Timeout, auth/model unavailability, and malformed output fall
back to deterministic server naming and never block creation. The parsed title
names native session metadata; only a separately sanitized server slug can
enter Git paths/refs.

## Run lifecycle

- Each thread owns an independent Pi runtime session. A thread-scoped preflight lease and database constraint permit one running run per thread while allowing distinct threads in the same project to run concurrently.
- Pi `prompt()` begins with `preflightResult`; adapter events are buffered until acceptance is known.
- On acceptance, the server atomically persists the command receipt and `running` run before publishing buffered events. Rejection creates no run.
- Project removal synchronously fences new prompt acceptance, then interrupts
  running child work and cancels already-started preflight work before disposal
  and soft removal complete.
- `steer()` and stop resolve the running run through its owning thread and do not affect other active project threads.
- Submitting while a run is active calls `steer()` immediately; text left unsent remains a browser-local draft, and the application does not use Pi follow-up queueing.
- Stop calls `abort()` and transitions to `interrupted` after authoritative settlement.
- Completion/provider/tool errors transition exactly once to completed or failed.
- Server restart marks unfinished runs interrupted because live in-process Pi runtimes are not reconnectable initially.

Run states are `running`, `completed`, `failed`, and `interrupted`.

## Future automatic command review

A future approved feature may interpose a dedicated reviewer agent before main-agent tool/command execution. It may receive the proposed structured operation plus intentionally bounded context and return approve/reject. That feature requires new product rules for failure mode, auditability, reviewer/main run relationships, recursion prevention, credentials, latency, and what happens when the reviewer is unavailable. The initial runtime avoids assumptions beyond using versionable contracts and forward database migrations.

## Event parsing and sensitive data

The adapter exhaustively narrows every used Pi event/message/tool shape. Unknown events become typed unsupported diagnostics rather than cast-through data. Browser DTOs may contain command text, safe display cwd, bounded output, and exit state, but never provider credentials, process environments, canonical roots, or native session paths.

## Alternatives considered

- **Application approve-once cards:** deliberately deferred to keep behavior aligned with Pi and avoid a premature command-policy system.
- **Automatic reviewer agent now:** deferred until separate product and trust decisions exist.
- **Disable Pi extensions/resources:** rejected because matching Pi's native trust behavior is the selected compatibility model.
- **Expose Pi SDK/RPC values directly:** rejected because it leaks implementation types and trusts external shapes.
- **Pi RPC subprocesses:** deferred; in-process SDK integration is simpler and more efficient for the initial Node server.
- **Pi follow-up for wait:** rejected because it blurs the product run boundary.

## Failure and recovery

Missing/corrupt sessions affect only their thread. Provider/tool failures map to safe failed-run categories while Pi history remains authoritative. Runtime disposal unsubscribes listeners and releases the thread lease. Removing a project fences new prompts and interrupts or cancels every already-started child run or preflight. Reopening reconstructs from Pi history plus application metadata and never resubmits an accepted prompt.

## Required tests

- Shared fake-runtime contract suite.
- Session discovery/open/import with v1-v3, branch, compaction, malformed, missing, duplicate UUID, cwd mismatch, and no-rewrite byte assertions.
- Controlled Pi event fixtures, unknown events, partial streaming, SDK throws, and output bounds.
- Prompt event-before-preflight, reject, accept then resolve/reject, duplicate callback defense, and buffered ordering.
- Concurrent submissions in distinct project threads, same-thread exclusion, independent steering/stop/settlement, multi-run project removal, local drafts, and restart reconciliation.
- Pi resource/trust fixture tests proving behavior matches SDK `0.84.2` without an application approval hook.
- UI disclosure that enabled tools execute with user permissions and no sandbox/approval.
