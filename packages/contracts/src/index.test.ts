import { describe, expect, it } from "vitest";

import {
  ArchiveThreadRequestSchema,
  ArchiveThreadResponseSchema,
  UnarchiveThreadRequestSchema,
  UnarchiveThreadResponseSchema,
  BrowseProjectRequestSchema,
  BrowseProjectResponseSchema,
  ChatCommandMultipartMetadataSchema,
  ChatImageResponseSchema,
  StartThreadMultipartMetadataSchema,
  LiveDiagnosticSchema,
  ProjectIdSchema,
  SessionIdSchema,
  RelativePathSchema,
  StartThreadRequestSchema,
  CreateThreadRequestSchema,
  ImportThreadRequestSchema,
  RuntimeKindSchema,
  SessionDescriptorSchema,
  ThreadSummarySchema,
  GitBranchSchema,
  TerminalClientFrameSchema,
  TranscriptCursorSchema,
  TranscriptPageSchema,
  TerminalServerFrameSchema,
  TerminalsResponseSchema,
  WorkspacePreflightQuerySchema,
  TERMINAL_MAX_PER_SCOPE,
} from "./index.js";

const id = "00000000-0000-4000-8000-000000000001";
const threadId = "00000000-0000-4000-8000-000000000003";

describe("wire contracts", () => {
  it("constructs opaque identifiers", () => {
    expect(ProjectIdSchema.parse(id)).toBe(id);
    expect(SessionIdSchema.parse(id)).toBe(id);
  });

  it("parses strict browse requests and selected or cancelled outcomes", () => {
    expect(BrowseProjectRequestSchema.parse({ idempotencyKey: id })).toEqual({
      idempotencyKey: id,
    });
    expect(
      BrowseProjectRequestSchema.safeParse({
        idempotencyKey: id,
        path: "/tmp/project",
      }).success,
    ).toBe(false);
    expect(BrowseProjectResponseSchema.parse({ outcome: "cancelled" })).toEqual(
      { outcome: "cancelled" },
    );
    expect(
      BrowseProjectResponseSchema.safeParse({
        outcome: "cancelled",
        path: "/tmp/project",
      }).success,
    ).toBe(false);
  });

  it("allows image-only multipart metadata while keeping text-only JSON non-empty", () => {
    expect(
      ChatCommandMultipartMetadataSchema.parse({
        prompt: "",
        idempotencyKey: id,
      }),
    ).toEqual({ prompt: "", idempotencyKey: id });
    expect(
      StartThreadMultipartMetadataSchema.safeParse({
        prompt: "",
        workspace: { mode: "shared" },
        idempotencyKey: id,
        extra: true,
      }).success,
    ).toBe(false);
    expect(
      StartThreadRequestSchema.safeParse({
        prompt: "",
        workspace: { mode: "shared" },
        idempotencyKey: id,
      }).success,
    ).toBe(false);
  });

  it("parses bounded conversation image responses", () => {
    const imageId = "a".repeat(64);
    expect(
      ChatImageResponseSchema.parse({
        id: imageId,
        mimeType: "image/png",
        data: "iVBORw0KGgo=",
      }),
    ).toEqual({ id: imageId, mimeType: "image/png", data: "iVBORw0KGgo=" });
    expect(
      ChatImageResponseSchema.safeParse({
        id: imageId,
        mimeType: "image/svg+xml",
        data: "iVBORw0KGgo=",
      }).success,
    ).toBe(false);
  });

  it("accepts only a known optional runtime for workspace preflight", () => {
    expect(WorkspacePreflightQuerySchema.parse({ runtime: "codex" })).toEqual({
      runtime: "codex",
    });
    expect(WorkspacePreflightQuerySchema.parse({})).toEqual({});
    expect(
      WorkspacePreflightQuerySchema.safeParse({ runtime: "claude" }).success,
    ).toBe(false);
  });

  it("parses explicit clean and local-change worktree starts", () => {
    expect(
      StartThreadRequestSchema.parse({
        prompt: "Build worktrees",
        workspace: {
          mode: "worktree",
          baseBranch: "main",
          sourceChanges: "none",
        },
        idempotencyKey: id,
      }).workspace,
    ).toMatchObject({ mode: "worktree", sourceChanges: "none" });
    expect(
      StartThreadRequestSchema.safeParse({
        prompt: "Build worktrees",
        workspace: {
          mode: "worktree",
          baseBranch: "main",
          sourceChanges: "tracked_and_untracked",
          path: "/tmp/unsafe",
        },
        idempotencyKey: id,
      }).success,
    ).toBe(false);
  });

  it.each(["../main", "main..next", "main/", "-main", "main branch"])(
    "rejects malformed Git branch %s",
    (branch) => {
      expect(GitBranchSchema.safeParse(branch).success).toBe(false);
    },
  );

  it("parses strict archive commands and acknowledgements", () => {
    expect(ArchiveThreadRequestSchema.parse({ idempotencyKey: id })).toEqual({
      idempotencyKey: id,
    });
    expect(
      ArchiveThreadRequestSchema.safeParse({
        idempotencyKey: id,
        archived: true,
      }).success,
    ).toBe(false);
    expect(ArchiveThreadResponseSchema.parse({ archived: true })).toEqual({
      archived: true,
    });
    expect(
      ArchiveThreadResponseSchema.safeParse({ archived: false }).success,
    ).toBe(false);
  });

  it("parses strict unarchive commands and acknowledgements", () => {
    expect(UnarchiveThreadRequestSchema.parse({ idempotencyKey: id })).toEqual({
      idempotencyKey: id,
    });
    expect(
      UnarchiveThreadRequestSchema.safeParse({
        idempotencyKey: id,
        archived: false,
      }).success,
    ).toBe(false);
    expect(UnarchiveThreadResponseSchema.parse({ archived: false })).toEqual({
      archived: false,
    });
    // The two acknowledgements are not interchangeable in either direction.
    expect(
      UnarchiveThreadResponseSchema.safeParse({ archived: true }).success,
    ).toBe(false);
  });

  it.each([
    "../secret",
    "a/../secret",
    "/etc/passwd",
    "C:/secret",
    "a\\b",
    "a/%2e%2e/b",
    "a//b",
    "a\0b",
  ])("rejects unsafe relative path %s", (path) => {
    expect(RelativePathSchema.safeParse(path).success).toBe(false);
  });

  it("accepts a normalized project-relative path", () => {
    expect(RelativePathSchema.parse("src/features/App.tsx")).toBe(
      "src/features/App.tsx",
    );
  });

  it("does not coerce terminal dimensions", () => {
    expect(
      TerminalClientFrameSchema.safeParse({
        version: 1,
        type: "resize",
        projectId: id,
        columns: "80",
        rows: 24,
      }).success,
    ).toBe(false);
  });

  it("requires a terminal ID for terminal controls", () => {
    const terminalId = "00000000-0000-4000-8000-000000000002";
    expect(
      TerminalClientFrameSchema.parse({
        version: 1,
        type: "input",
        projectId: id,
        threadId,
        terminalId,
        data: "echo ready",
      }),
    ).toMatchObject({ type: "input", terminalId });
    for (const frame of [
      { version: 1, type: "input", projectId: id, data: "echo missing" },
      {
        version: 1,
        type: "resize",
        projectId: id,
        terminalId: "not-a-uuid",
        columns: 80,
        rows: 24,
      },
      { version: 1, type: "restart", projectId: id },
      { version: 1, type: "terminate", projectId: id },
    ])
      expect(TerminalClientFrameSchema.safeParse(frame).success).toBe(false);
  });

  it("requires a thread ID for every terminal frame", () => {
    const terminalId = "00000000-0000-4000-8000-000000000002";
    for (const frame of [
      { version: 1, type: "attach", projectId: id },
      {
        version: 1,
        type: "input",
        projectId: id,
        terminalId,
        data: "echo missing",
      },
      {
        version: 1,
        type: "resize",
        projectId: id,
        terminalId,
        columns: 80,
        rows: 24,
      },
      { version: 1, type: "restart", projectId: id, terminalId },
      { version: 1, type: "terminate", projectId: id, terminalId },
    ])
      expect(TerminalClientFrameSchema.safeParse(frame).success).toBe(false);
  });

  // WSP-07: several terminals per execution scope. `attach` naming a terminal
  // is a RE-ATTACH to that one; `attach` naming none takes a new one, and
  // `create` always makes one. A reloaded browser therefore reclaims its own
  // shells by identity rather than by luck of a scope key.
  it("distinguishes re-attaching to a named terminal from taking a new one", () => {
    const terminalId = "00000000-0000-4000-8000-000000000002";
    expect(
      TerminalClientFrameSchema.parse({
        version: 1,
        type: "attach",
        projectId: id,
        threadId,
        terminalId,
      }),
    ).toMatchObject({ type: "attach", terminalId });
    expect(
      TerminalClientFrameSchema.parse({
        version: 1,
        type: "attach",
        projectId: id,
        threadId,
      }),
    ).not.toHaveProperty("terminalId");
    expect(
      TerminalClientFrameSchema.parse({
        version: 1,
        type: "create",
        projectId: id,
        threadId,
        cwd: "apps/server",
      }),
    ).toMatchObject({ type: "create", cwd: "apps/server" });
    // A create still needs to know which worktree it is creating in.
    expect(
      TerminalClientFrameSchema.safeParse({
        version: 1,
        type: "create",
        projectId: id,
      }).success,
    ).toBe(false);
  });

  // The spawn directory is client text that becomes a filesystem path, so it
  // is held to exactly the rules every other path on this wire obeys. The
  // execution root is spelled by OMITTING the field: the relative-path schema
  // rejects the empty string, and inventing a second spelling for the root
  // would be a second thing for the server to have to contain.
  it("holds a terminal's spawn directory to the relative-path rules", () => {
    for (const cwd of ["/etc", "../secret", "a/../b", "a\0b", "a//b"])
      for (const type of ["attach", "create", "restart"] as const)
        expect(
          TerminalClientFrameSchema.safeParse({
            version: 1,
            type,
            projectId: id,
            threadId,
            terminalId: "00000000-0000-4000-8000-000000000002",
            cwd,
          }).success,
        ).toBe(false);
  });

  // A rejection the client has to act on differently — the per-scope cap, a
  // stale id, a refused directory — carries a code. Without one the client
  // could only match on prose (D-2).
  it("types the rejections a terminal client must tell apart", () => {
    expect(
      TerminalServerFrameSchema.parse({
        version: 1,
        type: "error",
        projectId: id,
        message: "Too many terminals.",
        code: "terminal_limit_reached",
      }),
    ).toMatchObject({ code: "terminal_limit_reached" });
    // Still optional: an untyped refusal is the ordinary case.
    expect(
      TerminalServerFrameSchema.parse({
        version: 1,
        type: "error",
        message: "Terminal command was rejected.",
      }),
    ).not.toHaveProperty("code");
    expect(
      TerminalServerFrameSchema.safeParse({
        version: 1,
        type: "error",
        message: "Unknown",
        code: "something_else",
      }).success,
    ).toBe(false);
  });

  // The observed working directory is a WORKSPACE-RELATIVE display path:
  // `""` is the execution root, and `null` means it could not be observed —
  // an unsupported platform, or a shell that has left the worktree. An
  // absolute server path never appears in a browser DTO.
  it("carries an observed directory as a relative display path or nothing", () => {
    const terminalId = "00000000-0000-4000-8000-000000000002";
    for (const cwd of ["", "apps/web", null])
      expect(
        TerminalServerFrameSchema.parse({
          version: 1,
          type: "cwd",
          projectId: id,
          terminalId,
          cwd,
        }),
      ).toMatchObject({ type: "cwd", cwd });
    for (const cwd of ["/Users/someone/project", "../elsewhere"])
      expect(
        TerminalServerFrameSchema.safeParse({
          version: 1,
          type: "cwd",
          projectId: id,
          terminalId,
          cwd,
        }).success,
      ).toBe(false);
  });

  it("lists the live terminals of one scope by identity and directory", () => {
    const terminalId = "00000000-0000-4000-8000-000000000002";
    expect(
      TerminalsResponseSchema.parse({
        terminals: [
          { id: terminalId, cwd: "" },
          { id: id, cwd: null },
        ],
      }).terminals,
    ).toHaveLength(2);
    expect(
      TerminalsResponseSchema.safeParse({
        terminals: [{ id: terminalId, cwd: "/absolute" }],
      }).success,
    ).toBe(false);
    // The cap is a number the browser states to the user, so it lives with
    // the frames rather than only inside the server that enforces it.
    expect(TERMINAL_MAX_PER_SCOPE).toBe(8);
  });
});

