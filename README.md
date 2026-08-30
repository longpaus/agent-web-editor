# Pi Web Workspace

A local-first browser workspace for persistent engineering projects and Pi
coding-agent threads. It provides a compact conversation and review UI backed by
a loopback-only Fastify server, SQLite application metadata, native Pi session
history, safe file/Git inspection, and one on-demand terminal per project.

The initial implementation is in progress; the active execution plan records
remaining acceptance hardening.

## Requirements

- Node.js 22.19 or later
- pnpm 11.1.2
- Python 3 for the documentation validator
- Playwright Chromium for `pnpm test:e2e`

## Setup and verification

```sh
pnpm install
pnpm check
pnpm test:e2e
```

Start both loopback development processes with `pnpm dev`, then open the
launch URL printed by the server. To build and run the loopback production
server in one step, use `pnpm start`; it serves the built web application from
the backend origin. Both commands load ignored, machine-local settings from
`.env.local`. `--port` overrides `PI_WEB_PORT`; the backend default is `3001`.
`PI_WEB_DEV_PORT` selects the Vite port and defaults to `5173`. Copy
`.env.example` to `.env.local` to keep these values in one ignored
repository-local file. Application metadata defaults to
`~/.pi/web-workspace/metadata.sqlite` and can be relocated with an absolute
`PI_WEB_STATE_DIR`.

## Agent backends

A chat runs on either **Pi** or **Codex**. The backend is chosen when the chat
is created and never changes: a chat is continued by resuming that backend's own
session, and no history transfers between agents. New chats default to Codex;
set `PI_WEB_DEFAULT_RUNTIME=pi` to change the machine default, or choose per
device under Settings. Chats created before this capability shipped are Pi.

Codex requires the [Codex CLI](https://github.com/openai/codex) (0.149.0 or
compatible) on PATH, or `PI_WEB_CODEX_BIN` pointing at it. When it is missing,
Codex is reported unavailable with the reason and Pi chats are unaffected.

The two backends do **not** run under the same permissions, deliberately:

- **Pi tools and the explicit project terminal** run with the server user's
  normal permissions. They are not application-approved or OS-sandboxed.
- **Codex** runs confined to the chat's execution root with no network access
  (`PI_WEB_CODEX_SANDBOX=workspace-write`, the default). That boundary also
  leaves `/tmp` and `$TMPDIR` writable, which Codex treats as workspace scratch
  space; everything else, including your home directory, is refused. Set it to
  `danger-full-access` to match Pi's posture, or `read-only` to forbid writes.
  A command blocked by that boundary appears as a failed command in the
  transcript; it never stalls the run.

Interactive approvals are disabled for Codex and are not configurable: this
workspace has no surface for answering a permission prompt, so no run may wait
on one. Anything Codex would have asked about either proceeds inside the
boundary above or fails visibly.

Conversation history opens as a bounded latest page and loads earlier pages only
when requested, so long chats are not transferred or mounted in full in the
browser. Codex restores historical shell and file activity from the confined
session file named by app-server. `PI_WEB_CODEX_HOME` can select an absolute
Codex state root; it otherwise follows `CODEX_HOME` and then `~/.codex`.
`PI_WEB_CODEX_REPLAY_TOOLS=off` disables private-format replay without disabling
messages, prompting, or live tools.

Image attachments work with image-capable Pi and Codex models. Codex stores
accepted source images as private, content-addressed history state beneath its
resolved state root and sends them to app-server as local-image inputs; image
bytes and native paths never enter project files or application metadata.

See the [documentation front door](docs/README.md),
[architecture overview](docs/architecture/overview.md), and
[development workflows](docs/development/workflows.md).
