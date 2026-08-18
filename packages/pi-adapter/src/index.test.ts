import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  create: vi.fn(),
  list: vi.fn(),
  open: vi.fn(),
  createAgentSession: vi.fn(),
  modelCreate: vi.fn(),
  settingsCreate: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  SessionManager: {
    create: sdk.create,
    list: sdk.list,
    open: sdk.open,
  },
  createAgentSession: sdk.createAgentSession,
  ModelRuntime: { create: sdk.modelCreate },
  SettingsManager: { create: sdk.settingsCreate },
}));

import { parseGeneratedTitle, PiAgentRuntime } from "./index.js";

const roots: string[] = [];
const sessionId = "10000000-0000-4000-8000-000000000001";
const pageLimits = { maxItems: 100, targetBytes: 1_048_576 };

afterEach(async () => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function manager(
  id: unknown,
  cwd = "/project",
  sessionFile = "/agent/session.jsonl",
): {
  appendSessionInfo(name: string): void;
  getEntries(): unknown[];
  getHeader(): unknown;
  getSessionFile(): string;
  getSessionId(): unknown;
} {
  let name = "New thread";
  return {
    appendSessionInfo: (value) => {
      name = value;
    },
    getEntries: () => [
      {
        type: "session_info",
        id: "session-info",
        parentId: null,
        timestamp: "2026-01-01T00:00:00.000Z",
        name,
      },
    ],
    getHeader: () => ({
      type: "session",
      version: 3,
      id,
      timestamp: "2026-01-01T00:00:00.000Z",
      cwd,
    }),
    getSessionFile: () => sessionFile,
    getSessionId: () => id,
  };
}

function openedManager(branch: unknown = []): {
  getSessionId(): string;
  getBranch(): unknown;
} {
  return { getSessionId: () => sessionId, getBranch: () => branch };
}

function descriptor(cwd: string, path: unknown): unknown {
  return {
    id: sessionId,
    cwd,
    path,
    created: new Date("2026-01-01T00:00:00.000Z"),
    modified: new Date("2026-01-01T00:00:00.000Z"),
    messageCount: 1,
    firstMessage: "Hello",
  };
}

async function fixture(): Promise<{
  root: string;
  project: string;
  sessionDirectory: string;
  sessionPath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "pi-web-pi-adapter-"));
  roots.push(root);
  const projectPath = join(root, "project");
  const agentDirectory = join(root, "agent");
  await mkdir(projectPath);
  const project = await realpath(projectPath);
  const encodedProject = `--${project.slice(1).replaceAll("/", "-")}--`;
  const sessionDirectory = join(agentDirectory, "sessions", encodedProject);
  const sessionFile = join(sessionDirectory, `${sessionId}.jsonl`);
  await mkdir(sessionDirectory, { recursive: true });
  await writeFile(sessionFile, "{}\n", "utf8");
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDirectory);
  return {
    root,
    project,
    sessionDirectory,
    sessionPath: await realpath(sessionFile),
  };
}

function namingHandle(
  provider: string,
  id: string,
): {
  provider: string;
  id: string;
  name: string;
  api: string;
  baseUrl: string;
  reasoning: boolean;
  input: ["text"];
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;
} {
  return {
    provider,
    id,
    name: id,
    api: "openai-completions",
    baseUrl: "https://example.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 16_000,
    maxTokens: 1_000,
  };
}

