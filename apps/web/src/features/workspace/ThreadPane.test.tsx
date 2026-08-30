// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ProjectId,
  RunId,
  ThreadId,
  ThreadSnapshot,
} from "@pi-web/contracts";

const api = vi.hoisted(() => ({
  getOlderTranscriptPage: vi.fn(),
  getSnapshot: vi.fn(),
  getWorkspace: vi.fn(),
  continueThread: vi.fn(),
  preflightContinuation: vi.fn(),
  markViewed: vi.fn(),
  prompt: vi.fn(),
  renameThread: vi.fn(),
  steer: vi.fn(),
  stop: vi.fn(),
  unarchiveThread: vi.fn(),
}));

vi.mock("../../api/client.js", async (importOriginal) => {
  const client = await importOriginal<typeof import("../../api/client.js")>();
  return { ...client, ...api };
});

import { ApiClientError } from "../../api/client.js";
import { isTextEntryTarget } from "./keybindings.js";
import { ThreadPane } from "./ThreadPane.js";

function localStorageFake(): Storage {
  const values = new Map<string, string>();
  return {
    get length(): number {
      return values.size;
    },
    clear(): void {
      values.clear();
    },
    getItem(key: string): string | null {
      return values.get(key) ?? null;
    },
    key(index: number): string | null {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key: string): void {
      values.delete(key);
    },
    setItem(key: string, value: string): void {
      values.set(key, value);
    },
  };
}

// The pane now asks the workspace listing whether its thread is still there
// (see the archive derivation in ThreadPane). Every test that is not about
// archiving wants the ordinary answer: yes.
beforeEach(() => {
  vi.stubGlobal("localStorage", localStorageFake());
  api.getWorkspace.mockResolvedValue({
    projects: [],
    threads: [{ id: threadId }],
    diagnostics: [],
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  restoreScrollGeometry();
  // Drafts are real localStorage keys and outlive the render. A test that
  // leaves one behind hands it to the next test's composer, which reads its
  // draft in a `useState` initialiser.
  localStorage.clear();
  vi.unstubAllGlobals();
});

// jsdom has no layout, so scrollHeight/clientHeight are always 0 and any
// scroll-to-bottom effect is unobservable. These helpers install writable
// geometry on the element prototype for the duration of one test (scrollTop
// itself is a real, settable property in jsdom).
let scrollGeometryStubbed = false;
function stubScrollGeometry(initial: {
  scrollHeight: number;
  clientHeight: number;
}) {
  let current = initial;
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get: () => current.scrollHeight,
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get: () => current.clientHeight,
  });
  scrollGeometryStubbed = true;
  return {
    set(next: { scrollHeight: number; clientHeight: number }) {
      current = next;
    },
  };
}
function restoreScrollGeometry() {
  if (!scrollGeometryStubbed) return;
  scrollGeometryStubbed = false;
  Reflect.deleteProperty(HTMLElement.prototype, "scrollHeight");
  Reflect.deleteProperty(HTMLElement.prototype, "clientHeight");
}

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
    runtime: "pi" as const,
    workspace: { mode: "shared", branchName: null, available: true },
  },
  transcriptPage: { items: [], olderCursor: null, atLatest: true },
  currentRun: null,
  lastRun: null,
  epoch: "40000000-0000-4000-8000-000000000001",
  highWaterSequence: 0,
  capabilities: { prompt: true, steer: true, stop: true },
  diagnostics: [],
};

function renderPane(
  overrides: {
    onFocus?: () => void;
    onClose?: () => void;
    onSplit?: () => void;
    onContinue?: () => void;
  } = {},
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const onFocus = overrides.onFocus ?? vi.fn();
  const onClose = overrides.onClose ?? vi.fn();
  const onSplit = overrides.onSplit ?? vi.fn();
  const onContinue = overrides.onContinue ?? vi.fn();
  const view = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ThreadPane
          projectId={projectId}
          threadId={threadId}
          focused
          onFocus={onFocus}
          onClose={onClose}
          onSplit={onSplit}
          onContinue={onContinue}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return {
    onFocus,
    onClose,
    onSplit,
    onContinue,
    queryClient,
    container: view.container,
  };
}

