import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type SyntheticEvent,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  LiveDiagnosticSchema,
  LiveEventSchema,
  LiveSnapshotRequiredSchema,
  TranscriptItemSchema,
  type LiveDiagnostic,
  type ProjectId,
  type ThreadId,
  type ThreadSnapshot,
  type TranscriptItem,
  type TranscriptPage,
} from "@pi-web/contracts";

import {
  ApiClientError,
  commandId,
  getChatImage,
  getOlderTranscriptPage,
  getSnapshot,
  getWorkspace,
  markViewed,
  preflightContinuation,
  prompt,
  renameThread,
  steer,
  stop,
  unarchiveThread,
  webSocketUrl,
} from "../../api/client.js";
import { ActivityGroup, displayTranscript } from "../../components/Activity.js";
import { ErrorNotice } from "../../components/ErrorNotice.js";
import { Loading } from "../../components/Loading.js";
import { Markdown } from "../../components/Markdown.js";
import { useAutoGrow } from "../../components/useAutoGrow.js";
import { readDraft, removeDraft, writeDraft } from "./drafts.js";
import { isReleaseKey, releaseFocusToPane } from "./paneFocus.js";
import {
  countAllUserMessages,
  countUserMessages,
  dropSettledSteers,
  isReaderFacingDiagnostic,
  mergeLiveTurn,
  mergePendingSteers,
  queuedSteerImageCount,
  reduceLiveTurn,
  STREAMING_ITEM_ID,
  type LiveTurn,
  type PendingSteer,
} from "./liveTranscript.js";
import { BACKEND_LABEL, PaneHeader } from "./PaneHeader.js";
import {
  deriveRunStatus,
  elapsedLabel,
  runOutcomeNotice,
} from "./runStatus.js";
import { useStickToBottom } from "./stickToBottom.js";
import { ChatAttachmentStrip, useChatAttachments } from "./chatAttachments.js";

export interface ThreadPaneProps {
  projectId: ProjectId;
  threadId: ThreadId;
  focused: boolean;
  onFocus(): void;
  onClose(): void;
  onSplit(): void;
  onContinue?(): void;
}

/**
 * How long streamed transcript frames are pooled before one state update.
 *
 * Measured against the running server: a 2,583 character answer arrived as
 * 494 `transcript` frames in 14.5s, median 7ms apart. Applying each one
 * separately would re-render the transcript ~140 times a second and make
 * typing in the composer stutter. 40ms is 25 updates a second — under a paint
 * budget, and far above the rate at which text stops reading as "streaming".
 */
const LIVE_FLUSH_MS = 40;

/**
 * The floor between authoritative refetches.
 *
 * Tool activity never travels on the live channel — the adapter maps Pi's
 * tool events to "unsupported event" diagnostics, so steps reach the client
 * only through the snapshot route. Settled turns, run transitions and
 * diagnostics therefore still refetch, but Pi emits those in bursts (eight
 * diagnostics inside 20ms is normal), so they are throttled instead of
 * firing one HTTP request each.
 */
const LIVE_REFETCH_MS = 200;

/**
 * The trust notice, in full. One constant because it is said in three places
 * that must not drift: the header's tooltip, the accessibility tree, and the
 * wide-pane visual form.
 */
const TRUST_NOTICE =
  "Direct execution: Pi tools run with your user permissions, without application approval or an OS sandbox.";

/**
 * Subscribes to the thread's live channel and returns the in-progress
 * assistant turn.
 *
 * The turn is returned as component state rather than written into the
 * `["snapshot", ...]` cache entry, and that is load-bearing: React Query
 * replaces query data wholesale on every fetch success, the pane polls every
 * 15s, and the server snapshot provably cannot contain the in-progress
 * message. Cached, a partly-streamed answer was deleted from the screen by
 * every poll tick and every throttled refetch — invisible while tokens flow
 * at 7ms intervals, but a blank paragraph for the whole of a tool call.
 */
export interface LiveState {
  turn: LiveTurn | null;
  /**
   * The newest reader-facing diagnostic of the run in flight, or null.
   *
   * One slot, not a list: these describe the state of the run *right now*
   * ("Provider retry 2 of 5.") and a reader wants the current one, not a
   * history of them.
   */
  diagnostic: LiveDiagnostic | null;
}

