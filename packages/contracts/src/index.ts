import { z } from "zod";

const uuid = z.uuid();
export const ProjectIdSchema = uuid.brand<"ProjectId">();
export const ThreadIdSchema = uuid.brand<"ThreadId">();
export const RunIdSchema = uuid.brand<"RunId">();
export const WorktreeIdSchema = uuid.brand<"WorktreeId">();
export const EventIdSchema = uuid.brand<"EventId">();
export const TerminalIdSchema = uuid.brand<"TerminalId">();
export const SessionIdSchema = uuid.brand<"SessionId">();
export const IdempotencyKeySchema = uuid.brand<"IdempotencyKey">();
export const ChatImageIdSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/)
  .brand<"ChatImageId">();
export const TimestampSchema = z.iso.datetime({ offset: true });
export const ChatImageMimeTypeSchema = z.enum([
  "image/jpeg",
  "image/png",
  "image/webp",
]);
export const ImageInputCapabilitySchema = z.enum([
  "supported",
  "unsupported",
  "unknown",
]);

export const CHAT_IMAGE_MAX_COUNT = 4;
export const CHAT_IMAGE_MAX_SOURCE_BYTES = 10 * 1024 * 1024;
export const CHAT_IMAGE_MAX_TOTAL_SOURCE_BYTES =
  CHAT_IMAGE_MAX_COUNT * CHAT_IMAGE_MAX_SOURCE_BYTES;
export const CHAT_IMAGE_MAX_PIXELS = 64_000_000;
export const CHAT_IMAGE_MAX_DIMENSION = 2_000;
/** Pi's resize helper bounds encoded base64 below 4.5 MiB. */
export const CHAT_IMAGE_MAX_BASE64_BYTES = Math.floor(4.5 * 1024 * 1024);
/** On-demand history may return a bounded, unmodified Codex source image. */
export const CHAT_IMAGE_MAX_RESPONSE_BASE64_BYTES =
  Math.ceil(CHAT_IMAGE_MAX_SOURCE_BYTES / 3) * 4;

function hasBytes(
  bytes: Uint8Array,
  offset: number,
  expected: readonly number[],
): boolean {
  return expected.every((value, index) => bytes[offset + index] === value);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.slice(offset, offset + length));
}

function uint24le(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] ?? 0) |
    ((bytes[offset + 1] ?? 0) << 8) |
    ((bytes[offset + 2] ?? 0) << 16)
  );
}

function uint16be(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function uint16le(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function uint32be(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] ?? 0) * 2 ** 24 +
    ((bytes[offset + 1] ?? 0) << 16) +
    ((bytes[offset + 2] ?? 0) << 8) +
    (bytes[offset + 3] ?? 0)
  );
}

function pngDimensions(
  bytes: Uint8Array,
): { width: number; height: number } | null {
  if (
    bytes.length < 24 ||
    !hasBytes(bytes, 0, [137, 80, 78, 71, 13, 10, 26, 10]) ||
    ascii(bytes, 12, 4) !== "IHDR"
  )
    return null;
  return { width: uint32be(bytes, 16), height: uint32be(bytes, 20) };
}

function jpegDimensions(
  bytes: Uint8Array,
): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset];
    offset += 1;
    if (marker === undefined || marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) return null;
    const length = uint16be(bytes, offset);
    if (length < 2 || offset + length > bytes.length) return null;
    const isStartOfFrame =
      marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isStartOfFrame) {
      if (length < 7) return null;
      return {
        height: uint16be(bytes, offset + 3),
        width: uint16be(bytes, offset + 5),
      };
    }
    offset += length;
  }
  return null;
}

function webpDimensions(
  bytes: Uint8Array,
): { width: number; height: number } | null {
  if (
    bytes.length < 30 ||
    ascii(bytes, 0, 4) !== "RIFF" ||
    ascii(bytes, 8, 4) !== "WEBP"
  )
    return null;
  const chunk = ascii(bytes, 12, 4);
  if (chunk === "VP8X")
    return {
      width: uint24le(bytes, 24) + 1,
      height: uint24le(bytes, 27) + 1,
    };
  if (chunk === "VP8 ") {
    if (
      bytes.length < 30 ||
      bytes[23] !== 0x9d ||
      bytes[24] !== 0x01 ||
      bytes[25] !== 0x2a
    )
      return null;
    return {
      width: uint16le(bytes, 26) & 0x3fff,
      height: uint16le(bytes, 28) & 0x3fff,
    };
  }
  if (chunk === "VP8L") {
    if (bytes.length < 25 || bytes[20] !== 0x2f) return null;
    const b1 = bytes[21] ?? 0;
    const b2 = bytes[22] ?? 0;
    const b3 = bytes[23] ?? 0;
    const b4 = bytes[24] ?? 0;
    return {
      width: 1 + ((b1 | (b2 << 8)) & 0x3fff),
      height: 1 + (((b2 >> 6) | (b3 << 2) | (b4 << 10)) & 0x3fff),
    };
  }
  return null;
}

