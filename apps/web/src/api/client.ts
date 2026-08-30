import {
  AgentBackendsResponseSchema,
  ApiErrorSchema,
  ArchivedThreadsResponseSchema,
  ArchiveThreadResponseSchema,
  UnarchiveThreadResponseSchema,
  BrowseProjectResponseSchema,
  ChatImageResponseSchema,
  ContinueThreadPreflightResponseSchema,
  ContinueThreadResponseSchema,
  FilePreviewResponseSchema,
  FileTreeResponseSchema,
  GitDiffResponseSchema,
  GitStatusResponseSchema,
  ProjectMutationResponseSchema,
  ProjectsResponseSchema,
  RunMutationResponseSchema,
  SessionsResponseSchema,
  StartThreadResponseSchema,
  ThreadMutationResponseSchema,
  ThreadSnapshotSchema,
  TranscriptPageSchema,
  WorkspacePreflightResponseSchema,
  type ChatImageId,
  type ProjectId,
  type RunId,
  type ThreadId,
  type RuntimeKind,
  type TranscriptCursor,
} from "@pi-web/contracts";
import { z } from "zod";

export class ApiClientError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

// `fetch` rejects with a bare `TypeError: Failed to fetch` when it never got
// a reply -- the workspace server stopped, was restarted, or the machine went
// to sleep. That string is the browser's, not ours, and it reached the reader
// verbatim inside a `role="alert"`: a developer sentence in the one place a
// non-developer most needs a next step. Everything else in this app maps a
// failure to a sentence with an action in it; this was the one hole.
//
// Mapped here rather than in `ErrorNotice` so every caller gets it -- queries
// and mutations alike -- and so the code is a real code the UI can branch on
// instead of a message match.
export const NETWORK_UNREACHABLE = "network_unreachable";
const NETWORK_UNREACHABLE_MESSAGE =
  "Can't reach the Pi workspace server — it may have stopped or be restarting. Your text is safe here; retry once it is back.";
/**
 * How long a panel read waits before it is a failure rather than a wait.
 *
 * H5: nothing bounded this, and a request that never settles is the one
 * failure React Query cannot turn into an error state — a rejected promise
 * retries and then fails, a pending one stays pending. The file tree's row
 * therefore read "Listing ops…" for as long as the page was open. Ten
 * seconds is the same deadline the server gives its own Git calls, and it is
 * far longer than the slowest measured listing on a real repository.
 */
export const PANEL_READ_TIMEOUT_MS = 10_000;

/**
 * Whether a failed request is worth issuing again.
 *
 * A client error is a statement about the request — a deleted directory is
 * still deleted on the third attempt — and a timeout has already waited its
 * whole deadline, so both go straight to the view's error state, where the
 * user has a retry control of their own. Everything else is a fault that may
 * not repeat, and is retried twice.
 */
export function shouldRetryRequest(
  failureCount: number,
  error: unknown,
): boolean {
  if (error instanceof ApiClientError) {
    if (error.status >= 400 && error.status < 500) return false;
    if (error.code === "request_timeout") return false;
  }
  return failureCount < 2;
}

interface RequestOptions {
  /** A deadline, after which the request is aborted and reported as one. */
  timeoutMs?: number;
}

async function request<T>(
  path: string,
  schema: z.ZodType<T>,
  init: RequestInit = {},
  options: RequestOptions = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (init.body !== undefined) {
    if (!(init.body instanceof FormData))
      headers.set("Content-Type", "application/json");
    headers.set("X-Pi-Web-Request", "1");
  }
  // An explicit controller and timer rather than `AbortSignal.timeout`: the
  // request has to be cancelled, not just abandoned, and this reports the
  // deadline as a typed failure of ours instead of an `AbortError` every
  // caller would have to recognise.
  const controller = new AbortController();
  const deadline =
    options.timeoutMs === undefined
      ? null
      : setTimeout(() => {
          controller.abort();
        }, options.timeoutMs);
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers,
      signal: controller.signal,
    });
  } catch (cause) {
    // Our own deadline is a statement about this request and carries its own
    // code, so it is answered before either general case below.
    if (controller.signal.aborted)
      throw new ApiClientError(
        504,
        "request_timeout",
        "The workspace did not answer in time. Try again.",
      );
    // An abort is the caller's own doing (a cancelled query, a navigation)
    // and must keep its identity so react-query does not report it as a
    // failure.
    if (cause instanceof DOMException && cause.name === "AbortError")
      throw cause;
    throw new ApiClientError(
      0,
      NETWORK_UNREACHABLE,
      NETWORK_UNREACHABLE_MESSAGE,
    );
  } finally {
    if (deadline !== null) clearTimeout(deadline);
  }
  const value: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const parsed = ApiErrorSchema.safeParse(value);
    throw new ApiClientError(
      response.status,
      parsed.success ? parsed.data.error.code : "invalid_response",
      parsed.success
        ? parsed.data.error.message
        : "The server returned an invalid error response.",
    );
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new ApiClientError(
      502,
      "invalid_response",
      "The server returned malformed data.",
    );
  return parsed.data;
}

