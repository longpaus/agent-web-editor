// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TranscriptPageSchema,
  type ProjectId,
  type RunId,
  type ThreadId,
  type ThreadSnapshot,
} from "@pi-web/contracts";

const emptyTranscriptPage = TranscriptPageSchema.parse({
  items: [],
  olderCursor: null,
  newerCursor: null,
  resumeCursor: "empty-transcript-page",
  atLatest: true,
});

const api = vi.hoisted(() => ({
  archiveThread: vi.fn(),
  discoverSessions: vi.fn(),
  getFiles: vi.fn(),
  getSnapshot: vi.fn(),
  getStatus: vi.fn(),
  getWorkspace: vi.fn(),
  getWorkspacePreflight: vi.fn(),
  importThread: vi.fn(),
  markViewed: vi.fn(),
  prompt: vi.fn(),
  renameThread: vi.fn(),
  startThread: vi.fn(),
  steer: vi.fn(),
}));

vi.mock("./api/client.js", async (importOriginal) => {
  const client = await importOriginal<typeof import("./api/client.js")>();
  return { ...client, ...api };
});

import { Markdown } from "./components/Markdown.js";
import { Status } from "./components/Status.js";
import { App, Composer } from "./App.js";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("safe and accessible workspace rendering", () => {
  it("renders the workspace immediately without an authentication screen", () => {
    api.getWorkspace.mockResolvedValue({
      projects: [],
      threads: [],
      diagnostics: [],
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <App />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(screen.getByText("Steer your coding agent")).toBeInTheDocument();
    expect(
      screen.queryByText("Opening local workspace…"),
    ).not.toBeInTheDocument();
  });

  it("discards malformed persisted composer drafts", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => 42,
      setItem: () => undefined,
      removeItem: () => undefined,
    });
    const projectId = "10000000-0000-4000-8000-000000000001" as ProjectId;
    const threadId = "20000000-0000-4000-8000-000000000001" as ThreadId;
    const snapshot: ThreadSnapshot = {
      version: 2,
      project: {
        id: projectId,
        displayName: "Example project",
        displayPath: "/example",
        createdAt: "2026-01-01T00:00:00.000Z",
        available: true,
        gitAvailable: true,
        sidebarExpanded: true,
        unreadCount: 0,
        lastOpenedThreadId: threadId,
      },
      thread: {
        id: threadId,
        projectId,
        title: "Example thread",
        createdAt: "2026-01-01T00:00:00.000Z",
        lastActivityAt: "2026-01-01T00:00:00.000Z",
        runState: null,
        unread: false,
        runtimeAvailable: true,
        workspace: { mode: "shared", branchName: null, available: true },
      },
      transcriptPage: emptyTranscriptPage,
      currentRun: null,
      lastRun: null,
      epoch: "40000000-0000-4000-8000-000000000001",
      highWaterSequence: 0,
      capabilities: { prompt: true, steer: true, stop: true },
      diagnostics: [],
    };
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <Composer
          projectId={projectId}
          threadId={threadId}
          snapshot={snapshot}
        />
      </QueryClientProvider>,
    );

    expect(screen.getByRole("textbox", { name: "Message Pi" })).toHaveValue("");
  });

  it("uses bound storage methods for draft reads and writes", async () => {
    const values = new Map<string, string>();
    const storage = {
      getItem(
        this: { values: Map<string, string> },
        key: string,
      ): string | null {
        return this.values.get(key) ?? null;
      },
      setItem(
        this: { values: Map<string, string> },
        key: string,
        value: string,
      ): void {
        this.values.set(key, value);
      },
      removeItem(this: { values: Map<string, string> }, key: string): void {
        this.values.delete(key);
      },
      values,
    };
    vi.stubGlobal("localStorage", storage);
    const projectId = "10000000-0000-4000-8000-000000000001" as ProjectId;
    const threadId = "20000000-0000-4000-8000-000000000001" as ThreadId;
    const snapshot = {
      version: 2,
      project: {
        id: projectId,
        displayName: "Example project",
        displayPath: "/example",
        createdAt: "2026-01-01T00:00:00.000Z",
        available: true,
        gitAvailable: true,
        sidebarExpanded: true,
        unreadCount: 0,
        lastOpenedThreadId: threadId,
      },
      thread: {
        id: threadId,
        projectId,
        title: "Example thread",
        createdAt: "2026-01-01T00:00:00.000Z",
        lastActivityAt: "2026-01-01T00:00:00.000Z",
        runState: null,
        unread: false,
        runtimeAvailable: true,
        workspace: { mode: "shared", branchName: null, available: true },
      },
      transcriptPage: emptyTranscriptPage,
      currentRun: null,
      lastRun: null,
      epoch: "40000000-0000-4000-8000-000000000001",
      highWaterSequence: 0,
      capabilities: { prompt: true, steer: true, stop: true },
      diagnostics: [],
    } satisfies ThreadSnapshot;
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={queryClient}>
        <Composer
          projectId={projectId}
          threadId={threadId}
          snapshot={snapshot}
        />
      </QueryClientProvider>,
    );
    await user.type(
      screen.getByRole("textbox", { name: "Message Pi" }),
      "Bound",
    );
    await waitFor(() => {
      expect(values.get(`pi-draft:${threadId}`)).toBe("Bound");
    });
  });

  it("shows Codex-style worktree choices with a clean default and no environment control", async () => {
    const user = userEvent.setup();
    const projectId = "10000000-0000-4000-8000-000000000001" as ProjectId;
    api.getWorkspace.mockResolvedValue({
      projects: [
        {
          id: projectId,
          displayName: "Example project",
          displayPath: "example",
          createdAt: "2026-01-01T00:00:00.000Z",
          available: true,
          gitAvailable: true,
          sidebarExpanded: true,
          unreadCount: 0,
          lastOpenedThreadId: null,
        },
      ],
      threads: [],
      diagnostics: [],
    });
    api.getWorkspacePreflight.mockResolvedValue({
      worktreeAvailable: true,
      unavailableReason: null,
      currentBranch: "main",
      branches: ["main", "release"],
      headCommit: "1234567",
      changes: {
        staged: 1,
        modified: 1,
        deleted: 0,
        renamed: 0,
        untracked: 1,
        files: ["one.ts", "two.ts", "three.ts"],
        token: "1234567890abcdef",
      },
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[`/projects/${projectId}/new`]}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByLabelText("Execution location")).toHaveValue(
      "worktree",
    );
    expect(screen.getByLabelText("Starting state")).toHaveValue("none");
    expect(screen.queryByLabelText(/environment/i)).not.toBeInTheDocument();
    expect(
      screen.getByText(/Local changes are not copied/),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByLabelText("Base branch")).toHaveValue("main");
    });
    await user.selectOptions(
      screen.getByLabelText("Starting state"),
      "tracked_and_untracked",
    );
    expect(screen.getByText(/Including 3 local changes/)).toBeInTheDocument();
  });

  it("sends with Enter, uses Shift+Enter for a new line, and steers active runs", async () => {
    const user = userEvent.setup();
    const drafts = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => drafts.get(key) ?? null,
      setItem: (key: string, value: string) => {
        drafts.set(key, value);
      },
      removeItem: (key: string) => {
        drafts.delete(key);
      },
    });
    api.prompt.mockResolvedValue(undefined);
    api.steer.mockResolvedValue(undefined);
    const projectId = "10000000-0000-4000-8000-000000000001" as ProjectId;
    const threadId = "20000000-0000-4000-8000-000000000001" as ThreadId;
    const snapshot: ThreadSnapshot = {
      version: 2,
      project: {
        id: projectId,
        displayName: "Example project",
        displayPath: "/example",
        createdAt: "2026-01-01T00:00:00.000Z",
        available: true,
        gitAvailable: true,
        sidebarExpanded: true,
        unreadCount: 0,
        lastOpenedThreadId: threadId,
      },
      thread: {
        id: threadId,
        projectId,
        title: "Example thread",
        createdAt: "2026-01-01T00:00:00.000Z",
        lastActivityAt: "2026-01-01T00:00:00.000Z",
        runState: null,
        unread: false,
        runtimeAvailable: true,
        workspace: { mode: "shared", branchName: null, available: true },
      },
      transcriptPage: emptyTranscriptPage,
      currentRun: null,
      lastRun: null,
      epoch: "40000000-0000-4000-8000-000000000001",
      highWaterSequence: 0,
      capabilities: { prompt: true, steer: true, stop: true },
      diagnostics: [],
    };
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    const view = render(
      <QueryClientProvider client={queryClient}>
        <Composer
          projectId={projectId}
          threadId={threadId}
          snapshot={snapshot}
        />
      </QueryClientProvider>,
    );

    const message = screen.getByRole("textbox", { name: "Message Pi" });
    await user.type(message, "First line");
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    await user.type(message, "Second line");
    expect(message).toHaveValue("First line\nSecond line");

    await user.keyboard("{Enter}");
    await waitFor(() => {
      expect(api.prompt).toHaveBeenCalledWith(
        projectId,
        threadId,
        "First line\nSecond line",
      );
      expect(message).toHaveValue("");
    });

    const activeSnapshot: ThreadSnapshot = {
      ...snapshot,
      thread: { ...snapshot.thread, runState: "running" },
      currentRun: {
        id: "50000000-0000-4000-8000-000000000001" as RunId,
        projectId,
        threadId,
        state: "running",
        startedAt: "2026-01-01T00:01:00.000Z",
        endedAt: null,
        failureCode: null,
        failureMessage: null,
      },
    };
    view.rerender(
      <QueryClientProvider client={queryClient}>
        <Composer
          projectId={projectId}
          threadId={threadId}
          snapshot={activeSnapshot}
        />
      </QueryClientProvider>,
    );

    expect(screen.queryByText("Wait until finished")).not.toBeInTheDocument();
    await user.type(message, "Focus on the tests");
    await user.keyboard("{Enter}");
    await waitFor(() => {
      expect(api.steer).toHaveBeenCalledWith(
        projectId,
        threadId,
        "Focus on the tests",
      );
      expect(message).toHaveValue("");
    });
  });

  it("renders compact inline run signals without visible status words", () => {
    const { rerender } = render(<Status state="running" unread={false} />);
    const running = screen.getByLabelText("Running");
    expect(running).toBeInTheDocument();
    expect(running.textContent).toBe("");
    expect(screen.queryByText("Running")).not.toBeInTheDocument();

    rerender(<Status state="completed" unread />);
    const unread = screen.getByLabelText("Unread completion");
    expect(unread).toHaveTextContent("●");
    expect(screen.queryByText("Unread")).not.toBeInTheDocument();
  });

  it("does not enable raw Markdown HTML", () => {
    const { container } = render(
      <Markdown>{`<img src=x onerror="alert(1)">\n\n[unsafe](javascript:alert(1))`}</Markdown>,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("[onerror]")).toBeNull();
    expect(screen.getByText("unsafe").closest("a")).not.toHaveAttribute(
      "href",
      expect.stringContaining("javascript:"),
    );
  });

  it("persists inspector visibility, selected tab, and resized width", async () => {
    const user = userEvent.setup();
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    });
    vi.stubGlobal("innerWidth", 1440);
    vi.stubGlobal(
      "WebSocket",
      class {
        public addEventListener() {
          return undefined;
        }
        public send() {
          return undefined;
        }
        public close() {
          return undefined;
        }
      },
    );
    const projectId = "10000000-0000-4000-8000-000000000001" as ProjectId;
    const threadId = "20000000-0000-4000-8000-000000000001" as ThreadId;
    const project = {
      id: projectId,
      displayName: "Example project",
      displayPath: "/example",
      createdAt: "2026-01-01T00:00:00.000Z",
      available: true,
      gitAvailable: true,
      sidebarExpanded: true,
      unreadCount: 0,
      lastOpenedThreadId: threadId,
    };
    api.getWorkspace.mockResolvedValue({
      projects: [project],
      threads: [
        {
          id: threadId,
          projectId,
          title: "Resizable thread",
          createdAt: "2026-01-01T00:00:00.000Z",
          lastActivityAt: "2026-01-01T00:00:00.000Z",
          runState: null,
          unread: false,
          runtimeAvailable: true,
          workspace: { mode: "shared", branchName: null, available: true },
        },
      ],
      diagnostics: [],
    });
    api.getSnapshot.mockResolvedValue({
      version: 2,
      project,
      thread: {
        id: threadId,
        projectId,
        title: "Resizable thread",
        createdAt: "2026-01-01T00:00:00.000Z",
        lastActivityAt: "2026-01-01T00:00:00.000Z",
        runState: null,
        unread: false,
        runtimeAvailable: true,
        workspace: { mode: "shared", branchName: null, available: true },
      },
      transcriptPage: emptyTranscriptPage,
      currentRun: null,
      lastRun: null,
      epoch: "40000000-0000-4000-8000-000000000001",
      highWaterSequence: 0,
      capabilities: { prompt: true, steer: true, stop: true },
      diagnostics: [],
    } satisfies ThreadSnapshot);
    api.getStatus.mockResolvedValue({
      available: true,
      message: null,
      files: [],
    });
    api.getFiles.mockResolvedValue({ entries: [], truncated: false });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter
          initialEntries={[`/projects/${projectId}/threads/${threadId}`]}
        >
          <App />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await screen.findByRole("heading", { name: "Resizable thread" });
    expect(
      screen.queryByRole("complementary", { name: "Project inspector" }),
    ).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Open inspector panel" }),
    );
    expect(
      await screen.findByRole("complementary", {
        name: "Project inspector",
      }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Files" }));
    await waitFor(() => {
      expect(
        JSON.parse(values.get("pi-workspace:inspector") ?? ""),
      ).toMatchObject({ activeTab: "files", open: true });
    });

    const closeInspector = screen.getByRole("button", {
      name: "Close inspector panel",
    });
    expect(closeInspector.querySelector(".panel-right-icon")).not.toBeNull();
    await user.click(closeInspector);
    expect(
      screen.queryByRole("complementary", { name: "Project inspector" }),
    ).not.toBeInTheDocument();
    expect(document.querySelector(".inspector")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    expect(document.querySelector(".inspector")).toHaveAttribute("inert");
    await waitFor(() => {
      expect(
        JSON.parse(values.get("pi-workspace:inspector") ?? ""),
      ).toMatchObject({ activeTab: "files", open: false });
    });

    await user.click(
      screen.getByRole("button", { name: "Open inspector panel" }),
    );
    expect(
      await screen.findByRole("tab", { name: "Files", selected: true }),
    ).toBeInTheDocument();

    const separator = screen.getByRole("separator", {
      name: "Resize inspector panel",
    });
    fireEvent.pointerDown(separator, { pointerId: 1 });
    fireEvent.pointerMove(separator, { clientX: 720, pointerId: 1 });
    fireEvent.pointerUp(separator, { pointerId: 1 });
    await waitFor(() => {
      expect(
        JSON.parse(values.get("pi-workspace:inspector") ?? ""),
      ).toMatchObject({ width: 720 });
    });
    expect(separator).toHaveAttribute("aria-valuenow", "720");
    separator.focus();
    await user.keyboard("{ArrowLeft}");
    await waitFor(() => {
      expect(
        JSON.parse(values.get("pi-workspace:inspector") ?? ""),
      ).toMatchObject({ width: 744 });
    });
  });

  it("imports a discovered session and renames a thread", async () => {
    const user = userEvent.setup();
    const drafts = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => drafts.get(key) ?? null,
      setItem: (key: string, value: string) => {
        drafts.set(key, value);
      },
      removeItem: (key: string) => {
        drafts.delete(key);
      },
    });
    const projectId = "10000000-0000-4000-8000-000000000001";
    const threadId = "20000000-0000-4000-8000-000000000001";
    const importedThreadId = "30000000-0000-4000-8000-000000000001";
    let workspace = {
      projects: [
        {
          id: projectId,
          displayName: "Example project",
          displayPath: "/example",
          available: true,
          sidebarExpanded: true,
          unreadCount: 0,
          lastOpenedThreadId: threadId,
        },
      ],
      threads: [
        {
          id: threadId,
          projectId,
          title: "Original thread",
          runtimeSessionId: "40000000-0000-4000-8000-000000000001",
          runState: null as "running" | null,
          unread: false,
        },
      ],
      diagnostics: [],
    };
    api.getWorkspace.mockImplementation(() => Promise.resolve(workspace));
    api.discoverSessions.mockResolvedValue({
      sessions: [
        {
          id: "50000000-0000-4000-8000-000000000001",
          name: "Existing session",
          createdAt: "2026-01-01T00:00:00.000Z",
          modifiedAt: "2026-01-01T00:00:00.000Z",
          messageCount: 1,
          preview: "Existing work",
          imported: false,
        },
      ],
      diagnostics: ["One session could not be read."],
    });
    api.importThread.mockResolvedValue({
      thread: {
        id: importedThreadId,
        projectId,
        title: "Existing session",
        runtimeSessionId: "50000000-0000-4000-8000-000000000001",
        runState: null,
        unread: false,
      },
    });
    api.getSnapshot.mockResolvedValue({
      version: 2,
      project: workspace.projects[0],
      thread: {
        id: importedThreadId,
        projectId,
        title: "Existing session",
        runtimeSessionId: "50000000-0000-4000-8000-000000000001",
        runState: null,
        unread: false,
      },
      transcriptPage: emptyTranscriptPage,
      currentRun: null,
      lastRun: null,
      epoch: "60000000-0000-4000-8000-000000000001",
      highWaterSequence: 0,
      capabilities: { prompt: true, steer: true, stop: true },
      diagnostics: [],
    });
    api.archiveThread.mockImplementation(
      (_projectId: ProjectId, archivedThreadId: ThreadId) => {
        workspace = {
          ...workspace,
          threads: workspace.threads.filter(
            (thread) => thread.id !== archivedThreadId,
          ),
        };
        return Promise.resolve({ archived: true as const });
      },
    );
    api.renameThread.mockImplementation(
      (_projectId: ProjectId, renamedThreadId: ThreadId, title: string) => {
        workspace = {
          ...workspace,
          threads: workspace.threads.map((thread) =>
            thread.id === renamedThreadId ? { ...thread, title } : thread,
          ),
        };
        const thread = workspace.threads.find(
          (candidate) => candidate.id === renamedThreadId,
        );
        if (thread === undefined) throw new Error("Expected test thread");
        return Promise.resolve({ thread });
      },
    );

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[`/projects/${projectId}`]}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await user.click(
      await screen.findByRole("button", {
        name: "Import an existing session into Example project",
      }),
    );
    expect(
      await screen.findByRole("button", { name: "Import" }),
    ).toBeInTheDocument();
    expect(api.discoverSessions).toHaveBeenCalledWith(projectId);
    expect(
      screen.getByText("One session could not be read."),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Import" }));
    await waitFor(() => {
      expect(api.importThread).toHaveBeenCalledWith(
        projectId,
        "50000000-0000-4000-8000-000000000001",
      );
      expect(api.getSnapshot).toHaveBeenCalledWith(projectId, importedThreadId);
    });
    expect(
      await screen.findByRole("heading", { name: "Existing session" }),
    ).toBeInTheDocument();

    const originalThread = screen.getByRole("link", {
      name: "Original thread",
    });
    fireEvent.contextMenu(originalThread);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "Archive" }),
    ).toBeInTheDocument();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    fireEvent.contextMenu(originalThread);
    await user.click(screen.getByRole("menuitem", { name: "Rename" }));
    const title = screen.getByRole("textbox", {
      name: "Rename Original thread",
    });
    await user.clear(title);
    await user.type(title, "Renamed thread");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(api.renameThread).toHaveBeenCalledWith(
        projectId,
        threadId,
        "Renamed thread",
      );
    });
    expect(await screen.findByText("Renamed thread")).toBeInTheDocument();

    const renamedLink = screen.getByRole("link", { name: "Renamed thread" });
    renamedLink.focus();
    await user.keyboard("{Shift>}{F10}{/Shift}");
    expect(
      screen.getByRole("menuitem", { name: "Rename" }),
    ).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    workspace = {
      ...workspace,
      threads: workspace.threads.map((thread) =>
        thread.id === threadId ? { ...thread, runState: "running" } : thread,
      ),
    };
    await queryClient.invalidateQueries({ queryKey: ["workspace"] });
    expect(
      await screen.findByRole("button", {
        name: "Archive Renamed thread (unavailable while running)",
      }),
    ).toBeDisabled();
    fireEvent.contextMenu(
      screen.getByRole("link", { name: /Renamed thread.*Running/ }),
    );
    expect(
      screen.getByRole("menuitem", {
        name: "Archive (unavailable while running)",
      }),
    ).toBeDisabled();
    await user.keyboard("{Escape}");

    workspace = {
      ...workspace,
      threads: workspace.threads.map((thread) =>
        thread.id === threadId ? { ...thread, runState: null } : thread,
      ),
    };
    await queryClient.invalidateQueries({ queryKey: ["workspace"] });
    await user.click(
      await screen.findByRole("button", { name: "Archive Renamed thread" }),
    );
    await waitFor(() => {
      expect(api.archiveThread).toHaveBeenCalledWith(projectId, threadId);
    });
    expect(screen.queryByText("Renamed thread")).not.toBeInTheDocument();
  });
});
