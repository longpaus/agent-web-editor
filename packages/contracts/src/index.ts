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
export const TimestampSchema = z.iso.datetime({ offset: true });
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
    timestamp: TimestampSchema.nullable(),
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

export const TranscriptCursorSchema = z
  .string()
  .min(16)
  .max(2_048)
  .regex(/^[A-Za-z0-9_-]+$/)
  .brand<"TranscriptCursor">();
export type TranscriptCursor = z.infer<typeof TranscriptCursorSchema>;

export const TranscriptPageDirectionSchema = z.enum([
  "older",
  "newer",
  "resume",
]);
export type TranscriptPageDirection = z.infer<
  typeof TranscriptPageDirectionSchema
>;

export const TranscriptPageRequestSchema = z
  .object({
    cursor: TranscriptCursorSchema,
    direction: TranscriptPageDirectionSchema,
  })
  .strict();
export type TranscriptPageRequest = z.infer<typeof TranscriptPageRequestSchema>;

export const TranscriptPageSchema = z
  .object({
    items: z.array(TranscriptItemSchema).max(100),
    olderCursor: TranscriptCursorSchema.nullable(),
    newerCursor: TranscriptCursorSchema.nullable(),
    resumeCursor: TranscriptCursorSchema,
    atLatest: z.boolean(),
  })
  .strict();
export type TranscriptPage = z.infer<typeof TranscriptPageSchema>;

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
  }),
  diagnostics: z.array(z.string().max(500)).max(100),
});
export type ThreadSnapshot = z.infer<typeof ThreadSnapshotSchema>;

export const ThreadLiveMetadataSchema = z
  .object({
    version: z.literal(1),
    currentRun: RunSchema.nullable(),
    lastRun: RunSchema.nullable(),
    epoch: uuid,
    highWaterSequence: z.number().int().nonnegative(),
    capabilities: z.object({
      prompt: z.boolean(),
      steer: z.boolean(),
      stop: z.boolean(),
    }),
  })
  .strict();
export type ThreadLiveMetadata = z.infer<typeof ThreadLiveMetadataSchema>;

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
  unavailableReason: z.string().min(1).max(500).nullable(),
  currentBranch: z.string().min(1).max(255).nullable(),
  branches: z.array(z.string().min(1).max(255)).max(10_000),
  headCommit: z
    .string()
    .regex(/^[0-9a-f]{7,64}$/)
    .nullable(),
  changes: LocalChangeSummarySchema.nullable(),
});
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
export const StartThreadRequestSchema = z
  .object({
    prompt: z.string().trim().min(1).max(200_000),
    workspace: ThreadWorkspaceRequestSchema,
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
export const ImportThreadRequestSchema = z
  .object({
    runtimeSessionId: SessionIdSchema,
    title: z.string().trim().min(1).max(200).optional(),
    idempotencyKey: IdempotencyKeySchema,
  })
  .strict();
export const PromptRequestSchema = z
  .object({
    prompt: z.string().trim().min(1).max(200_000),
    idempotencyKey: IdempotencyKeySchema,
  })
  .strict();
export const SteerRequestSchema = z
  .object({
    prompt: z.string().trim().min(1).max(200_000),
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
});
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

export const TerminalClientFrameSchema = z.discriminatedUnion("type", [
  z.object({
    version: z.literal(1),
    type: z.literal("attach"),
    projectId: ProjectIdSchema,
    threadId: ThreadIdSchema,
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
    columns: z.number().int().min(2).max(500),
    rows: z.number().int().min(2).max(200),
  }),
  z.object({
    version: z.literal(1),
    type: z.literal("restart"),
    projectId: ProjectIdSchema,
    threadId: ThreadIdSchema,
    terminalId: TerminalIdSchema,
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
  }),
]);
export type TerminalServerFrame = z.infer<typeof TerminalServerFrameSchema>;

export function parseContract<T>(schema: z.ZodType<T>, value: unknown): T {
  return schema.parse(value);
}