export function commandId(): string {
  return crypto.randomUUID();
}
const body = (value: unknown): string => JSON.stringify(value);

function chatForm(metadata: unknown, images: readonly File[]): FormData {
  const form = new FormData();
  form.append("metadata", JSON.stringify(metadata));
  for (const image of images) form.append("images", image, image.name);
  return form;
}

export async function getWorkspace() {
  return await request("/api/projects", ProjectsResponseSchema);
}
export async function browseProject() {
  return await request("/api/projects/browse", BrowseProjectResponseSchema, {
    method: "POST",
    body: body({ idempotencyKey: commandId() }),
  });
}
// The fallback route in, for when the native folder chooser cannot be used --
// it fails to open, opens behind the window, or lands on another desktop.
// Returns the same `{ project }` shape as every other project mutation; the
// browse route's `cancelled` outcome has no meaning here, because a typed
// path is either a project or an error.
export async function addProjectByPath(path: string) {
  return await request("/api/projects", ProjectMutationResponseSchema, {
    method: "POST",
    body: body({ path, idempotencyKey: commandId() }),
  });
}
export async function removeProject(projectId: ProjectId) {
  return await request(
    `/api/projects/${projectId}`,
    z.object({ removed: z.literal(true) }),
    { method: "DELETE", body: body({ idempotencyKey: commandId() }) },
  );
}
export async function setExpanded(
  projectId: ProjectId,
  sidebarExpanded: boolean,
) {
  return await request(
    `/api/projects/${projectId}`,
    ProjectMutationResponseSchema,
    {
      method: "PATCH",
      body: body({ sidebarExpanded, idempotencyKey: commandId() }),
    },
  );
}
export async function getWorkspacePreflight(
  projectId: ProjectId,
  runtime?: RuntimeKind,
) {
  return await request(
    `/api/projects/${projectId}/workspace-preflight${
      runtime === undefined ? "" : `?runtime=${encodeURIComponent(runtime)}`
    }`,
    WorkspacePreflightResponseSchema,
  );
}
export async function startThread(
  projectId: ProjectId,
  prompt: string,
  workspace:
    | { mode: "shared" }
    | {
        mode: "worktree";
        baseBranch: string;
        sourceChanges: "none" | "tracked_and_untracked";
        sourceStateToken?: string;
      },
  idempotencyKey: string,
  runtime?: RuntimeKind,
  images: readonly File[] = [],
) {
  const metadata = {
    prompt,
    workspace,
    idempotencyKey,
    ...(runtime === undefined ? {} : { runtime }),
  };
  return await request(
    `/api/projects/${projectId}/threads/start`,
    StartThreadResponseSchema,
    {
      method: "POST",
      body: images.length === 0 ? body(metadata) : chatForm(metadata, images),
    },
  );
}
export async function preflightContinuation(
  projectId: ProjectId,
  threadId: ThreadId,
) {
  return await request(
    `/api/projects/${projectId}/threads/${threadId}/continue/preflight`,
    ContinueThreadPreflightResponseSchema,
  );
}

export async function continueThread(
  projectId: ProjectId,
  threadId: ThreadId,
  prompt: string,
  idempotencyKey: string,
  images: readonly File[] = [],
) {
  const metadata = { prompt, idempotencyKey };
  return await request(
    `/api/projects/${projectId}/threads/${threadId}/continue`,
    ContinueThreadResponseSchema,
    {
      method: "POST",
      body: images.length === 0 ? body(metadata) : chatForm(metadata, images),
    },
  );
}

