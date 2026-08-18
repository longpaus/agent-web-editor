import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  useInfiniteQuery,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import type {
  ProjectId,
  ThreadId,
  TranscriptCursor,
  TranscriptItem,
  TranscriptPage,
  TranscriptPageRequest,
} from "@pi-web/contracts";

import {
  ApiClientError,
  getSnapshot,
  getTranscriptPage,
} from "../api/client.js";
import { Activity, displayTranscript } from "../components/Activity.js";
import { Markdown } from "../components/Markdown.js";

export const TRANSCRIPT_PAGE_LIMIT = 5;
export const TRANSCRIPT_ITEM_LIMIT = 500;
export const NEAR_LATEST_PX = 80;

type ViewportBookmark =
  | { mode: "following-latest" }
  | {
      mode: "anchor";
      itemId: string;
      offset: number;
      resumeCursor: TranscriptCursor;
    };

interface BookmarkStore {
  get(threadId: ThreadId): ViewportBookmark | undefined;
  set(threadId: ThreadId, bookmark: ViewportBookmark): void;
}

const BookmarkContext = createContext<BookmarkStore | null>(null);

export function TranscriptBookmarkProvider({
  children,
}: {
  children: ReactNode;
}) {
  const bookmarks = useRef(new Map<ThreadId, ViewportBookmark>());
  const store = useMemo<BookmarkStore>(
    () => ({
      get: (threadId) => bookmarks.current.get(threadId),
      set: (threadId, bookmark) => {
        bookmarks.current.set(threadId, bookmark);
      },
    }),
    [],
  );
  return (
    <BookmarkContext.Provider value={store}>
      {children}
    </BookmarkContext.Provider>
  );
}

export function useTranscriptBookmarks(): BookmarkStore {
  const store = useContext(BookmarkContext);
  if (store === null)
    throw new Error("TranscriptBookmarkProvider is required.");
  return store;
}

type PageParam = TranscriptPageRequest | { direction: "initial" };

function transcriptQueryKey(projectId: ProjectId, threadId: ThreadId) {
  return ["transcript", projectId, threadId] as const;
}

function rowsFromPages(
  pages: readonly TranscriptPage[],
  liveItem: TranscriptItem | null,
  following: boolean,
): TranscriptItem[] {
  const byId = new Map<string, TranscriptItem>();
  for (const page of pages)
    for (const item of page.items) {
      const previous = byId.get(item.id);
      if (
        previous === undefined ||
        JSON.stringify(previous) === JSON.stringify(item)
      )
        byId.set(item.id, item);
    }
  if (following && liveItem !== null) byId.set(liveItem.id, liveItem);
  return displayTranscript([...byId.values()]);
}

function nearLatest(element: HTMLElement): boolean {
  const distance =
    element.scrollHeight - element.clientHeight - element.scrollTop;
  return Number.isFinite(distance) && distance <= NEAR_LATEST_PX;
}

interface VisibleAnchor {
  itemId: string;
  offset: number;
  resumeCursor: TranscriptCursor;
}

function containingResumeCursor(
  pages: readonly TranscriptPage[],
  itemId: string,
): TranscriptCursor | null {
  return (
    pages.find((page) => page.items.some((item) => item.id === itemId))
      ?.resumeCursor ?? null
  );
}

function visibleAnchor(
  viewport: HTMLElement,
  pages: readonly TranscriptPage[],
): VisibleAnchor | null {
  const viewportTop = viewport.getBoundingClientRect().top;
  const rows = viewport.querySelectorAll<HTMLElement>(
    "[data-transcript-item-id]",
  );
  for (const row of rows) {
    const rect = row.getBoundingClientRect();
    if (rect.bottom <= viewportTop) continue;
    const itemId = row.dataset.transcriptItemId;
    if (itemId === undefined || itemId === "streaming-assistant") continue;
    const resumeCursor = containingResumeCursor(pages, itemId);
    if (resumeCursor === null) continue;
    return { itemId, offset: rect.top - viewportTop, resumeCursor };
  }
  return null;
}

function findRow(viewport: HTMLElement, itemId: string): HTMLElement | null {
  for (const row of viewport.querySelectorAll<HTMLElement>(
    "[data-transcript-item-id]",
  ))
    if (row.dataset.transcriptItemId === itemId) return row;
  return null;
}