function useLive(
  projectId: ProjectId,
  threadId: ThreadId,
  ready: boolean,
  runActive: boolean,
): LiveState {
  const queryClient = useQueryClient();
  const [liveTurn, setLiveTurn] = useState<LiveTurn | null>(null);
  const [diagnostic, setDiagnostic] = useState<LiveDiagnostic | null>(null);
  // The turn belongs to the run that produced it. `runActive` only goes false
  // once a fetch has told us so, and that same fetch carried the settled
  // message, so there is no moment where the text belongs to neither.
  useEffect(() => {
    if (!runActive) {
      setLiveTurn(null);
      setDiagnostic(null);
    }
  }, [runActive]);
  useEffect(() => {
    if (!ready) return;
    const queryKey = ["snapshot", projectId, threadId];
    let closed = false;
    let retry: number | undefined;
    let socket: WebSocket | undefined;
    // Where this client has read up to. Held here rather than in the query
    // data on purpose: making the effect depend on the snapshot's cursor tore
    // the socket down and rebuilt it after every refetch.
    let cursor: { epoch: string; sequence: number } | null = null;
    const pending: TranscriptItem[] = [];
    let flushTimer: number | undefined;
    let refetchTimer: number | undefined;
    let lastRefetch = 0;

    const flush = () => {
      if (flushTimer !== undefined) {
        clearTimeout(flushTimer);
        flushTimer = undefined;
      }
      if (pending.length === 0) return;
      const batch = pending.splice(0, pending.length);
      // The baseline a new turn is identified by: how many user messages the
      // authoritative transcript holds right now. Read from the cache rather
      // than passed down, because this is the moment the turn begins and the
      // pane's render is not.
      const cached = queryClient.getQueryData<ThreadSnapshot>(queryKey);
      const userMessagesNow =
        cached === undefined
          ? 0
          : countAllUserMessages(cached.transcriptPage.items);
      setLiveTurn((current) =>
        batch.reduce(
          (turn, item) => reduceLiveTurn(turn, item, userMessagesNow),
          current,
        ),
      );
    };
    const scheduleFlush = () => {
      flushTimer ??= window.setTimeout(flush, LIVE_FLUSH_MS);
    };
    const refetch = () => {
      if (refetchTimer !== undefined) {
        clearTimeout(refetchTimer);
        refetchTimer = undefined;
      }
      lastRefetch = Date.now();
      void queryClient.invalidateQueries({ queryKey });
      void queryClient.invalidateQueries({ queryKey: ["workspace"] });
    };
    const scheduleRefetch = () => {
      if (refetchTimer !== undefined) return;
      refetchTimer = window.setTimeout(
        refetch,
        Math.max(0, LIVE_REFETCH_MS - (Date.now() - lastRefetch)),
      );
    };

    const onMessage = (event: MessageEvent) => {
      // A frame can still be dispatched after cleanup closed the socket;
      // acting on it would leave a timer running past unmount.
      if (closed) return;
      let value: unknown;
      try {
        value = JSON.parse(String(event.data));
      } catch {
        return;
      }
      // The server cannot replay from where we are: everything we hold may be
      // stale, so drop the queue and take a full snapshot.
      if (LiveSnapshotRequiredSchema.safeParse(value).success) {
        cursor = null;
        pending.length = 0;
        refetch();
        return;
      }
      const parsed = LiveEventSchema.safeParse(value);
      if (!parsed.success) return;
      const live = parsed.data;
      if (live.threadId !== threadId) return;
      const contiguous =
        cursor !== null &&
        live.epoch === cursor.epoch &&
        live.sequence === cursor.sequence + 1;
      // Only ever forwards within an epoch, so a server that replayed an old
      // event could not rewind gap detection.
      if (live.epoch !== cursor?.epoch || live.sequence > cursor.sequence)
        cursor = { epoch: live.epoch, sequence: live.sequence };
      // A gap or a new epoch means events we never saw. The frame in hand is
      // still applied (payloads are whole items, not deltas), but the
      // snapshot is re-fetched to close whatever was missed.
      if (!contiguous) scheduleRefetch();
      if (live.eventType === "transcript") {
        const item = TranscriptItemSchema.safeParse(live.payload);
        if (!item.success) {
          scheduleRefetch();
          return;
        }
        // Content is moving again, so whatever the run was last complaining
        // about ("Provider retry 2 of 5.") has resolved. Clearing here rather
        // than on a timer means the notice lives exactly as long as the
        // stall it describes.
        setDiagnostic(null);
        pending.push(item.data);
        if (item.data.id === STREAMING_ITEM_ID) {
          scheduleFlush();
          return;
        }
        // The turn settled. Show it at once, then reconcile with the server
        // for the tool steps and canonical ids the live channel does not
        // carry; `mergeLiveTurn` stops appending it once that lands.
        flush();
        scheduleRefetch();
        return;
      }
      if (live.eventType === "diagnostic") {
        // Diagnostics used to fall through to the refetch below and nothing
        // else -- received, used purely as a poll trigger, and dropped. The
        // refetch is still right (a diagnostic can accompany state the
        // snapshot knows about), but the message itself is the only account
        // the app ever gets of a provider retry, and it is not in any
        // snapshot: `snapshot()` builds its transcript from Pi's persisted
        // branch, which never held it.
        const parsedDiagnostic = LiveDiagnosticSchema.safeParse(live.payload);
        if (
          parsedDiagnostic.success &&
          isReaderFacingDiagnostic(parsedDiagnostic.data)
        )
          setDiagnostic(parsedDiagnostic.data);
        scheduleRefetch();
        return;
      }
      scheduleRefetch();
    };

    const connect = () => {
      socket = new WebSocket(webSocketUrl("/api/live"));
      socket.addEventListener("open", () => {
        const cached = queryClient.getQueryData<ThreadSnapshot>(queryKey);
        const resume =
          cursor ??
          (cached === undefined
            ? null
            : { epoch: cached.epoch, sequence: cached.highWaterSequence });
        cursor = resume;
        socket?.send(
          JSON.stringify({
            version: 1,
            type: "subscribe",
            threadId,
            ...(resume === null
              ? {}
              : { epoch: resume.epoch, cursor: resume.sequence }),
          }),
        );
      });
      socket.addEventListener("message", onMessage);
      socket.addEventListener("close", () => {
        if (!closed) retry = window.setTimeout(connect, 1_000);
      });
    };
    connect();
    return () => {
      closed = true;
      setLiveTurn(null);
      setDiagnostic(null);
      if (retry !== undefined) clearTimeout(retry);
      if (flushTimer !== undefined) clearTimeout(flushTimer);
      if (refetchTimer !== undefined) clearTimeout(refetchTimer);
      socket?.close();
    };
  }, [projectId, queryClient, ready, threadId]);
  return { turn: liveTurn, diagnostic };
}

type ToolItem = Extract<TranscriptItem, { kind: "tool" }>;
type NonToolItem = Exclude<TranscriptItem, { kind: "tool" }>;
type TranscriptGroup =
  | { kind: "tool-run"; items: ToolItem[] }
  | { kind: "single"; item: NonToolItem };

// Contiguous tool items between messages/diagnostics collapse into one
// "Worked for …" disclosure, matching the Codex reading model.
function groupTranscriptItems(
  items: readonly TranscriptItem[],
): TranscriptGroup[] {
  const groups: TranscriptGroup[] = [];
  for (const item of items) {
    if (item.kind === "tool") {
      const last = groups.at(-1);
      if (last?.kind === "tool-run") {
        last.items.push(item);
      } else {
        groups.push({ kind: "tool-run", items: [item] });
      }
    } else {
      groups.push({ kind: "single", item });
    }
  }
  return groups;
}

// Changes whenever the rendered transcript grows or its newest item's text
// grows (a streaming assistant turn), so the scroll container can follow the
// newest content without re-pinning on every unrelated re-render.
function transcriptContentKey(
  items: readonly TranscriptItem[],
  diagnostics: readonly string[],
  live: LiveDiagnostic | null,
): string {
  const last = items.at(-1);
  const lastLength =
    last !== undefined && "text" in last ? last.text.length : 0;
  return [
    items.length,
    last?.id ?? "",
    lastLength,
    diagnostics.length,
    live?.message ?? "",
  ].join(":");
}

function TranscriptImage({
  projectId,
  threadId,
  image,
  ordinal,
}: {
  projectId: ProjectId;
  threadId: ThreadId;
  image: NonNullable<
    Extract<TranscriptItem, { kind: "message" }>["images"]
  >[number];
  ordinal: number;
}) {
  const [open, setOpen] = useState(false);
  const query = useQuery({
    queryKey: ["chat-image", projectId, threadId, image.id],
    queryFn: () => getChatImage(projectId, threadId, image.id),
  });
  if (query.isPending)
    return (
      <span className="transcript-image-loading" role="status">
        Loading attached image {String(ordinal)}…
      </span>
    );
  if (query.data === undefined)
    return <span className="transcript-image-error">Image unavailable</span>;
  const src = `data:${query.data.mimeType};base64,${query.data.data}`;
  return (
    <>
      <button
        type="button"
        className="transcript-image-button"
        aria-label={`Open attached image ${String(ordinal)}`}
        onClick={() => {
          setOpen(true);
        }}
      >
        <img src={src} alt={`Attached image ${String(ordinal)}`} />
      </button>
      {open && (
        <div
          className="image-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={`Attached image ${String(ordinal)}`}
          onKeyDown={(event) => {
            if (event.key === "Escape") setOpen(false);
          }}
        >
          <button
            type="button"
            className="image-lightbox-close"
            aria-label="Close image preview"
            autoFocus
            onClick={() => {
              setOpen(false);
            }}
          >
            ×
          </button>
          <img src={src} alt={`Attached image ${String(ordinal)}, enlarged`} />
        </div>
      )}
    </>
  );
}