/** Parses supported chat-image bytes into their bounded native dimensions. */
export function parseChatImageBytes(bytes: Uint8Array): {
  mimeType: ChatImageMimeType;
  width: number;
  height: number;
} {
  const candidates: {
    mimeType: ChatImageMimeType;
    dimensions: { width: number; height: number } | null;
  }[] = [
    { mimeType: "image/png", dimensions: pngDimensions(bytes) },
    { mimeType: "image/jpeg", dimensions: jpegDimensions(bytes) },
    { mimeType: "image/webp", dimensions: webpDimensions(bytes) },
  ];
  const found = candidates.find((candidate) => candidate.dimensions !== null);
  if (found?.dimensions === null || found === undefined)
    throw new Error("chat_image_unsupported");
  const { width, height } = found.dimensions;
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0
  )
    throw new Error("chat_image_malformed");
  if (width * height > CHAT_IMAGE_MAX_PIXELS)
    throw new Error("chat_image_pixels_exceeded");
  return { mimeType: found.mimeType, width, height };
}

export const ChatImageRefSchema = z
  .object({
    id: ChatImageIdSchema,
    mimeType: ChatImageMimeTypeSchema,
  })
  .strict();
export type ChatImageRef = z.infer<typeof ChatImageRefSchema>;

const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function base64Prefix(data: string, maximum: number): number[] | null {
  const output: number[] = [];
  for (
    let offset = 0;
    offset < data.length && output.length < maximum;
    offset += 4
  ) {
    const a = BASE64_ALPHABET.indexOf(data[offset] ?? "");
    const b = BASE64_ALPHABET.indexOf(data[offset + 1] ?? "");
    const cText = data[offset + 2] ?? "=";
    const dText = data[offset + 3] ?? "=";
    const c = cText === "=" ? 0 : BASE64_ALPHABET.indexOf(cText);
    const d = dText === "=" ? 0 : BASE64_ALPHABET.indexOf(dText);
    if (a < 0 || b < 0 || c < 0 || d < 0) return null;
    output.push((a << 2) | (b >> 4));
    if (cText !== "=") output.push(((b & 15) << 4) | (c >> 2));
    if (dText !== "=") output.push(((c & 3) << 6) | d);
  }
  return output;
}