// `LiveEventSchema.payload` is `unknown` because four event types share one
// envelope, so a diagnostic payload has to be asserted at the point of use —
// the same arrangement `transcript` already has with TranscriptItemSchema.
// Before this existed there was nothing to assert it WITH, which is part of
// why the client used diagnostics only as a refetch trigger.
describe("LiveDiagnosticSchema", () => {
  it("accepts the payload the server republishes, code and all", () => {
    expect(
      LiveDiagnosticSchema.parse({
        type: "diagnostic",
        level: "warning",
        code: "provider_retry",
        message: "Provider retry 2 of 5.",
      }),
    ).toEqual({
      type: "diagnostic",
      level: "warning",
      code: "provider_retry",
      message: "Provider retry 2 of 5.",
    });
  });

  it("accepts a runtime that predates the code field", () => {
    expect(
      LiveDiagnosticSchema.safeParse({
        type: "diagnostic",
        level: "info",
        message: "Compacted the session.",
      }).success,
    ).toBe(true);
  });

  it("rejects payloads from the envelope's other event types", () => {
    for (const payload of [
      { type: "transcript", level: "warning", message: "x" },
      { type: "diagnostic", level: "fatal", message: "x" },
      { type: "diagnostic", level: "warning", message: "" },
      { type: "diagnostic", level: "warning" },
    ])
      expect(LiveDiagnosticSchema.safeParse(payload).success).toBe(false);
  });
});

