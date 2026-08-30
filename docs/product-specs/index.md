# Product specification index

Product specifications define durable user-visible behavior, business rules,
permissions, acceptance criteria, and important edge cases. They are organized
by stable capability rather than task. Temporary implementation steps do not
belong here.

| Capability                                                        | Current version | Proposed version | Proposal | Implementation | Related open plan                                                                                   |
| ----------------------------------------------------------------- | --------------- | ---------------- | -------- | -------------- | --------------------------------------------------------------------------------------------------- |
| [Initial agent workspace](initial-workspace.md)                   | None            | 2                | Approved | In progress    | [Initial agent workspace](../exec-plans/active/2026-08-15-initial-agent-workspace.md)               |
| [Chat image attachments](chat-image-attachments.md)               | 3               | None             | None     | Current        | —                                                                                                   |
| [Scalable conversation history](scalable-conversation-history.md) | None            | 1                | Approved | In progress    | [Scalable conversation history](../exec-plans/active/2026-08-16-scalable-conversation-history.md)   |
| [Thread management](thread-management.md)                         | 3               | None             | None     | Current        | —                                                                                                   |
| [Thread workspaces](thread-workspaces.md)                         | 3               | 4                | Approved | In progress    | [Same-worktree new-chat command](../exec-plans/active/2026-08-29-same-worktree-new-chat-command.md) |
| [Tiling workspace surface](tiling-workspace-surface.md)           | None            | 1                | Draft    | In progress    | [Tiling workspace surface](../exec-plans/active/2026-08-21-tiling-workspace-surface.md)             |
| [Codex-style workspace surface](codex-workspace-surface.md)       | None            | 1                | Draft    | In progress    | [Codex-style workspace surface](../exec-plans/active/2026-08-22-codex-workspace-surface.md)         |
| [Workspace panel](workspace-panel.md)                             | None            | 2                | Approved | In progress    | [Workspace panel](../exec-plans/active/2026-08-22-workspace-panel.md)                               |
| [Agent backends](agent-backends.md)                               | None            | 3                | Approved | In progress    | [Codex tool-call replay](../exec-plans/active/2026-08-23-codex-tool-call-replay.md)                 |

The initial workspace is not yet Current. Proposed version 2 retains the
version 1 baseline and revises its run lease to allow concurrent runs in
distinct threads of one project. The user approved product and technical
version 2 on 2026-08-16; the concurrency slice is implemented and verified
while the broader initial-workspace plan remains in progress. Thread workspaces
version 3 is Current and provides per-chat source-checkout or isolated-worktree
execution, default-model naming, and explicit naming-completion metadata while
preserving the merged per-thread concurrency behavior. A pre-merge immediate
same-worktree continuation revision was approved and implemented but not
promoted. The user then selected deferred first-prompt creation so an abandoned
exact `/new` leaves no empty server thread or agent session. That material
revision is Approved version 4: `/new` opens a device-local pending
same-worktree composer, and its first real prompt recovery-safely creates the
titled thread, session, prompt, and run. One-to-many managed-worktree ownership, one active sibling
agent, no copied context/Git operation, and Local checkout exclusion remain.
The user approved product version 4 and plan version 2 on 2026-08-29;
refactoring is active.

Chat image attachments version 3 is Current. The user approved versions 1 and 2
on 2026-08-29, then explicitly requested version 3's quiet unsupported state the
same day. Users can
drop or paste JPEG, PNG, or WebP images into a specific new-chat or thread
composer (with an accessible Add photos alternative), preview and remove up to
four bounded images, and send text-plus-image or image-only Pi or Codex prompts
and steering messages when the effective model supports images. Pending photos
are page-memory only and multipart command bodies avoid a staging store. Pi
retains accepted images in native history; Codex retains private,
content-addressed source files in adapter-owned state. Both load on demand in
typed user messages through authorized opaque references and never expose local
paths. Arbitrary remote URLs, external local paths, project/SQLite copies, and
Markdown images remain disabled. Version 3 removes the file-picker row from all
composers while retaining pane-scoped drop and focused paste; a
known-unsupported model also shows no capability explanation. Pending previews
remain visible if capability changes after attachment.

Scalable conversation history is a separate Approved capability for bounded
latest pages, progressive older-history navigation, polite live following, and
a bounded browser rendering window. The user approved product specification
version 1 on 2026-08-16. Technical approvals for plan versions 1 and 2 are invalidated; plan version 3
is Draft with technical approval pending. Its shared bounded-page foundation
was implemented and verified under the separately approved Agent backends v3 /
Codex replay plan v2; the remaining page-free live refresh, full viewport
behavior, and completion work stays paused until plan-v3 approval.

Thread management version 3 is Current. It retains the Codex-style action menu,
non-destructive inactive-thread archival, and compact run-state signals while
giving sidebar and pane-header titles the same one-row inline rename editor:
double-click enters editing, blur or Enter saves, and Escape or one Revert
control restores the prior title without an accept/cancel action row. The user
approved the bounded revision on 2026-08-29 under its conversational label 2.1;
it was renumbered without a content change to satisfy integer lifecycle
metadata. The separate archival-recovery text remains a deferred candidate
outside Current version 3 and needs its own later version and approval.