function base64ImageMatchesMime(data: string, mimeType: string): boolean {
  const bytes = base64Prefix(data, 12);
  if (bytes === null) return false;
  if (mimeType === "image/png")
    return [137, 80, 78, 71, 13, 10, 26, 10].every(
      (value, index) => bytes[index] === value,
    );
  if (mimeType === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8;
  return (
    mimeType === "image/webp" &&
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
  );
}

export const ChatImageResponseSchema = z
  .object({
    id: ChatImageIdSchema,
    mimeType: ChatImageMimeTypeSchema,
    data: z
      .string()
      .min(1)
      .max(CHAT_IMAGE_MAX_RESPONSE_BASE64_BYTES)
      .regex(
        /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
      ),
  })
  .strict()
  .superRefine((value, context) => {
    if (!base64ImageMatchesMime(value.data, value.mimeType))
      context.addIssue({ code: "custom", message: "Malformed image data" });
  });
export type ChatImageResponse = z.infer<typeof ChatImageResponseSchema>;

// A chat's agent backend. It is chosen once, at creation, and is immutable for
// the life of the chat: a chat is continued by resuming that backend's own
// native session, and no transcript or tool history transfers between agents.
export const RuntimeKindSchema = z.enum(["pi", "codex"]);
export type RuntimeKind = z.infer<typeof RuntimeKindSchema>;

export const RunStateSchema = z.enum([
  "running",
  "completed",
  "failed",
  "interrupted",
]);

export type ProjectId = z.infer<typeof ProjectIdSchema>;
export type ThreadId = z.infer<typeof ThreadIdSchema>;
export type RunId = z.infer<typeof RunIdSchema>;
export type WorktreeId = z.infer<typeof WorktreeIdSchema>;
export type TerminalId = z.infer<typeof TerminalIdSchema>;
export type SessionId = z.infer<typeof SessionIdSchema>;
export type IdempotencyKey = z.infer<typeof IdempotencyKeySchema>;
export type ChatImageId = z.infer<typeof ChatImageIdSchema>;
export type ChatImageMimeType = z.infer<typeof ChatImageMimeTypeSchema>;
export type ImageInputCapability = z.infer<typeof ImageInputCapabilitySchema>;
export type RunState = z.infer<typeof RunStateSchema>;

/** A Git local branch name safe to use only after repository authorization. */
export const GitBranchSchema = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (value) =>
      !value.startsWith("-") &&
      !value.startsWith("/") &&
      !value.endsWith("/") &&
      !value.endsWith(".") &&
      !value.includes("..") &&
      !value.includes("//") &&
      !value.includes("@{") &&
      value !== "@" &&
      !/[\s~^:?*\\[\0]/.test(value),
    "Invalid Git branch name.",
  )
  .brand<"GitBranch">();
export type GitBranch = z.infer<typeof GitBranchSchema>;

export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string().min(1).max(80),
    message: z.string().min(1).max(500),
    details: z.record(z.string(), z.string()).optional(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

export const ProjectSchema = z.object({
  id: ProjectIdSchema,
  displayName: z.string().min(1).max(200),
  displayPath: z.string().min(1).max(500),
  createdAt: TimestampSchema,
  sidebarExpanded: z.boolean(),
  lastOpenedThreadId: ThreadIdSchema.nullable(),
  available: z.boolean(),
  gitAvailable: z.boolean(),
  unreadCount: z.number().int().nonnegative(),
});
export type Project = z.infer<typeof ProjectSchema>;

export const ThreadWorkspaceSummarySchema = z
  .discriminatedUnion("mode", [
    z.object({
      mode: z.literal("shared"),
      branchName: z.string().min(1).max(255).nullable(),
      available: z.boolean(),
    }),
    z.object({
      mode: z.literal("worktree"),
      worktreeId: WorktreeIdSchema,
      branchName: GitBranchSchema,
      baseBranch: GitBranchSchema,
      baseCommit: z.string().regex(/^[0-9a-f]{7,64}$/),
      available: z.boolean(),
    }),
  ])
  .default({ mode: "shared", branchName: null, available: true });
export type ThreadWorkspaceSummary = z.infer<
  typeof ThreadWorkspaceSummarySchema
>;

export const ThreadSummarySchema = z.object({
  id: ThreadIdSchema,
  projectId: ProjectIdSchema,
  title: z.string().min(1).max(200),
  createdAt: TimestampSchema,
  lastActivityAt: TimestampSchema,
  runState: RunStateSchema.nullable(),
  unread: z.boolean(),
  runtimeAvailable: z.boolean(),
  /** Present when opening this existing backend session is currently unsafe. */
  runtimeUnavailableReason: z.string().max(500).optional(),
  runtime: RuntimeKindSchema,
  workspace: ThreadWorkspaceSummarySchema,
});
export type ThreadSummary = z.infer<typeof ThreadSummarySchema>;

export const RunSchema = z.object({
  id: RunIdSchema,
  threadId: ThreadIdSchema,
  projectId: ProjectIdSchema,
  state: RunStateSchema,
  startedAt: TimestampSchema,
  endedAt: TimestampSchema.nullable(),
  failureCode: z.string().max(80).nullable(),
  failureMessage: z.string().max(500).nullable(),
});
export type Run = z.infer<typeof RunSchema>;

export const TranscriptItemSchema = z.discriminatedUnion("kind", [
  z.object({
    id: z.string().min(1).max(200),
    kind: z.literal("message"),
    role: z.enum(["user", "assistant", "system"]),
    text: z.string().max(2_000_000),
    images: z.array(ChatImageRefSchema).max(CHAT_IMAGE_MAX_COUNT).optional(),
    timestamp: TimestampSchema.nullable(),
  }),
  z.object({
    id: z.string().min(1).max(200),
    kind: z.literal("tool"),
    name: z.string().min(1).max(200),
    status: z.enum(["running", "completed", "failed"]),
    input: z.string().max(200_000),
    output: z.string().max(1_000_000),
    cwd: z.string().max(500).nullable(),
    exitCode: z.number().int().nullable(),
    /**
     * When the step *started* -- the moment the agent issued the call.
     *
     * A tool step is the only transcript item that occupies a span rather
     * than an instant, and the two ends arrive as two separate entries in the
     * native session history. Carrying only one of them made a step's own
     * elapsed time unrepresentable, which is how a 45-second shell command
     * came to be summarised as "Worked for <1s".
     */
    timestamp: TimestampSchema.nullable(),
    /**
     * When the step finished. `null` while it is still running, and
     * `undefined` on a transcript produced before this field existed, so a
     * reader must treat both as "no completion time" rather than as zero.
     */
    completedAt: TimestampSchema.nullable().optional(),
  }),
  z.object({
    id: z.string().min(1).max(200),
    kind: z.literal("diagnostic"),
    level: z.enum(["info", "warning", "error"]),
    text: z.string().max(2_000),
    timestamp: TimestampSchema.nullable(),
  }),
]);
export type TranscriptItem = z.infer<typeof TranscriptItemSchema>;

/**
 * Runtime-owned, opaque paging position. Browsers may return it only to the
 * thread endpoint that issued it; they never decode or construct one.
 */
export const TranscriptCursorSchema = z
  .string()
  .min(16)
  .max(2_048)
  .regex(/^[A-Za-z0-9_-]+$/)
  .brand<"TranscriptCursor">();
export type TranscriptCursor = z.infer<typeof TranscriptCursorSchema>;

export const TranscriptPageSchema = z
  .object({
    items: z.array(TranscriptItemSchema).max(100),
    olderCursor: TranscriptCursorSchema.nullable(),
    atLatest: z.boolean(),
  })
  .strict();
export type TranscriptPage = z.infer<typeof TranscriptPageSchema>;

export const TranscriptPageQuerySchema = z
  .object({ cursor: TranscriptCursorSchema })
  .strict();
export type TranscriptPageQuery = z.infer<typeof TranscriptPageQuerySchema>;

export const ThreadSnapshotSchema = z.object({
  version: z.literal(2),
  project: ProjectSchema,
  thread: ThreadSummarySchema,
  transcriptPage: TranscriptPageSchema,
  currentRun: RunSchema.nullable(),
  lastRun: RunSchema.nullable(),
  epoch: uuid,
  highWaterSequence: z.number().int().nonnegative(),
  capabilities: z.object({
    prompt: z.boolean(),
    steer: z.boolean(),
    stop: z.boolean(),
    imageInput: ImageInputCapabilitySchema.optional(),
  }),
  diagnostics: z.array(z.string().max(500)).max(100),
});
export type ThreadSnapshot = z.infer<typeof ThreadSnapshotSchema>;

export const ProjectsResponseSchema = z.object({
  projects: z.array(ProjectSchema),
  threads: z.array(ThreadSummarySchema),
  diagnostics: z.array(z.string().max(500)),
});
export const ProjectMutationResponseSchema = z.object({
  project: ProjectSchema,
});
export const BrowseProjectResponseSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("selected"), project: ProjectSchema }).strict(),
  z.object({ outcome: z.literal("cancelled") }).strict(),
]);
export type BrowseProjectResponse = z.infer<typeof BrowseProjectResponseSchema>;
export const ThreadMutationResponseSchema = z.object({
  thread: ThreadSummarySchema,
});