function pageKey(page: TranscriptPage): string {
  return `${page.items[0]?.id ?? "empty"}:${page.items.at(-1)?.id ?? "empty"}:${String(page.items.length)}`;
}

function Transcript({
  projectId,
  threadId,
  snapshot,
  items,
  diagnostic,
  scrollRef,
  resetToLatest,
  onLatestChange,
}: {
  projectId: ProjectId;
  threadId: ThreadId;
  snapshot: ThreadSnapshot;
  items: readonly TranscriptItem[];
  diagnostic: LiveDiagnostic | null;
  scrollRef: (node: HTMLDivElement | null) => void;
  resetToLatest: number;
  onLatestChange: (atLatest: boolean) => void;
}) {
  const [pages, setPages] = useState<TranscriptPage[]>([
    snapshot.transcriptPage,
  ]);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const elementRef = useRef<HTMLDivElement | null>(null);
  const handledReset = useRef(0);
  const latestKey = pageKey(snapshot.transcriptPage);

  useEffect(() => {
    setPages([snapshot.transcriptPage]);
    setHistoryError(null);
  }, [snapshot.thread.id]);

  useEffect(() => {
    setPages((current) => {
      const latestIndex = current.findIndex((page) => page.atLatest);
      if (latestIndex < 0) return current;
      // An unavailable backend cannot authoritatively replace history with an
      // empty page: retain the page this pane already obtained until it can
      // reopen, while still showing the availability diagnostic.
      if (
        !snapshot.thread.runtimeAvailable &&
        snapshot.transcriptPage.items.length === 0 &&
        current[latestIndex]?.items.length !== 0
      )
        return current;
      const next = [...current];
      next[latestIndex] = snapshot.transcriptPage;
      return next;
    });
  }, [latestKey, snapshot.transcriptPage]);

  const showingLatest = pages.some((page) => page.atLatest);
  useEffect(() => {
    onLatestChange(showingLatest);
  }, [onLatestChange, showingLatest]);
  useEffect(() => {
    if (resetToLatest === handledReset.current) return;
    handledReset.current = resetToLatest;
    setPages([snapshot.transcriptPage]);
  }, [resetToLatest, snapshot.transcriptPage]);
  const renderedItems = displayTranscript([
    ...pages.filter((page) => !page.atLatest).flatMap((page) => page.items),
    ...(showingLatest ? items : []),
  ]).filter(
    (item, index, all) =>
      all.findIndex((candidate) => candidate.id === item.id) === index,
  );
  const running = snapshot.currentRun?.state === "running";
  const groups = groupTranscriptItems(renderedItems);
  // The newest batch of steps stays open for the whole run. Keying "live" to
  // the last group of any kind made a finished batch snap shut the moment the
  // assistant started narrating after it, which is a layout jump mid-run.
  const lastToolGroup = groups.reduce(
    (last, group, index) => (group.kind === "tool-run" ? index : last),
    -1,
  );
  const oldestCursor = pages[0]?.olderCursor ?? null;

  const loadEarlier = async () => {
    if (oldestCursor === null || loadingOlder) return;
    setLoadingOlder(true);
    setHistoryError(null);
    const element = elementRef.current;
    const previousHeight = element?.scrollHeight ?? 0;
    const previousTop = element?.scrollTop ?? 0;
    try {
      const page = await getOlderTranscriptPage(
        projectId,
        threadId,
        oldestCursor,
      );
      // Keep one contiguous browser window. Once it is full, discard its
      // newest edge (including the latest page) rather than a page in the
      // middle; Jump to latest restores that deliberately omitted edge.
      setPages((current) => [page, ...current].slice(0, 5));
      requestAnimationFrame(() => {
        if (element !== null)
          element.scrollTop =
            previousTop + element.scrollHeight - previousHeight;
      });
    } catch (error) {
      if (
        error instanceof ApiClientError &&
        error.code === "stale_transcript"
      ) {
        setPages([snapshot.transcriptPage]);
        setHistoryError(
          "Conversation history changed, so the view returned to the latest messages.",
        );
      } else
        setHistoryError(
          error instanceof Error
            ? error.message
            : "Earlier messages could not be loaded.",
        );
    } finally {
      setLoadingOlder(false);
    }
  };

  return (
    <div
      className="transcript"
      aria-label="Conversation"
      ref={(node) => {
        elementRef.current = node;
        scrollRef(node);
      }}
    >
      <div className="transcript-column">
        {oldestCursor !== null && (
          <button
            type="button"
            className="history-page-control"
            disabled={loadingOlder}
            onClick={() => void loadEarlier()}
          >
            {loadingOlder
              ? "Loading earlier messages…"
              : "Load earlier messages"}
          </button>
        )}
        {historyError !== null && (
          <p className="diagnostic warning" role="alert">
            {historyError}{" "}
            <button type="button" onClick={() => void loadEarlier()}>
              Retry
            </button>
          </p>
        )}
        {renderedItems.length === 0 && (
          <div className="empty conversation-empty">
            <strong>No messages yet</strong>
            <span>
              Ask {BACKEND_LABEL[snapshot.thread.runtime]} to inspect,
              implement, or review something in this project.
            </span>
          </div>
        )}
        {groups.map((group, index) => {
          if (group.kind === "tool-run") {
            // A group is live while its run is: either it is the newest
            // batch of steps, or one of its steps is still running.
            const live =
              running &&
              (index === lastToolGroup ||
                group.items.some((item) => item.status === "running"));
            return (
              <ActivityGroup
                items={group.items}
                key={group.items[0]?.id}
                live={live}
                projectPath={snapshot.project.displayPath}
              />
            );
          }
          const { item } = group;
          if (item.kind === "diagnostic") {
            return (
              <p className={`diagnostic ${item.level}`} key={item.id}>
                {item.text}
              </p>
            );
          }
          if (item.role === "user") {
            const queuedImageCount = queuedSteerImageCount(item);
            return (
              <div className="u-row" key={item.id}>
                <div className="u-bubble">
                  <span className="sr-only">You</span>
                  {(item.images?.length ?? 0) > 0 && (
                    <div
                      className="transcript-images"
                      aria-label="Attached images"
                    >
                      {(item.images ?? []).map((image, imageIndex) => (
                        <TranscriptImage
                          key={image.id}
                          projectId={snapshot.project.id}
                          threadId={snapshot.thread.id}
                          image={image}
                          ordinal={imageIndex + 1}
                        />
                      ))}
                    </div>
                  )}
                  {queuedImageCount > 0 && (
                    <div
                      className="transcript-images"
                      aria-label={`${String(queuedImageCount)} queued ${queuedImageCount === 1 ? "image" : "images"}`}
                    >
                      {queuedImageCount === 1
                        ? "1 image queued for steering"
                        : `${String(queuedImageCount)} images queued for steering`}
                    </div>
                  )}
                  {item.text !== "" && (
                    <div className="markdown">
                      <Markdown>{item.text}</Markdown>
                    </div>
                  )}
                </div>
              </div>
            );
          }
          return (
            <div className="a-block" key={item.id}>
              <span className="sr-only">
                {item.role === "assistant" ? "Pi" : "System"}
              </span>
              <div className="markdown">
                <Markdown>{item.text}</Markdown>
              </div>
            </div>
          );
        })}
        {/* The live diagnostic sits at the foot of the transcript, directly
            under the running activity group -- where a reader watching a
            stalled run is already looking. `role="status"` so it is
            announced when it appears without stealing focus. */}
        {diagnostic !== null && (
          <p className={`diagnostic live ${diagnostic.level}`} role="status">
            {diagnostic.message}
          </p>
        )}
        {snapshot.diagnostics.map((text) => (
          <p className="diagnostic warning" key={text}>
            {text}
          </p>
        ))}
      </div>
    </div>
  );
}