describe("PiAgentRuntime session creation boundary", () => {
  async function creationFixture(): Promise<{
    agentDirectory: string;
    project: string;
    sessionDirectory: string;
    sessionPath: string;
  }> {
    const root = await mkdtemp(join(tmpdir(), "pi-web-pi-adapter-create-"));
    roots.push(root);
    const projectPath = join(root, "project");
    const agentDirectory = join(root, "agent");
    await mkdir(projectPath);
    const project = await realpath(projectPath);
    const encodedProject = `--${project.slice(1).replaceAll("/", "-")}--`;
    const sessionDirectory = join(agentDirectory, "sessions", encodedProject);
    const sessionPath = join(sessionDirectory, `${sessionId}.jsonl`);
    await mkdir(sessionDirectory, { recursive: true });
    return { agentDirectory, project, sessionDirectory, sessionPath };
  }

  it("returns a parsed UUID only after persisting the new session", async () => {
    const context = await creationFixture();
    sdk.create.mockReturnValue(
      manager(sessionId, context.project, context.sessionPath),
    );

    await expect(
      new PiAgentRuntime(context.agentDirectory).create(
        context.project,
        "Implement thread workspaces",
      ),
    ).resolves.toEqual({ sessionId });
    expect(sdk.create).toHaveBeenCalledWith(
      context.project,
      context.sessionDirectory,
    );
    const persisted = await readFile(context.sessionPath, "utf8");
    expect(persisted).toContain(`"id":"${sessionId}"`);
    expect(persisted).toContain(`"name":"Implement thread workspaces"`);
  });

  it("does not overwrite an existing native session file", async () => {
    const context = await creationFixture();
    await writeFile(context.sessionPath, "existing\n", "utf8");
    sdk.create.mockReturnValue(
      manager(sessionId, context.project, context.sessionPath),
    );

    await expect(
      new PiAgentRuntime(context.agentDirectory).create(context.project),
    ).rejects.toMatchObject({
      code: "unavailable",
      message: "The native session could not be created.",
    });
    await expect(readFile(context.sessionPath, "utf8")).resolves.toBe(
      "existing\n",
    );
  });

  it("rejects a created session path outside its Pi session directory", async () => {
    const context = await creationFixture();
    const outside = join(dirname(context.sessionDirectory), "outside.jsonl");
    sdk.create.mockReturnValue(manager(sessionId, context.project, outside));

    await expect(
      new PiAgentRuntime(context.agentDirectory).create(context.project),
    ).rejects.toMatchObject({
      code: "malformed",
      message: "The native session returned malformed creation state.",
    });
  });

  it("rejects malformed SDK session identifiers before persistence", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-web-pi-adapter-"));
    roots.push(root);
    sdk.create.mockReturnValue(manager("not-a-uuid"));

    await expect(new PiAgentRuntime().create(root)).rejects.toMatchObject({
      code: "malformed",
      message: "The native session returned an invalid identifier.",
    });
  });
});