export function ConversationTranscript({
  projectId,
  threadId,
  projectPath,
  initialPage,
  diagnostics,
  liveItem,
  onFollowingChange,
}: {
  projectId: ProjectId;
  threadId: ThreadId;
  projectPath: string;
  initialPage?: TranscriptPage;
  diagnostics: readonly string[];
  liveItem: TranscriptItem | null;
  onFollowingChange: (following: boolean) => void;
}) {
  const bookmarks = useTranscriptBookmarks();
  const bookmark = useRef(bookmarks.get(threadId));
  const startsFollowing = bookmark.current?.mode !== "anchor";
  const [following, setFollowing] = useState(startsFollowing);
  const [notice, setNotice] = useState<string | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const restoredRef = useRef(false);
  const pendingAnchor = useRef<{ itemId: string; offset: number } | null>(null);
  const queryClient = useQueryClient();
  const queryKey = useMemo(
    () => transcriptQueryKey(projectId, threadId),
    [projectId, threadId],
  );
  const seededPage =
    queryClient
      .getQueryData<InfiniteData<TranscriptPage, PageParam>>(queryKey)
      ?.pages.at(-1) ?? initialPage;
  const initialParam: PageParam =
    bookmark.current?.mode === "anchor"
      ? {
          cursor: bookmark.current.resumeCursor,
          direction: "resume",
        }
      : { direction: "initial" };
  const pages = useInfiniteQuery({
    queryKey,
    queryFn: async ({ pageParam }: { pageParam: PageParam }) => {
      if (pageParam.direction === "initial") {
        if (seededPage !== undefined) return seededPage;
        return (await getSnapshot(projectId, threadId)).transcriptPage;
      }
      try {
        return await getTranscriptPage(projectId, threadId, pageParam);
      } catch (error) {
        if (
          pageParam.direction !== "resume" ||
          !(error instanceof ApiClientError) ||
          error.code !== "stale_transcript_cursor"
        )
          throw error;
        const latest = await getSnapshot(projectId, threadId);
        bookmarks.set(threadId, { mode: "following-latest" });
        void queryClient.invalidateQueries({
          queryKey: ["snapshot", projectId, threadId],
          exact: true,
        });
        setFollowing(true);
        setNotice(
          "The saved reading position changed. Showing latest messages.",
        );
        return latest.transcriptPage;
      }
    },
    initialPageParam: initialParam,
    ...(startsFollowing && initialPage !== undefined
      ? {
          initialData: {
            pages: [initialPage],
            pageParams: [{ direction: "initial" } satisfies PageParam],
          },
        }
      : {}),
    getPreviousPageParam: (firstPage): PageParam | undefined =>
      firstPage.olderCursor === null
        ? undefined
        : { cursor: firstPage.olderCursor, direction: "older" },
    getNextPageParam: (lastPage): PageParam | undefined =>
      lastPage.newerCursor === null
        ? undefined
        : { cursor: lastPage.newerCursor, direction: "newer" },
    maxPages: TRANSCRIPT_PAGE_LIMIT,
    staleTime: Infinity,
    retry: false,
  });
  const pageValues = pages.data?.pages ?? [];
  const rows = rowsFromPages(pageValues, liveItem, following);

  useEffect(() => {
    onFollowingChange(following);
  }, [following, onFollowingChange]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (viewport === null || pages.data === undefined) return;
    const pending = pendingAnchor.current;
    if (pending !== null) {
      const row = findRow(viewport, pending.itemId);
      if (row !== null) {
        const current =
          row.getBoundingClientRect().top -
          viewport.getBoundingClientRect().top;
        viewport.scrollTop += current - pending.offset;
      }
      pendingAnchor.current = null;
      return;
    }
    if (restoredRef.current) return;
    const saved = bookmark.current;
    if (saved?.mode === "anchor") {
      const row = findRow(viewport, saved.itemId);
      if (row !== null) {
        const current =
          row.getBoundingClientRect().top -
          viewport.getBoundingClientRect().top;
        viewport.scrollTop += current - saved.offset;
        restoredRef.current = true;
        return;
      }
    }
    viewport.scrollTop = viewport.scrollHeight;
    restoredRef.current = true;
  }, [pageValues, pages.data, rows.length]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport === null) return;
    const scrolled = () => {
      const next = nearLatest(viewport);
      if (next) bookmarks.set(threadId, { mode: "following-latest" });
      else {
        const anchor = visibleAnchor(viewport, pageValues);
        if (anchor !== null)
          bookmarks.set(threadId, { mode: "anchor", ...anchor });
      }
      setFollowing((current) => (current === next ? current : next));
    };
    viewport.addEventListener("scroll", scrolled, { passive: true });
    return () => {
      viewport.removeEventListener("scroll", scrolled);
    };
  }, [bookmarks, pageValues, threadId]);

  useEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (viewport === null || content === null || !following) return;
    let frame: number | null = null;
    const follow = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        viewport.scrollTop = viewport.scrollHeight;
      });
    };
    follow();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(follow);
    observer.observe(content);
    return () => {
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [following, rows]);

  useLayoutEffect(
    () => () => {
      const viewport = viewportRef.current;
      const currentPages =
        queryClient.getQueryData<InfiniteData<TranscriptPage, PageParam>>(
          queryKey,
        )?.pages;
      if (viewport === null || currentPages === undefined) return;
      if (nearLatest(viewport)) {
        bookmarks.set(threadId, { mode: "following-latest" });
        return;
      }
      const anchor = visibleAnchor(viewport, currentPages);
      if (anchor !== null)
        bookmarks.set(threadId, { mode: "anchor", ...anchor });
    },
    [bookmarks, queryClient, queryKey, threadId],
  );

  useEffect(
    () => () => {
      void queryClient.cancelQueries({ queryKey, exact: true });
      queryClient.removeQueries({ queryKey, exact: true });
    },
    [queryClient, queryKey],
  );

  const preserveBeforePageChange = () => {
    const viewport = viewportRef.current;
    if (viewport === null) return;
    const anchor = visibleAnchor(viewport, pageValues);
    if (anchor !== null)
      pendingAnchor.current = { itemId: anchor.itemId, offset: anchor.offset };
  };

  const jumpLatest = async () => {
    const latest = await getSnapshot(projectId, threadId);
    queryClient.setQueryData<InfiniteData<TranscriptPage, PageParam>>(
      queryKey,
      {
        pages: [latest.transcriptPage],
        pageParams: [{ direction: "initial" }],
      },
    );
    bookmarks.set(threadId, { mode: "following-latest" });
    void queryClient.invalidateQueries({
      queryKey: ["snapshot", projectId, threadId],
      exact: true,
    });
    setFollowing(true);
    setNotice(null);
    requestAnimationFrame(() => {
      const viewport = viewportRef.current;
      if (viewport !== null) viewport.scrollTop = viewport.scrollHeight;
    });
  };

  return (
    <div className="transcript-shell">
      <div className="transcript" aria-label="Conversation" ref={viewportRef}>
        <div className="transcript-content" ref={contentRef}>
          {pages.isPending && <p role="status">Loading messages…</p>}
          {pages.isError && (
            <p className="error-notice" role="alert">
              Messages could not be loaded.
            </p>
          )}
          {notice !== null && (
            <p className="diagnostic warning" role="status">
              {notice}
            </p>
          )}
          {pages.isFetchPreviousPageError && (
            <p className="error-notice" role="alert">
              Earlier messages could not be loaded. Try again.
            </p>
          )}
          {pages.hasPreviousPage && (
            <button
              type="button"
              className="history-control"
              disabled={pages.isFetchingPreviousPage}
              onClick={() => {
                preserveBeforePageChange();
                void pages.fetchPreviousPage();
              }}
            >
              {pages.isFetchingPreviousPage
                ? "Loading earlier messages…"
                : "Load earlier messages"}
            </button>
          )}
          {!pages.isPending && rows.length === 0 && (
            <div className="empty conversation-empty">
              <strong>No messages yet</strong>
              <span>
                Ask Pi to inspect, implement, or review something in this
                project.
              </span>
            </div>
          )}
          {rows.map((item) =>
            item.kind === "message" ? (
              <article
                className={`message message-${item.role}`}
                data-transcript-item-id={item.id}
                key={item.id}
              >
                <header>
                  {item.role === "assistant"
                    ? "Pi"
                    : item.role === "user"
                      ? "You"
                      : "System"}
                </header>
                <div className="markdown">
                  <Markdown>{item.text}</Markdown>
                </div>
              </article>
            ) : item.kind === "tool" ? (
              <div data-transcript-item-id={item.id} key={item.id}>
                <Activity item={item} projectPath={projectPath} />
              </div>
            ) : (
              <p
                className={`diagnostic ${item.level}`}
                data-transcript-item-id={item.id}
                key={item.id}
              >
                {item.text}
              </p>
            ),
          )}
          {pages.isFetchNextPageError && (
            <p className="error-notice" role="alert">
              Newer messages could not be loaded. Try again.
            </p>
          )}
          {pages.hasNextPage && (
            <button
              type="button"
              className="history-control"
              disabled={pages.isFetchingNextPage}
              onClick={() => {
                preserveBeforePageChange();
                void pages.fetchNextPage();
              }}
            >
              {pages.isFetchingNextPage
                ? "Loading newer messages…"
                : "Load newer messages"}
            </button>
          )}
          {diagnostics.map((diagnostic) => (
            <p className="diagnostic warning" key={diagnostic}>
              {diagnostic}
            </p>
          ))}
        </div>
      </div>
      {!following && (
        <button
          type="button"
          className="jump-latest"
          onClick={() => void jumpLatest()}
        >
          Jump to latest
        </button>
      )}
    </div>
  );
}