export function Composer({
  projectId,
  threadId,
  snapshot,
  onSteered,
  onSent,
  onContinue,
  onFocus,
}: {
  projectId: ProjectId;
  threadId: ThreadId;
  snapshot: ThreadSnapshot;
  /**
   * A steer the server accepted. The pane echoes it into the transcript,
   * because nothing else will until the run ends (see `steerEchoItem`).
   *
   * The two baselines are how many user messages already carried this text,
   * and how many there were of any text, when the request went out. They are
   * measured HERE rather than in the pane so that they describe the
   * transcript as it stood before the steer could possibly have landed.
   */
  onSteered?:
    | ((
        text: string,
        runId: string,
        baseline: { priorCopies: number; priorUserMessages: number },
        images: readonly File[],
      ) => void)
    | undefined;
  /** Anything was sent: re-pin the transcript to the bottom. */
  onSent?: (() => void) | undefined;
  /** Exact `/new` passed preflight and should open a pending sibling pane. */
  onContinue?: (() => void) | undefined;
  onFocus?: (() => void) | undefined;
}) {
  const queryClient = useQueryClient();
  const [text, setText] = useState(() => readDraft(`pi-draft:${threadId}`));
  const textareaRef = useAutoGrow<HTMLTextAreaElement>(text);
  const attachments = useChatAttachments(
    snapshot.capabilities.imageInput ?? "unknown",
    () => {
      onFocus?.();
      textareaRef.current?.focus();
    },
  );
  const submissionKey = useRef(commandId());
  const attachmentKey = attachments.images.map((image) => image.id).join(":");
  useEffect(() => {
    submissionKey.current = commandId();
  }, [text, attachmentKey]);
  const activeRun =
    snapshot.currentRun?.state === "running" ? snapshot.currentRun : null;
  const active = activeRun !== null;
  const continuing = useMutation({
    mutationFn: async () => await preflightContinuation(projectId, threadId),
    onSuccess: () => {
      setText("");
      removeDraft(`pi-draft:${threadId}`);
      onContinue?.();
    },
  });
  const runtimeUnavailable = !snapshot.thread.runtimeAvailable;
  // Stop used to be `void stop(...).then(...)` with no rejection handler: a
  // Stop the server refused produced an unhandled promise rejection in the
  // console and NOTHING on screen, so the run went on running under a button
  // the reader had already pressed. It has an error to show now -- the server
  // reports `stop_timed_out` when the agent does not come to rest inside its
  // deadline, and that run really is still active -- so the failure has to be
  // visible, and Retry has to be the obvious thing to do with it.
  const stopping = useMutation({
    mutationFn: async () => await stop(projectId, threadId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["snapshot", projectId, threadId],
      });
    },
  });
  const mutation = useMutation({
    mutationFn: async () => {
      // Trimmed, because that is what the server stores: `SteerRequestSchema`
      // and `PromptRequestSchema` are both `z.string().trim()`, and the route
      // hands Pi the PARSED value. Sending the raw textarea contents made the
      // echo and the eventual persisted message different strings -- one
      // trailing newline from Shift+Enter was enough -- so the echo could
      // never be retired and the steer showed twice for the rest of the run.
      const sent = text.trim();
      if (activeRun === null)
        return attachments.files.length === 0
          ? await prompt(projectId, threadId, sent)
          : await prompt(
              projectId,
              threadId,
              sent,
              attachments.files,
              submissionKey.current,
            );
      // Measured before the request, so a copy that arrives after it is
      // unambiguously this steer landing. Both are taken: Pi rewrites a
      // `/`-prefixed steer before storing it, and the count of ALL user
      // messages is the only baseline that still means something then.
      const baseline = {
        priorCopies: countUserMessages(snapshot.transcriptPage.items, sent),
        priorUserMessages: countAllUserMessages(snapshot.transcriptPage.items),
      };
      const result =
        attachments.files.length === 0
          ? await steer(projectId, threadId, sent)
          : await steer(
              projectId,
              threadId,
              sent,
              attachments.files,
              submissionKey.current,
            );
      onSteered?.(sent, activeRun.id, baseline, attachments.files);
      return result;
    },
    onSuccess: async () => {
      setText("");
      attachments.clear();
      removeDraft(`pi-draft:${threadId}`);
      await queryClient.invalidateQueries({
        queryKey: ["snapshot", projectId, threadId],
      });
      await queryClient.invalidateQueries({ queryKey: ["workspace"] });
    },
  });
  useEffect(() => {
    writeDraft(`pi-draft:${threadId}`, text);
  }, [text, threadId]);
  const submit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const submitted = text.trim();
    if (
      runtimeUnavailable ||
      (submitted === "" && attachments.images.length === 0) ||
      (attachments.images.length > 0 &&
        snapshot.capabilities.imageInput === "unsupported")
    )
      return;
    // Never discard pending photos by interpreting their caption as an app
    // command. Exact text-only `/new` remains the continuation command.
    if (submitted === "/new" && attachments.images.length === 0) {
      continuing.mutate();
      return;
    }
    // Before the request, not after it: sending is the moment the reader
    // expects to be taken to the bottom, and waiting for the response would
    // leave them staring at old history for the length of a round trip.
    onSent?.();
    mutation.mutate();
  };
  // The composer names the agent that will actually read the message; a Codex
  // chat inviting you to "Ask Pi" would be simply wrong.
  const agentLabel = BACKEND_LABEL[snapshot.thread.runtime];
  // A thread the server no longer serves. Retry can never clear it while the
  // thread stays archived, and "Thread was not found in this project." is
  // both written for a developer and untrue -- the thread exists.
  const missingThread =
    mutation.error instanceof ApiClientError &&
    mutation.error.code === "thread_not_found";
  return (
    <form
      className={`composer${active ? " steering" : ""}${attachments.dragging ? " image-dragging" : ""}`}
      onSubmit={submit}
      onDragEnterCapture={(event) => {
        if (!mutation.isPending || !event.dataTransfer.types.includes("Files"))
          return;
        event.preventDefault();
        event.stopPropagation();
      }}
      onDragOverCapture={(event) => {
        if (!mutation.isPending || !event.dataTransfer.types.includes("Files"))
          return;
        event.preventDefault();
        event.stopPropagation();
      }}
      onDropCapture={(event) => {
        if (!mutation.isPending || !event.dataTransfer.types.includes("Files"))
          return;
        event.preventDefault();
        event.stopPropagation();
      }}
      {...attachments.dropHandlers}
    >
      {attachments.dragging && (
        <div className="chat-drop-overlay" aria-hidden="true">
          Drop photos here
        </div>
      )}
      <div className="composer-stack">
        {text.trimStart().startsWith("/") && (
          <button
            type="button"
            className="composer-command"
            aria-label="/new — New chat in this worktree"
            onClick={() => {
              setText("/new");
              textareaRef.current?.focus();
            }}
          >
            <code>/new</code> — New chat in this worktree
          </button>
        )}
        <div className="composer-input">
          <ChatAttachmentStrip
            images={attachments.images}
            error={attachments.error}
            onRemove={attachments.remove}
          />
          <textarea
            ref={textareaRef}
            aria-label={`Message ${agentLabel}`}
            // The mode was previously visible ONLY on the submit button's
            // aria-label, i.e. after the decision to send had already been
            // made. Placeholder, hint line and the rule above them now say it
            // too, so "am I adding to this run or starting a new turn?" is
            // answerable before the keystroke rather than after it.
            placeholder={
              active
                ? `Steer this run — ${agentLabel} picks it up mid-task…`
                : `Ask ${agentLabel} to work in this project…`
            }
            rows={1}
            value={text}
            onChange={(event) => {
              setText(event.target.value);
            }}
            onPasteCapture={(event) => {
              if (
                mutation.isPending &&
                [...event.clipboardData.items].some(
                  (item) =>
                    item.kind === "file" && item.type.startsWith("image/"),
                )
              ) {
                event.preventDefault();
                event.stopPropagation();
              }
            }}
            onPaste={attachments.onPaste}
            readOnly={mutation.isPending}
            onKeyDown={(event) => {
              if (isReleaseKey(event)) {
                event.preventDefault();
                releaseFocusToPane(event.currentTarget);
                return;
              }
              if (
                event.key !== "Enter" ||
                event.shiftKey ||
                event.nativeEvent.isComposing
              )
                return;
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }}
          />
          <div className="composer-actions">
            <span>
              {active
                ? "Enter to steer this run · Shift + Enter for a new line · Esc to leave the composer"
                : "Enter to send · Shift + Enter for a new line · Esc to leave the composer"}
            </span>
            {active && (
              <button
                type="button"
                className="stop"
                disabled={stopping.isPending}
                onClick={() => {
                  stopping.mutate();
                }}
              >
                ■ Stop
              </button>
            )}
            <button
              type="submit"
              className="send"
              aria-label={
                text.trim() === "/new" && attachments.images.length === 0
                  ? "Start new chat in this worktree"
                  : active
                    ? "Steer current run"
                    : "Send message"
              }
              title={
                text.trim() === "/new" && attachments.images.length === 0
                  ? "Start new chat in this worktree"
                  : active
                    ? "Steer current run"
                    : "Send message"
              }
              disabled={
                runtimeUnavailable ||
                mutation.isPending ||
                continuing.isPending ||
                (attachments.images.length > 0 &&
                  snapshot.capabilities.imageInput === "unsupported") ||
                (text.trim() === "" && attachments.images.length === 0)
              }
            >
              <span aria-hidden="true">↑</span>
            </button>
          </div>
        </div>
      </div>
      {continuing.error !== null && (
        <ErrorNotice
          error={continuing.error}
          context="Could not start a new chat in this worktree"
          onRetry={() => {
            continuing.mutate();
          }}
        />
      )}
      {stopping.error !== null && (
        <ErrorNotice
          error={stopping.error}
          context="Could not stop this run"
          onRetry={() => {
            stopping.mutate();
          }}
        />
      )}
      {mutation.error !== null &&
        (missingThread ? (
          <div className="error-notice" role="alert">
            <span className="error-notice-message">
              This thread is no longer open for messages. If you archived it,
              restore it from the sidebar to keep working; your message is still
              in the box.
            </span>
          </div>
        ) : (
          <ErrorNotice
            error={mutation.error}
            onRetry={() => {
              mutation.mutate();
            }}
          />
        ))}
    </form>
  );
}