export const LocalChangeSummarySchema = z.object({
  staged: z.number().int().nonnegative(),
  modified: z.number().int().nonnegative(),
  deleted: z.number().int().nonnegative(),
  renamed: z.number().int().nonnegative(),
  untracked: z.number().int().nonnegative(),
  files: z.array(z.string().min(1).max(4096)).max(20_000),
  token: z.string().min(16).max(128),
});
export const WorkspacePreflightResponseSchema = z.object({
  worktreeAvailable: z.boolean(),
  imageInput: ImageInputCapabilitySchema.optional(),
  unavailableReason: z.string().min(1).max(500).nullable(),
  currentBranch: z.string().min(1).max(255).nullable(),
  branches: z.array(z.string().min(1).max(255)).max(10_000),
  headCommit: z
    .string()
    .regex(/^[0-9a-f]{7,64}$/)
    .nullable(),
  changes: LocalChangeSummarySchema.nullable(),
});
export const WorkspacePreflightQuerySchema = z
  .object({ runtime: RuntimeKindSchema.optional() })
  .strict();
export type WorkspacePreflightQuery = z.infer<
  typeof WorkspacePreflightQuerySchema
>;
export type WorkspacePreflightResponse = z.infer<
  typeof WorkspacePreflightResponseSchema
>;

export const ThreadWorkspaceRequestSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("shared") }).strict(),
  z
    .object({
      mode: z.literal("worktree"),
      baseBranch: GitBranchSchema,
      sourceChanges: z.enum(["none", "tracked_and_untracked"]),
      sourceStateToken: z.string().min(16).max(128).optional(),
    })
    .strict(),
]);
const ChatPromptTextSchema = z.string().trim().max(200_000);

