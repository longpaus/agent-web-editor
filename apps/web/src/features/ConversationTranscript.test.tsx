// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  TranscriptCursorSchema,
  TranscriptPageSchema,
  type ProjectId,
  type ThreadId,
  type TranscriptItem,
} from "@pi-web/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getSnapshot: vi.fn(),
  getTranscriptPage: vi.fn(),
}));

vi.mock("../api/client.js", async (importOriginal) => {
  const client = await importOriginal<typeof import("../api/client.js")>();
  return { ...client, ...api };
});

import {
  ConversationTranscript,
  TranscriptBookmarkProvider,
} from "./ConversationTranscript.js";

const projectId = "10000000-0000-4000-8000-000000000001" as ProjectId;
const firstThread = "20000000-0000-4000-8000-000000000001" as ThreadId;
const secondThread = "20000000-0000-4000-8000-000000000002" as ThreadId;
const cursor = "resume-cursor-0000000000000001";

function item(id: string, text = id): TranscriptItem {
  return { id, kind: "message", role: "assistant", text, timestamp: null };
}

function page(items: TranscriptItem[]) {
  return TranscriptPageSchema.parse({
    items,
    olderCursor: null,
    newerCursor: null,
    resumeCursor: cursor,
    atLatest: true,
  });
}

function view(
  threadId: ThreadId,
  items: TranscriptItem[],
  liveItem: TranscriptItem | null = null,
) {
  return (
    <ConversationTranscript
      key={threadId}
      projectId={projectId}
      threadId={threadId}
      projectPath="project"
      initialPage={page(items)}
      diagnostics={[]}
      liveItem={liveItem}
      onFollowingChange={() => undefined}
    />
  );
}

function shell(child: React.ReactNode, queryClient = new QueryClient()) {
  return (
    <QueryClientProvider client={queryClient}>
      <TranscriptBookmarkProvider>{child}</TranscriptBookmarkProvider>
    </QueryClientProvider>
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("ConversationTranscript viewport behavior", () => {
  it("opens at latest and follows growth of the streaming item", async () => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    Object.defineProperties(HTMLElement.prototype, {
      scrollHeight: {
        configurable: true,
        get(this: HTMLElement) {
          return this.getAttribute("aria-label") === "Conversation" ? 900 : 0;
        },
      },
      clientHeight: {
        configurable: true,
        get(this: HTMLElement) {
          return this.getAttribute("aria-label") === "Conversation" ? 300 : 0;
        },
      },
    });
    const queryClient = new QueryClient();
    const rendered = render(
      shell(view(firstThread, [item("one")]), queryClient),
    );
    const transcript = screen.getByLabelText("Conversation");
    expect(transcript.scrollTop).toBe(900);

    rendered.rerender(
      shell(
        view(
          firstThread,
          [item("one")],
          item("streaming-assistant", "Growing response"),
        ),
        queryClient,
      ),
    );
    await waitFor(() => {
      expect(transcript.scrollTop).toBe(900);
    });
    expect(screen.getByText("Growing response")).toBeInTheDocument();
  });

  it("stops following after scroll-away and jumps to an authoritative latest page", async () => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    const latestPage = page([item("latest", "Latest answer")]);
    api.getSnapshot.mockResolvedValue({ transcriptPage: latestPage });
    const rendered = render(shell(view(firstThread, [item("older")])));
    const transcript = screen.getByLabelText("Conversation");
    Object.defineProperties(transcript, {
      scrollHeight: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 300 },
    });
    transcript.scrollTop = 100;
    fireEvent.scroll(transcript);

    const jump = await screen.findByRole("button", { name: "Jump to latest" });
    fireEvent.click(jump);
    expect(await screen.findByText("Latest answer")).toBeInTheDocument();
    expect(api.getSnapshot).toHaveBeenCalledWith(projectId, firstThread);
    rendered.unmount();
  });

  it("evicts distant pages after the five-page active window", async () => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    const cursorFor = (index: number) =>
      TranscriptCursorSchema.parse(`page-${String(index).padStart(20, "0")}`);
    const numberedPage = (index: number) =>
      TranscriptPageSchema.parse({
        items: [item(`item-${String(index)}`, `Page ${String(index)}`)],
        olderCursor: index === 0 ? null : cursorFor(index - 1),
        newerCursor: index === 6 ? null : cursorFor(index + 1),
        resumeCursor: cursorFor(index),
        atLatest: index === 6,
      });
    api.getTranscriptPage.mockImplementation(
      (_project: ProjectId, _thread: ThreadId, request: { cursor: string }) => {
        const index = Number(request.cursor.slice("page-".length));
        return Promise.resolve(numberedPage(index));
      },
    );
    const queryClient = new QueryClient();
    render(
      shell(
        <ConversationTranscript
          key={firstThread}
          projectId={projectId}
          threadId={firstThread}
          projectPath="project"
          initialPage={numberedPage(6)}
          diagnostics={[]}
          liveItem={null}
          onFollowingChange={() => undefined}
        />,
        queryClient,
      ),
    );

    for (let index = 5; index >= 0; index -= 1) {
      fireEvent.click(
        await screen.findByRole("button", { name: "Load earlier messages" }),
      );
      expect(
        await screen.findByText(`Page ${String(index)}`),
      ).toBeInTheDocument();
    }

    const cached = queryClient.getQueryData<{ pages: unknown[] }>([
      "transcript",
      projectId,
      firstThread,
    ]);
    expect(cached?.pages).toHaveLength(5);
    expect(document.querySelectorAll("[data-transcript-item-id]").length).toBe(
      5,
    );
  });

  it("resumes the prior thread page after its active query is discarded", async () => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    const firstPage = page([item("anchor", "Remember me")]);
    api.getTranscriptPage.mockResolvedValue(firstPage);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const rendered = render(
      shell(view(firstThread, firstPage.items), queryClient),
    );
    const transcript = screen.getByLabelText("Conversation");
    Object.defineProperties(transcript, {
      scrollHeight: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 300 },
    });
    transcript.scrollTop = 100;
    const row = screen.getByText("Remember me").closest("article");
    if (!(row instanceof HTMLElement))
      throw new Error("missing transcript row");
    vi.spyOn(transcript, "getBoundingClientRect").mockReturnValue({
      top: 0,
      bottom: 300,
      left: 0,
      right: 600,
      width: 600,
      height: 300,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    vi.spyOn(row, "getBoundingClientRect").mockReturnValue({
      top: 20,
      bottom: 80,
      left: 0,
      right: 600,
      width: 600,
      height: 60,
      x: 0,
      y: 20,
      toJSON: () => ({}),
    });
    fireEvent.scroll(transcript);

    rendered.rerender(shell(view(secondThread, [item("other")]), queryClient));
    rendered.rerender(
      shell(view(firstThread, [item("new-latest")]), queryClient),
    );

    await waitFor(() => {
      expect(api.getTranscriptPage).toHaveBeenCalledWith(
        projectId,
        firstThread,
        {
          cursor,
          direction: "resume",
        },
      );
    });
    expect(await screen.findByText("Remember me")).toBeInTheDocument();
  });
});