describe("PiAgentRuntime naming-model boundary", () => {
  it("constructs only non-empty normalized title results", () => {
    expect(parseGeneratedTitle("  ** Implement worktrees!  ")).toEqual({
      outcome: "available",
      title: "Implement worktrees",
    });
    expect(parseGeneratedTitle("... ***")).toEqual({ outcome: "unavailable" });
    expect(parseGeneratedTitle("x".repeat(61))).toEqual({
      outcome: "unavailable",
    });
  });

  it("selects a parsed explicit model and reports malformed SDK responses unavailable", async () => {
    const context = await fixture();
    const getAvailable = vi.fn().mockResolvedValue([
      {
        provider: "test",
        id: "cheap",
        cost: { input: 0, output: 0 },
      },
      { provider: "test", id: "invalid", cost: { input: -1, output: 0 } },
    ]);
    const completeSimple = vi.fn().mockResolvedValue({
      stopReason: "stop",
      content: [{ type: "text", text: "Implement worktrees" }],
    });
    const getModel = vi.fn((provider: string, id: string) =>
      provider === "test" && id === "cheap"
        ? namingHandle(provider, id)
        : undefined,
    );
    sdk.modelCreate.mockResolvedValue({
      getAvailable,
      getModel,
      completeSimple,
    });
    const runtime = new PiAgentRuntime(context.root, {
      provider: "test",
      id: "cheap",
    });

    await expect(
      runtime.suggestTitle(context.project, "Do the work"),
    ).resolves.toEqual({ outcome: "unavailable" });

    getAvailable.mockResolvedValue([
      { provider: "test", id: "cheap", cost: { input: 0, output: 0 } },
    ]);
    await expect(
      runtime.suggestTitle(context.project, "Do the work"),
    ).resolves.toEqual({ outcome: "available", title: "Implement worktrees" });
    expect(completeSimple).toHaveBeenCalledOnce();
    expect(completeSimple).toHaveBeenCalledWith(
      namingHandle("test", "cheap"),
      expect.any(Object),
      expect.any(Object),
    );

    completeSimple.mockResolvedValue({
      stopReason: "stop",
      content: [
        { type: "text", text: "One" },
        { type: "text", text: "Two" },
      ],
    });
    await expect(
      runtime.suggestTitle(context.project, "Do the work"),
    ).resolves.toEqual({ outcome: "unavailable" });
  });

  it("parses automatic settings before model lookup and selects the lower-cost default-provider model", async () => {
    const context = await fixture();
    const getModel = vi.fn((provider: string, id: string) =>
      provider === "test" && id === "default"
        ? {
            ...namingHandle(provider, id),
            cost: { input: 2, output: 2, cacheRead: 0, cacheWrite: 0 },
          }
        : provider === "test" && id === "cheap"
          ? namingHandle(provider, id)
          : undefined,
    );
    const completeSimple = vi.fn().mockResolvedValue({
      stopReason: "stop",
      content: [{ type: "text", text: "Implement worktrees" }],
    });
    sdk.settingsCreate.mockReturnValue({
      getDefaultProvider: () => "test",
      getDefaultModel: () => "default",
    });
    sdk.modelCreate.mockResolvedValue({
      getAvailable: vi.fn().mockResolvedValue([
        { provider: "other", id: "cheapest", cost: { input: 0, output: 0 } },
        { provider: "test", id: "default", cost: { input: 2, output: 2 } },
        { provider: "test", id: "cheap", cost: { input: 0, output: 0 } },
      ]),
      getModel,
      completeSimple,
    });

    await expect(
      new PiAgentRuntime(context.root).suggestTitle(
        context.project,
        "Do the work",
      ),
    ).resolves.toEqual({ outcome: "available", title: "Implement worktrees" });
    expect(getModel).toHaveBeenCalledWith("test", "default");
    expect(completeSimple).toHaveBeenCalledWith(
      namingHandle("test", "cheap"),
      expect.any(Object),
      expect.any(Object),
    );
  });

  it.each([
    ["provider", undefined, "default"],
    ["provider", "", "default"],
    ["provider", 1, "default"],
    ["model", "test", undefined],
    ["model", "test", ""],
    ["model", "test", 1],
  ])(
    "does not look up or complete when the automatic default %s is malformed",
    async (_field, provider: unknown, id: unknown) => {
      const context = await fixture();
      const getModel = vi.fn();
      const completeSimple = vi.fn();
      sdk.settingsCreate.mockReturnValue({
        getDefaultProvider: () => provider,
        getDefaultModel: () => id,
      });
      sdk.modelCreate.mockResolvedValue({
        getAvailable: vi.fn().mockResolvedValue([]),
        getModel,
        completeSimple,
      });

      await expect(
        new PiAgentRuntime(context.root).suggestTitle(
          context.project,
          "Do the work",
        ),
      ).resolves.toEqual({ outcome: "unavailable" });
      expect(getModel).not.toHaveBeenCalled();
      expect(completeSimple).not.toHaveBeenCalled();
    },
  );

  it("constructs a completion handle and rejects malformed SDK handles", async () => {
    const context = await fixture();
    const completeSimple = vi.fn().mockResolvedValue({
      stopReason: "stop",
      content: [{ type: "text", text: "Implement worktrees" }],
    });
    const rawHandle = { ...namingHandle("test", "cheap"), untrusted: true };
    const getModel = vi.fn().mockReturnValue(rawHandle);
    sdk.modelCreate.mockResolvedValue({
      getAvailable: vi
        .fn()
        .mockResolvedValue([
          { provider: "test", id: "cheap", cost: { input: 0, output: 0 } },
        ]),
      getModel,
      completeSimple,
    });
    const runtime = new PiAgentRuntime(context.root, {
      provider: "test",
      id: "cheap",
    });

    await expect(
      runtime.suggestTitle(context.project, "Do the work"),
    ).resolves.toEqual({
      outcome: "available",
      title: "Implement worktrees",
    });
    const completedHandle: unknown = completeSimple.mock.calls[0]?.[0];
    expect(completedHandle).toEqual(namingHandle("test", "cheap"));
    expect(completedHandle).not.toBe(rawHandle);

    getModel.mockReturnValue({ provider: "test", id: "cheap" });
    await expect(
      runtime.suggestTitle(context.project, "Do the work"),
    ).resolves.toEqual({
      outcome: "unavailable",
    });
    expect(completeSimple).toHaveBeenCalledOnce();
  });
});