/**
 * What a pane shows in place of its composer once its thread is archived.
 *
 * The pane used to keep a fully enabled composer pointed at a thread the
 * server answers 404 for, so the first sign anything was wrong arrived after
 * the message had been typed and sent.
 */
function ArchivedNotice({
  onRestore,
  restoring,
  error,
}: {
  onRestore: () => void;
  restoring: boolean;
  error: unknown;
}) {
  return (
    <div className="archived-notice">
      <div className="archived-notice-body">
        <p className="archived-notice-text" role="status">
          This thread is archived. Restore it to keep working.
        </p>
        <button
          type="button"
          className="archived-notice-restore"
          onClick={onRestore}
          disabled={restoring}
        >
          Restore thread
        </button>
      </div>
      {error !== null && error !== undefined && (
        <ErrorNotice error={error} context="Could not restore this thread" />
      )}
    </div>
  );
}

/**
 * A pane bound to one thread.
 *
 * Keyed on the thread, and that is load-bearing rather than tidy. Everything
 * this component keeps outside the query cache belongs to the thread it was
 * showing: the archived latch (which only ever goes true, so a rebind onto a
 * thread the listing has not caught up with would declare a live thread
 * Archived and take its composer away), the unpersisted steer echoes, the
 * composer's draft, and the restore mutation. None of it should outlive a
 * change of thread, and nothing in here is worth carrying across one.
 *
 * The key lives here rather than at the call site so that it cannot be lost
 * by a future caller: `TilingSurface` is not the only thing that could render
 * a pane, and the state hazard belongs to this component, not to whoever
 * mounts it.
 */
export function ThreadPane(props: ThreadPaneProps) {
  return <ThreadPaneBody key={props.threadId} {...props} />;
}