export const StartThreadRequestSchema = z
  .object({
    prompt: ChatPromptTextSchema.pipe(z.string().min(1)),
    workspace: ThreadWorkspaceRequestSchema,
    runtime: RuntimeKindSchema.optional(),
    idempotencyKey: IdempotencyKeySchema,
  })
  .strict();
export const StartThreadMultipartMetadataSchema = z
  .object({
    prompt: ChatPromptTextSchema,
    workspace: ThreadWorkspaceRequestSchema,
    runtime: RuntimeKindSchema.optional(),
    idempotencyKey: IdempotencyKeySchema,
  })
  .strict();
export const StartThreadResponseSchema = z.object({
  thread: ThreadSummarySchema,
  run: RunSchema,
});

export const BrowseProjectRequestSchema = z
  .object({ idempotencyKey: IdempotencyKeySchema })
  .strict();
/* Adding a project by typing or pasting its path, as the second route in
   beside the native folder picker. The picker is the better path when it
   works; this one exists because it is the only one that still works when
   the picker does not -- it opens as a separate OS window that can land
   behind the browser or on another desktop, and until now a failure there
   left no way to add a project at all.
   `.trim()` because a pasted path routinely carries a trailing newline or a
   leading space from a terminal. The cost is that a directory whose name
   really does end in a space cannot be added THIS way; it can still be added
   with the picker, and that trade is worth one keystroke of forgiveness on
   every ordinary paste.
   The NUL check is structural, not security theatre: this server is loopback
   only and Pi already runs with the user's own permissions, so a path from
   this field grants nothing the picker did not. But a NUL byte truncates a
   path in every C API underneath us, so a string containing one never means
   what it appears to mean and is refused rather than silently reinterpreted.
   Absoluteness is checked on the server with node:path, not here: "absolute"
   is spelled differently on Windows and a regex in a shared contract would
   get one of the two platforms wrong. */
export const AddProjectRequestSchema = z
  .object({
    path: z
      .string()
      .trim()
      .min(1)
      .max(4096)
      .refine((value) => !value.includes("\u0000"), {
        message: "A project path cannot contain a NUL byte.",
      }),
    idempotencyKey: IdempotencyKeySchema,
  })
  .strict();
export type AddProjectRequest = z.infer<typeof AddProjectRequestSchema>;
export const UpdateProjectRequestSchema = z
  .object({
    sidebarExpanded: z.boolean(),
    idempotencyKey: IdempotencyKeySchema,
  })
  .strict();
export const RemoveProjectRequestSchema = z
  .object({ idempotencyKey: IdempotencyKeySchema })
  .strict();
export const CreateThreadRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    runtime: RuntimeKindSchema.optional(),
    idempotencyKey: IdempotencyKeySchema,
  })
  .strict();
export const RenameThreadRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    idempotencyKey: IdempotencyKeySchema,
  })
  .strict();
export const ArchiveThreadRequestSchema = z
  .object({ idempotencyKey: IdempotencyKeySchema })
  .strict();
export const ArchiveThreadResponseSchema = z
  .object({ archived: z.literal(true) })
  .strict();
// Archiving is reversible: a thread that leaves the sidebar can be listed
// under the project's Archived section and restored. Without this, archive
// was a one-way door whose only recovery was editing the database by hand.
export const UnarchiveThreadRequestSchema = z
  .object({ idempotencyKey: IdempotencyKeySchema })
  .strict();
export const UnarchiveThreadResponseSchema = z
  .object({ archived: z.literal(false) })
  .strict();
export const ArchivedThreadsResponseSchema = z
  .object({ threads: z.array(ThreadSummarySchema) })
  .strict();
export const ImportThreadRequestSchema = z
  .object({
    runtimeSessionId: SessionIdSchema,
    title: z.string().trim().min(1).max(200).optional(),
    runtime: RuntimeKindSchema.optional(),
    idempotencyKey: IdempotencyKeySchema,
  })
  .strict();
export const ContinueThreadPreflightResponseSchema = z
  .object({
    available: z.literal(true),
    imageInput: ImageInputCapabilitySchema.optional(),
  })
  .strict();
export const ContinueThreadRequestSchema = z
  .object({
    prompt: z.string().trim().min(1).max(200_000),
    idempotencyKey: IdempotencyKeySchema,
  })
  .strict();