describe("bounded transcript pages", () => {
  const message = (index: number) => ({
    id: `message-${String(index)}`,
    kind: "message" as const,
    role: "assistant" as const,
    text: `message ${String(index)}`,
    timestamp: null,
  });

  it("accepts one strict bounded chronological page", () => {
    const cursor = TranscriptCursorSchema.parse("abcdefghijklmnop");
    expect(
      TranscriptPageSchema.parse({
        items: [message(1), message(2)],
        olderCursor: cursor,
        atLatest: true,
      }).items,
    ).toHaveLength(2);
    expect(
      TranscriptPageSchema.safeParse({
        items: [],
        olderCursor: null,
        atLatest: true,
        nativePath: "/private/history.jsonl",
      }).success,
    ).toBe(false);
  });

  it("rejects more than 100 wire items and malformed cursors", () => {
    expect(
      TranscriptPageSchema.safeParse({
        items: Array.from({ length: 101 }, (_, index) => message(index)),
        olderCursor: null,
        atLatest: false,
      }).success,
    ).toBe(false);
    expect(TranscriptCursorSchema.safeParse("../history").success).toBe(false);
  });
});

describe("agent backend runtime kind", () => {
  const summary = {
    id: threadId,
    projectId: id,
    title: "A chat",
    createdAt: "2026-08-22T00:00:00.000Z",
    lastActivityAt: "2026-08-22T00:00:00.000Z",
    runState: null,
    unread: false,
    runtimeAvailable: true,
    runtime: "codex",
    workspace: { mode: "shared", branchName: "main", available: true },
  };

  it("accepts exactly the two supported backends", () => {
    expect(RuntimeKindSchema.parse("pi")).toBe("pi");
    expect(RuntimeKindSchema.parse("codex")).toBe("codex");
    for (const value of ["claude", "PI", "", "codex ", null, 1])
      expect(RuntimeKindSchema.safeParse(value).success).toBe(false);
  });

  it("requires a backend on every thread summary", () => {
    expect(ThreadSummarySchema.parse(summary).runtime).toBe("codex");
    const { runtime, ...withoutRuntime } = summary;
    expect(runtime).toBe("codex");
    expect(ThreadSummarySchema.safeParse(withoutRuntime).success).toBe(false);
    expect(
      ThreadSummarySchema.safeParse({ ...summary, runtime: "claude" }).success,
    ).toBe(false);
  });

  it("treats the backend as optional when starting a chat", () => {
    const request = {
      prompt: "Start on Codex",
      workspace: { mode: "shared" as const },
      idempotencyKey: id,
    };
    expect(StartThreadRequestSchema.parse(request).runtime).toBeUndefined();
    expect(
      StartThreadRequestSchema.parse({ ...request, runtime: "pi" }).runtime,
    ).toBe("pi");
    expect(
      StartThreadRequestSchema.safeParse({ ...request, runtime: "claude" })
        .success,
    ).toBe(false);
  });

  it("treats the backend as optional when creating or importing a chat", () => {
    expect(
      CreateThreadRequestSchema.parse({ idempotencyKey: id }).runtime,
    ).toBeUndefined();
    expect(
      CreateThreadRequestSchema.parse({ idempotencyKey: id, runtime: "codex" })
        .runtime,
    ).toBe("codex");
    expect(
      ImportThreadRequestSchema.parse({
        runtimeSessionId: id,
        idempotencyKey: id,
      }).runtime,
    ).toBeUndefined();
    expect(
      ImportThreadRequestSchema.parse({
        runtimeSessionId: id,
        idempotencyKey: id,
        runtime: "pi",
      }).runtime,
    ).toBe("pi");
  });

  it("accepts a Codex UUIDv7 session identifier unchanged", () => {
    const codexThreadId = "019fa011-c136-7dc0-8c67-e5f7926bd517";
    expect(SessionIdSchema.parse(codexThreadId)).toBe(codexThreadId);
    expect(
      ImportThreadRequestSchema.parse({
        runtimeSessionId: codexThreadId,
        idempotencyKey: id,
        runtime: "codex",
      }).runtimeSessionId,
    ).toBe(codexThreadId);
  });

  it("labels every discovered session with the backend that owns it", () => {
    const descriptor = {
      id,
      name: null,
      createdAt: "2026-08-22T00:00:00.000Z",
      modifiedAt: "2026-08-22T00:00:00.000Z",
      messageCount: 2,
      preview: "hello",
      imported: false,
      runtime: "codex",
    };
    expect(SessionDescriptorSchema.parse(descriptor).runtime).toBe("codex");
    const { runtime, ...withoutRuntime } = descriptor;
    expect(runtime).toBe("codex");
    expect(SessionDescriptorSchema.safeParse(withoutRuntime).success).toBe(
      false,
    );
  });
});