describe("PiAgentRuntime session open boundary", () => {
  it("parses the agent-directory setting before native operations", () => {
    expect(() => new PiAgentRuntime(undefined)).not.toThrow();
    expect(() => new PiAgentRuntime("relative-agent-directory")).toThrow(
      "The Pi agent directory configuration is invalid.",
    );
    expect(sdk.list).not.toHaveBeenCalled();
    expect(sdk.open).not.toHaveBeenCalled();
  });

  it("exposes a creation ID only for a valid UUID marker", async () => {
    const context = await fixture();
    const valid = "20000000-0000-4000-8000-000000000001";
    const malformed = "a".repeat(36);
    sdk.list.mockResolvedValue([
      {
        id: sessionId,
        cwd: context.project,
        path: context.sessionPath,
        name: `Work [pi-create:${valid}]`,
        created: new Date("2026-01-01T00:00:00.000Z"),
        modified: new Date("2026-01-01T00:00:00.000Z"),
        messageCount: 1,
        firstMessage: "Hello",
      },
    ]);

    await expect(
      new PiAgentRuntime().discover(context.project),
    ).resolves.toMatchObject({
      sessions: [expect.objectContaining({ name: "Work", creationId: valid })],
    });

    sdk.list.mockResolvedValue([
      {
        id: sessionId,
        cwd: context.project,
        path: context.sessionPath,
        name: `Work [pi-create:${malformed}]`,
        created: new Date("2026-01-01T00:00:00.000Z"),
        modified: new Date("2026-01-01T00:00:00.000Z"),
        messageCount: 1,
        firstMessage: "Hello",
      },
    ]);
    await expect(
      new PiAgentRuntime().discover(context.project),
    ).resolves.toMatchObject({
      sessions: [
        expect.objectContaining({ name: `Work [pi-create:${malformed}]` }),
      ],
    });
  });

  it("discovers and opens an authorized native session file", async () => {
    const context = await fixture();
    sdk.list.mockResolvedValue([
      descriptor(context.project, context.sessionPath),
    ]);
    sdk.open.mockReturnValue(openedManager());
    sdk.createAgentSession.mockResolvedValue({
      session: { subscribe: () => () => undefined },
    });

    const runtime = new PiAgentRuntime(
      join(context.sessionDirectory, "..", ".."),
    );
    await expect(runtime.discover(context.project)).resolves.toEqual({
      sessions: [
        {
          id: sessionId,
          name: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          modifiedAt: "2026-01-01T00:00:00.000Z",
          messageCount: 1,
          preview: "Hello",
        },
      ],
      diagnostics: [],
    });

    await expect(
      runtime.open(context.project, sessionId),
    ).resolves.toBeDefined();
    expect(sdk.open).toHaveBeenCalledWith(
      context.sessionPath,
      undefined,
      context.project,
    );
  });

  it("omits a duplicate discovery descriptor before filesystem validation", async () => {
    const context = await fixture();
    sdk.list.mockResolvedValue([
      descriptor(context.project, context.sessionPath),
      descriptor(join(context.root, "missing-project"), context.sessionPath),
    ]);

    await expect(
      new PiAgentRuntime().discover(context.project),
    ).resolves.toEqual({
      sessions: [
        {
          id: sessionId,
          name: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          modifiedAt: "2026-01-01T00:00:00.000Z",
          messageCount: 1,
          preview: "Hello",
        },
      ],
      diagnostics: ["A duplicate Pi session identifier was omitted."],
    });
  });

  it("omits a native descriptor whose name exceeds the shared contract limit", async () => {
    const context = await fixture();
    sdk.list.mockResolvedValue([
      {
        id: sessionId,
        cwd: context.project,
        path: context.sessionPath,
        name: "n".repeat(201),
        created: new Date("2026-01-01T00:00:00.000Z"),
        modified: new Date("2026-01-01T00:00:00.000Z"),
        messageCount: 1,
        firstMessage: "Hello",
      },
    ]);

    await expect(
      new PiAgentRuntime().discover(context.project),
    ).resolves.toEqual({
      sessions: [],
      diagnostics: ["A malformed Pi session descriptor was omitted."],
    });
  });

  it("does not open malformed or duplicate matching listed descriptors", async () => {
    const context = await fixture();
    sdk.list.mockResolvedValue([
      { id: sessionId },
      descriptor(context.project, context.sessionPath),
      descriptor(context.project, context.sessionPath),
    ]);

    await expect(
      new PiAgentRuntime().open(context.project, sessionId),
    ).rejects.toMatchObject({
      code: "malformed",
      message: "The native session is unavailable.",
    });
    expect(sdk.open).not.toHaveBeenCalled();
  });

  it("rejects a malformed native session list before opening", async () => {
    const context = await fixture();
    sdk.list.mockResolvedValue({ sessions: [] });

    await expect(
      new PiAgentRuntime().open(context.project, sessionId),
    ).rejects.toMatchObject({
      code: "malformed",
      message: "The native session list is malformed.",
    });
    expect(sdk.open).not.toHaveBeenCalled();
  });

  it("rejects a malformed native session list during discovery", async () => {
    const context = await fixture();
    sdk.list.mockResolvedValue({ sessions: [] });

    await expect(
      new PiAgentRuntime().discover(context.project),
    ).rejects.toMatchObject({
      code: "malformed",
      message: "The native session list is malformed.",
    });
  });

  it.each([
    [
      "a non-string path",
      (context: Awaited<ReturnType<typeof fixture>>) =>
        descriptor(context.project, 7),
      "unavailable",
    ],
    [
      "a relative path",
      (context: Awaited<ReturnType<typeof fixture>>) =>
        descriptor(context.project, "session.jsonl"),
      "malformed",
    ],
    [
      "an absent path",
      (context: Awaited<ReturnType<typeof fixture>>) =>
        descriptor(
          context.project,
          join(context.sessionDirectory, "missing.jsonl"),
        ),
      "unavailable",
    ],
    [
      "a non-regular path",
      (context: Awaited<ReturnType<typeof fixture>>) =>
        descriptor(context.project, context.sessionDirectory),
      "malformed",
    ],
    [
      "a path outside the project session directory",
      (context: Awaited<ReturnType<typeof fixture>>) =>
        descriptor(context.project, join(context.root, "outside.jsonl")),
      "malformed",
    ],
    [
      "a descriptor from another canonical project",
      (context: Awaited<ReturnType<typeof fixture>>) =>
        descriptor(join(context.root, "other-project"), context.sessionPath),
      "unauthorized",
    ],
  ])(
    "rejects %s without opening a native session",
    async (_name, build, code) => {
      const context = await fixture();
      if (_name === "a path outside the project session directory")
        await writeFile(join(context.root, "outside.jsonl"), "{}\n", "utf8");
      if (_name === "a descriptor from another canonical project")
        await mkdir(join(context.root, "other-project"));
      sdk.list.mockResolvedValue([build(context)]);

      let failure: unknown;
      try {
        await new PiAgentRuntime().open(context.project, sessionId);
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ code });
      expect(String(failure)).not.toContain(context.root);
      expect(sdk.open).not.toHaveBeenCalled();
    },
  );

  it("omits malformed compaction and displayed custom messages from snapshots", async () => {
    const context = await fixture();
    sdk.list.mockResolvedValue([
      descriptor(context.project, context.sessionPath),
    ]);
    sdk.open.mockReturnValue(
      openedManager([
        {
          id: "valid-message",
          type: "message",
          timestamp: "2026-01-01T00:00:00.000Z",
          message: { role: "user", content: "Retained" },
        },
        {
          id: "c".repeat(201),
          type: "compaction",
          timestamp: "2026-01-01T00:00:00.000Z",
          summary: "Too long identifier",
        },
        {
          id: "m".repeat(201),
          type: "custom_message",
          timestamp: "2026-01-01T00:00:00.000Z",
          display: true,
          content: "Too long identifier",
        },
      ]),
    );
    sdk.createAgentSession.mockResolvedValue({
      session: { subscribe: () => () => undefined },
    });

    const opened = await new PiAgentRuntime().open(context.project, sessionId);
    await expect(opened.snapshot(pageLimits)).resolves.toMatchObject({
      sessionId,
      transcriptPage: {
        items: [
          {
            id: "valid-message",
            kind: "message",
            role: "user",
            text: "Retained",
            timestamp: "2026-01-01T00:00:00.000Z",
          },
        ],
        olderCursor: null,
        newerCursor: null,
        atLatest: true,
      },
      diagnostics: [
        "A malformed native session entry was omitted.",
        "A malformed native session entry was omitted.",
      ],
    });
  });

  it("bounds and resumes pages in a deterministic 10,000-item history", async () => {
    const context = await fixture();
    sdk.list.mockResolvedValue([
      descriptor(context.project, context.sessionPath),
    ]);
    const nativeEntries = Array.from({ length: 10_000 }, (_, index) => ({
      id: `message-${String(index).padStart(5, "0")}`,
      type: "message",
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content: `Message ${String(index)}` },
    }));
    sdk.open.mockReturnValue(openedManager(nativeEntries));
    sdk.createAgentSession.mockResolvedValue({
      session: { subscribe: () => () => undefined },
    });

    const opened = await new PiAgentRuntime().open(context.project, sessionId);
    const latest = await opened.snapshot(pageLimits);
    expect(latest.transcriptPage.items).toHaveLength(100);
    expect(latest.transcriptPage.items[0]?.id).toBe("message-09900");
    expect(latest.transcriptPage.atLatest).toBe(true);

    const olderCursor = latest.transcriptPage.olderCursor;
    expect(olderCursor).not.toBeNull();
    if (olderCursor === null) throw new Error("missing older cursor");
    const older = await opened.transcriptPage(
      { cursor: olderCursor, direction: "older" },
      pageLimits,
    );
    expect(older.items).toHaveLength(100);
    expect(older.items[0]?.id).toBe("message-09800");
    expect(older.items.at(-1)?.id).toBe("message-09899");

    const resumed = await opened.transcriptPage(
      { cursor: older.resumeCursor, direction: "resume" },
      pageLimits,
    );
    expect(resumed.items.map((item) => item.id)).toEqual(
      older.items.map((item) => item.id),
    );

    nativeEntries.push({
      id: "message-10000",
      type: "message",
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content: "Appended" },
    });
    await expect(
      opened.transcriptPage(
        { cursor: older.resumeCursor, direction: "resume" },
        pageLimits,
      ),
    ).resolves.toMatchObject({
      items: older.items,
    });

    const divergent = nativeEntries[9_850];
    if (divergent === undefined) throw new Error("missing divergent entry");
    nativeEntries[9_850] = {
      ...divergent,
      message: { role: "user", content: "Diverged" },
    };
    await expect(
      opened.transcriptPage(
        { cursor: older.resumeCursor, direction: "resume" },
        pageLimits,
      ),
    ).rejects.toMatchObject({ code: "stale" });

    const newerCursor = older.newerCursor;
    expect(newerCursor).not.toBeNull();
    if (newerCursor === null) throw new Error("missing newer cursor");
    await expect(
      opened.transcriptPage(
        { cursor: newerCursor, direction: "newer" },
        pageLimits,
      ),
    ).rejects.toMatchObject({ code: "stale" });

    await expect(
      opened.transcriptPage(
        { cursor: older.resumeCursor, direction: "older" },
        pageLimits,
      ),
    ).rejects.toMatchObject({ code: "stale" });
  });

  it("rejects malformed native history collections from snapshots", async () => {
    const context = await fixture();
    sdk.list.mockResolvedValue([
      descriptor(context.project, context.sessionPath),
    ]);
    sdk.open.mockReturnValue(openedManager({ entries: [] }));
    sdk.createAgentSession.mockResolvedValue({
      session: { subscribe: () => () => undefined },
    });

    const opened = await new PiAgentRuntime().open(context.project, sessionId);
    await expect(opened.snapshot(pageLimits)).rejects.toMatchObject({
      code: "malformed",
      message: "The native session history is malformed.",
    });
  });

  it("preserves bounded Pi tool calls, results, and bash executions in snapshots", async () => {
    const context = await fixture();
    sdk.list.mockResolvedValue([
      descriptor(context.project, context.sessionPath),
    ]);
    sdk.open.mockReturnValue(
      openedManager([
        {
          id: "assistant",
          type: "message",
          timestamp: "2026-01-01T00:00:00.000Z",
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "call-1",
                name: "bash",
                arguments: { command: "pwd", cwd: "/project" },
              },
              {
                type: "toolCall",
                id: "call-2",
                name: "bash",
                arguments: { command: "pwd", cwd: "/project" },
              },
            ],
          },
        },
        {
          id: "result-2",
          type: "message",
          timestamp: "2026-01-01T00:00:01.000Z",
          message: {
            role: "toolResult",
            toolCallId: "call-2",
            toolName: "bash",
            content: [{ type: "text", text: "second result\n" }],
            isError: false,
            details: { cwd: "/project", exitCode: 0 },
          },
        },
        {
          id: "result-1",
          type: "message",
          timestamp: "2026-01-01T00:00:02.000Z",
          message: {
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "bash",
            content: [{ type: "text", text: "first result\n" }],
            isError: false,
            details: { cwd: "/project", exitCode: 0 },
          },
        },
        {
          id: "bash",
          type: "message",
          timestamp: "2026-01-01T00:00:03.000Z",
          message: {
            role: "bashExecution",
            command: "false",
            output: "failed",
            exitCode: 1,
            cancelled: false,
          },
        },
        {
          id: "bad-tool",
          type: "message",
          timestamp: "2026-01-01T00:00:04.000Z",
          message: {
            role: "toolResult",
            toolCallId: "call-3",
            toolName: "bash",
            content: [],
            isError: "false",
          },
        },
      ]),
    );
    sdk.createAgentSession.mockResolvedValue({
      session: { subscribe: () => () => undefined },
    });

    const opened = await new PiAgentRuntime().open(context.project, sessionId);
    const snapshot = await opened.snapshot(pageLimits);
    expect(snapshot.transcriptPage.items).toMatchObject([
      { id: "assistant", kind: "message", role: "assistant" },
      {
        id: "result-1",
        kind: "tool",
        name: "bash",
        status: "completed",
        input: '{"command":"pwd","cwd":"/project"}',
        output: "first result\n",
        cwd: "/project",
        exitCode: 0,
      },
      {
        id: "result-2",
        kind: "tool",
        name: "bash",
        status: "completed",
        input: '{"command":"pwd","cwd":"/project"}',
        output: "second result\n",
        cwd: "/project",
        exitCode: 0,
      },
      {
        id: "bash",
        kind: "tool",
        name: "bash",
        status: "failed",
        input: "false",
        output: "failed",
        exitCode: 1,
      },
    ]);
    expect(snapshot.diagnostics).toEqual([
      "An unsupported native message was omitted.",
    ]);
  });
});

