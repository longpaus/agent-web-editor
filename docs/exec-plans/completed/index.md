# Completed execution plans

Completed, superseded, and abandoned plans are retained here as historical
implementation context. They are not authoritative over current architecture,
specifications, designs, code, or tests.

- [Initial agent workspace specification](2026-08-15-initial-workspace-specification.md)
  — recorded the approved project, thread, run, completion-notification,
  workspace-layout, and persistence contract.
- [Initial GitHub publication](2026-08-15-initial-github-publication.md)
  — initialized `main`, published the reviewed scaffold to GitHub, and verified
  local/remote commit parity.
- [Fast and Plan implementation lanes](2026-08-15-fast-plan-lanes.md)
  — simplified change classification to Fast or Plan, with approved
  specifications and living ExecPlans required for every non-Fast change.
- [Monorepo and documentation scaffold](2026-08-15-monorepo-and-documentation-scaffold.md)
  — initialized the root toolchain, five workspace packages, documentation
  conventions, and static environment verification.
- [Native project directory picker](2026-08-15-native-project-directory-picker.md)
  — replaced typed project paths with an authenticated, server-owned macOS and
  Windows native directory chooser while keeping canonical paths out of the
  browser.
- [Specification and ExecPlan approval workflow](2026-08-15-spec-and-exec-plan-approval-workflow.md)
  — made capability specifications and versioned technical plans co-evolving
  Draft artifacts with explicit product and implementation approvals,
  traceability, invalidation rules, and validator coverage.
- [Codex-style thread actions and archival](2026-08-16-thread-actions.md) —
  added right-click and keyboard Rename/Archive actions, a direct hover/focus
  Archive icon, durable inactive-thread archival, and compact inline run
  signals.
- [Inline thread title editing](2026-08-29-inline-thread-title-editing.md) —
  replaced the sidebar's multi-row Save/Cancel form and the pane header's
  static title with one shared one-row editor: double-click enters editing,
  blur or Enter saves, and Escape or Revert restores the prior title.
- [Thread workspace and worktree support](2026-08-16-thread-workspaces.md) —
  added the Codex-style new-chat flow, clean or explicitly transferred managed
  worktrees, prompt-derived names, durable creation recovery, and thread-scoped
  runtime, inspector, Git, and terminal roots.
- [Isolated worktree review environment](2026-08-16-worktree-review-environment.md) —
  added a manually invoked project-local Pi skill and checked-in start/close
  commands for random-port, disposable-SQLite UI review environments that
  install missing dependencies and hard-refuse the main worktree.
- [Chat image attachments](2026-08-29-chat-image-attachments.md) — added
  pane-scoped JPEG/PNG/WebP drag, focused clipboard paste, and accessible file
  selection; bounded multipart prompt/steer transport; Pi multimodal delivery,
  idempotent recovery, native-history image refs, and authorized on-demand
  rendering without a staging store or local path exposure.
- [Codex image attachments](2026-08-29-codex-image-attachments.md) — replaced the
  unconditional Codex image rejection with model-aware capability discovery,
  private content-addressed thread storage, ordered app-server `localImage`
  prompt/steer input, exact recovery, and authorized opaque history refs while
  preserving Pi behavior.
- [Default-model thread and worktree naming](2026-08-29-default-model-thread-naming.md) —
  changed automatic first-prompt naming from a distinct lower-cost
  same-provider model to the selected project's configured default Pi model,
  while preserving the explicit override and deterministic fallback.
- [Accept provider metadata in naming completions](2026-08-29-naming-completion-metadata.md) —
  fixed prompt-prefix fallback when valid default-model title blocks include
  additive provider metadata by projecting only the required text fields.