describe("ThreadPane", () => {
  it("renders the transcript and composer for a stubbed thread snapshot", async () => {
    api.getSnapshot.mockResolvedValue(snapshot);
    renderPane();

    expect(
      await screen.findByRole("heading", { name: "Example thread" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Conversation")).toBeInTheDocument();
    expect(
      screen.getByRole("textbox", { name: "Message Pi" }),
    ).toBeInTheDocument();
  });

  it("consumes exact /new into a pending pane without creating a thread", async () => {
    api.getSnapshot.mockResolvedValue(snapshot);
    api.preflightContinuation.mockResolvedValue({ available: true });
    const user = userEvent.setup();
    const { onContinue } = renderPane();

    const composer = await screen.findByRole("textbox", { name: "Message Pi" });
    await user.type(composer, "/new");
    const commandHint = screen.getByText(/New chat in this worktree/);
    expect(commandHint).toBeVisible();
    expect(
      commandHint.compareDocumentPosition(composer) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    expect(commandHint.parentElement).toBe(
      composer.closest(".composer-input")?.parentElement,
    );
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(api.preflightContinuation).toHaveBeenCalledWith(
        projectId,
        threadId,
      );
    });
    expect(api.continueThread).not.toHaveBeenCalled();
    expect(api.prompt).not.toHaveBeenCalled();
    expect(api.steer).not.toHaveBeenCalled();
    expect(onContinue).toHaveBeenCalledWith();
  });

  it("fills the composer when the /new command suggestion is clicked", async () => {
    api.getSnapshot.mockResolvedValue(snapshot);
    const user = userEvent.setup();
    renderPane();

    const composer = await screen.findByRole("textbox", { name: "Message Pi" });
    await user.type(composer, "/");
    await user.click(
      screen.getByRole("button", { name: "/new — New chat in this worktree" }),
    );

    expect(composer).toHaveValue("/new");
    expect(composer).toHaveFocus();
    expect(api.preflightContinuation).not.toHaveBeenCalled();
  });

  it("leaves argument-bearing /new input on the ordinary Pi prompt path", async () => {
    api.getSnapshot.mockResolvedValue(snapshot);
    api.prompt.mockResolvedValue({});
    const user = userEvent.setup();
    renderPane();

    const composer = await screen.findByRole("textbox", { name: "Message Pi" });
    await user.type(composer, "/new continue the task");
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(api.prompt).toHaveBeenCalledWith(
        projectId,
        threadId,
        "/new continue the task",
      );
    });
    expect(api.continueThread).not.toHaveBeenCalled();
  });

  it("renames from the pane header and updates its cached title immediately", async () => {
    api.getSnapshot.mockResolvedValue(snapshot);
    api.renameThread.mockImplementation(
      (_projectId: ProjectId, _threadId: ThreadId, title: string) =>
        Promise.resolve({
          thread: { ...snapshot.thread, title },
        }),
    );
    const user = userEvent.setup();
    renderPane();

    await user.dblClick(
      await screen.findByRole("heading", { name: "Example thread" }),
    );
    const field = screen.getByRole("textbox", {
      name: "Rename Example thread",
    });
    await user.clear(field);
    await user.type(field, "Header rename{Enter}");

    await waitFor(() => {
      expect(api.renameThread).toHaveBeenCalledWith(
        projectId,
        threadId,
        "Header rename",
      );
    });
    expect(
      await screen.findByRole("heading", { name: "Header rename" }),
    ).toBeInTheDocument();
  });

  it("invokes onClose from the pane header, without changing behavior otherwise", async () => {
    api.getSnapshot.mockResolvedValue(snapshot);
    const user = userEvent.setup();
    const { onClose } = renderPane();

    await screen.findByRole("heading", { name: "Example thread" });

    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("invokes onSplit from the pane header and exposes no Collapse/Bind button", async () => {
    api.getSnapshot.mockResolvedValue(snapshot);
    const user = userEvent.setup();
    const { onSplit } = renderPane();

    await screen.findByRole("heading", { name: "Example thread" });

    await user.click(
      screen.getByRole("button", { name: "Split right into a new chat" }),
    );
    expect(onSplit).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole("button", { name: "Collapse" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Bind" }),
    ).not.toBeInTheDocument();
  });

  it("renders the user turn as a quiet pill and the assistant turn as flowing text without a card", async () => {
    api.getSnapshot.mockResolvedValue({
      ...snapshot,
      transcriptPage: {
        ...snapshot.transcriptPage,
        items: [
          {
            id: "u1",
            kind: "message",
            role: "user",
            text: "Ping",
            timestamp: "2026-01-01T00:00:00.000Z",
          },
          {
            id: "a1",
            kind: "message",
            role: "assistant",
            text: "Pong",
            timestamp: "2026-01-01T00:00:01.000Z",
          },
        ],
      },
    });
    renderPane();
    await screen.findByRole("heading", { name: "Example thread" });

    const userBubble = screen.getByText("Ping").closest(".u-bubble");
    expect(userBubble).not.toBeNull();
    expect(userBubble?.closest(".message-user")).toBeNull();

    const assistantBlock = screen.getByText("Pong").closest(".a-block");
    expect(assistantBlock).not.toBeNull();
    expect(assistantBlock).not.toHaveClass("message");
  });

  it("loads earlier history explicitly without requesting the complete chat", async () => {
    const latest = {
      id: "latest-message",
      kind: "message" as const,
      role: "assistant" as const,
      text: "Latest",
      timestamp: null,
    };
    const older = {
      id: "older-message",
      kind: "message" as const,
      role: "user" as const,
      text: "Earlier",
      timestamp: null,
    };
    api.getSnapshot.mockResolvedValue({
      ...snapshot,
      transcriptPage: {
        items: [latest],
        olderCursor: "abcdefghijklmnop",
        atLatest: true,
      },
    });
    api.getOlderTranscriptPage.mockResolvedValue({
      items: [older],
      olderCursor: null,
      atLatest: false,
    });
    const user = userEvent.setup();
    renderPane();
    await screen.findByText("Latest");
    expect(screen.queryByText("Earlier")).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Load earlier messages" }),
    );
    expect(await screen.findByText("Earlier")).toBeInTheDocument();
    expect(api.getOlderTranscriptPage).toHaveBeenCalledWith(
      projectId,
      threadId,
      "abcdefghijklmnop",
    );
  });

  it("keeps a contiguous five-page history window and can jump back to latest", async () => {
    const latest = {
      id: "latest-message",
      kind: "message" as const,
      role: "assistant" as const,
      text: "Latest remains visible",
      timestamp: null,
    };
    api.getSnapshot.mockResolvedValue({
      ...snapshot,
      transcriptPage: {
        items: [latest],
        olderCursor: "cursor-0000000001",
        atLatest: true,
      },
    });
    for (let index = 1; index <= 6; index += 1) {
      api.getOlderTranscriptPage.mockResolvedValueOnce({
        items: [
          {
            id: `older-${String(index)}`,
            kind: "message" as const,
            role: "user" as const,
            text: `Older ${String(index)}`,
            timestamp: null,
          },
        ],
        olderCursor: index < 6 ? `cursor-000000000${String(index + 1)}` : null,
        atLatest: false,
      });
    }
    const user = userEvent.setup();
    renderPane();
    await screen.findByText("Latest remains visible");

    for (let index = 0; index < 6; index += 1) {
      await user.click(
        screen.getByRole("button", { name: "Load earlier messages" }),
      );
      await screen.findByText(`Older ${String(index + 1)}`);
    }

    // The window is oldest-first in loading order, so after the sixth prepend
    // it contains 6 through 2 with no missing page in the middle.
    for (let index = 2; index <= 6; index += 1)
      expect(screen.getByText(`Older ${String(index)}`)).toBeInTheDocument();
    expect(screen.queryByText("Older 1")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Latest remains visible"),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Jump to latest" }));
    expect(
      await screen.findByText("Latest remains visible"),
    ).toBeInTheDocument();
  });

  it("retains an unavailable backend draft without allowing it to submit", async () => {
    api.getSnapshot.mockResolvedValue({
      ...snapshot,
      thread: { ...snapshot.thread, runtimeAvailable: false },
    });
    const user = userEvent.setup();
    renderPane();
    const input = await screen.findByRole("textbox", { name: "Message Pi" });
    await user.type(input, "Keep this draft");
    await user.keyboard("{Enter}");

    expect(input).toHaveValue("Keep this draft");
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    expect(api.prompt).not.toHaveBeenCalled();
  });

  // Rewritten for UX-4: the pane no longer stacks a second `.thread-header`
  // band under `.pane-head`. The trust note is now the quiet inline line of
  // the single merged pane header, so this asserts the same CWS-01 intent
  // ("one quiet inline status line in the pane header region") against the
  // merged header instead of the removed one.
  it("demotes the trust notice to a single quiet line in the one pane header, not a full-width banner", async () => {
    api.getSnapshot.mockResolvedValue(snapshot);
    renderPane();

    const heading = await screen.findByRole("heading", {
      name: "Example thread",
    });
    const note = screen.getByText("Direct execution:");
    expect(note.closest(".trust-warning")).toBeNull();
    expect(note.closest(".pane-head")).not.toBeNull();
    expect(heading.closest(".pane-head")).toBe(note.closest(".pane-head"));
  });

  it("renders exactly one header, one title and one run status for the thread", async () => {
    api.getSnapshot.mockResolvedValue({
      ...snapshot,
      thread: { ...snapshot.thread, runState: "completed" },
    });
    const { container } = renderPane();
    await screen.findByRole("heading", { name: "Example thread" });

    expect(container.querySelectorAll(".thread-header")).toHaveLength(0);
    expect(container.querySelectorAll("header")).toHaveLength(1);
    expect(screen.getAllByText("Example thread")).toHaveLength(1);
    expect(screen.getAllByText("Done")).toHaveLength(1);
  });

  const ping = {
    id: "u1",
    kind: "message",
    role: "user",
    text: "Ping",
    timestamp: "2026-01-01T00:00:00.000Z",
  } as const;
  const pong = {
    id: "a1",
    kind: "message",
    role: "assistant",
    text: "Pong",
    timestamp: "2026-01-01T00:00:01.000Z",
  } as const;

  it("opens the transcript scrolled to the newest message and follows new items while pinned to the bottom", async () => {
    const geometry = stubScrollGeometry({
      scrollHeight: 2000,
      clientHeight: 400,
    });
    api.getSnapshot.mockResolvedValue({
      ...snapshot,
      transcriptPage: { items: [ping], olderCursor: null, atLatest: true },
    });
    const { queryClient } = renderPane();
    await screen.findByRole("heading", { name: "Example thread" });

    const transcript = screen.getByLabelText("Conversation");
    await waitFor(() => {
      expect(transcript.scrollTop).toBe(2000);
    });

    geometry.set({ scrollHeight: 3000, clientHeight: 400 });
    api.getSnapshot.mockResolvedValue({
      ...snapshot,
      transcriptPage: {
        items: [ping, pong],
        olderCursor: null,
        atLatest: true,
      },
    });
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["snapshot"] });
    });
    await screen.findByText("Pong");
    await waitFor(() => {
      expect(transcript.scrollTop).toBe(3000);
    });
  });

  it("keeps a pinned transcript at the newest content when the composer changes its height", async () => {
    const callbacks: ResizeObserverCallback[] = [];
    const observed = new Set<Element>();
    class StubResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        callbacks.push(callback);
      }
      observe(target: Element) {
        observed.add(target);
      }
      unobserve() {
        return;
      }
      disconnect() {
        return;
      }
    }
    vi.stubGlobal("ResizeObserver", StubResizeObserver);
    stubScrollGeometry({ scrollHeight: 2000, clientHeight: 400 });
    api.getSnapshot.mockResolvedValue({ ...snapshot, transcript: [ping] });
    renderPane();
    await screen.findByRole("heading", { name: "Example thread" });

    const transcript = screen.getByLabelText("Conversation");
    await waitFor(() => {
      expect(transcript.scrollTop).toBe(2000);
    });
    expect(observed.has(transcript)).toBe(true);
    const transcriptContent = transcript.firstElementChild;
    expect(transcriptContent).not.toBeNull();
    if (transcriptContent === null)
      throw new Error("missing transcript content");
    expect(observed.has(transcriptContent)).toBe(true);

    // Growing the composer reduces the transcript viewport without changing
    // its content key or necessarily dispatching a scroll event. Model the
    // resulting stale old-bottom position, then deliver ResizeObserver's
    // layout notification: a pinned transcript must follow the new bottom.
    transcript.scrollTop = 1500;
    act(() => {
      callbacks[0]?.([], {} as ResizeObserver);
    });
    expect(transcript.scrollTop).toBe(2000);

    // The same resize must not steal the viewport from someone who actually
    // scrolled up to read history.
    transcript.scrollTop = 0;
    fireEvent.scroll(transcript);
    act(() => {
      callbacks[0]?.([], {} as ResizeObserver);
    });
    expect(transcript.scrollTop).toBe(0);
  });

  it("does not yank the user back to the bottom once they have scrolled up", async () => {
    const geometry = stubScrollGeometry({
      scrollHeight: 2000,
      clientHeight: 400,
    });
    api.getSnapshot.mockResolvedValue({
      ...snapshot,
      transcriptPage: { items: [ping], olderCursor: null, atLatest: true },
    });
    const { queryClient } = renderPane();
    await screen.findByRole("heading", { name: "Example thread" });

    const transcript = screen.getByLabelText("Conversation");
    await waitFor(() => {
      expect(transcript.scrollTop).toBe(2000);
    });

    // The user scrolls up: the transcript must stop following new content.
    transcript.scrollTop = 0;
    fireEvent.scroll(transcript);

    geometry.set({ scrollHeight: 3000, clientHeight: 400 });
    api.getSnapshot.mockResolvedValue({
      ...snapshot,
      transcriptPage: {
        items: [ping, pong],
        olderCursor: null,
        atLatest: true,
      },
    });
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["snapshot"] });
    });
    await screen.findByText("Pong");
    expect(transcript.scrollTop).toBe(0);
  });

  // G5, the half that was actually broken. The pin itself works — measured
  // against a real Pi run, a genuine wheel scroll held scrollTop at 14320
  // for eight seconds while scrollHeight grew by 1,142px. What did NOT work
  // is getting back: the pin is never re-armed by content, so once a reader
  // had scrolled away, SENDING a message no longer jumped them to the
  // bottom. Measured in the browser: frozen at 10104 with a 4,900px gap for
  // 5.6 seconds after send, with the user's own message off screen.
  it("jumps back to the bottom when the user sends, even after scrolling away", async () => {
    const geometry = stubScrollGeometry({
      scrollHeight: 2000,
      clientHeight: 400,
    });
    api.getSnapshot.mockResolvedValue({
      ...snapshot,
      transcriptPage: { ...snapshot.transcriptPage, items: [ping] },
    });
    api.prompt.mockResolvedValue({ run: null });
    const user = userEvent.setup();
    renderPane();
    await screen.findByRole("heading", { name: "Example thread" });

    const transcript = screen.getByLabelText("Conversation");
    await waitFor(() => {
      expect(transcript.scrollTop).toBe(2000);
    });
    transcript.scrollTop = 0;
    fireEvent.scroll(transcript);
    expect(transcript.scrollTop).toBe(0);

    geometry.set({ scrollHeight: 3000, clientHeight: 400 });
    await user.type(
      screen.getByRole("textbox", { name: "Message Pi" }),
      "next question",
    );
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(transcript.scrollTop).toBe(3000);
    });
  });

  // During a fast run the transcript grows faster than a reader can scroll —
  // 40 wheel ticks of scrolling down gained no net ground against a stream in
  // the browser — so an explicit way back is not a nicety.
  it("offers a way back to the newest content only while the reader is away from it", async () => {
    stubScrollGeometry({ scrollHeight: 2000, clientHeight: 400 });
    api.getSnapshot.mockResolvedValue({
      ...snapshot,
      transcriptPage: { ...snapshot.transcriptPage, items: [ping] },
    });
    const user = userEvent.setup();
    renderPane();
    await screen.findByRole("heading", { name: "Example thread" });

    const transcript = screen.getByLabelText("Conversation");
    await waitFor(() => {
      expect(transcript.scrollTop).toBe(2000);
    });
    // Pinned: nothing to offer.
    expect(
      screen.queryByRole("button", { name: /Jump to latest/ }),
    ).not.toBeInTheDocument();

    transcript.scrollTop = 0;
    fireEvent.scroll(transcript);

    const jump = await screen.findByRole("button", { name: /Jump to latest/ });
    // In normal flow, not laid over the transcript: an overlay would cover
    // the newest line, which is the line they scrolled away from.
    expect(transcript.contains(jump)).toBe(false);

    await user.click(jump);
    await waitFor(() => {
      expect(transcript.scrollTop).toBe(2000);
    });
    expect(
      screen.queryByRole("button", { name: /Jump to latest/ }),
    ).not.toBeInTheDocument();
  });

  it("keeps the pane header usable and offers a Retry when the snapshot fails to load", async () => {
    api.getSnapshot.mockRejectedValueOnce(new Error("connection refused"));
    const user = userEvent.setup();
    renderPane();

    await screen.findByText("connection refused");
    // The pane chrome survives the failure: Close is still reachable.
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();

    api.getSnapshot.mockResolvedValue(snapshot);
    await user.click(screen.getByRole("button", { name: "Retry" }));

    expect(
      await screen.findByRole("heading", { name: "Example thread" }),
    ).toBeInTheDocument();
  });

  it("invokes onFocus when the pane body is clicked", async () => {
    api.getSnapshot.mockResolvedValue(snapshot);
    const user = userEvent.setup();
    const { onFocus } = renderPane();

    const heading = await screen.findByRole("heading", {
      name: "Example thread",
    });
    await user.click(heading);
    await waitFor(() => {
      expect(onFocus).toHaveBeenCalled();
    });
  });
});