Tiling workspace surface is a Draft proposal for version 1, distilled from the
multi-agent tiling workspace design as its first phase. It turns the project
route into a terminal-style tiling surface of panes with the approved
keybinding set, close-archives-thread behavior, and device-local layout. Its
original collapse-to-dock pane tier and dock attention signal are superseded by
[Codex-style workspace surface](codex-workspace-surface.md) (see that spec's
Superseded requirements). Additional agent backends and worktree forking remain
separate later-phase capabilities. Product approval is pending; implementation
is in progress under the linked plan and the proposal becomes Current only after
the user approves it and the behavior is verified.

Workspace panel is an Approved proposal for version 1, approved by the user on
2026-08-22 from the design as presented in session rather than from a reading of
the document itself. It replaces the right-hand inspector with a docked panel of tab
groups in their own binary tiling tree, holding durable tabs — Changes, Diff,
Files, File, Terminal, and Browser — that each carry the
`(project, thread, execution scope)` they were opened against and keep it when
chat focus moves. It also specifies several terminals per execution scope with a
stated limit and a remembered working directory, an embedded browser tab that
fails with an explicit named state rather than a blank frame, a device-local
panel record that migrates the shipped inspector preference, and per-tab
responsiveness and keyboard/accessibility contracts. It supersedes **CWS-06** of
[Codex-style workspace surface](codex-workspace-surface.md) in full; that spec's
other requirements are unaffected. Implementation is in progress under the
linked plan and the proposal becomes Current only after the behavior is
implemented and verified.

Workspace panel version 2 is an Approved proposal, approved by the user on
2026-08-23 from the behaviour as described in session rather than from a reading
of the document; as for version 1, a discrepancy between the document and that
discussion resolves in favour of the discussion and returns the proposal to
Draft. It is bounded to WSP-05: after a 2026-08-22 hands-on pass at a real
repository found the Files tab flooded by `node_modules` and presented as a flat
list of root-relative paths, version 2 requires a navigable tree with persisted
expansion, ignore rules honoured by default in both the listing and the search
with an explicit opt-in to reveal ignored files, flat results while a search is
active, and accessible names on every row and every tab. Version 1 stays
approved and in progress; version 2 reopens nothing else, and the read-only
non-goal is unchanged — a tree adds navigation, never editing. The same pass
reported four defects against version 1; two of them — panel tabs and file rows
said to expose no accessible name — were probed against the live DOM and closed
as false positives from the inspection tool, which renders name-from-content
roles as blank. The two that stand are one close control rather than one per tab
(a design decision to confirm) and clipped file content. None needs a contract
change; all four, closed and open, are recorded in that specification's Findings
section and tracked in the plan's milestones 3 and 5.

Codex-style workspace surface is a Draft proposal for version 1 that restyles
the tiling surface to a calm, near-borderless Codex desktop aesthetic; adds
complete light and dark themes (System default, live OS follow, before-paint
apply) behind a new Settings page; keeps exactly one right-hand column — the
`Changes | Files | Terminal` inspector, which follows the focused pane;
surfaces a four-way pane-header and sidebar run status
(working / needs-approval / done / failed); reduces pane actions to Split and a
non-destructive Close; and removes the tiling surface's
collapse-to-dock pane tier entirely, migrating any persisted docked panes back
into the tiling tree. Its CWS-06 inspector requirement is superseded in full by
[Workspace panel](workspace-panel.md) (see that spec and the CWS Superseded
requirements section); every other CWS requirement stands. Product approval is
pending; implementation is in progress under the linked plan and the proposal
becomes Current only after the user approves it and the behavior is verified.

Agent backends carries three proposals. Version 1 — approved by the user on
2026-08-22 together with its plan version 1, and implemented but not yet
promoted — makes a chat's coding agent an explicit, durable, immutable per-chat
property, adds Codex beside Pi, makes Codex the default for new chats, and shows
the backend wherever a chat appears. Existing chats are Pi and are unchanged.
Codex chats run with interactive approvals disabled and, by default, confined
to their execution root with no network. Version 2 was approved on 2026-08-23:
a reopened Codex chat restores shell commands and file changes from Codex's
private history and degrades to messages when that history cannot be read.
Version 3 is an Approved follow-up that makes shared bounded progressive
history a shipping requirement for replay: one latest page opens, older
message/tool pages load explicitly, and the browser retains one bounded page
window instead of the complete chat. Its production implementation and
automated verification are complete; real-provider manual checks remain before
promotion to Current.

When durable behavior changes, prefer a bounded proposed revision in the
canonical capability document that already governs it. Create a new file only
for a distinct durable capability with an independent lifecycle and normal
reader entry point. Keep the Current contract readable while proposals are
Draft or Approved, and promote an approved version to Current only after its
coherent behavior is implemented and verified.

Link every canonical specification from this index and keep its current/proposed
version, implementation state, and overlapping open plan visible here.