export const ContinueThreadResponseSchema = z
  .object({ thread: ThreadSummarySchema, run: RunSchema })
  .strict();
export const PromptRequestSchema = z
  .object({
    prompt: ChatPromptTextSchema.pipe(z.string().min(1)),
    idempotencyKey: IdempotencyKeySchema,
  })
  .strict();
export const SteerRequestSchema = z
  .object({
    prompt: ChatPromptTextSchema.pipe(z.string().min(1)),
    idempotencyKey: IdempotencyKeySchema,
  })
  .strict();
export const ChatCommandMultipartMetadataSchema = z
  .object({
    prompt: ChatPromptTextSchema,
    idempotencyKey: IdempotencyKeySchema,
  })
  .strict();
export const CommandRequestSchema = z
  .object({ idempotencyKey: IdempotencyKeySchema })
  .strict();
export const RunMutationResponseSchema = z.object({ run: RunSchema });

export const SessionDescriptorSchema = z.object({
  id: z.uuid(),
  name: z.string().max(200).nullable(),
  createdAt: TimestampSchema,
  modifiedAt: TimestampSchema,
  messageCount: z.number().int().nonnegative(),
  preview: z.string().max(500),
  imported: z.boolean(),
  runtime: RuntimeKindSchema,
});
export type SessionDescriptor = z.infer<typeof SessionDescriptorSchema>;

// The browser needs both halves to render the composer's backend choice: which
// backend a new chat gets by default (AGB-02), and which are usable on this
// machine so an unusable one can be shown disabled with its reason (AGB-03).
export const AgentBackendSchema = z.object({
  kind: RuntimeKindSchema,
  available: z.boolean(),
  reason: z.string().max(300).nullable(),
});
export const AgentBackendsResponseSchema = z.object({
  defaultRuntime: RuntimeKindSchema,
  backends: z.array(AgentBackendSchema),
});
export type AgentBackend = z.infer<typeof AgentBackendSchema>;
export type AgentBackendsResponse = z.infer<typeof AgentBackendsResponseSchema>;
export const SessionsResponseSchema = z.object({
  sessions: z.array(SessionDescriptorSchema),
  diagnostics: z.array(z.string()),
});

export const RelativePathSchema = z
  .string()
  .max(4096)
  .superRefine((value, context) => {
    if (
      value.includes("\0") ||
      value.includes("\\") ||
      value.startsWith("/") ||
      /^[A-Za-z]:/.test(value)
    ) {
      context.addIssue({
        code: "custom",
        message: "Path must be project-relative",
      });
      return;
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(value);
    } catch {
      context.addIssue({ code: "custom", message: "Malformed path encoding" });
      return;
    }
    const segments = decoded.split("/");
    if (
      segments.some(
        (segment) => segment === "" || segment === "." || segment === "..",
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "Path contains an invalid segment",
      });
    }
  });

export const FileEntrySchema = z.object({
  path: z.string(),
  name: z.string(),
  kind: z.enum(["file", "directory", "symlink"]),
  size: z.number().int().nonnegative().nullable(),
});
export const FileTreeResponseSchema = z.object({
  entries: z.array(FileEntrySchema),
  truncated: z.boolean(),
  // Whether this listing omitted anything because the working tree's ignore
  // rules matched it. The browser states it rather than under-reporting
  // quietly (WSP-05 as revised by specification version 2). `.git` is not an
  // ignore rule and never sets this.
  ignoredHidden: z.boolean(),
});
export const FilePreviewResponseSchema = z.object({
  path: z.string(),
  language: z.string().nullable(),
  content: z.string(),
  binary: z.boolean(),
  truncated: z.boolean(),
});

export const GitFileStatusSchema = z.object({
  path: z.string(),
  originalPath: z.string().nullable(),
  indexStatus: z.string().max(1),
  worktreeStatus: z.string().max(1),
  kind: z.enum([
    "added",
    "modified",
    "deleted",
    "renamed",
    "copied",
    "untracked",
    "conflicted",
  ]),
});
export type GitFileStatus = z.infer<typeof GitFileStatusSchema>;
export const GitStatusResponseSchema = z.object({
  available: z.boolean(),
  files: z.array(GitFileStatusSchema),
  message: z.string().nullable(),
});
export const GitDiffResponseSchema = z.object({
  path: z.string(),
  staged: z.string(),
  unstaged: z.string(),
  truncated: z.boolean(),
});

export const LiveSubscribeSchema = z
  .object({
    version: z.literal(1),
    type: z.literal("subscribe"),
    threadId: ThreadIdSchema,
    epoch: uuid.optional(),
    cursor: z.number().int().nonnegative().optional(),
  })
  .strict();