// R2-8. Run.failureCode / Run.failureMessage have always been in the
// contracts and sent by the server, but the web app used them nowhere: a
// dead run showed a red dot labelled "Failed" and nothing else — no reason,
// no retry, nothing to paste into a bug report.
describe("failed run reporting", () => {
  const failedSnapshot: ThreadSnapshot = {
    ...snapshot,
    thread: { ...snapshot.thread, runState: "failed" },
    currentRun: null,
    lastRun: {
      id: "50000000-0000-4000-8000-000000000001" as RunId,
      threadId,
      projectId,
      state: "failed",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:00:05.000Z",
      failureCode: "runtime_unavailable",
      failureMessage: "The Pi runtime exited before the run completed.",
    },
  };

  it("renders the run's failure message, not just a red dot", async () => {
    api.getSnapshot.mockResolvedValue(failedSnapshot);
    renderPane();

    await screen.findByRole("heading", { name: "Example thread" });
    expect(
      await screen.findByText(
        "The Pi runtime exited before the run completed.",
      ),
    ).toBeVisible();
    // The status label is still there; the message is additional, not a
    // replacement.
    expect(screen.getByText("Failed")).toBeInTheDocument();
  });

  it("falls back to the failure code when no message is supplied", async () => {
    api.getSnapshot.mockResolvedValue({
      ...failedSnapshot,
      lastRun: { ...failedSnapshot.lastRun, failureMessage: null },
    });
    renderPane();

    await screen.findByRole("heading", { name: "Example thread" });
    expect(await screen.findByText(/runtime_unavailable/)).toBeVisible();
  });

  it("says nothing about failure when the run did not fail", async () => {
    api.getSnapshot.mockResolvedValue(snapshot);
    renderPane();

    await screen.findByRole("heading", { name: "Example thread" });
    expect(document.querySelector(".run-failure")).toBeNull();
  });
});