describe("PiOpenSession streaming projection", () => {
  it("replaces repeated message updates and includes the newest bounded projection", async () => {
    const context = await fixture();
    sdk.list.mockResolvedValue([
      descriptor(context.project, context.sessionPath),
    ]);
    sdk.open.mockReturnValue(openedManager());
    let listener: ((event: unknown) => void) | undefined;
    sdk.createAgentSession.mockResolvedValue({
      session: {
        subscribe: (next: (event: unknown) => void) => {
          listener = next;
          return () => undefined;
        },
        dispose: () => undefined,
      },
    });
    const opened = await new PiAgentRuntime().open(context.project, sessionId);

    listener?.({
      type: "message_update",
      message: { role: "assistant", content: "First" },
    });
    listener?.({
      type: "message_update",
      message: { role: "assistant", content: "Newest" },
    });
    const streaming = await opened.snapshot(pageLimits);
    expect(streaming.transcriptPage.items).toMatchObject([
      { id: "streaming-assistant", text: "Newest" },
    ]);

    listener?.({ type: "agent_settled" });
    const settled = await opened.snapshot(pageLimits);
    expect(settled.transcriptPage.items).toEqual([]);
  });
});

describe("PiOpenSession preflight boundary", () => {
  it.each([
    [true, true],
    [false, false],
    ["accepted", false],
  ])(
    "accepts only a boolean preflight result",
    async (providerValue, accepted) => {
      const context = await fixture();
      sdk.list.mockResolvedValue([
        descriptor(context.project, context.sessionPath),
      ]);
      sdk.open.mockReturnValue(openedManager());
      let listener: ((event: unknown) => void) | undefined;
      sdk.createAgentSession.mockResolvedValue({
        session: {
          subscribe: (next: (event: unknown) => void) => {
            listener = next;
            return () => undefined;
          },
          prompt: (
            _text: string,
            options: { preflightResult: (value: boolean) => void },
          ) => {
            listener?.({ type: "agent_settled" });
            Reflect.apply(options.preflightResult, undefined, [providerValue]);
            return new Promise<void>(() => undefined);
          },
          steer: () => Promise.resolve(),
          abort: () => Promise.resolve(),
          dispose: () => undefined,
        },
      });
      const opened = await new PiAgentRuntime().open(
        context.project,
        sessionId,
      );
      const events: unknown[] = [];
      opened.subscribe((event) => events.push(event));

      const outcome = await opened.prompt("Work");
      expect(outcome.accepted).toBe(accepted);
      if (accepted) outcome.releaseEvents();
      else outcome.discardEvents();
      expect(events).toHaveLength(accepted ? 1 : 0);
    },
  );
});