export const LiveEventSchema = z.object({
  version: z.literal(1),
  type: z.literal("event"),
  threadId: ThreadIdSchema,
  epoch: uuid,
  sequence: z.number().int().positive(),
  eventId: EventIdSchema,
  eventType: z.enum(["transcript", "run", "completion", "diagnostic"]),
  payload: z.unknown(),
});
export const LiveSnapshotRequiredSchema = z.object({
  version: z.literal(1),
  type: z.literal("snapshot_required"),
  threadId: ThreadIdSchema,
});
/**
 * The payload of a `diagnostic` live event.
 *
 * `LiveEventSchema.payload` is `unknown` because four event types share the
 * envelope, so the shape has to be asserted per type at the point of use --
 * exactly as `TranscriptItemSchema` is for `transcript`. The server
 * republishes the runtime's whole diagnostic event (`workspace.ts`
 * `onRuntimeEvent`), which is why the redundant `type` discriminator is still
 * on the payload.
 *
 * `code` is optional because it post-dates the field it explains: a runtime
 * that predates it still sends level and message.
 */
export const LiveDiagnosticSchema = z.object({
  type: z.literal("diagnostic"),
  level: z.enum(["info", "warning", "error"]),
  message: z.string().min(1).max(2_000),
  code: z.string().min(1).max(80).optional(),
});
export type LiveDiagnostic = z.infer<typeof LiveDiagnosticSchema>;

/**
 * What a terminal may be resized to.
 *
 * Exported because the client has to obey these bounds BEFORE it sends a
 * frame, not discover them from a rejection: the fit addon happily proposes
 * `rows: 1` for a group shrunk to its floor, and a frame the schema refuses
 * costs the user an error in their shell (F1). The schema below is built
 * from these constants, and the server's own resize guard reads them, so
 * there is exactly one place the numbers live.
 */
export const TERMINAL_MIN_COLUMNS = 2;
export const TERMINAL_MAX_COLUMNS = 500;
export const TERMINAL_MIN_ROWS = 2;
export const TERMINAL_MAX_ROWS = 200;

/**
 * How many terminals one execution scope may hold at once (WSP-07).
 *
 * Exported for the same reason the size bounds are: the browser states the
 * limit to the user when it is reached, and a number the message invents
 * separately from the number the server enforces would eventually disagree
 * with it. Shared threads count against their project scope, isolated
 * threads against their worktree scope.
 */
export const TERMINAL_MAX_PER_SCOPE = 8;

/**
 * A workspace-relative display path, where `""` is the execution root.
 *
 * {@link RelativePathSchema} rejects the empty string, because an empty
 * segment is how traversal spellings start. A DISPLAYED directory, though,
 * genuinely can be the root itself, so the root is spelled `""` in what the
 * server reports and by OMITTING the field in what the client asks for.
 * Absolute server paths never appear in a browser DTO, here or anywhere.
 */
export const WorkspaceDisplayPathSchema = z.union([
  z.literal(""),
  RelativePathSchema,
]);

/**
 * The terminal rejections a client has to act on differently.
 *
 * Reaching the per-scope cap, naming a terminal that is gone, and asking for
 * a spawn directory outside the execution root each need their own state in
 * the tab — a cap message, a restart action, a refused path. They used to be
 * one untyped string, which a client could only tell apart by matching on
 * prose (D-2).
 */
export const TerminalErrorCodeSchema = z.enum([
  "terminal_limit_reached",
  "terminal_gone",
  "terminal_cwd_invalid",
]);
export type TerminalErrorCode = z.infer<typeof TerminalErrorCodeSchema>;

/** A proposed size brought inside {@link TerminalClientFrameSchema}'s bounds. */
export function clampTerminalSize(
  columns: number,
  rows: number,
): { columns: number; rows: number } {
  return {
    columns: clampDimension(
      columns,
      TERMINAL_MIN_COLUMNS,
      TERMINAL_MAX_COLUMNS,
    ),
    rows: clampDimension(rows, TERMINAL_MIN_ROWS, TERMINAL_MAX_ROWS),
  };
}

function clampDimension(
  value: number,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}