describe("a continued chat exposes no backend control", () => {
  // AGB-01: a chat's backend is immutable, and no resuming surface offers to
  // change it. A regression here would be silent, so it is asserted rather
  // than left to review.
  it("offers no agent or provider control anywhere in the pane", async () => {
    api.getSnapshot.mockResolvedValue(snapshot);
    renderPane();
    await screen.findByText("Example thread");

    expect(
      screen.queryByRole("combobox", { name: /agent/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("radiogroup", { name: /agent/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("combobox", { name: /provider|model|backend/i }),
    ).not.toBeInTheDocument();
  });

  it("shows which agent runs the chat, without offering to change it", async () => {
    api.getSnapshot.mockResolvedValue(snapshot);
    renderPane();
    await screen.findByText("Example thread");
    expect(screen.getByText("Pi")).toBeInTheDocument();
  });

  it("addresses the composer to the agent that will read it", async () => {
    api.getSnapshot.mockResolvedValue({
      ...snapshot,
      thread: { ...snapshot.thread, runtime: "codex" as const },
    });
    renderPane();
    expect(
      await screen.findByRole("textbox", { name: "Message Codex" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("textbox", { name: "Message Pi" }),
    ).not.toBeInTheDocument();
  });

  it("describes Codex execution as confined rather than as Pi's", async () => {
    api.getSnapshot.mockResolvedValue({
      ...snapshot,
      thread: { ...snapshot.thread, runtime: "codex" as const },
    });
    renderPane();
    await screen.findByText("Example thread");
    expect(screen.getAllByText(/Confined execution/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Direct execution/)).not.toBeInTheDocument();
  });
});

// G1. Press Stop and the pane rendered a green dot and the word "Done" —
// byte-for-byte the presentation of a run that completed normally — while
// the server held `state: "interrupted", failureCode: "user_stop",
// failureMessage: "Stopped by the user."`. The same path swallowed
// "Interrupted because the project was removed."
describe("stopped run reporting", () => {
  const stoppedSnapshot: ThreadSnapshot = {
    ...snapshot,
    thread: { ...snapshot.thread, runState: "interrupted" },
    currentRun: null,
    lastRun: {
      id: "50000000-0000-4000-8000-000000000002" as RunId,
      threadId,
      projectId,
      state: "interrupted",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:00:23.000Z",
      failureCode: "user_stop",
      failureMessage: "Stopped by the user.",
    },
  };

  it("labels a stopped run Stopped, never Done", async () => {
    api.getSnapshot.mockResolvedValue(stoppedSnapshot);
    const { container } = renderPane();

    await screen.findByRole("heading", { name: "Example thread" });
    expect(screen.getByText("Stopped")).toBeInTheDocument();
    expect(screen.queryByText("Done")).not.toBeInTheDocument();
    // And not on the success token, which is what made the dot green.
    const status = container.querySelector(".pane-head .status");
    expect(status?.className).toContain("stop");
    expect(status?.className).not.toContain("done");
  });

  it("surfaces the server's reason, in a tone that is not failure", async () => {
    api.getSnapshot.mockResolvedValue(stoppedSnapshot);
    const { container } = renderPane();

    await screen.findByRole("heading", { name: "Example thread" });
    expect(await screen.findByText("Stopped by the user.")).toBeVisible();
    const notice = container.querySelector(".run-failure");
    expect(notice?.className).toContain("stopped");
  });

  it("carries the project-removal wording through the same path", async () => {
    api.getSnapshot.mockResolvedValue({
      ...stoppedSnapshot,
      lastRun: {
        ...stoppedSnapshot.lastRun,
        failureCode: "project_removed",
        failureMessage: "Interrupted because the project was removed.",
      },
    });
    renderPane();

    await screen.findByRole("heading", { name: "Example thread" });
    expect(
      await screen.findByText("Interrupted because the project was removed."),
    ).toBeVisible();
  });
});

// G2. Archiving a thread left its open pane completely unchanged: same
// title, green "Done" header, and a fully enabled composer. Typing into it
// cleared the box and THEN failed with the raw internal "Thread was not found
// in this project." plus a Retry that could never succeed.
describe("a pane whose thread is archived", () => {
  const listed = {
    projects: [],
    threads: [{ id: threadId }],
    diagnostics: [],
  };
  const gone = { projects: [], threads: [], diagnostics: [] };

  it("says so, and stops inviting input, as soon as the thread leaves the listing", async () => {
    api.getSnapshot.mockResolvedValue(snapshot);
    api.getWorkspace.mockResolvedValue(listed);
    const { queryClient, container } = renderPane();
    await screen.findByRole("heading", { name: "Example thread" });
    expect(
      screen.getByRole("textbox", { name: "Message Pi" }),
    ).toBeInTheDocument();

    // The sidebar archives the thread and invalidates ["workspace"].
    api.getWorkspace.mockResolvedValue(gone);
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["workspace"] });
    });

    expect(
      await screen.findByText(
        "This thread is archived. Restore it to keep working.",
      ),
    ).toBeVisible();
    // No composer at all: the pane cannot take a message it would only lose.
    expect(
      screen.queryByRole("textbox", { name: "Message Pi" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Archived")).toBeInTheDocument();
    expect(container.querySelector(".pane-head .status")?.className).toContain(
      "archived",
    );
  });

  it("offers Restore, which is an action that can actually succeed", async () => {
    api.getSnapshot.mockResolvedValue(snapshot);
    api.getWorkspace.mockResolvedValue(listed);
    api.unarchiveThread.mockResolvedValue({ archived: false });
    const user = userEvent.setup();
    const { queryClient } = renderPane();
    await screen.findByRole("heading", { name: "Example thread" });

    api.getWorkspace.mockResolvedValue(gone);
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["workspace"] });
    });

    await user.click(
      await screen.findByRole("button", { name: "Restore thread" }),
    );
    await waitFor(() => {
      expect(api.unarchiveThread).toHaveBeenCalledWith(projectId, threadId);
    });
  });

  it("recognises an archived thread the pane was opened on directly, from the server's own refusal", async () => {
    // A layout restored from storage can point straight at an archived
    // thread. There is no listing history to consult, so the 404 is the
    // signal — and it must not be shown raw.
    api.getSnapshot.mockRejectedValue(
      new ApiClientError(
        404,
        "thread_not_found",
        "Thread was not found in this project.",
      ),
    );
    api.getWorkspace.mockResolvedValue(gone);
    renderPane();

    expect(
      await screen.findByText(
        "This thread is archived. Restore it to keep working.",
      ),
    ).toBeVisible();
    expect(
      screen.queryByText("Thread was not found in this project."),
    ).not.toBeInTheDocument();
  });

  it("does not call a brand-new thread archived just because the listing is stale", async () => {
    // The thread has never appeared in the listing, and the snapshot loads
    // fine. Without the latch this flashed "Archived" on every new thread.
    api.getSnapshot.mockResolvedValue(snapshot);
    api.getWorkspace.mockResolvedValue(gone);
    renderPane();

    await screen.findByRole("heading", { name: "Example thread" });
    expect(
      screen.getByRole("textbox", { name: "Message Pi" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Archived")).not.toBeInTheDocument();
  });

  // SF3. Every piece of per-thread state in this component -- the archived
  // latch, the steer echoes, the restore mutation -- belonged to the thread
  // the pane was showing, and none of it was keyed to the thread. The latch
  // only ever goes true, so a pane rebound from a listed thread onto one the
  // listing has not caught up with declared a live, brand-new thread Archived
  // and took its composer away.
  it("does not carry the archived latch across a rebind to another thread", async () => {
    const otherThreadId = "20000000-0000-4000-8000-000000000002" as ThreadId;
    const otherSnapshot: ThreadSnapshot = {
      ...snapshot,
      thread: {
        ...snapshot.thread,
        id: otherThreadId,
        title: "Second thread",
      },
    };
    api.getSnapshot.mockImplementation((_projectId: ProjectId, id: ThreadId) =>
      Promise.resolve(id === threadId ? snapshot : otherSnapshot),
    );
    // The listing knows the first thread and not the second one.
    api.getWorkspace.mockResolvedValue(listed);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const pane = (id: ThreadId) => (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <ThreadPane
            projectId={projectId}
            threadId={id}
            focused
            onFocus={vi.fn()}
            onClose={vi.fn()}
            onSplit={vi.fn()}
          />
        </MemoryRouter>
      </QueryClientProvider>
    );
    const view = render(pane(threadId));
    await screen.findByRole("heading", { name: "Example thread" });

    view.rerender(pane(otherThreadId));

    await screen.findByRole("heading", { name: "Second thread" });
    expect(
      screen.getByRole("textbox", { name: "Message Pi" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Archived")).not.toBeInTheDocument();
    expect(
      screen.queryByText(
        "This thread is archived. Restore it to keep working.",
      ),
    ).not.toBeInTheDocument();
  });

  it("resolves while the retry ladder is still running, instead of sitting on Loading", async () => {
    // Observed in the running app before this: two panes restored onto a
    // just-archived thread stayed on "Loading workspace…". The app-wide
    // default retries twice with backoff, and for the whole of that ladder
    // `error` is null and `isPending` is true — so the pane read the outcome
    // off `failureReason`, which is set by the FIRST failed attempt.
    api.getSnapshot.mockRejectedValue(
      new ApiClientError(
        404,
        "thread_not_found",
        "Thread was not found in this project.",
      ),
    );
    api.getWorkspace.mockResolvedValue(gone);
    const queryClient = new QueryClient({
      // The application's own retry policy (main.tsx), not the usual test
      // opt-out — the point of this test is that the ladder does not matter.
      defaultOptions: { queries: { retry: (count: number) => count < 2 } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <ThreadPane
            projectId={projectId}
            threadId={threadId}
            focused
            onFocus={vi.fn()}
            onClose={vi.fn()}
            onSplit={vi.fn()}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(
      await screen.findByText(
        "This thread is archived. Restore it to keep working.",
      ),
    ).toBeVisible();
    expect(screen.queryByText("Loading workspace…")).not.toBeInTheDocument();
  });

  it("keeps a genuine transport failure on the ordinary retryable notice", async () => {
    api.getSnapshot.mockRejectedValue(new Error("connection refused"));
    api.getWorkspace.mockResolvedValue(listed);
    renderPane();

    await screen.findByText("connection refused");
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});

// The composer reads its saved draft ONCE, in a `useState` initialiser, and
// `<ThreadPane>` is rendered without a React key while its `threadId` is a
// prop (TilingSurface). So a pane rebound to another thread kept the previous
// thread's text on screen AND its draft-writing effect immediately copied
// that text over the NEW thread's saved draft, destroying it.
describe("draft restore when a pane is rebound to another thread", () => {
  const otherThreadId = "20000000-0000-4000-8000-000000000002" as ThreadId;

  function renderRebindable(bound: ThreadId) {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const view = render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <ThreadPane
            projectId={projectId}
            threadId={bound}
            focused
            onFocus={vi.fn()}
            onClose={vi.fn()}
            onSplit={vi.fn()}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    return {
      rerender: (next: ThreadId) => {
        view.rerender(
          <QueryClientProvider client={queryClient}>
            <MemoryRouter>
              <ThreadPane
                projectId={projectId}
                threadId={next}
                focused
                onFocus={vi.fn()}
                onClose={vi.fn()}
                onSplit={vi.fn()}
              />
            </MemoryRouter>
          </QueryClientProvider>,
        );
      },
    };
  }

  it("shows the new thread's own draft and leaves it in storage", async () => {
    window.localStorage.setItem("pi-draft:" + threadId, "draft for A");
    window.localStorage.setItem("pi-draft:" + otherThreadId, "draft for B");
    api.getSnapshot.mockImplementation((_project: unknown, id: ThreadId) =>
      Promise.resolve({
        ...snapshot,
        thread: {
          ...snapshot.thread,
          id,
          title: id === threadId ? "Thread A" : "Thread B",
        },
      }),
    );
    api.getWorkspace.mockResolvedValue({
      projects: [],
      threads: [{ id: threadId }, { id: otherThreadId }],
      diagnostics: [],
    });

    const { rerender } = renderRebindable(threadId);
    const composer = await screen.findByRole("textbox", { name: "Message Pi" });
    expect(composer).toHaveValue("draft for A");

    rerender(otherThreadId);
    await screen.findByRole("heading", { name: "Thread B" });

    expect(screen.getByRole("textbox", { name: "Message Pi" })).toHaveValue(
      "draft for B",
    );
    // And A's draft is still A's.
    await waitFor(() => {
      expect(window.localStorage.getItem("pi-draft:" + otherThreadId)).toBe(
        "draft for B",
      );
    });
    expect(window.localStorage.getItem("pi-draft:" + threadId)).toBe(
      "draft for A",
    );
    window.localStorage.clear();
  });
});

// The pane used to receive every live frame, validate it, throw the payload
// away and invalidate the snapshot query instead. That could not stream: the
// snapshot route reads Pi's PERSISTED session branch, which does not contain
// the in-progress message at all, so no amount of refetching could show a
// partial answer. Measured against the running server, a 2,583 character
// answer arrived as 494 live frames and landed on screen in exactly one DOM
// mutation, 17s after the question.
describe("live streaming", () => {
  class FakeWebSocket {
    public static instances: FakeWebSocket[] = [];
    public readonly sent: string[] = [];
    private readonly listeners = new Map<string, Set<(event: never) => void>>();
    public constructor(public readonly url: string) {
      FakeWebSocket.instances.push(this);
    }
    public addEventListener(type: string, handler: (event: never) => void) {
      const set = this.listeners.get(type) ?? new Set();
      set.add(handler);
      this.listeners.set(type, set);
    }
    public removeEventListener(type: string, handler: (event: never) => void) {
      this.listeners.get(type)?.delete(handler);
    }
    public send(data: string) {
      this.sent.push(data);
    }
    public close() {
      this.emit("close", {});
    }
    public openSocket() {
      this.emit("open", {});
    }
    public deliver(payload: unknown) {
      this.emit("message", { data: JSON.stringify(payload) });
    }
    private emit(type: string, event: unknown) {
      for (const handler of [...(this.listeners.get(type) ?? [])])
        (handler as (value: unknown) => void)(event);
    }
  }

  let originalWebSocket: unknown;
  beforeEach(() => {
    FakeWebSocket.instances = [];
    originalWebSocket = globalThis.WebSocket;
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: FakeWebSocket,
    });
  });
  afterEach(() => {
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: originalWebSocket,
    });
  });

  const epoch = "40000000-0000-4000-8000-000000000001";
  /** A thread with a run in flight, which is when live frames arrive. */
  const running: ThreadSnapshot = {
    ...snapshot,
    thread: { ...snapshot.thread, runState: "running" },
    currentRun: {
      id: "50000000-0000-4000-8000-000000000009" as RunId,
      threadId,
      projectId,
      state: "running",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: null,
      failureCode: null,
      failureMessage: null,
    },
  };
  function frame(sequence: number, payload: unknown) {
    return {
      version: 1,
      type: "event",
      threadId,
      epoch,
      sequence,
      eventId: `60000000-0000-4000-8000-00000000000${String(sequence % 10)}`,
      eventType: "transcript",
      payload,
    };
  }
  function streamed(text: string) {
    return {
      id: "streaming-assistant",
      kind: "message",
      role: "assistant",
      text,
      timestamp: "2026-01-01T00:00:01.000Z",
    };
  }

  /** Opens the pane's live socket and returns it, subscription already sent. */
  async function connect() {
    const socket = FakeWebSocket.instances.at(-1);
    if (socket === undefined) throw new Error("no live socket was opened");
    await act(async () => {
      socket.openSocket();
      await Promise.resolve();
    });
    return socket;
  }
  /** Delivers frames and lets the pane's coalescing window elapse. */
  async function deliver(socket: FakeWebSocket, ...payloads: unknown[]) {
    await act(async () => {
      for (const payload of payloads) socket.deliver(payload);
      await new Promise((resolve) => setTimeout(resolve, 80));
    });
  }

  it("resumes from the snapshot's cursor when the socket opens", async () => {
    api.getSnapshot.mockResolvedValue({ ...snapshot, highWaterSequence: 7 });
    renderPane();
    await screen.findByRole("heading", { name: "Example thread" });

    const socket = await connect();
    expect(JSON.parse(socket.sent[0] ?? "{}")).toMatchObject({
      type: "subscribe",
      threadId,
      epoch: snapshot.epoch,
      cursor: 7,
    });
  });

  it("paints each streamed frame from the event payload, without refetching the thread", async () => {
    api.getSnapshot.mockResolvedValue(snapshot);
    renderPane();
    await screen.findByRole("heading", { name: "Example thread" });
    const socket = await connect();
    api.getSnapshot.mockClear();

    await deliver(socket, frame(1, streamed("The Pomodoro")));
    expect(screen.getByText("The Pomodoro")).toBeInTheDocument();

    await deliver(socket, frame(2, streamed("The Pomodoro technique")));
    expect(screen.getByText("The Pomodoro technique")).toBeInTheDocument();

    await deliver(socket, frame(3, streamed("The Pomodoro technique splits")));
    expect(
      screen.getByText("The Pomodoro technique splits"),
    ).toBeInTheDocument();

    // The regression this test exists for: the answer reached the screen
    // three separate times and the thread was never re-fetched to do it.
    expect(api.getSnapshot).not.toHaveBeenCalled();
  });

  it("replaces the streaming placeholder with the settled turn instead of showing both", async () => {
    const settled = {
      id: "live-0e4bf4e4-6c2e-4b2f-9f2b-0f4b0f4b0f4b",
      kind: "message",
      role: "assistant",
      text: "Work in 25 minute blocks.",
      timestamp: "2026-01-01T00:00:02.000Z",
    } as const;
    // The refetch the settled frame triggers must NOT be what makes this pass:
    // the server is left holding the pre-turn transcript, so a placeholder
    // that survived alongside the settled turn would show up as a duplicate.
    api.getSnapshot.mockResolvedValue(running);
    renderPane();
    await screen.findByRole("heading", { name: "Example thread" });
    const socket = await connect();

    await deliver(socket, frame(1, streamed("Work in 25 minute")));
    await deliver(socket, frame(2, settled));

    expect(screen.getAllByText("Work in 25 minute blocks.")).toHaveLength(1);
    expect(screen.queryByText("Work in 25 minute")).toBeNull();
    // A settled turn still reconciles with the server: tool steps never
    // travel on the live channel.
    await waitFor(() => {
      expect(api.getSnapshot).toHaveBeenCalled();
    });
    // ...and the reconciled snapshot does not double the answer either.
    expect(screen.getAllByText("Work in 25 minute blocks.")).toHaveLength(1);
  });

  // B1. The streamed turn used to live in the ["snapshot", ...] query cache,
  // and React Query replaces query data wholesale on every fetch success.
  // The pane polls every 15s and the server snapshot provably cannot hold
  // the in-progress message, so every completed fetch wiped the partial
  // answer off the screen. While tokens flow at a 7ms median it was restored
  // within the 40ms flush window and was invisible -- but while the model is
  // paused on a tool call, nothing restores it, and the paragraph stays gone
  // for the whole pause. Text -> tool -> text is the most common real turn.
  it("keeps a partly-streamed answer on screen across a refetch while the model is paused", async () => {
    api.getSnapshot.mockResolvedValue(running);
    const { queryClient } = renderPane();
    await screen.findByRole("heading", { name: "Example thread" });
    const socket = await connect();

    await deliver(socket, frame(1, streamed("Let me check the repository")));
    expect(screen.getByText("Let me check the repository")).toBeInTheDocument();

    // The 15s background poll fires while Pi is inside a slow tool call, so
    // no further frame arrives to repaint the text.
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ["snapshot"] });
      await new Promise((resolve) => setTimeout(resolve, 80));
    });

    expect(screen.getByText("Let me check the repository")).toBeInTheDocument();
  });

  it("drops the streamed turn once the run is no longer active", async () => {
    api.getSnapshot.mockResolvedValue(running);
    const { queryClient } = renderPane();
    await screen.findByRole("heading", { name: "Example thread" });
    const socket = await connect();

    await deliver(socket, frame(1, streamed("half an answer")));
    expect(screen.getByText("half an answer")).toBeInTheDocument();

    // The fetch that reports the run settled is the one that carries the
    // persisted message, so nothing is lost by letting go here.
    api.getSnapshot.mockResolvedValue(snapshot);
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ["snapshot"] });
      await new Promise((resolve) => setTimeout(resolve, 80));
    });

    expect(screen.queryByText("half an answer")).toBeNull();
  });

  // B1. Pi drains its steering queue AFTER the turn in flight, so a steer it
  // persists lands BELOW the assistant message it interrupted. The window
  // `alreadySettled` searched was anchored on the last user message, so the
  // settled turn fell outside it, `mergeLiveTurn` appended the live copy
  // again, and the reader saw the entire answer twice under their own steer.
  // `live.turn` is only cleared when the run goes inactive, and this happens
  // while the run is still going, so nothing rescued it.
  it("does not duplicate the settled turn once a steer is persisted after it", async () => {
    const prompt = {
      id: "pi-prompt",
      kind: "message",
      role: "user",
      text: "do the thing",
      timestamp: "2026-01-01T00:00:00.000Z",
    } as const;
    api.getSnapshot.mockResolvedValue({
      ...running,
      transcriptPage: { ...running.transcriptPage, items: [prompt] },
    });
    const { queryClient } = renderPane();
    await screen.findByRole("heading", { name: "Example thread" });
    const socket = await connect();

    await deliver(socket, frame(1, streamed("Here is the")));
    await deliver(
      socket,
      frame(2, {
        id: "live-0e4bf4e4-6c2e-4b2f-9f2b-0f4b0f4b0f4b",
        kind: "message",
        role: "assistant",
        text: "Here is the answer.",
        timestamp: "2026-01-01T00:00:02.000Z",
      }),
    );
    expect(screen.getAllByText("Here is the answer.")).toHaveLength(1);

    // The turn is persisted, and the steer Pi drained after it lands below.
    // The run is STILL running: the next turn has not produced a token yet,
    // so nothing replaces the live turn.
    api.getSnapshot.mockResolvedValue({
      ...running,
      transcriptPage: {
        ...running.transcriptPage,
        items: [
          prompt,
          {
            id: "pi-answer",
            kind: "message",
            role: "assistant",
            text: "Here is the answer.",
            timestamp: "2026-01-01T00:00:02.000Z",
          },
          {
            id: "pi-steer",
            kind: "message",
            role: "user",
            text: "also add tests",
            timestamp: "2026-01-01T00:00:03.000Z",
          },
        ],
      },
    });
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["snapshot"] });
    });

    await screen.findByText("also add tests");
    expect(screen.getAllByText("Here is the answer.")).toHaveLength(1);
  });

  it("falls back to a full refetch when the server cannot replay from our cursor", async () => {
    api.getSnapshot.mockResolvedValue(snapshot);
    renderPane();
    await screen.findByRole("heading", { name: "Example thread" });
    const socket = await connect();
    api.getSnapshot.mockClear();

    await deliver(socket, {
      version: 1,
      type: "snapshot_required",
      threadId,
    });
    await waitFor(() => {
      expect(api.getSnapshot).toHaveBeenCalled();
    });
  });

  it("refetches when a sequence gap says frames were missed, and still paints the frame it has", async () => {
    api.getSnapshot.mockResolvedValue(snapshot);
    renderPane();
    await screen.findByRole("heading", { name: "Example thread" });
    const socket = await connect();
    api.getSnapshot.mockClear();

    await deliver(socket, frame(1, streamed("first")));
    expect(api.getSnapshot).not.toHaveBeenCalled();

    // Sequence 5 after sequence 1: three events never arrived. The snapshot
    // route still has nothing to add mid-turn (Pi's session branch does not
    // hold the in-progress message), so the streamed frame is what keeps the
    // answer on screen while the resync runs.
    await deliver(socket, frame(5, streamed("first second third")));
    expect(screen.getByText("first second third")).toBeInTheDocument();
    await waitFor(() => {
      expect(api.getSnapshot).toHaveBeenCalled();
    });
  });

  it("keeps one socket across refetches instead of reconnecting on every snapshot change", async () => {
    api.getSnapshot.mockResolvedValue(snapshot);
    const { queryClient } = renderPane();
    await screen.findByRole("heading", { name: "Example thread" });
    await connect();
    expect(FakeWebSocket.instances).toHaveLength(1);

    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["snapshot"] });
    });
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  function diagnosticFrame(sequence: number, payload: unknown) {
    return { ...frame(sequence, payload), eventType: "diagnostic" };
  }

  // G12. The pane's onMessage handled only `eventType === "transcript"`;
  // every other type fell through to scheduleRefetch() and the payload was
  // discarded. Among what was discarded: "Provider retry N of M." So while
  // the provider was retrying, the app looked like a run that was merely
  // slow — the exact ambiguity the streaming work existed to remove.
  it("shows a provider retry instead of using it only as a refetch trigger", async () => {
    api.getSnapshot.mockResolvedValue(running);
    renderPane();
    await screen.findByRole("heading", { name: "Example thread" });
    const socket = await connect();

    await deliver(
      socket,
      diagnosticFrame(1, {
        type: "diagnostic",
        level: "warning",
        code: "provider_retry",
        message: "Provider retry 2 of 5.",
      }),
    );

    expect(await screen.findByText("Provider retry 2 of 5.")).toBeVisible();
  });

  it("stays silent about the unsupported-event diagnostics Pi's tool activity produces", async () => {
    api.getSnapshot.mockResolvedValue(running);
    renderPane();
    await screen.findByRole("heading", { name: "Example thread" });
    const socket = await connect();

    await deliver(
      socket,
      diagnosticFrame(1, {
        type: "diagnostic",
        level: "warning",
        code: "unsupported_event",
        message: "Pi emitted an unsupported event.",
      }),
    );

    expect(
      screen.queryByText("Pi emitted an unsupported event."),
    ).not.toBeInTheDocument();
  });

  it("clears the retry notice as soon as content moves again", async () => {
    api.getSnapshot.mockResolvedValue(running);
    renderPane();
    await screen.findByRole("heading", { name: "Example thread" });
    const socket = await connect();

    await deliver(
      socket,
      diagnosticFrame(1, {
        type: "diagnostic",
        level: "warning",
        code: "provider_retry",
        message: "Provider retry 2 of 5.",
      }),
    );
    await screen.findByText("Provider retry 2 of 5.");

    await deliver(socket, frame(2, streamed("Back on track.")));

    await waitFor(() => {
      expect(
        screen.queryByText("Provider retry 2 of 5."),
      ).not.toBeInTheDocument();
    });
  });

  // G3. The composer cleared — the app's universal "sent" signal — and then
  // nothing appeared for the whole of a five-minute run, in the pane or in
  // the server's transcript. Nothing can be fetched here: `steer` writes no
  // transcript state and Pi does not persist a steering message until it
  // drains its queue at the end of the turn in flight.
  it("echoes a steer into the transcript the moment the server accepts it", async () => {
    api.getSnapshot.mockResolvedValue(running);
    api.steer.mockResolvedValue({ run: running.currentRun });
    const user = userEvent.setup();
    renderPane();
    await screen.findByRole("heading", { name: "Example thread" });

    const composer = await screen.findByRole("textbox", { name: "Message Pi" });
    await user.type(composer, "Stop and reply BANANA");
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(api.steer).toHaveBeenCalled();
    });
    // Visible without any refetch having produced it: the snapshot mock has
    // not changed and still returns an empty transcript.
    expect(await screen.findByText("Stop and reply BANANA")).toBeVisible();
    expect(composer).toHaveValue("");
  });

  it("confirms an image-only accepted steer until Pi persists it", async () => {
    api.getSnapshot.mockResolvedValue(running);
    api.steer.mockResolvedValue({ run: running.currentRun });
    const user = userEvent.setup();
    const { queryClient } = renderPane();
    await screen.findByRole("heading", { name: "Example thread" });
    const composer = await screen.findByRole("textbox", { name: "Message Pi" });

    const image = new File([new Uint8Array([1, 2, 3])], "queued.png", {
      type: "image/png",
    });
    const form = composer.closest("form");
    if (form === null) throw new Error("Expected a composer form");
    fireEvent.drop(form, {
      dataTransfer: { types: ["Files"], files: [image] },
    });
    await user.click(screen.getByRole("button", { name: "Steer current run" }));

    await waitFor(() => {
      expect(api.steer).toHaveBeenCalled();
    });
    expect(await screen.findByLabelText("1 queued image")).toHaveTextContent(
      "1 image queued for steering",
    );
    expect(screen.getByRole("textbox", { name: "Message Pi" })).toHaveValue("");

    api.getSnapshot.mockResolvedValue({
      ...snapshot,
      transcript: [
        {
          id: "pi-queued-image",
          kind: "message",
          role: "user",
          text: "",
          timestamp: "2026-01-01T00:00:02.000Z",
        },
      ],
    });
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["snapshot"] });
    });

    await waitFor(() => {
      expect(screen.queryByLabelText("1 queued image")).not.toBeInTheDocument();
    });
  });

  // Named for what it actually exercises. It settles the run in the same step
  // that delivers the persisted message, so the run-settled sweep clears the
  // echo whether or not retirement is wired in at all; the mid-run test below
  // is the one that pins the handover.
  it("clears the echo when the run settles, leaving one copy on screen", async () => {
    api.getSnapshot.mockResolvedValue(running);
    api.steer.mockResolvedValue({ run: running.currentRun });
    const user = userEvent.setup();
    const { queryClient } = renderPane();
    await screen.findByRole("heading", { name: "Example thread" });

    await user.type(
      await screen.findByRole("textbox", { name: "Message Pi" }),
      "Stop and reply BANANA",
    );
    await user.keyboard("{Enter}");
    await screen.findByText("Stop and reply BANANA");

    // The run settles and Pi has now persisted the steer.
    api.getSnapshot.mockResolvedValue({
      ...snapshot,
      transcriptPage: {
        ...snapshot.transcriptPage,
        items: [
          {
            id: "pi-1a2b3c4d",
            kind: "message",
            role: "user",
            text: "Stop and reply BANANA",
            timestamp: "2026-01-01T00:00:02.000Z",
          },
        ],
      },
    });
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["snapshot"] });
    });

    await waitFor(() => {
      expect(screen.getAllByText("Stop and reply BANANA")).toHaveLength(1);
    });
  });

  // BL1, end to end. "keep going" is the vocabulary of steering, and the
  // second time you say it is the time it matters. The earlier prompt was
  // never a pending echo, so nothing had consumed it.
  it("keeps the echo when an earlier turn in this thread used the same words", async () => {
    const earlier: ThreadSnapshot = {
      ...running,
      transcriptPage: {
        ...running.transcriptPage,
        items: [
          {
            id: "pi-earlier",
            kind: "message",
            role: "user",
            text: "keep going",
            timestamp: "2026-01-01T00:00:00.000Z",
          },
          {
            id: "pi-answer",
            kind: "message",
            role: "assistant",
            text: "On it.",
            timestamp: "2026-01-01T00:00:01.000Z",
          },
        ],
      },
    };
    api.getSnapshot.mockResolvedValue(earlier);
    api.steer.mockResolvedValue({ run: earlier.currentRun });
    const user = userEvent.setup();
    const { queryClient } = renderPane();
    await screen.findByRole("heading", { name: "Example thread" });

    await user.type(
      await screen.findByRole("textbox", { name: "Message Pi" }),
      "keep going",
    );
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(api.steer).toHaveBeenCalled();
    });
    expect(screen.getAllByText("keep going")).toHaveLength(2);

    // A tool step lands, as one does every few seconds during a run. The
    // transcript changed, but Pi still has not persisted the steer, so both
    // copies must still be on screen.
    api.getSnapshot.mockResolvedValue({
      ...earlier,
      transcriptPage: {
        ...earlier.transcriptPage,
        items: [
          ...earlier.transcriptPage.items,
          {
            id: "pi-progress",
            kind: "message",
            role: "assistant",
            text: "Still working.",
            timestamp: "2026-01-01T00:00:02.000Z",
          },
        ],
      },
    });
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["snapshot"] });
    });

    await screen.findByText("Still working.");
    expect(screen.getAllByText("keep going")).toHaveLength(2);
  });

  // BL2. `SteerRequestSchema` is `z.string().trim()` and the server hands Pi
  // the PARSED value, so echoing the raw textarea contents meant the echo
  // could never match what came back -- two identical bubbles for the rest of
  // the run. This also covers the real handover, which happens while the run
  // is still going: Pi drains its steering queue at the end of the TURN.
  it("echoes what the server will store, and hands over mid-run", async () => {
    api.getSnapshot.mockResolvedValue(running);
    api.steer.mockResolvedValue({ run: running.currentRun });
    const user = userEvent.setup();
    const { queryClient } = renderPane();
    await screen.findByRole("heading", { name: "Example thread" });

    const composer = await screen.findByRole("textbox", { name: "Message Pi" });
    await user.type(composer, "fix the test");
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    expect(composer).toHaveValue("fix the test\n");
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(api.steer).toHaveBeenCalledWith(
        projectId,
        threadId,
        "fix the test",
      );
    });

    // Pi persisted it at the end of the turn in flight. The run is STILL
    // running -- this is the ordinary case, not the settled one.
    api.getSnapshot.mockResolvedValue({
      ...running,
      transcriptPage: {
        ...running.transcriptPage,
        items: [
          {
            id: "pi-1a2b3c4d",
            kind: "message",
            role: "user",
            text: "fix the test",
            timestamp: "2026-01-01T00:00:02.000Z",
          },
        ],
      },
    });
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["snapshot"] });
    });

    await waitFor(() => {
      expect(screen.getAllByText("fix the test")).toHaveLength(1);
    });
  });

  // SF1. Pi neither persists nor flushes a queued steer when the turn it was
  // queued into is aborted (`agent-loop.js:106-111`), so the words are gone
  // from the transcript AND from the composer, with no notice. The composer
  // clearing is this app's promise that the message was accepted.
  it("keeps an undelivered steer individually retryable when the run is stopped", async () => {
    api.getSnapshot.mockResolvedValue(running);
    api.steer.mockResolvedValue({ run: running.currentRun });
    const user = userEvent.setup();
    const { queryClient } = renderPane();
    await screen.findByRole("heading", { name: "Example thread" });

    await user.type(
      await screen.findByRole("textbox", { name: "Message Pi" }),
      "wait, use pnpm",
    );
    await user.keyboard("{Enter}");
    await screen.findByText("wait, use pnpm");

    api.getSnapshot.mockResolvedValue({
      ...snapshot,
      thread: { ...snapshot.thread, runState: "interrupted" },
      currentRun: null,
      lastRun: {
        ...running.currentRun,
        state: "interrupted",
        endedAt: "2026-01-01T00:00:05.000Z",
        failureCode: "user_stop",
        failureMessage: "Stopped by the user.",
      },
    });
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["snapshot"] });
    });

    await screen.findByRole("button", { name: "Retry steering message 1" });
    expect(screen.getByText(/never delivered/)).toBeInTheDocument();
  });

  // Nit 5. The hand-back used to remount the composer to make the restored
  // draft visible, which threw away focus and the caret. A reader typing
  // when a stopped run hands a steer back should keep both.
  it("keeps a reader's draft and cursor when a steer becomes retryable", async () => {
    api.getSnapshot.mockResolvedValue(running);
    api.steer.mockResolvedValue({ run: running.currentRun });
    const user = userEvent.setup();
    const { queryClient } = renderPane();
    await screen.findByRole("heading", { name: "Example thread" });

    const composer = await screen.findByRole("textbox", { name: "Message Pi" });
    await user.type(composer, "wait, use pnpm");
    await user.keyboard("{Enter}");
    await screen.findByText("wait, use pnpm");
    // The reader has started typing the next thing while the run finishes.
    await user.type(composer, "and then");
    expect(composer).toHaveFocus();

    api.getSnapshot.mockResolvedValue({
      ...snapshot,
      thread: { ...snapshot.thread, runState: "interrupted" },
      currentRun: null,
      lastRun: {
        ...running.currentRun,
        state: "interrupted",
        endedAt: "2026-01-01T00:00:05.000Z",
        failureCode: "user_stop",
        failureMessage: "Stopped by the user.",
      },
    });
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["snapshot"] });
    });

    await screen.findByRole("button", { name: "Retry steering message 1" });
    expect(screen.getByRole("textbox", { name: "Message Pi" })).toHaveValue(
      "and then",
    );
    // Same element, still focused: recovery does not rebuild the draft.
    expect(screen.getByRole("textbox", { name: "Message Pi" })).toBe(composer);
    expect(composer).toHaveFocus();
    expect(localStorage.getItem(`pi-draft:${threadId}`)).toBe(
      "and then\n\nwait, use pnpm",
    );
  });

  // Nit 6. `lost` was filtered to `steer.runId === lastRun.id`, and a fast
  // Stop-then-send makes `lastRun` the NEW run. The stranded text was then
  // dropped with no notice at all -- the exact outcome this path exists to
  // prevent, and now a guaranteed loss rather than a double send, because
  // the adapter really does clear Pi's queue.
  it("keeps a stranded steer retryable once the next run has already started", async () => {
    api.getSnapshot.mockResolvedValue(running);
    api.steer.mockResolvedValue({ run: running.currentRun });
    const user = userEvent.setup();
    const { queryClient } = renderPane();
    await screen.findByRole("heading", { name: "Example thread" });

    const composer = await screen.findByRole("textbox", { name: "Message Pi" });
    await user.type(composer, "wait, use pnpm");
    await user.keyboard("{Enter}");
    await screen.findByText("wait, use pnpm");

    // Stopped, and a NEW run is already in flight by the time the pane sees
    // it -- so `lastRun` names the new run, not the one that was stopped.
    const nextRun = {
      ...running.currentRun,
      id: "50000000-0000-4000-8000-00000000000a" as RunId,
      startedAt: "2026-01-01T00:00:06.000Z",
    };
    api.getSnapshot.mockResolvedValue({
      ...running,
      currentRun: nextRun,
      lastRun: nextRun,
    });
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["snapshot"] });
    });

    await screen.findByRole("button", { name: "Retry steering message 1" });
    // And it says why, although the run it belongs to is no longer the one
    // the pane has an outcome for.
    expect(screen.getByText(/never delivered/)).toBeInTheDocument();
    expect(composer).toHaveFocus();
  });

  // Nit 5. The outcome notice is about the run that just ended; once the user
  // has sent the next message it is describing history above an already
  // cleared composer.
  it("drops the previous run's outcome notice as soon as the next message is sent", async () => {
    api.getSnapshot.mockResolvedValue({
      ...snapshot,
      lastRun: {
        ...running.currentRun,
        state: "interrupted",
        endedAt: "2026-01-01T00:00:05.000Z",
        failureCode: "user_stop",
        failureMessage: "Stopped by the user.",
      },
    });
    api.prompt.mockResolvedValue({ run: running.currentRun });
    const user = userEvent.setup();
    renderPane();
    await screen.findByText("Stopped by the user.");

    await user.type(
      await screen.findByRole("textbox", { name: "Message Pi" }),
      "next thing please",
    );
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(
        screen.queryByText("Stopped by the user."),
      ).not.toBeInTheDocument();
    });
  });

  // The mirror of the test above, and the one that matters: `lastRun`
  // includes the run IN FLIGHT, so dismissing by its id on every send
  // pre-dismissed the outcome of the run being steered. Stopping it then
  // produced no notice at all. Found in the running app, not here.
  it("still reports the outcome of a run that was steered before it was stopped", async () => {
    api.getSnapshot.mockResolvedValue(running);
    api.steer.mockResolvedValue({ run: running.currentRun });
    const user = userEvent.setup();
    const { queryClient } = renderPane();
    await screen.findByRole("heading", { name: "Example thread" });

    await user.type(
      await screen.findByRole("textbox", { name: "Message Pi" }),
      "use pnpm not npm",
    );
    await user.keyboard("{Enter}");
    await waitFor(() => {
      expect(api.steer).toHaveBeenCalled();
    });

    api.getSnapshot.mockResolvedValue({
      ...snapshot,
      thread: { ...snapshot.thread, runState: "interrupted" },
      currentRun: null,
      lastRun: {
        ...running.currentRun,
        state: "interrupted",
        endedAt: "2026-01-01T00:00:05.000Z",
        failureCode: "user_stop",
        failureMessage: "Stopped by the user.",
      },
    });
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["snapshot"] });
    });

    expect(await screen.findByText(/Stopped by the user\./)).toBeVisible();
  });

  it("says it is steering before the keystroke, not only on the submit button", async () => {
    api.getSnapshot.mockResolvedValue(running);
    renderPane();
    await screen.findByRole("heading", { name: "Example thread" });

    const composer = await screen.findByRole("textbox", { name: "Message Pi" });
    expect(composer).toHaveAttribute(
      "placeholder",
      "Steer this run — Pi picks it up mid-task…",
    );
    expect(screen.getByText(/Enter to steer this run/)).toBeInTheDocument();
  });

  it("goes back to send wording once no run is in flight", async () => {
    api.getSnapshot.mockResolvedValue(snapshot);
    renderPane();
    await screen.findByRole("heading", { name: "Example thread" });

    expect(
      await screen.findByRole("textbox", { name: "Message Pi" }),
    ).toHaveAttribute("placeholder", "Ask Pi to work in this project…");
    expect(screen.getByText(/^Enter to send/)).toBeInTheDocument();
  });

  // F9. The composer was a one-way door: Escape changed neither the value nor
  // document.activeElement, so Tab was the only exit and every pane shortcut
  // was unreachable once you started typing.
  it("hands focus from the composer to the pane on Escape, keeping the draft", async () => {
    const user = userEvent.setup();
    api.getSnapshot.mockResolvedValue(snapshot);
    renderPane();

    const composer = await screen.findByRole("textbox", {
      name: "Message Pi",
    });
    await user.click(composer);
    await user.paste("half a message");
    expect(composer).toHaveFocus();

    await user.keyboard("{Escape}");

    const pane = screen.getByRole("region", { name: "Example thread" });
    expect(pane).toHaveFocus();
    expect(pane).toHaveAttribute("tabindex", "-1");
    expect(composer).toHaveValue("half a message");
    // The pane the shortcuts will now act on is the one focus landed in, and
    // it is not a text-entry target, so the window handler stops suppressing
    // them (see isTextEntryTarget).
    expect(isTextEntryTarget(document.activeElement)).toBe(false);
  });

  // F10. At a 360px pane the full sentence was ellipsised to "...without
  // appl..." -- a security notice cut off exactly before the part that
  // matters. Both visible forms are hidden from assistive technology and the
  // complete wording is carried separately, so the notice is never SAID in
  // its shortened form.
  it("offers a short visual trust notice while always exposing the full one", async () => {
    api.getSnapshot.mockResolvedValue(snapshot);
    const { container } = renderPane();
    await screen.findByRole("heading", { name: "Example thread" });

    const full =
      "Direct execution: Pi tools run with your user permissions, without application approval or an OS sandbox.";
    const note = container.querySelector(".trust-note");
    if (note === null) throw new Error("expected a trust note");

    const spoken = note.querySelector(".sr-only");
    expect(spoken).toHaveTextContent(full);
    expect(spoken?.closest("[aria-hidden='true']")).toBeNull();

    // Neither visible form is announced; only the complete one above is.
    for (const selector of [".trust-note-long", ".trust-note-short"]) {
      const form = note.querySelector(selector);
      expect(form).not.toBeNull();
      expect(form?.closest("[aria-hidden='true']")).not.toBeNull();
    }

    // The header's tooltip carries the same complete wording.
    expect(
      container.querySelector(".pane-head-detail")?.getAttribute("title"),
    ).toContain(full);
  });
});

