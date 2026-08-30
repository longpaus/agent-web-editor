# Chat image attachments

**Current version:** 3

**Proposed version:** None

**Proposal status:** None

**Implementation status:** Current

**Product approval:** Not applicable — no proposed revision; version 3 was approved by the user on 2026-08-29 by explicitly asking to remove the unsupported attachment row

**Subsystem:** New-chat and existing-thread message composition

**Last verified:** 2026-08-29

**Related ExecPlans:** [Chat image attachments](../exec-plans/completed/2026-08-29-chat-image-attachments.md)
and [Codex image attachments](../exec-plans/completed/2026-08-29-codex-image-attachments.md)

**Related documents:** [Initial agent workspace](initial-workspace.md),
[architecture overview](../architecture/overview.md), and
[Parse, Don't Validate](../architecture/data-boundaries.md)

## Purpose

A user can give the selected Pi or Codex backend visual context without first
copying an image into the workspace or describing it in text. Photos and
screenshots attach to the same new-thread prompts, later prompts, and active-run
steering messages as text.

## Current contract v1

### CIA-01 — Add images to the intended composer

A user can drag one or more supported image files from the operating system onto
a new-chat or existing-thread composer. While a file drag is over a chat pane,
that pane shows a clear drop target; dropping attaches to that pane only and
focuses it. File drops do not trigger the workspace panel's tab-drag behavior or
attach to another focused pane.

A user can also paste image data from the operating-system clipboard while a
new-chat or existing-thread message field is focused. Image clipboard items
attach to that composer only. When a paste contains image data, the application
handles it as an attachment and does not also insert a browser-generated URL,
HTML representation, or other clipboard text into the message. An ordinary
text-only paste remains ordinary text editing. If the browser or operating
system does not expose copied image data as a file, the application does not
claim that an image was attached.

Every composer also has a keyboard- and touch-accessible **Add photos** control
that opens the platform file chooser with the same rules. Workspace-file
references, non-image files, PDFs, and remote image URLs are not part of version 1.

### CIA-02 — Supported inputs, previews, and limits

Version 1 accepts JPEG, PNG, and WebP image content. The server determines the
format from file bytes rather than trusting a filename extension or browser MIME
label. A message may hold at most four images. Each source file may be at most
10 MiB and 64 megapixels. Duplicate files count separately.

Each accepted image appears above the message field as a thumbnail with its file
name—or a generated **Pasted image N** label when the clipboard supplies no
usable name—size, position in the attachment set, and an individually named
Remove button. The user can remove an image before sending. When a drop, paste,
or selection is mixed, supported images within the remaining limits are
attached and every rejected item gets a visible, safe reason; rejection of one
item does not silently discard the others.

### CIA-03 — Sending to Pi

A message is sendable when it has non-whitespace text, one or more images, or
both. Image-only input is valid. The first image-only message creates a thread
with the deterministic fallback title **Image request**; prompt-derived naming
receives text only and is skipped when there is no text.

The server passes the images and text as one ordered Pi user message. This
applies when creating a thread, starting a later run, and steering an active
run. Pi's persistent session remains the conversation source of truth.

The application must not claim an image was sent when Pi's selected model or
image-blocking setting cannot pass images to the provider. A known unsupported
state disables image attachment with an explanation. A capability change or an
unknown state is rechecked on submission; refusal keeps the text and images in
the composer and shows an actionable error.

### CIA-04 — Pending attachment lifecycle and failures

Pending images are local to the loaded browser page. They are not uploaded when
they are merely dropped, and they are not written to application metadata,
localStorage, or the project workspace. Text draft behavior remains unchanged.
A reload or page close may discard pending images, so the application uses the
browser's leave-page warning while unsent images exist.

A failed, rejected, or timed-out send keeps every pending image and the text in
the originating composer so the user can retry or edit. An accepted send clears
them. If an image-bearing steering message is not delivered before a run fails
or is stopped, its still-available in-memory attachments return to that
composer with the existing undelivered-steer notice. No guarantee is made for
recovering an unsent image after the page itself has gone away.

### CIA-05 — Conversation history

An accepted image is persisted by native Pi history with its user message and
survives browser and server restarts. User messages render their image
thumbnails in the transcript before their text. Each thumbnail has an accessible
name and can be opened at a larger, viewport-bounded size without navigating
away from the thread.

The browser loads image bytes on demand through a thread-authorized endpoint;
normal snapshots and live events carry bounded image references, not base64
payloads. A missing or malformed native image omits only that image and surfaces
a thread-scoped diagnostic. It does not remove the text or make unrelated
history unavailable.

Typed chat attachments are the only new image-rendering path. Arbitrary images
in assistant Markdown, raw HTML, tool text, file previews, and remote URLs remain
disabled.

### CIA-06 — Bounded processing, retries, and disclosure

The application bounds source count, encoded size, decoded pixel count, and the
normalized image handed to Pi. Images are resized to fit within 2000 by 2000
pixels and Pi/provider payload limits; an image that cannot be decoded or
normalized inside those bounds is rejected before prompt acceptance.

Command idempotency covers the text, image order, and image content. Retrying
the same accepted command does not create another run, user message, or native
image copy. The application database stores command fingerprints and result
references but not image bytes. The UI explains that sending gives the selected
model the image and stores the accepted image in native Pi session history.

## Acceptance criteria

1. Dragging two supported photos onto one pane attaches them only to that pane,
   displays removable previews, and does not interfere with panel tab dragging.
2. Pasting an image while one pane's message field is focused attaches it only
   there; text-only paste still inserts text, and an image paste does not also
   insert a URL, HTML, or fallback clipboard text.
3. The **Add photos** control provides the same attachment behavior without a
   pointer-only drag gesture.
4. A user can create a new chat, start a later run, or steer an active run with
   text plus images or images alone, and an image-capable fake/real Pi session
   receives one user message containing both forms of content.
5. Unsupported formats, spoofed MIME labels, malformed images, too many files,
   oversized files, and excessive decoded dimensions fail visibly at the
   boundary without sending or losing valid pending input.
6. A model or Pi setting that cannot send images produces an explained disabled
   or rejected state and never silently degrades an attachment into text-only
   input.
7. A failed submission leaves previews and text available for retry; an accepted
   submission clears them; an undelivered image steering message is restored
   while its browser page remains alive.
8. After reconnecting or restarting, an accepted user message still shows its
   image thumbnails, and opening one retrieves only an image owned by that
   project/thread.
9. A duplicate transport retry returns the original accepted result and creates
   no duplicate run, message, or image.
10. Assistant Markdown images and arbitrary remote image sources remain disabled.

## Non-goals

- Reading the clipboard without an explicit user paste event
- PDFs, SVG, HEIC/HEIF, GIF, video, audio, or generic file attachments
- Attaching a file already in the workspace by path
- Fetching or attaching an image URL
- Image annotation, cropping, rotation, or editing
- Durable unsent image drafts across page reloads
- Storing image bytes in the application database or project workspace
- Assistant-generated images or rendering arbitrary Markdown images

## Open product questions

- None.

## Current revision v2 — Codex image input

Version 2 extends the same attachment experience to Codex without weakening the
existing Pi behavior or the shared format, count, size, retry, and rendering
rules.

### CIA-07 — Images follow the selected backend

When the selected backend and its active model accept image input, a user can
attach JPEG, PNG, or WebP images to a Codex message in every place version 1
supports for Pi: the first message of a new chat, a later prompt, a same-worktree
continuation's first message, and an active-run steering message. Text-plus-image
and image-only messages are both valid, preserve attachment order, and reach the
selected backend as one user message.

The attachment control is governed by the effective backend, not by a hard-coded
Pi/Codex distinction. Switching a pending new chat between capable backends does
not discard its pending text or images. Switching to a known-incapable backend
keeps the pending images visible but prevents submission and explains how to
proceed.

### CIA-08 — Capability is model-aware and rechecked

The application reports image availability from the selected backend's current
model. A known unsupported model disables attachment and explains that the
model cannot receive images. An unknown capability may allow attachment, but
submission rechecks or attempts the native request and must fail visibly rather
than silently sending text alone. A capability or model change between display
and submission follows the same keep-and-explain failure behavior as version 1.

Backend unavailability and image-modality unavailability remain distinct: a
missing or disconnected backend prevents the chat itself, while an otherwise
usable text-only model prevents only image-bearing submission.

### CIA-09 — Codex history retains accepted attachments

An image accepted by Codex stays associated with its native user message and is
available after browser and server restart under the same on-demand,
thread-authorized thumbnail behavior as Pi. Normal snapshots and live events
carry only bounded opaque image references. No native local path, remote image
URL, or image bytes enter application metadata or ordinary transcript payloads.

A missing, malformed, or unauthorized Codex image omits only that image and
surfaces a thread-scoped diagnostic. It does not remove message text or make the
rest of the conversation unavailable. Images added to a Codex session by an
external client are rendered only when they use a representation this
application can authorize without broadening filesystem or network access.

### CIA-10 — Storage, retries, and disclosure remain backend-neutral

Pending images remain page-memory only. After acceptance, image bytes may be
stored only in the selected runtime's native or adapter-owned state, never in
the application database or project workspace. Command idempotency includes
text, image order, format, and content, so retrying one accepted Codex command
does not create another run, user message, or stored image copy.

The send disclosure names the selected backend and explains that the model
receives the image and the accepted attachment remains in that backend's chat
history. Pi's existing normalization and native-history behavior remains
unchanged.

## Version 2 acceptance criteria

1. A user can attach and send text-plus-image or image-only input to an
   image-capable Codex chat for new-thread, later-prompt, continuation, and
   active-steer paths.
2. Selecting Codex no longer produces an unconditional unsupported warning;
   the control follows the effective Codex model's reported capability.
3. A known text-only Codex model disables image-bearing submission without
   dropping pending text or images, and an unknown or changed capability fails
   visibly without text-only degradation.
4. An accepted Codex attachment reappears with its user message after browser
   and server restart and opens only through the owning project/thread route.
5. A malformed, missing, outside-root, or externally referenced Codex image
   never exposes a local path or triggers an arbitrary filesystem or network
   read.
6. Retrying the same accepted Codex command creates no duplicate run, message,
   or stored attachment; a rejected send retains the browser's pending input.
7. All version 1 Pi acceptance criteria and the arbitrary-Markdown-image ban
   continue to pass unchanged.

## Version 2 non-goals

- A model picker or automatic model substitution
- Fetching remote images found in imported or externally created Codex history
- Rendering arbitrary local-image paths from externally created Codex history
- Moving pending attachment drafts out of browser page memory
- Generic file, PDF, video, audio, generated-image, or assistant-image support
- Changing Pi's image normalization, persistence, or capability rules

## Version 2 open product questions

- None.

## Current revision v3 — Streamlined composer

Version 3 retains all version 2 image transport, storage, history, and capable
model behavior while removing the file-picker row from every composer.

### CIA-11 — No file-picker row

The composer shows no **Add photos** control or native file-input status.
Supported and unknown models retain pane-scoped drag-and-drop and focused image
paste as their attachment ingestion paths. When image input is known
unsupported, drop and paste attempts are ignored without adding a standalone
capability explanation or attachment error. This supersedes CIA-01's explicit
picker requirement and the explanatory-control clauses in CIA-07 and CIA-08.

If images were attached while capability was supported and the capability then
becomes unsupported, their previews remain available for removal and submission
stays blocked until capability returns or the images are removed.

### Version 3 acceptance criteria

1. No composer contains **Add photos** or native **No file chosen** text; known
   unsupported composers also contain no model/settings capability explanation.
2. Switching from supported to unsupported retains existing previews but hides
   the picker and prevents image-bearing submission.
3. Supported and unknown models retain image drop, image paste, and all version
   2 delivery behavior.