function ThreadPaneBody(props: ThreadPaneProps) {
  const { projectId, threadId, focused } = props;
  const queryClient = useQueryClient();
  const snapshotKey = ["snapshot", projectId, threadId] as const;
  const snapshot = useQuery({
    queryKey: snapshotKey,
    queryFn: () => getSnapshot(projectId, threadId),
    refetchInterval: 15_000,
  });
  const rename = useMutation({
    mutationFn: async (title: string) =>
      await renameThread(projectId, threadId, title),
    onSuccess: async (result) => {
      // The parsed mutation response carries the authoritative ThreadSummary.
      // Patch only that member so the title changes without a stale-heading
      // frame while preserving transcript/live state owned by this snapshot.
      queryClient.setQueryData<ThreadSnapshot>(snapshotKey, (current) =>
        current === undefined ? current : { ...current, thread: result.thread },
      );
      await queryClient.invalidateQueries({ queryKey: ["workspace"] });
    },
  });
  // Keep the query declaration adjacent to the rename cache patch: both must
  // use the exact same key, or a pane can keep its old title until polling.
  const runActive = snapshot.data?.currentRun?.state === "running";
  const currentRunId = snapshot.data?.currentRun?.id ?? null;
  const live = useLive(
    projectId,
    threadId,
    snapshot.data !== undefined,
    runActive,
  );
  // Archive is a sidebar action in a file this pane does not own, and NO
  // contract carries an `archived` flag: `ThreadSummary` has none, and every
  // thread route answers an archived thread with a flat 404
  // (`store.getThread` appends `AND t.archived_at IS NULL`). So the pane
  // infers it, from two signals it can already see.
  //
  // Archiving is very nearly the only way a thread leaves the workspace
  // listing: `apps/server/src/app.ts` has no delete-thread route at all (and
  // no `DELETE FROM` anywhere in the server), the listing is neither filtered
  // by project nor paginated, and removing the whole project takes this pane
  // with it. Two other paths do exist, and both make this pane say "Archived"
  // about a thread that is not:
  //   - a soft-removed project (`p.removed_at IS NULL` is a join predicate;
  //     the thread rows are untouched), which takes the pane with it anyway;
  //   - a stored thread row that fails its schema, which `parseListRows`
  //     (`apps/server/src/db/store.ts`) drops silently, substituting a
  //     diagnostic string. Such a thread leaves the listing without being
  //     archived, and the Restore offered here cannot help it.
  // If a delete route is ever added it joins that list, and this has to grow
  // a way to tell the cases apart.
  const workspace = useQuery({
    queryKey: ["workspace"],
    queryFn: getWorkspace,
  });
  const listedNow =
    workspace.data?.threads.some((thread) => thread.id === threadId) ?? false;
  // Latched: a thread that has never appeared in the listing might simply be
  // newer than the listing. One that HAS appeared and then left was archived.
  // Without this, a thread created a moment ago flashes "Archived" while the
  // workspace query catches up.
  //
  // State set from an effect, not a ref written during render: the latch is
  // read by the render that decides whether to take the composer away, and a
  // render that React discards must not be able to leave it set.
  const [wasListed, setWasListed] = useState(false);
  useEffect(() => {
    if (listedNow) setWasListed(true);
  }, [listedNow]);
  const missingFromWorkspace =
    workspace.data !== undefined && !listedNow && wasListed;
  // The slower but unambiguous signal: the server itself refusing the thread.
  // Kept alongside the listing check because the two arrive at different
  // times -- App invalidates ["workspace"] the instant an archive commits,
  // while this pane's own snapshot only re-asks on its 15s poll, and waiting
  // for that would leave a green header and a live composer up for as long as
  // the reported bug did.
  //
  // `failureReason` as well as `error`, and that is load-bearing: the
  // app-wide default retries twice with backoff, and for the whole of that
  // ladder `error` is still null and `isPending` is still true. Observed in
  // the running app, two panes restored onto a just-archived thread sat on
  // "Loading workspace…" rather than reaching any resolution.
  // `failureReason` carries the FIRST failed attempt's error, so the pane can
  // say what happened at once without this query having to opt out of a
  // retry policy it does not own.
  const refusal = snapshot.error ?? snapshot.failureReason;
  const snapshotRefused =
    refusal instanceof ApiClientError && refusal.code === "thread_not_found";
  const archived = snapshotRefused || missingFromWorkspace;
  // Steers the client has sent and no transcript can show yet. Held here, in
  // component state, for the same reason the streamed turn is: the server
  // provably cannot produce them, so a query cache entry holding them would
  // be deleted by the next authoritative fetch.
  const [pendingSteers, setPendingSteers] = useState<readonly PendingSteer[]>(
    [],
  );
  // Minted, never reused, so an echo's React key is fixed for its lifetime.
  const nextOrdinal = useRef(0);
  const settledTranscript = snapshot.data?.transcriptPage.items;
  const onSteered = useCallback(
    (
      text: string,
      runId: string,
      baseline: { priorCopies: number; priorUserMessages: number },
      images: readonly File[],
    ) => {
      const ordinal = nextOrdinal.current;
      nextOrdinal.current += 1;
      setPendingSteers((current) => [
        ...current,
        { runId, text, ordinal, images, ...baseline },
      ]);
    },
    [],
  );
  // An echo stops the moment Pi has persisted it. Computed at RENDER time,
  // below, not here: the live turn's handover is a render-time predicate
  // (`mergeLiveTurn` -> `alreadySettled`), which is why the frame that first
  // carries the settled text is also the first frame that stops drawing the
  // placeholder. Doing it in an effect instead meant the render that first
  // carried the persisted steer still held the old `pendingSteers` and
  // painted both. This effect only garbage-collects what that render has
  // already stopped showing.
  useEffect(() => {
    if (settledTranscript === undefined) return;
    setPendingSteers((current) =>
      dropSettledSteers(settledTranscript, current),
    );
  }, [settledTranscript]);
  // Steers the run ended without ever delivering. They stay independently
  // actionable: merging their images into the active draft would silently
  // discard anything beyond one message's four-image limit.
  const [undelivered, setUndelivered] = useState<{
    steers: readonly PendingSteer[];
  } | null>(null);
  const lastRun = snapshot.data?.lastRun ?? null;
  // An echo belongs to its run, and cannot outlive it.
  //
  // For a run that COMPLETED the handover is silent: the fetch that reports
  // the run finished is the same fetch that carries the now-persisted
  // message, so the text is never gone from both. A run that was STOPPED is
  // the case this exists for, and the claim it makes is true only because
  // `PiOpenSession.stop` now empties Pi's steering queue before aborting.
  // Neither `AgentSession.abort()` nor `Agent.abort()` does that on its own,
  // and the queue belongs to the session rather than the run, so a steer left
  // in it used to be injected into whatever the reader sent next -- while
  // this pane told them it had never been delivered and put it back in the
  // composer for them to send again. See the comment on that method.
  //
  // Dropping the echo instead would take the user's words off the screen,
  // having already taken them out of the composer, with no notice that they
  // were never acted on. So they go back where they came from: the composer
  // is the one place the text is actionable -- one keystroke re-sends it --
  // and leaving it in the transcript would assert it is part of a
  // conversation it never reached.
  useEffect(() => {
    const stale = pendingSteers.filter(
      (steer) => !runActive || steer.runId !== currentRunId,
    );
    if (stale.length === 0) return;
    setPendingSteers((current) =>
      current.filter((steer) => runActive && steer.runId === currentRunId),
    );
    // Anything Pi did persist is server truth now and must not be handed
    // back as well -- and that check is the WHOLE guard. It used to be
    // fenced behind `lastRun.state !== "completed"` and a
    // `steer.runId === lastRun.id` filter, and the filter silently dropped
    // the text whenever a fast Stop-then-send had already made `lastRun` the
    // new run: the exact outcome this path exists to prevent. The transcript
    // is better evidence than either fence, because the fetch that reports a
    // run settled is the same fetch that carries what that run persisted.
    const lost =
      settledTranscript === undefined
        ? stale
        : dropSettledSteers(settledTranscript, stale);
    if (lost.length === 0) return;
    // Keep the reader's in-memory draft and caret untouched, but preserve the
    // lost text in the reload-safe draft as well as the explicit retry queue.
    // Image files remain in the retry records because browser storage cannot
    // safely or durably represent them.
    const draftKey = `pi-draft:${threadId}`;
    writeDraft(
      draftKey,
      [readDraft(draftKey), ...lost.map((steer) => steer.text)]
        .filter((part) => part !== "")
        .join("\n\n"),
    );
    setUndelivered((current) => ({
      steers: [...(current?.steers ?? []), ...lost],
    }));
  }, [runActive, currentRunId, pendingSteers, settledTranscript, threadId]);
  const restore = useMutation({
    mutationFn: async () => await unarchiveThread(projectId, threadId),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["workspace"] }),
        queryClient.invalidateQueries({ queryKey: ["archived-threads"] }),
        queryClient.invalidateQueries({
          queryKey: ["snapshot", projectId, threadId],
        }),
      ]);
    },
  });
  useEffect(() => {
    const lastRun = snapshot.data?.lastRun;
    if (snapshot.data?.thread.unread === true && lastRun?.state === "completed")
      void markViewed(projectId, threadId, lastRun.id);
  }, [
    projectId,
    snapshot.data?.lastRun,
    snapshot.data?.thread.unread,
    threadId,
  ]);
  const threadWorkspace = snapshot.data?.thread.workspace ?? {
    mode: "shared" as const,
    branchName: null,
    available: true,
  };
  const status = deriveRunStatus({
    runState: snapshot.data?.thread.runState ?? null,
    archived,
  });
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (status !== "working") return;
    const id = window.setInterval(() => {
      setNow(Date.now());
    }, 1_000);
    return () => {
      window.clearInterval(id);
    };
  }, [status]);
  const elapsed =
    status === "working"
      ? elapsedLabel(snapshot.data?.currentRun?.startedAt ?? null, now)
      : null;
  const workspaceLabel = `${
    threadWorkspace.mode === "worktree" ? "↗ Worktree" : "⌂ Local checkout"
  }${threadWorkspace.branchName === null ? "" : ` · ⑂ ${threadWorkspace.branchName}`}`;
  // The header clamps its detail line to one row, so the full text lives on
  // the tooltip rather than being lost.
  const trustNotice =
    snapshot.data?.thread.runtime === "codex"
      ? "Confined execution: Codex runs without application approval, inside the boundary this server was configured with."
      : TRUST_NOTICE;
  const detailTitle = `${workspaceLabel} · ${trustNotice}`;
  // A failed run used to be a red dot and nothing else, and an INTERRUPTED
  // one was worse: it rendered as a green "Done" with no notice at all, so a
  // run the user cancelled was presented exactly like one that succeeded.
  // Run.failureMessage / Run.failureCode have always been in the contract and
  // sent by the server ("Stopped by the user.", "Interrupted because the
  // project was removed."); both settled non-success states now surface
  // whichever of them the server gave us.
  //
  // Dismissed on send, because the notice describes the run that just ended
  // and the reader has moved on: without this it sat above an already-cleared
  // composer for a whole round trip, until the next snapshot replaced it.
  const [dismissedOutcomeRunId, setDismissedOutcomeRunId] = useState<
    string | null
  >(null);
  const outcome = runOutcomeNotice(
    lastRun !== null && lastRun.id !== dismissedOutcomeRunId ? lastRun : null,
  );
  const recoverSteer = useMutation({
    mutationFn: async (lost: PendingSteer) => {
      const currentSnapshot = snapshot.data;
      const currentRun = currentSnapshot?.currentRun;
      const files = lost.images ?? [];
      if (currentRun?.state === "running" && currentSnapshot !== undefined) {
        const baseline = {
          priorCopies: countUserMessages(
            currentSnapshot.transcriptPage.items,
            lost.text,
          ),
          priorUserMessages: countAllUserMessages(
            currentSnapshot.transcriptPage.items,
          ),
        };
        const result =
          files.length === 0
            ? await steer(projectId, threadId, lost.text)
            : await steer(projectId, threadId, lost.text, files, commandId());
        onSteered(lost.text, currentRun.id, baseline, files);
        return result;
      }
      return files.length === 0
        ? await prompt(projectId, threadId, lost.text)
        : await prompt(projectId, threadId, lost.text, files, commandId());
    },
    onSuccess: async (_result, restored) => {
      setUndelivered((current) => {
        if (current === null) return null;
        const steers = current.steers.filter(
          (steer) => steer.ordinal !== restored.ordinal,
        );
        return steers.length === 0 ? null : { steers };
      });
      await queryClient.invalidateQueries({
        queryKey: ["snapshot", projectId, threadId],
      });
      await queryClient.invalidateQueries({ queryKey: ["workspace"] });
    },
  });

  // The transcript and the composer are siblings, and sending has to re-pin
  // the transcript, so the pin lives here where both can reach it rather than
  // inside the transcript.
  //
  // The retirement of a settled steer happens here, at render time, for the
  // same reason `mergeLiveTurn` does: the frame that first carries the
  // persisted message is the first frame that stops drawing the echo, so
  // there is no frame that paints both and none that paints neither.
  const visibleSteers = useMemo(
    () =>
      snapshot.data === undefined
        ? pendingSteers
        : dropSettledSteers(snapshot.data.transcriptPage.items, pendingSteers),
    [snapshot.data, pendingSteers],
  );
  const items = useMemo(() => {
    if (snapshot.data === undefined) return [];
    return displayTranscript(
      mergePendingSteers(
        mergeLiveTurn(snapshot.data.transcriptPage.items, live.turn),
        visibleSteers,
      ),
    );
  }, [snapshot.data, live.turn, visibleSteers]);
  const [historyAtLatest, setHistoryAtLatest] = useState(true);
  const [historyReset, setHistoryReset] = useState(0);
  const transcript = useStickToBottom<HTMLDivElement>(
    threadId,
    transcriptContentKey(
      items,
      snapshot.data?.diagnostics ?? [],
      live.diagnostic,
    ),
  );

  return (
    <section
      className={`pane thread-pane ${focused ? "focused" : "dim"}`}
      aria-label={snapshot.data?.thread.title ?? "Thread"}
      aria-current={focused ? "true" : undefined}
      // Escape in the composer parks focus here (see paneFocus.ts). Not in
      // the tab order -- this is a landing site, not a stop.
      tabIndex={-1}
      onClick={() => {
        props.onFocus();
      }}
    >
      <PaneHeader
        status={status}
        elapsed={elapsed}
        title={snapshot.data?.thread.title ?? "Thread"}
        projectLabel={snapshot.data?.project.displayName ?? ""}
        runtime={snapshot.data?.thread.runtime ?? null}
        focused={focused}
        detailTitle={detailTitle}
        detail={
          <>
            <span className="pane-meta">{workspaceLabel}</span>
            <span className="trust-note">
              <span className="trust-dot" aria-hidden="true" />
              {/* The complete notice remains in the accessibility tree while
                  narrow panes use a shorter visual form. */}
              <span className="sr-only">{trustNotice}</span>
              <span aria-hidden="true">
                <strong>
                  {snapshot.data?.thread.runtime === "codex"
                    ? "Confined execution:"
                    : "Direct execution:"}
                </strong>{" "}
                <span className="trust-note-long">
                  {snapshot.data?.thread.runtime === "codex"
                    ? "Codex runs without application approval, inside the boundary this server was configured with."
                    : "Pi tools run with your user permissions, without application approval or an OS sandbox."}
                </span>
                <span className="trust-note-short">
                  {snapshot.data?.thread.runtime === "codex"
                    ? "configured boundary, no approvals."
                    : "no sandbox, no approvals."}
                </span>
              </span>
            </span>
          </>
        }
        onRename={
          snapshot.data === undefined || archived
            ? undefined
            : async (title) => {
                await rename.mutateAsync(title);
              }
        }
        onSplit={() => {
          props.onSplit();
        }}
        onClose={() => {
          props.onClose();
        }}
      />
      {/* Archived is checked BEFORE isPending: a thread that has been
          archived is settled, and there is nothing a still-running retry
          could return that would change the answer. Waiting for the ladder
          to finish is what left the pane on "Loading workspace…". */}
      {archived && snapshot.data === undefined ? (
        <main className="center">
          <ArchivedNotice
            onRestore={() => {
              restore.mutate();
            }}
            restoring={restore.isPending}
            error={restore.error}
          />
        </main>
      ) : snapshot.isPending ? (
        <Loading />
      ) : snapshot.data === undefined ? (
        <main className="center">
          <ErrorNotice
            error={snapshot.error}
            onRetry={() => {
              void snapshot.refetch();
            }}
          />
        </main>
      ) : (
        <main className="center">
          <Transcript
            projectId={projectId}
            threadId={threadId}
            snapshot={snapshot.data}
            items={items}
            diagnostic={live.diagnostic}
            scrollRef={transcript.attach}
            resetToLatest={historyReset}
            onLatestChange={setHistoryAtLatest}
          />
          {/* In normal flow between the transcript and the composer, never
              over the transcript: an overlay would hide the newest line,
              which is the line the reader unpinned in order to get away
              from. It is the only route back during a fast run -- the
              content grows faster than a reader can scroll, so scrolling
              down by hand does not converge. */}
          {(!transcript.pinned || !historyAtLatest) && (
            <div className="jump-latest">
              <button
                type="button"
                className="jump-latest-btn"
                aria-label="Jump to latest"
                onClick={() => {
                  if (!historyAtLatest) setHistoryReset((value) => value + 1);
                  requestAnimationFrame(transcript.pinToBottom);
                }}
              >
                ↓ Jump to latest
              </button>
            </div>
          )}
          {/* The undelivered sentence rides on the outcome notice wherever
              there is one: it is part of what the ended run means, and it
              has the same lifetime -- the reader sending again is exactly
              what resolves it. But it must not DEPEND on one. A Stop
              followed quickly by a send makes `lastRun` the new, running
              run, which has no outcome to report, and the sentence used to
              vanish with it -- handing the words back with nothing on
              screen to say why they had reappeared. */}
          {(outcome !== null || undelivered !== null) && (
            <div className={`run-failure ${outcome?.tone ?? "stopped"}`}>
              <p className="run-failure-body" role="status">
                <span
                  className={`sdot ${outcome?.tone === "failed" ? "fail" : "stop"}`}
                  aria-hidden="true"
                />
                {outcome?.text}
                {outcome !== null && undelivered !== null && " "}
                {undelivered !== null &&
                  (undelivered.steers.length === 1
                    ? "Your steering message was never delivered. Retry it below."
                    : `Your ${String(undelivered.steers.length)} steering messages were never delivered. Retry each below.`)}
              </p>
              {undelivered !== null && (
                <div className="undelivered-steers">
                  {undelivered.steers.map((lost, index) => (
                    <button
                      type="button"
                      key={lost.ordinal}
                      disabled={recoverSteer.isPending}
                      onClick={() => {
                        recoverSteer.mutate(lost);
                      }}
                    >
                      {`Retry steering message ${String(index + 1)}${(lost.images?.length ?? 0) === 0 ? "" : ` with ${String(lost.images?.length ?? 0)} photos`}`}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {recoverSteer.error !== null && (
            <ErrorNotice
              error={recoverSteer.error}
              context="Could not retry steering message"
            />
          )}
          {archived ? (
            <ArchivedNotice
              onRestore={() => {
                restore.mutate();
              }}
              restoring={restore.isPending}
              error={restore.error}
            />
          ) : (
            <Composer
              projectId={projectId}
              threadId={threadId}
              snapshot={snapshot.data}
              onSteered={onSteered}
              onContinue={() => {
                props.onContinue?.();
              }}
              onFocus={() => {
                props.onFocus();
              }}
              onSent={() => {
                setUndelivered(null);
                // Only a notice that is on screen right now can be dismissed
                // by sending. `lastRun` INCLUDES the run in flight, so
                // recording its id unconditionally pre-dismissed the outcome
                // of the very run this message was steering: stopping it
                // afterwards then showed no "Stopped by the user." at all.
                // Caught in the running app, not by a test.
                setDismissedOutcomeRunId(
                  outcome === null ? null : (lastRun?.id ?? null),
                );
                transcript.pinToBottom();
              }}
            />
          )}
        </main>
      )}
    </section>
  );
}