// Implementer H's third handoff, at the other end of the wire. The server now
// gives up on a Stop the agent never answers and reports `stop_timed_out`
// rather than settling the run as "Stopped by the user." -- so the reader is
// no longer told a lie, but only if the pane says anything at all. Stop was
// `void stop(...).then(...)`, with no rejection handler: the failure became
// an unhandled promise rejection in the console, and the reader watched a run
// keep running under a button they had already pressed.
describe("a Stop the server refuses", () => {
  const running: ThreadSnapshot = {
    ...snapshot,
    thread: { ...snapshot.thread, runState: "running" },
    currentRun: {
      id: "50000000-0000-4000-8000-000000000021" as RunId,
      threadId,
      projectId,
      state: "running",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: null,
      failureCode: null,
      failureMessage: null,
    },
  };

  it("says so, and offers the retry that is the only thing to do about it", async () => {
    api.getSnapshot.mockResolvedValue(running);
    api.stop.mockRejectedValue(
      new Error(
        "Stop was sent, but the agent did not come to rest. The run is still active — try again.",
      ),
    );
    const user = userEvent.setup();
    renderPane();

    await user.click(await screen.findByRole("button", { name: "■ Stop" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "Could not stop this run: Stop was sent, but the agent did not come to rest.",
    );
    // The run is still going, so the pane still offers the control.
    expect(screen.getByRole("button", { name: "■ Stop" })).toBeInTheDocument();

    api.stop.mockResolvedValue(undefined);
    await user.click(within(alert).getByRole("button", { name: "Retry" }));

    await waitFor(() => {
      expect(api.stop).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
  });
});
