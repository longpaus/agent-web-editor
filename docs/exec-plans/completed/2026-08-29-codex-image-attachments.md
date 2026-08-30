# Codex image attachments

**Status:** Completed

**Plan version:** 1

**Technical approval:** Approved by the user on 2026-08-29 for plan version 1
by asking to implement the reviewed plan

**Subsystem:** Codex adapter, runtime capability preflight, chat attachment
delivery, and transcript image projection

**Affected paths or contracts:** `packages/codex-adapter/src/**`,
`packages/agent-runtime/src/index.ts`, `packages/contracts/src/index.ts`,
`apps/server/src/domain/workspace.ts`, `apps/server/src/app.ts`,
`apps/web/src/features/workspace/**`, workspace-preflight capability reporting,
Codex app-server `model/list`, `turn/start`, `turn/steer`, and `userMessage`
input projection

**Governing specification:** [Chat image attachments current version 2,
CIA-07 through CIA-10](../../product-specs/chat-image-attachments.md#current-revision-v2--codex-image-input)

**Related documents or issue:** [Codex adapter](../../../packages/codex-adapter/README.md),
[runtime and Pi adapter](../../design/runtime-and-pi-adapter.md),
[architecture overview](../../architecture/overview.md),
[Codex agent runtime](2026-08-22-codex-agent-runtime.md),
[completed Pi image plan](../completed/2026-08-29-chat-image-attachments.md),
and the [official Codex app-server protocol](https://developers.openai.com/codex/app-server)

**Last updated:** 2026-08-29

**Completion:** Implemented and repository-verified on 2026-08-29

## Working specification and approval context

Chat image attachments version 2 is Current and extends the same bounded
attachment experience to image-capable Pi and Codex models. On 2026-08-29 the
user approved both specification version 2 and this technical plan version 1 by
asking to implement the reviewed plan. Implementation and repository
verification are complete.

## Purpose and user-visible outcome

Remove the unconditional “Codex image input is not supported” state. A Codex
chat whose effective model advertises image input will accept the same bounded
JPEG, PNG, and WebP attachments as Pi for first prompts, later prompts,
continuations, and active-run steering. Accepted images remain visible with
their user messages after restart; unsupported models fail clearly without
dropping the pending composer input.

## Requirement traceability

| Spec requirement                                                                                                                                                                | Technical consequence                                                                                                                                                                               | Verification                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| [CIA-07 — Images follow the selected backend](../../product-specs/chat-image-attachments.md#cia-07--images-follow-the-selected-backend)                                         | Remove UI/runtime hard-coding, report the selected runtime in preflight, convert one `RuntimeUserInput` into ordered Codex `text` and `localImage` items for prompt and steer                       | Codex adapter payload tests, workspace preflight tests, new-chat/thread component tests, and real Codex prompt/steer checks        |
| [CIA-08 — Capability is model-aware and rechecked](../../product-specs/chat-image-attachments.md#cia-08--capability-is-model-aware-and-rechecked)                               | Parse `model/list`, retain the model returned by thread start/resume, map `inputModalities`, and recheck immediately before image dispatch                                                          | Supported, unsupported, missing-field, malformed-catalog, model-change, and failed-native-request tests                            |
| [CIA-09 — Codex history retains accepted attachments](../../product-specs/chat-image-attachments.md#cia-09--codex-history-retains-accepted-attachments)                         | Store accepted local-image bytes in private thread-scoped Codex adapter state, project authorized refs from `userMessage` items, and implement bounded `readImage` without trusting arbitrary paths | Live/history/restart tests, ownership and symlink/traversal tests, missing/malformed image diagnostics, and authorized route tests |
| [CIA-10 — Storage, retries, and disclosure remain backend-neutral](../../product-specs/chat-image-attachments.md#cia-10--storage-retries-and-disclosure-remain-backend-neutral) | Use content-addressed files outside SQLite/project roots, preserve existing command fingerprints and Codex `clientUserMessageId` recovery, and make disclosure name the effective backend           | Duplicate/recovery tests, no-project/no-database storage assertions, rejection retention tests, and UI disclosure checks           |

## Current behavior and affected invariants

- The browser and server already accept bounded ordered JPEG, PNG, and WebP
  bytes for start, continuation, prompt, and steer. The server constructs the
  provider-neutral `{text, images}` runtime input and fingerprints image MIME,
  order, and SHA-256 content digest.
- `CodexAgentRuntime.inspectImageInput()` unconditionally returns
  `"unsupported"`. `CodexOpenSession.textInput()` throws
  `chat_image_input_unsupported` whenever `images.length > 0`, and Codex prompt
  and steer always send one text item.
- `NewChatPane` hard-codes every non-Pi runtime to `"unsupported"` even though
  the shared capability contract is already runtime-neutral. The general
  workspace preflight also inspects Pi regardless of the selected new-chat
  backend. Continuation preflight knows the source runtime but the UI still
  overrides Codex to unsupported.
- The official app-server contract and locally generated Codex CLI 0.151.0
  bindings define mixed `UserInput` items, including `{type:"localImage",
path}`, on both `turn/start` and `turn/steer`. `model/list` reports each
  model's `inputModalities`; `thread/start` and `thread/resume` report the
  effective model.
- Codex `userMessage.content` can contain text, image, and local-image items.
  The current mapper deliberately reads text parts only. `CodexOpenSession`
  does not implement `readImage`, and the server therefore marks an open Codex
  thread's image capability unsupported independently of the model.
- Existing invariants remain: no image bytes or local paths in SQLite or normal
  transcript/event DTOs; no project-workspace image copies; opaque
  project/thread-authorized reads; at most four bounded source images; no
  remote URL fetching; no arbitrary Markdown images; text-only JSON callers
  remain compatible; Pi behavior remains unchanged.

## Scope, non-goals, assumptions, and unresolved technical decisions

### Selected approach

1. Keep the existing browser attachment controller, multipart routes, server
   byte parsing, and provider-neutral `RuntimeUserInput`. No new upload endpoint,
   database table, or browser persistence is introduced.
2. Make workspace preflight runtime-aware. The selected runtime is parsed at
   the HTTP boundary and included in the browser query key; continuation and
   existing-thread snapshots continue deriving the immutable runtime from the
   source thread.
3. Add a narrow Zod parser for the app-server model catalogue. For new chats,
   `inspectImageInput` uses the catalogue default. For opened threads, retain
   the exact model returned by `thread/resume` and resolve its modalities from
   the catalogue. `text + image` means supported, a known text-only model means
   unsupported, and an unreadable or unmatched catalogue means unknown. When an
   older catalogue omits `inputModalities`, follow the official compatibility
   rule and treat it as text plus image.
4. Before every Codex image dispatch, re-parse the runtime input, verify the
   supplied digest against the bounded bytes, and recheck the current model.
   Store each image atomically as a content-addressed file under a versioned,
   adapter-owned directory inside the configured Codex state root:
   `pi-web-image-attachments/v1/<thread-id>/<digest>.<ext>`. Directories are
   private and files are created without following or replacing links. A
   repeated image in one thread reuses verified bytes; attachment order remains
   in the app-server input list.
5. Send one text item when text is non-empty followed by ordered
   `{type:"localImage", path}` items to `turn/start` or `turn/steer`. Image-only
   input omits the empty text item. The files remain after acceptance because
   Codex history stores the local-image path and must survive server restart.
   Files created for a definitive native rejection are removed only when they
   were newly created and are not shared; ambiguous transport failures retain
   them for dispatch recovery.
6. Extend Codex user-message mapping with a context-bound local-image parser.
   It accepts only canonical paths inside the current thread's exact attachment
   directory whose filename contains a valid digest and matching supported
   extension. It emits opaque `{id, mimeType}` refs and never copies the path to
   a DTO. Remote `image` URLs and arbitrary `localImage` paths from external
   clients remain unrendered.
7. Implement `CodexOpenSession.readImage`. Resolve the requested ID only inside
   the authorized thread directory, refuse symlinks/non-regular files, bound the
   read, re-detect MIME and dimensions from bytes, and require the SHA-256 to
   match the filename before returning canonical base64. Missing or malformed
   files omit only their image and produce the existing scoped diagnostic path.
8. Extend `recoverPrompt` comparison from text only to the exact ordered
   content identity: `clientUserMessageId`, text, and local-image digest paths.
   Existing text-only recovery remains compatible. No idempotency schema or
   database migration is required because server fingerprints already include
   image content.
9. Remove the browser's Pi/Codex capability branches. The attachment strip,
   disable reason, retention behavior, and disclosure consume the effective
   runtime capability and label. Keep pending images visible if a user switches
   a new chat to a known-unsupported backend; block send until images are
   removed or a capable backend is restored.

### Non-goals

- The proposed specification's non-goals apply.
- Do not add a model picker, change Codex model selection, or substitute a
  different model to gain image support.
- Do not accept remote image URLs from the browser or fetch URLs found in Codex
  history.
- Do not render arbitrary local-image paths from imported/external Codex
  sessions.
- Do not move Codex attachments into SQLite, the managed worktree, or the
  source checkout.
- Do not refactor Pi normalization or Codex private tool-call replay.
- Do not add speculative garbage collection of accepted or ambiguously
  dispatched attachment files; correctness and recovery take precedence over
  reclaiming storage in this revision.

### Assumptions

- Codex CLI 0.149.0-compatible app-server accepts `localImage` in
  `turn/start`/`turn/steer`, persists that input in `userMessage.content`, and
  reports the current/default model through the methods above. CLI 0.151.0's
  locally generated bindings and current official documentation confirm the
  shape. If the declared 0.149.0 floor fails the compatibility check, changing
  the minimum version is a material deployment decision and requires plan
  version 2 before implementation continues.
- Codex reads local-image files from its own state root under the configured
  read boundary. It owns provider-specific decoding and resizing after this app
  has enforced the existing source byte, format, and decoded-dimension bounds.
- Codex history retains the caller-provided local-image path. The adapter-owned
  file is therefore native-adjacent runtime state, not a pending upload or
  application database record.

### Unresolved technical decisions

None material. Exact helper names, directory module boundaries, and safe
diagnostic wording may change without altering the selected storage,
authorization, protocol, or compatibility approach.

## Implementation milestones

### Milestone 1 — Protocol characterization and capability discovery

- Generate/read protocol bindings from the declared minimum compatible Codex
  CLI and the installed CLI, then add hand-written narrow Zod schemas for
  `model/list`, start/resume model fields, and image/local-image user inputs.
- Add `CodexClient`-level or runtime-level model catalogue lookup with bounded
  pagination and reconnect-safe caching. Parse every raw app-server response;
  generated TypeScript is reference material, not a trusted runtime boundary.
- Replace the unconditional adapter capability with default-model and
  open-thread model-aware results. Characterize supported, unsupported,
  missing-modality compatibility, unmatched, malformed, and request-failure
  cases.

### Milestone 2 — Private attachment storage and Codex dispatch

- Add a small adapter-owned attachment store rooted beneath parsed
  `codexHome`. Validate thread IDs, MIME-to-extension mapping, bytes,
  dimensions, digest, canonical containment, regular-file type, and no-link
  behavior on every write/read boundary.
- Convert `RuntimeUserInput` to ordered app-server input items and use it in
  prompt and steer. Preserve event preflight buffering, turn settlement, and
  text-only payload compatibility.
- Extend prompt recovery to compare exact ordered text/image identity and cover
  accepted, rejected, duplicate, conflict, disconnect, and image-only cases.

### Milestone 3 — Codex transcript projection and authorized reads

- Parse only adapter-owned local-image paths from live and historical
  `userMessage.content`, append bounded image refs to user transcript items,
  and flag malformed adapter-owned entries without treating unrelated external
  paths as readable.
- Implement thread-scoped `readImage`, including content/MIME/dimension/digest
  revalidation, canonical base64, missing-file behavior, and symlink/traversal
  refusal.
- Verify bounded latest/older pages and private tool replay keep their current
  ordering and do not read image bytes during normal transcript projection.

### Milestone 4 — Runtime-aware preflight and browser behavior

- Parse the requested runtime on workspace preflight, inspect that adapter, and
  key browser queries by project plus runtime. Keep continuation and existing
  thread capability tied to their immutable runtime.
- Remove `NewChatPane` and `ThreadPane` hard-coded Codex branches. Use the
  shared capability for attach/disable/send behavior and the runtime label for
  explanations and disclosure.
- Cover switching between Pi and Codex with pending images, capable and
  incapable Codex models, capability changes on submission, retry retention,
  image-only first prompts, continuation, and steer restoration.

### Milestone 5 — Compatibility, documentation, and end-to-end verification

- Run the existing Pi image suite unchanged and add a fake-app-server
  integration path that exercises multipart input through transcript image
  retrieval.
- Verify one real Codex new-chat prompt, later prompt, active steer, server
  restart, thumbnail open, and duplicate retry with a small PNG. Verify a
  text-only or faked unsupported model leaves the pending composer intact.
- Update the Codex adapter README, repository README/version statement if
  required by the compatibility check, architecture image flow, and UI copy.
  After all evidence passes, fold proposed specification version 2 into
  Current, complete this plan, and update both indexes.

## Untrusted-data-boundary analysis

| Source and raw representation                               | Entry/read point                       | Runtime parser                                                                                                | Trusted output and guarantees                               | Failure behavior                                                            | Boundary tests                                                                          |
| ----------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Browser runtime query string                                | workspace-preflight route              | strict Zod query schema using `RuntimeKindSchema`                                                             | one known registered runtime kind                           | 400 malformed response; no adapter call                                     | valid Pi/Codex, missing default, unknown, extra fields                                  |
| Server-owned `RuntimeUserInput` crossing into Codex adapter | prompt/recover/steer                   | strict input/image schemas plus byte parsing and SHA-256 recomputation                                        | bounded supported MIME bytes with matching digest and order | typed rejected/malformed failure before app-server dispatch                 | valid mixed/image-only, spoofed MIME, digest mismatch, count/size/pixel limits          |
| App-server `model/list` response                            | capability lookup                      | bounded-page Zod schemas                                                                                      | exact model IDs/default marker and narrowed modalities      | `unknown`; submission still performs native attempt and never strips images | supported, text-only, missing modality, duplicate/no default, malformed, pagination cap |
| App-server start/resume response                            | runtime create/open                    | Zod envelope including effective model                                                                        | non-empty thread/model identity bound to open session       | typed malformed/unavailable failure                                         | valid/missing/wrong type/model mismatch                                                 |
| App-server `userMessage.content`                            | live mapping and `thread/read` history | discriminated text/local-image schemas plus thread-scoped path parser                                         | text and opaque refs only; no URL/path escapes              | omit bad image and surface bounded diagnostic; retain message text          | valid adapter path, remote URL, other thread, outside root, malformed digest/extension  |
| Adapter attachment filesystem                               | write, history mapping, `readImage`    | canonical containment, `lstat`/regular-file checks, bounded read, `parseChatImageBytes`, digest recomputation | private regular supported image owned by exact Codex thread | refuse link/traversal/missing/malformed/oversize; no bytes returned         | atomic duplicate, symlink, directory, replacement race, MIME mismatch, digest mismatch  |
| Browser image-read route                                    | existing project/thread/image endpoint | existing ID/ownership schemas plus runtime `readImage`                                                        | canonical image response for owning thread only             | existing safe not-found response                                            | owner, other thread/project, missing image, malformed runtime response                  |

## Touched-legacy-code analysis

- `CodexAgentRuntime.inspectImageInput()` and
  `CodexOpenSession.textInput()` encode an intentional version-1 limitation,
  not an upstream Codex limitation. Replace them with capability discovery and
  multimodal conversion; retain string input compatibility for existing tests
  and callers.
- Codex prompt preflight buffering, settlement ordering, `clientUserMessageId`
  recovery, and active-turn steering are already subtle. Image conversion must
  wrap these paths without changing when a run is considered accepted or when
  buffered events are released/discarded. Existing race tests remain standing
  characterization coverage.
- `mapThreadItem()` currently ignores every non-text user part. Add images
  without allowing arbitrary remote or filesystem content and without changing
  assistant/tool/reasoning mappings. Existing message and pagination tests
  remain.
- `WorkspaceService.snapshot()` currently infers unsupported from the absence
  of `readImage`. Once Codex implements `readImage`, it must take authoritative
  capability from the runtime snapshot just as Pi does. Unknown remains omitted
  from the browser DTO.
- The shared workspace preflight currently asks Pi because images were Pi-only.
  Make only capability lookup runtime-selectable; git/worktree preflight and
  older callers defaulting to the machine runtime remain compatible.
- Browser composers currently contain explicit Codex rejection copy. Replace
  it with capability-driven copy while preserving pending object URL cleanup,
  unload warning, mutation retention, steer restoration, and the Markdown image
  ban.
- Existing Codex sessions and private rollout files require no rewrite. Text
  remains readable; external image parts remain safely omitted unless they
  point to this adapter's exact thread-owned store.

## Verification

Focused automated checks completed during implementation:

The focused Codex adapter, storage, mapping, contract, server route, new-chat,
thread composer, and attachment-controller suites passed. They cover supported,
text-only, legacy missing-modality, malformed-catalogue, mixed, image-only,
steer, recovery, definitive rejection cleanup, ambiguous retention,
thread-scoped reads, symlink refusal, runtime-aware preflight, and pending-image
retention behavior.

Final repository checks:

`pnpm test` passed 76 files and 1,542 tests plus 12 Node script tests. `pnpm
typecheck`, `pnpm lint`, `pnpm build`, `pnpm format:check`, `pnpm docs:check`,
and `pnpm test:docs` all passed. The production build retained its existing
large-chunk warning and completed successfully.

Recorded protocol and boundary checks:

1. Generated bindings from the declared minimum compatible Codex CLI 0.149.0
   and installed CLI 0.151.0. Both expose `localImage` on turn start/steer,
   `inputModalities`, and the effective model on thread start/resume, matching
   the adapter's narrow schemas.
2. Fake app-server integration sent a small PNG as mixed and image-only prompt
   input and active steering, recovered the exact ordered persisted input,
   reopened transcript refs, and loaded verified bytes through `readImage`.
3. Controlled filesystem tests proved cross-thread, arbitrary-path, malformed
   digest, and symlink boundaries; full existing tests covered authorized HTTP
   image retrieval and Pi regressions.
4. A live provider prompt was not run because it would consume external model
   service and is not required to establish protocol or repository correctness.

## Compatibility, deployment, migration, recovery, and rollback

- Database migration: none. Existing command fingerprints already cover image
  MIME, order, and digest; no image bytes or paths enter SQLite.
- Filesystem migration: none. The attachment directory is created lazily for
  the first accepted or ambiguously dispatched Codex image. Existing Codex and
  Pi sessions remain readable.
- CLI compatibility: retain the documented 0.149.0-compatible floor only if
  protocol characterization passes. Otherwise pause, revise this plan, update
  availability/version diagnostics, and obtain renewed technical approval.
- Recovery: a content-addressed file is written before native dispatch and
  retained across ambiguous failures, so the existing dispatch ID can prove
  acceptance after restart. Definitive rejection removes only a file this
  attempt newly created; it never removes a pre-existing shared digest.
- Storage growth: accepted and ambiguous files are durable runtime history.
  Automatic garbage collection is intentionally excluded until deletion and
  retention semantics exist; content addressing prevents retry duplicates.
- Rollback: reverting application code leaves the versioned directory ignored
  by older code. Older code will return to disabling Codex attachment and show
  text-only history, but it will not corrupt sessions or expose paths. The
  files can be recovered by re-enabling the feature; no destructive rollback is
  required.
- Deployment order: packages, server, and web ship together in this repository.
  Until the server reports support, older browser behavior remains disabled or
  unknown; submission remains authoritative.

## Progress

- [x] Investigated current UI, server, runtime, Codex mapping, tests, and
      official app-server image/capability contracts.
- [x] Drafted chat image attachments proposed specification version 2 and this
      plan version 1.
- [x] Obtained explicit product approval for specification version 2 and
      technical approval for plan version 1 on 2026-08-29.
- [x] Implement milestones 1 through 5.
- [x] Record automated/protocol evidence, promote the specification, and complete
      the plan.

## Discoveries and blockers

- The warning is application-authored: both the browser and Codex adapter
  explicitly hard-code unsupported behavior. It is not an error returned by
  Codex or the selected model.
- Current official app-server documentation explicitly accepts `image` and
  `localImage` input items for turns and exposes `inputModalities` from
  `model/list`. Locally generated Codex CLI 0.151.0 types also expose those
  fields on prompt, steer, start/resume, and stored user-message shapes.
- The workspace's installed CLI is 0.151.0 while repository documentation names
  0.149.0 or compatible. The minimum-version protocol check is therefore a
  required first implementation milestone, not an assumed version bump.
- Codex CLI 0.149.0 generated bindings confirm the repository's documented
  compatibility floor; no version bump is required.
- No blocker remains. Live provider behavior was deliberately not exercised;
  fake app-server and generated-protocol verification cover the shipped
  boundary without consuming an external model request.

## Decision and revision log

- 2026-08-29: Created plan version 1. Selected app-server `localImage` over
  remote/data URLs so the adapter does not fetch network content or depend on
  undocumented URL schemes. Selected a private thread-scoped,
  content-addressed store under configured Codex state so history survives
  restart without using SQLite or the project workspace.
- 2026-08-29: Selected model-aware capability discovery through `model/list`
  plus current model from start/resume. Retained unknown as a recoverable state
  and native submission as the authoritative final check.
- 2026-08-29: The user approved specification version 2 and plan version 1 by
  asking to implement the reviewed plan. Marked the plan Active.
- 2026-08-29: Implemented model-aware capability discovery, private
  content-addressed image storage, prompt/steer/recovery/history integration,
  runtime-aware preflight, and backend-specific UI explanations. Confirmed the
  minimum and installed CLI schemas, passed repository verification, promoted
  specification version 2 to Current, and completed the plan.

## Final outcomes

Codex no longer receives an unconditional unsupported classification. Image
capability follows the selected/default or resumed model, and known capable
models accept the same bounded attachment flows as Pi. The adapter stores
validated sources privately under the Codex state root, sends ordered
`localImage` input, recovers exact mixed prompts, exposes only thread-owned
opaque history refs, and serves bytes through the existing authorized route.
Known text-only models block image-bearing submission without dropping pending
browser input; unknown capability attempts the native request without silently
degrading to text.