export const TerminalClientFrameSchema = z.discriminatedUnion("type", [
  z.object({
    version: z.literal(1),
    type: z.literal("attach"),
    projectId: ProjectIdSchema,
    threadId: ThreadIdSchema,
    /**
     * Which terminal to re-attach to (WSP-07). With one, this claims that
     * existing terminal — the reload path, which replays its scrollback.
     * Without one, it takes a new terminal, exactly as `create` does.
     */
    terminalId: TerminalIdSchema.optional(),
    /** Spawn directory for a terminal this frame creates; root when absent. */
    cwd: RelativePathSchema.optional(),
  }),
  z.object({
    version: z.literal(1),
    type: z.literal("create"),
    projectId: ProjectIdSchema,
    threadId: ThreadIdSchema,
    cwd: RelativePathSchema.optional(),
  }),
  z.object({
    version: z.literal(1),
    type: z.literal("input"),
    projectId: ProjectIdSchema,
    threadId: ThreadIdSchema,
    terminalId: TerminalIdSchema,
    data: z.string().max(65_536),
  }),
  z.object({
    version: z.literal(1),
    type: z.literal("resize"),
    projectId: ProjectIdSchema,
    threadId: ThreadIdSchema,
    terminalId: TerminalIdSchema,
    columns: z
      .number()
      .int()
      .min(TERMINAL_MIN_COLUMNS)
      .max(TERMINAL_MAX_COLUMNS),
    rows: z.number().int().min(TERMINAL_MIN_ROWS).max(TERMINAL_MAX_ROWS),
  }),
  z.object({
    version: z.literal(1),
    type: z.literal("restart"),
    projectId: ProjectIdSchema,
    threadId: ThreadIdSchema,
    terminalId: TerminalIdSchema,
    /**
     * Where the replacement starts. A restart disposes the process and
     * creates another, so the replacement has no directory of its own to
     * inherit — the tab supplies the one it recorded, which is what makes
     * "restart carries the working directory forward" true (WSP-07). The
     * observed directory cannot serve here: it is `null` wherever the
     * platform cannot answer, and the tab's record is not.
     */
    cwd: RelativePathSchema.optional(),
  }),
  z.object({
    version: z.literal(1),
    type: z.literal("terminate"),
    projectId: ProjectIdSchema,
    threadId: ThreadIdSchema,
    terminalId: TerminalIdSchema,
  }),
]);
export const TerminalServerFrameSchema = z.discriminatedUnion("type", [
  z.object({
    version: z.literal(1),
    type: z.literal("ready"),
    projectId: ProjectIdSchema,
    terminalId: TerminalIdSchema,
  }),
  z.object({
    version: z.literal(1),
    type: z.literal("output"),
    projectId: ProjectIdSchema,
    data: z.string().max(1_048_576),
  }),
  z.object({
    version: z.literal(1),
    type: z.literal("exit"),
    projectId: ProjectIdSchema,
    exitCode: z.number().int(),
    signal: z.number().int().nullable(),
  }),
  z.object({
    version: z.literal(1),
    type: z.literal("reset"),
    projectId: ProjectIdSchema,
    reason: z.string(),
  }),
  z.object({
    version: z.literal(1),
    type: z.literal("error"),
    projectId: ProjectIdSchema.optional(),
    message: z.string().max(500),
    code: TerminalErrorCodeSchema.optional(),
  }),
  z.object({
    version: z.literal(1),
    type: z.literal("cwd"),
    projectId: ProjectIdSchema,
    terminalId: TerminalIdSchema,
    /**
     * The directory the shell is in, reduced against its execution root:
     * `""` for the root itself, a relative path for a descendant, and `null`
     * where it cannot be observed — an unsupported platform, a process the
     * server cannot see, or a shell that has `cd`'d out of the worktree. A
     * `null` is not a stale value: the tab shows the directory it was
     * STARTED in and says so, rather than presenting one as the other.
     */
    cwd: WorkspaceDisplayPathSchema.nullable(),
  }),
]);
export type TerminalServerFrame = z.infer<typeof TerminalServerFrameSchema>;

/**
 * One live terminal of an execution scope, as the listing route reports it.
 *
 * The route exists so a reloaded browser can reclaim the shells it has the
 * ids of rather than orphaning them (WSP-07). `cwd` is the same observed,
 * workspace-relative value the `cwd` frame carries, and is `null` for the
 * same reasons.
 */
export const TerminalDescriptorSchema = z.object({
  id: TerminalIdSchema,
  cwd: WorkspaceDisplayPathSchema.nullable(),
});
export const TerminalsResponseSchema = z.object({
  terminals: z.array(TerminalDescriptorSchema),
});
export type TerminalDescriptor = z.infer<typeof TerminalDescriptorSchema>;

export function parseContract<T>(schema: z.ZodType<T>, value: unknown): T {
  return schema.parse(value);
}