export async function getAgentBackends() {
  return await request("/api/agent-backends", AgentBackendsResponseSchema);
}
export async function archiveThread(projectId: ProjectId, threadId: ThreadId) {
  return await request(
    `/api/projects/${projectId}/threads/${threadId}/archive`,
    ArchiveThreadResponseSchema,
    { method: "POST", body: body({ idempotencyKey: commandId() }) },
  );
}
export async function unarchiveThread(
  projectId: ProjectId,
  threadId: ThreadId,
) {
  return await request(
    `/api/projects/${projectId}/threads/${threadId}/unarchive`,
    UnarchiveThreadResponseSchema,
    { method: "POST", body: body({ idempotencyKey: commandId() }) },
  );
}
export async function getArchivedThreads(projectId: ProjectId) {
  return await request(
    `/api/projects/${projectId}/archived-threads`,
    ArchivedThreadsResponseSchema,
  );
}
export async function renameThread(
  projectId: ProjectId,
  threadId: ThreadId,
  title: string,
) {
  return await request(
    `/api/projects/${projectId}/threads/${threadId}`,
    ThreadMutationResponseSchema,
    { method: "PATCH", body: body({ title, idempotencyKey: commandId() }) },
  );
}
export async function discoverSessions(projectId: ProjectId) {
  return await request(
    `/api/projects/${projectId}/sessions`,
    SessionsResponseSchema,
  );
}
export async function importThread(
  projectId: ProjectId,
  runtimeSessionId: string,
  runtime?: RuntimeKind,
) {
  return await request(
    `/api/projects/${projectId}/threads/import`,
    ThreadMutationResponseSchema,
    {
      method: "POST",
      body: body({
        runtimeSessionId,
        idempotencyKey: commandId(),
        ...(runtime === undefined ? {} : { runtime }),
      }),
    },
  );
}
export async function getSnapshot(projectId: ProjectId, threadId: ThreadId) {
  return await request(
    `/api/projects/${projectId}/threads/${threadId}`,
    ThreadSnapshotSchema,
  );
}
export async function getOlderTranscriptPage(
  projectId: ProjectId,
  threadId: ThreadId,
  cursor: TranscriptCursor,
) {
  return await request(
    `/api/projects/${projectId}/threads/${threadId}/transcript?cursor=${encodeURIComponent(cursor)}`,
    TranscriptPageSchema,
  );
}
export async function prompt(
  projectId: ProjectId,
  threadId: ThreadId,
  promptText: string,
  images: readonly File[] = [],
  idempotencyKey = commandId(),
) {
  const metadata = { prompt: promptText, idempotencyKey };
  return await request(
    `/api/projects/${projectId}/threads/${threadId}/prompt`,
    RunMutationResponseSchema,
    {
      method: "POST",
      body: images.length === 0 ? body(metadata) : chatForm(metadata, images),
    },
  );
}
export async function steer(
  projectId: ProjectId,
  threadId: ThreadId,
  promptText: string,
  images: readonly File[] = [],
  idempotencyKey = commandId(),
) {
  const metadata = { prompt: promptText, idempotencyKey };
  return await request(
    `/api/projects/${projectId}/threads/${threadId}/steer`,
    RunMutationResponseSchema,
    {
      method: "POST",
      body: images.length === 0 ? body(metadata) : chatForm(metadata, images),
    },
  );
}
export async function getChatImage(
  projectId: ProjectId,
  threadId: ThreadId,
  imageId: ChatImageId,
) {
  return await request(
    `/api/projects/${projectId}/threads/${threadId}/images/${imageId}`,
    ChatImageResponseSchema,
  );
}
export async function stop(projectId: ProjectId, threadId: ThreadId) {
  return await request(
    `/api/projects/${projectId}/threads/${threadId}/stop`,
    RunMutationResponseSchema,
    { method: "POST", body: body({ idempotencyKey: commandId() }) },
  );
}
export async function markViewed(
  projectId: ProjectId,
  threadId: ThreadId,
  runId: RunId,
) {
  return await request(
    `/api/projects/${projectId}/threads/${threadId}/runs/${runId}/viewed`,
    z.object({ viewed: z.literal(true) }),
    { method: "POST", body: body({ idempotencyKey: commandId() }) },
  );
}
export interface FileListingOptions {
  /** Bounded server-side substring search over the workspace-relative path. */
  search?: string;
  /** The directory to list, relative to the execution root; `""` is the root. */
  path?: string;
  /**
   * `"1"` fetches one level, which is what the tree asks for as the user
   * expands; `"full"` is the whole recursive listing, which only the flat
   * search mode wants (WSP-05 as revised by specification version 2).
   */
  depth?: "1" | "full";
  /** The explicit opt-in to seeing ignored paths. `.git` is never revealed. */
  showIgnored?: boolean;
}

export async function getFiles(
  projectId: ProjectId,
  threadId: ThreadId,
  options: FileListingOptions = {},
) {
  const query = new URLSearchParams({
    search: options.search ?? "",
    path: options.path ?? "",
    depth: options.depth ?? "full",
    showIgnored: options.showIgnored === true ? "true" : "false",
  });
  return await request(
    `/api/projects/${projectId}/threads/${threadId}/files?${query.toString()}`,
    FileTreeResponseSchema,
    {},
    { timeoutMs: PANEL_READ_TIMEOUT_MS },
  );
}
export async function getFile(
  projectId: ProjectId,
  threadId: ThreadId,
  path: string,
) {
  return await request(
    `/api/projects/${projectId}/threads/${threadId}/file?path=${encodeURIComponent(path)}`,
    FilePreviewResponseSchema,
    {},
    { timeoutMs: PANEL_READ_TIMEOUT_MS },
  );
}
export async function getStatus(projectId: ProjectId, threadId: ThreadId) {
  return await request(
    `/api/projects/${projectId}/threads/${threadId}/git/status`,
    GitStatusResponseSchema,
  );
}
export async function getDiff(
  projectId: ProjectId,
  threadId: ThreadId,
  path: string,
) {
  return await request(
    `/api/projects/${projectId}/threads/${threadId}/git/diff?path=${encodeURIComponent(path)}`,
    GitDiffResponseSchema,
  );
}

export function webSocketUrl(path: string): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}${path}`;
}
