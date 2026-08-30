import { access, constants, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import { spawn } from "node:child_process";

import type {
  AgentRuntime,
  OpenRuntimeSession,
  TitleSuggestion,
  PromptAcceptance,
  RuntimeEvent,
} from "@pi-web/agent-runtime";
import { TranscriptPager } from "@pi-web/agent-runtime";
import {
  ArchiveThreadResponseSchema,
  UnarchiveThreadResponseSchema,
  BrowseProjectResponseSchema,
  ChatImageResponseSchema,
  ProjectIdSchema,
  ProjectSchema,
  RunIdSchema,
  RunSchema,
  StartThreadResponseSchema,
  ThreadIdSchema,
  ThreadSnapshotSchema,
  TranscriptPageSchema,
  ThreadWorkspaceRequestSchema,
  ThreadSummarySchema,
  type ChatImageId,
  type ImageInputCapability,
  type Project,
  type ProjectId,
  type Run,
  type RuntimeKind,
  type ThreadId,
  type AgentBackendsResponse,
  type SessionDescriptor,
  type ThreadSnapshot,
  type ThreadSummary,
  type TranscriptCursor,
  type TranscriptPage,
  type WorktreeId,
} from "@pi-web/contracts";
import { z } from "zod";

import { RuntimeRegistry } from "./runtimes.js";
import {
  canonicalRequestHash,
  MetadataStore,
  ReceiptConflictError,
  type ProjectRecord,
  type RunRecord,
  type ThreadRecord,
} from "../db/store.js";
import { LiveBroker } from "../live/broker.js";
import type { ParsedChatInput } from "../chat-images.js";
import { GitWorktreeManager, worktreeSlug } from "../worktrees/manager.js";
import {
  ThreadExecutionContextResolver,
  type ThreadExecutionContext,
} from "./execution-context.js";

interface PendingPreflight {
  projectId: ProjectId;
  runtime: OpenRuntimeSession | undefined;
  stopRequested: boolean;
}

function canonicalInput(input: ParsedChatInput): {
  text: string;
  images: { mimeType: string; digest: string }[];
} {
  return {
    text: input.text,
    images: input.images.map(({ mimeType, digest }) => ({ mimeType, digest })),
  };
}

function runtimeInput(input: ParsedChatInput) {
  return {
    text: input.text,
    images: input.images.map((image) => ({
      mimeType: image.mimeType,
      data: new Uint8Array(image.data),
      digest: image.digest,
    })),
  };
}

async function inspectImageInput(
  runtime: AgentRuntime,
  projectRoot: string,
): Promise<ImageInputCapability> {
  try {
    return (await runtime.inspectImageInput?.(projectRoot)) ?? "unknown";
  } catch {
    return "unknown";
  }
}

async function gitAvailable(path: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const child = spawn("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: path,
      shell: false,
      stdio: ["ignore", "ignore", "ignore"],
    });
    const timeout = setTimeout(() => {
      child.kill();
      resolve(false);
    }, 2_000);
    child.once("error", () => {
      clearTimeout(timeout);
      resolve(false);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolve(code === 0);
    });
  });
}

async function parseProjectRoot(path: unknown): Promise<string | null> {
  if (typeof path !== "string" || !isAbsolute(path)) return null;
  try {
    const canonical = await realpath(path);
    const info = await stat(canonical);
    if (!info.isDirectory()) return null;
    await access(canonical, constants.R_OK | constants.X_OK);
    return canonical;
  } catch {
    return null;
  }
}

/**
 * Distinguishes "there is nothing at that path" from "there is something and
 * we could not look at it".
 *
 * The difference did not matter while a native folder picker was the only way
 * in -- an OS chooser does not hand back paths that do not exist -- but a
 * person typing a path mistypes it, and "unavailable or inaccessible" sends
 * them looking for a permissions problem they do not have.
 */
function missingPathError(cause: unknown): Error {
  const code =
    typeof cause === "object" && cause !== null && "code" in cause
      ? cause.code
      : undefined;
  const symptom =
    code === "ENOENT" || code === "ENOTDIR"
      ? "project_path_not_found"
      : code === "EACCES" || code === "EPERM"
        ? "project_not_readable"
        : "project_unavailable";
  return new Error(symptom, { cause });
}

function runDto(record: RunRecord): Run {
  return RunSchema.parse({
    id: record.id,
    threadId: record.thread_id,
    projectId: record.project_id,
    state: record.state,
    startedAt: record.started_at,
    endedAt: record.ended_at,
    failureCode: record.failure_code,
    failureMessage: record.failure_message,
  });
}

const browseReceiptSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("selected"), projectId: ProjectIdSchema }),
  z.object({ outcome: z.literal("cancelled") }),
]);
const removedReceiptSchema = z.object({ removed: z.literal(true) });
const viewedReceiptSchema = z.object({ viewed: z.literal(true) });

/**
 * How long a Stop is given to bring the agent to rest before the request
 * gives up on it.
 *
 * `OpenRuntimeSession.stop()` bottoms out in `AgentSession.abort()`, which is
 * `abortRetry(); agent.abort(); await waitForIdle()` -- and `waitForIdle()`
 * has no timeout of its own. An agent that never reaches idle therefore
 * wedges the HTTP request forever and leaves the run row `running` until a
 * restart reconciles it; that was observed twice on this build (iteration 3,
 * implementer H) before the queue-clearing fix removed the one trigger then
 * known. The hazard is general, so the deadline is here rather than at the
 * one trigger.
 *
 * Ten seconds because a Stop that works is not close to it -- every live Stop
 * measured in this loop returned in well under a second, including one taken
 * mid-`sleep 40` -- while a wedged one must not hold a connection open until
 * the browser gives up on its own and leaves the reader with nothing at all.
 */
const STOP_TIMEOUT_MS = 10_000;

/**
 * `work`, or `onTimeout()` thrown if it has not settled within `ms`.
 *
 * `Promise.race` has already attached handlers to `work`, so a rejection that
 * arrives after the deadline is handled and does not surface as an unhandled
 * rejection; the loser is abandoned, not cancelled.
 */
async function withDeadline<T>(
  work: Promise<T>,
  ms: number,
  onTimeout: () => Error,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(onTimeout());
    }, ms);
    timer.unref();
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const TITLE_LIMIT = 60;
// A prompt's first clause is rarely this short, and when it is, it is
// something like "Hi." or "Ok." rather than a title. Below this a sentence
// boundary is ignored and the truncator takes over.
const TITLE_SENTENCE_FLOOR = 12;
// Words that carry no meaning at the end of a truncated title. Dropping the
// last one turns "Create a file called LOCAL-CHECKOUT-PROOF.txt containing
// the…" into "…containing…", which says the same thing without the dangle.
const TITLE_TRAILING_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "but",
  "by",
  "for",
  "from",
  "in",
  "into",
  "of",
  "on",
  "or",
  "that",
  "the",
  "then",
  "to",
  "with",
]);

/**
 * The thread title used when the model-based namer is unavailable.
 *
 * This used to strip every character that is not a letter or a digit, which
 * is exactly the wrong class to remove from a developer's prompt: it turned
 * `LOCAL-CHECKOUT-PROOF.txt` into `LOCAL CHECKOUT PROOF` (no longer a
 * filename), and it silently deleted the `&&` from `sleep 40 && ls`, changing
 * the meaning of the command the title names. The sidebar title is the only
 * handle a thread has, so identifiers are the part worth keeping.
 *
 * Punctuation is now kept and the length is managed by truncation instead:
 *
 *  1. whitespace collapses to single spaces (a newline is a break, not a
 *     character to delete);
 *  2. if the first sentence or line ends inside the limit, that is the title
 *     -- `Run the shell command: sleep 40 && ls. Reply with…` becomes
 *     `Run the shell command: sleep 40 && ls`, a complete clause with its
 *     operator intact;
 *  3. otherwise it is cut at the last word boundary that fits, a dangling
 *     stopword or separator is dropped, and an ellipsis marks the cut.
 *
 * A `.` inside a filename is not a sentence end: a terminator only counts
 * when whitespace or the end of the prompt follows it, which is what keeps
 * `PROOF.txt` whole.
 *
 * Characters with no glyph are removed before any of that. The slug this
 * replaced deleted them as a side effect of deleting all punctuation; `\s`
 * does not, so without this step a prompt of nothing but a zero-width space
 * produced a one-character title that renders as an empty sidebar row, and a
 * NUL pasted out of a log file was persisted into one -- the same class of
 * value `12dfd65` had to fix in the file tree's row keys.
 */
export function fallbackTitle(prompt: string): string {
  const text = collapse(prompt);
  if (text === "") return "New coding task";
  // A line break is a break, not a character to delete: a prompt whose first
  // line is a summary followed by a list or a code block has already told us
  // where its title ends.
  const line = collapse(prompt.split(/[\r\n]/u, 1)[0] ?? "");
  const source = line.length >= TITLE_SENTENCE_FLOOR ? line : text;
  const sentence = firstSentence(source);
  const value =
    sentence ??
    (source.length <= TITLE_LIMIT
      ? trimTail(source)
      : truncateOnWord(source, TITLE_LIMIT));
  if (value === "") return "New coding task";
  return `${capitaliseFirst(value)}${value.slice(1)}`;
}

/**
 * Characters that occupy no space and draw nothing: C0/C1 controls, the
 * zero-width formatting marks, surrogates, private use and unassigned code
 * points. `\s` covers only the space-like ones (plus U+FEFF), so these
 * survive `collapse` and reach the title.
 *
 * ZWJ and ZWNJ are deliberately exempt. They are invisible themselves but
 * they change which glyphs their neighbours draw -- an emoji sequence, a
 * Persian word form -- so removing them corrupts text rather than cleaning
 * it. Everything else in `\p{C}` can only ever subtract from what the reader
 * can see.
 */
const INVISIBLE = /[^\P{C}\u200c\u200d]+/gu;

function collapse(text: string): string {
  return text.replace(INVISIBLE, "").replace(/\s+/gu, " ").trim();
}

/**
 * The first character upper-cased, unless upper-casing it makes it longer.
 *
 * `"ß".toUpperCase()` is `"SS"` and `"ﬁ".toUpperCase()` is `"FI"`, so the
 * naive form could return 61 characters from a 60-character budget and
 * `TITLE_LIMIT` was not actually a bound. It also rewrites the word: a title
 * is a label for what the user typed, not a place to expand their ligatures.
 */
function capitaliseFirst(value: string): string {
  const head = value[0] ?? "";
  const upper = head.toUpperCase();
  return upper.length === head.length ? upper : head;
}

/**
 * The first sentence, or null when there is none that makes a usable title.
 *
 * A terminator only counts when whitespace or the end of the string follows
 * it, which is what keeps `PROOF.txt` whole -- the `.` there is followed by a
 * letter, so it is part of an identifier and not the end of anything.
 *
 * The terminator itself is dropped, EXCEPT a question mark. A full stop adds
 * nothing to a label, but `Why does the build fail` and
 * `Why does the build fail?` are not the same sidebar entry: the first reads
 * as a statement of fact about the build, the second as the thing the user
 * asked. One `?` is restored however many the prompt piled up, so `What?!!`
 * titles as `What?` rather than shouting in the sidebar.
 */
function firstSentence(text: string): string | null {
  const match = /[.!?]+(?=\s|$)/u.exec(text);
  if (match === null) return null;
  const terminator = match[0].includes("?") ? "?" : "";
  const sentence = `${text.slice(0, match.index).trim()}${terminator}`;
  return sentence.length < TITLE_SENTENCE_FLOOR || sentence.length > TITLE_LIMIT
    ? null
    : sentence;
}

/** `text` cut to `limit` characters on a word boundary, ellipsis included. */
function truncateOnWord(text: string, limit: number): string {
  if (text.length <= limit) return trimTail(text);
  // One character of the budget belongs to the ellipsis.
  const window = text.slice(0, limit - 1);
  const lastSpace = window.lastIndexOf(" ");
  // A single word longer than the whole limit has no boundary to cut on, so
  // it is cut mid-word rather than thrown away.
  const head = lastSpace === -1 ? window : window.slice(0, lastSpace);
  const trimmed = dropTrailingStopword(trimTail(head));
  return trimmed === "" ? "New coding task" : `${trimmed}…`;
}

/** Drops trailing separators that would sit awkwardly before an ellipsis. */
function trimTail(text: string): string {
  return text.replace(/[\s,;:.!?-]+$/u, "");
}

function dropTrailingStopword(text: string): string {
  const space = text.lastIndexOf(" ");
  if (space === -1) return text;
  const last = text.slice(space + 1).toLowerCase();
  return TITLE_TRAILING_STOPWORDS.has(last) ? text.slice(0, space) : text;
}

export class WorkspaceService {
  private readonly runtimes = new Map<
    ThreadId,
    {
      runtime: OpenRuntimeSession;
      unsubscribe: () => void;
      unsubscribeUnavailable: () => void;
    }
  >();
  private readonly fallbackPagers = new Map<ThreadId, TranscriptPager>();
  /** Last readable page lets a temporarily unavailable external backend stay readable. */
  private readonly transcriptPages = new Map<ThreadId, TranscriptPage>();
  private readonly runtimeUnavailableReasons = new Map<ThreadId, string>();
  private readonly activeThreads = new Set<ThreadId>();
  private readonly activeWorktrees = new Set<WorktreeId>();
  private readonly preflightPrompts = new Map<ThreadId, PendingPreflight>();
  private readonly removingProjects = new Set<ProjectId>();
  private readonly inFlightCommands = new Map<
    string,
    { operation: string; requestHash: string; pending: Promise<unknown> }
  >();

  private readonly executionContexts: ThreadExecutionContextResolver;

  public constructor(
    public readonly store: MetadataStore,
    private readonly adapters: RuntimeRegistry,
    public readonly broker: LiveBroker,
    private readonly terminalCleanup: { terminate(projectId: string): void } = {
      terminate: () => undefined,
    },
    private readonly worktreeManager = new GitWorktreeManager(),
  ) {
    this.executionContexts = new ThreadExecutionContextResolver(store);
  }

  public async projectDto(record: ProjectRecord): Promise<Project> {
    const root = await parseProjectRoot(record.canonical_path);
    const isAvailable = root !== null;
    return ProjectSchema.parse({
      id: record.id,
      displayName: record.display_name,
      displayPath: basename(record.canonical_path),
      createdAt: record.created_at,
      sidebarExpanded: record.sidebar_expanded === 1,
      lastOpenedThreadId: record.last_opened_thread_id,
      available: isAvailable,
      gitAvailable: root !== null && (await gitAvailable(root)),
      unreadCount: this.store.unreadCount(record.id),
    });
  }

  public threadDto(record: ThreadRecord): ThreadSummary {
    const latest = this.store.latestRun(record.id);
    const worktree =
      record.worktree_id === null
        ? null
        : this.store.getWorktree(record.worktree_id);
    const backendStatus = this.adapters.status(record.runtime);
    const runtimeUnavailableReason =
      this.runtimeUnavailableReasons.get(record.id) ??
      (backendStatus.available
        ? undefined
        : (backendStatus.reason ??
          `${record.runtime} is not available on this machine.`));
    return ThreadSummarySchema.parse({
      id: record.id,
      projectId: record.project_id,
      title: record.title,
      createdAt: record.created_at,
      lastActivityAt: record.last_activity_at,
      runState: latest?.state ?? null,
      unread: this.store.isUnread(record),
      runtimeAvailable:
        (record.worktree_id === null || worktree?.state === "ready") &&
        runtimeUnavailableReason === undefined,
      ...(runtimeUnavailableReason === undefined
        ? {}
        : { runtimeUnavailableReason }),
      runtime: record.runtime,
      workspace:
        worktree === null
          ? { mode: "shared", branchName: null, available: true }
          : {
              mode: "worktree",
              worktreeId: worktree.id,
              branchName: worktree.branch_name,
              baseBranch: worktree.base_branch,
              baseCommit: worktree.base_commit,
              available: worktree.state === "ready",
            },
    });
  }

  public async list(): Promise<{
    projects: Project[];
    threads: ThreadSummary[];
    diagnostics: string[];
  }> {
    // Probe once per backend, not once per thread, before persisted thread
    // summaries are constructed. This makes the first response after restart
    // honest even when an external runtime disappeared while the server was down.
    await this.adapters.availability();
    const projectResults = this.store.listProjectResults();
    const threadResults = this.store.listThreadResults();
    const projectRecords = projectResults.flatMap((result) =>
      result.record === null ? [] : [result.record],
    );
    const threadRecords = threadResults.flatMap((result) =>
      result.record === null ? [] : [result.record],
    );
    return {
      projects: await Promise.all(
        projectRecords.map((project) => this.projectDto(project)),
      ),
      threads: threadRecords.map((thread) => this.threadDto(thread)),
      diagnostics: [
        ...[...projectResults, ...threadResults].flatMap((result) =>
          result.diagnostic === null ? [] : [result.diagnostic],
        ),
        ...this.store.listWorktreeDiagnostics(),
      ].slice(0, 100),
    };
  }

  public async workspacePreflight(
    projectId: ProjectId,
    runtime: RuntimeKind = this.adapters.defaultKind,
  ) {
    const projectRoot = await this.requireProjectRoot(projectId);
    const preflight = await this.worktreeManager.preflight(projectRoot);
    const imageInput = await inspectImageInput(
      this.adapters.get(runtime),
      projectRoot,
    );
    return { ...preflight, imageInput };
  }

  public async startThread(
    projectId: ProjectId,
    input: ParsedChatInput,
    workspace: z.infer<typeof ThreadWorkspaceRequestSchema>,
    idempotencyKey: string,
    runtime: RuntimeKind = this.adapters.defaultKind,
  ) {
    const prompt = input.text;
    const operation = "start-thread";
    const hash = canonicalRequestHash(
      operation,
      input.images.length === 0
        ? { projectId, prompt, workspace, runtime }
        : {
            projectId,
            input: canonicalInput(input),
            workspace,
            runtime,
          },
    );
    return await this.serialized(
      projectId,
      idempotencyKey,
      operation,
      hash,
      StartThreadResponseSchema,
      async () => {
        const projectRoot = await this.requireProjectRoot(projectId);
        if (input.images.length > 0) {
          const capability = await inspectImageInput(
            this.adapters.get(runtime),
            projectRoot,
          );
          if (capability === "unsupported")
            throw new Error("chat_image_input_unsupported");
        }
        const existingCreation = this.store.getThreadCreation(
          projectId,
          idempotencyKey,
        );
        // Do this before recording or provisioning a new creation. A registered
        // external adapter may be installed but presently unable to start.
        // Existing operations retain their normal idempotent recovery path.
        if (existingCreation === null) await this.adapters.usable(runtime);
        if (existingCreation === null && workspace.mode === "worktree")
          await this.worktreeManager.authorizeBaseBranch(
            projectRoot,
            workspace.baseBranch,
          );
        let creation = this.store.beginThreadCreation({
          projectId,
          idempotencyKey,
          requestHash: hash,
          runtime,
          workspaceMode: workspace.mode,
          baseBranch:
            workspace.mode === "worktree" ? workspace.baseBranch : null,
          sourceChanges:
            workspace.mode === "worktree" ? workspace.sourceChanges : null,
        });
        const recoverFailedWorktree =
          creation.state === "failed" &&
          creation.workspace_mode === "worktree" &&
          creation.worktree_id !== null &&
          creation.runtime_session_id === null &&
          creation.thread_id === null &&
          creation.run_id === null;
        if (creation.state === "failed" && !recoverFailedWorktree)
          throw new Error(creation.failure_code ?? "thread_creation_failed");
        if (creation.title === null || creation.slug === null) {
          let suggested: TitleSuggestion = { outcome: "unavailable" };
          try {
            if (prompt !== "")
              suggested =
                (await this.adapters
                  .get(creation.runtime)
                  .suggestTitle?.(projectRoot, prompt)) ?? suggested;
          } catch {
            // Naming is optional; use the deterministic product fallback.
          }
          const title =
            suggested.outcome === "available"
              ? suggested.title
              : prompt === ""
                ? "Image request"
                : fallbackTitle(prompt);
          creation = this.store.nameThreadCreation(
            projectId,
            idempotencyKey,
            title,
            worktreeSlug(title),
          );
        }
        let executionRoot = projectRoot;
        let worktreeId: WorktreeId | null = creation.worktree_id;
        if (workspace.mode === "worktree") {
          let worktree =
            worktreeId === null ? null : this.store.getWorktree(worktreeId);
          if (worktree?.state !== "ready") {
            const plan =
              worktree === null
                ? await this.worktreeManager.plan({
                    projectRoot,
                    stateDirectory: this.store.stateDirectory,
                    projectId,
                    worktreeId: creation.id,
                    title: creation.title ?? fallbackTitle(prompt),
                    baseBranch: workspace.baseBranch,
                    ...(workspace.sourceStateToken === undefined
                      ? {}
                      : { expectedToken: workspace.sourceStateToken }),
                    includeChanges:
                      workspace.sourceChanges === "tracked_and_untracked",
                  })
                : await this.worktreeManager.recoveryPlan({
                    projectRoot,
                    stateDirectory: this.store.stateDirectory,
                    projectId,
                    worktreeId: creation.id,
                    title: creation.title ?? fallbackTitle(prompt),
                    record: worktree,
                    ...(workspace.sourceStateToken === undefined
                      ? {}
                      : { expectedToken: workspace.sourceStateToken }),
                    includeChanges:
                      creation.source_changes === "tracked_and_untracked",
                  });
            if (worktree === null) {
              const reserved = this.store.reserveCreationWorktree({
                projectId,
                idempotencyKey,
                executionRoot: plan.executionRoot,
                worktreeRoot: plan.worktreeRoot,
                gitCommonDir: plan.gitCommonDir,
                projectSubpath: plan.projectSubpath,
                baseBranch: plan.baseBranch,
                baseCommit: plan.baseCommit,
                branchName: plan.branchName,
                transferToken:
                  workspace.sourceChanges === "tracked_and_untracked"
                    ? plan.sourceToken
                    : null,
              });
              worktree = reserved.worktree;
              worktreeId = worktree.id;
              creation = reserved.creation;
            } else if (
              worktree.execution_root !== plan.executionRoot ||
              worktree.worktree_root !== plan.worktreeRoot ||
              worktree.git_common_dir !== plan.gitCommonDir ||
              worktree.base_commit !== plan.baseCommit ||
              worktree.branch_name !== plan.branchName
            ) {
              throw new Error("worktree_identity_failed");
            }
            if (recoverFailedWorktree) {
              const resumed = this.store.resumeFailedCreationWorktree(
                projectId,
                idempotencyKey,
              );
              creation = resumed.creation;
              worktree = resumed.worktree;
            }
            if (worktree.state === "provisioning") {
              try {
                await this.worktreeManager.provision(
                  plan,
                  workspace.sourceChanges === "tracked_and_untracked",
                );
                worktree = this.store.setWorktreeState(worktree.id, "ready");
              } catch (error) {
                this.store.setWorktreeState(
                  worktree.id,
                  "failed",
                  error instanceof Error ? error.message : "worktree_failed",
                  "The worktree could not be prepared.",
                );
                this.store.failThreadCreation(
                  projectId,
                  idempotencyKey,
                  error instanceof Error ? error.message : "worktree_failed",
                  "The worktree could not be prepared.",
                );
                throw error;
              }
            }
          }
          if (worktree.state !== "ready")
            throw new Error("worktree_unavailable");
          executionRoot = worktree.execution_root;
        }
        if (creation.runtime_session_id === null) {
          creation = this.store.reserveCreationSession(
            projectId,
            idempotencyKey,
          );
          const session = await this.adapters
            .get(creation.runtime)
            .create(
              executionRoot,
              creation.title ?? fallbackTitle(prompt),
              creation.session_creation_id ?? undefined,
            );
          creation = this.store.attachCreationSession(
            projectId,
            idempotencyKey,
            session.sessionId,
          );
        }
        let thread =
          creation.thread_id === null
            ? null
            : this.store.getThread(projectId, creation.thread_id);
        thread ??= this.store.createThreadForCreation(
          projectId,
          idempotencyKey,
          creation.runtime_session_id ?? "",
          creation.title ?? fallbackTitle(prompt),
          worktreeId,
        );
        creation = this.store.reserveCreationPromptDispatch(
          projectId,
          idempotencyKey,
        );
        let run =
          creation.run_id === null ? null : this.store.getRun(creation.run_id);
        if (run?.id !== creation.run_id) {
          const dispatch = {
            id:
              creation.initial_prompt_dispatch_id ?? creation.prompt_command_id,
          };
          const runtime = await this.openRuntime(thread);
          const recovered = await runtime.recoverPrompt(
            runtimeInput(input),
            dispatch,
          );
          if (recovered.outcome === "accepted") {
            const receipt = this.store.readReceipt(
              projectId,
              creation.prompt_command_id,
              "prompt",
              canonicalRequestHash(
                "prompt",
                input.images.length === 0
                  ? { projectId, threadId: thread.id, text: input.text }
                  : {
                      projectId,
                      threadId: thread.id,
                      input: canonicalInput(input),
                    },
              ),
              RunSchema,
            );
            if (receipt !== null) {
              this.store.attachCreationRun(
                projectId,
                idempotencyKey,
                receipt.id,
              );
              run = this.store.getRun(receipt.id);
            } else {
              run = this.store.acceptRecoveredCreationPrompt(
                projectId,
                idempotencyKey,
                thread.id,
              );
            }
          } else {
            const started = await this.prompt(
              projectId,
              thread.id,
              input,
              creation.prompt_command_id,
              dispatch,
            );
            this.store.attachCreationRun(projectId, idempotencyKey, started.id);
            run = this.store.getRun(started.id);
          }
        }
        if (run === null) throw new Error("run_not_found");
        await this.adapters.refresh(thread.runtime);
        return StartThreadResponseSchema.parse({
          thread: this.threadDto(this.requireThread(projectId, thread.id)),
          run: runDto(run),
        });
      },
    );
  }

  private async serialized<T>(
    scope: string,
    key: string,
    operation: string,
    requestHash: string,
    parser: z.ZodType<T>,
    action: () => Promise<T>,
  ): Promise<T> {
    const lock = `${scope}:${key}`;
    const current = this.inFlightCommands.get(lock);
    if (current !== undefined) {
      if (
        current.operation === operation &&
        current.requestHash === requestHash
      )
        return parser.parse(await current.pending);
      try {
        await current.pending;
      } catch {
        // A failed command leaves no receipt to conflict with; run the normal
        // receipt check before this distinct command performs any work.
      }
      return await action();
    }
    const pending = action();
    const entry = { operation, requestHash, pending };
    this.inFlightCommands.set(lock, entry);
    try {
      return parser.parse(await pending);
    } finally {
      if (this.inFlightCommands.get(lock) === entry)
        this.inFlightCommands.delete(lock);
    }
  }

  /**
   * The single gate every project path passes through, whether the OS folder
   * picker chose it or a person typed it. It is deliberately ONE function:
   * the typed route is a second door into the same room, not a second room
   * with its own weaker lock.
   *
   * The failures used to collapse into one `project_unavailable`, which was
   * tolerable when the only caller was a picker (the OS does not hand back
   * paths that do not exist) and is not tolerable now that a person can
   * mistype. A typo and a permissions problem are different problems with
   * different next steps, so they get different codes.
   */
  private async canonicalProject(path: string): Promise<string> {
    // A NUL byte truncates a path in every C API beneath this one, so the
    // string would not mean what it appears to mean. Refused, not trimmed.
    if (path.includes("\u0000")) throw new Error("project_path_invalid");
    // Relative paths are refused rather than resolved: they would resolve
    // against the SERVER's working directory, which is not a place the person
    // typing has any reason to be thinking about, and the project they got
    // would not be the one they meant.
    if (!isAbsolute(path)) throw new Error("project_path_relative");
    let canonical: string;
    try {
      canonical = await realpath(path);
    } catch (cause) {
      throw missingPathError(cause);
    }
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(canonical);
    } catch (cause) {
      throw missingPathError(cause);
    }
    if (!info.isDirectory()) throw new Error("project_not_directory");
    try {
      await access(canonical, constants.R_OK | constants.X_OK);
    } catch {
      throw new Error("project_not_readable");
    }
    return canonical;
  }

  /**
   * Registers a project from a path supplied by the person using the app,
   * rather than by the native folder picker.
   *
   * Same shape as {@link browseProject}: serialized on the `"process"` lane,
   * replayed from a receipt when the same idempotency key comes back, and
   * validated by the same {@link canonicalProject}. The request hash carries
   * the path, so re-sending the same key with a DIFFERENT path is a conflict
   * rather than a silent no-op that returns the first project.
   */
  public async addProjectByPath(
    path: string,
    idempotencyKey: string,
  ): Promise<Project> {
    const operation = "add-project-path";
    const hash = canonicalRequestHash(operation, { path });
    return await this.serialized(
      "process",
      idempotencyKey,
      operation,
      hash,
      ProjectSchema,
      async () => {
        const prior = this.store.readReceipt(
          "process",
          idempotencyKey,
          operation,
          hash,
          ProjectIdSchema,
        );
        if (prior !== null)
          return await this.projectDto(this.requireProject(prior));
        const canonical = await this.canonicalProject(path);
        const receipt = this.store.withReceipt(
          "process",
          idempotencyKey,
          operation,
          hash,
          ProjectIdSchema,
          () => this.store.registerProject(canonical).id,
        );
        return await this.projectDto(this.requireProject(receipt.response));
      },
    );
  }

  public async registerSelectedProject(path: string): Promise<Project> {
    const canonical = await this.canonicalProject(path);
    return await this.projectDto(this.store.registerProject(canonical));
  }

  public async browseProject(
    idempotencyKey: string,
    chooseDirectory: () => Promise<string | null>,
  ): Promise<z.infer<typeof BrowseProjectResponseSchema>> {
    const operation = "browse-project";
    const hash = canonicalRequestHash(operation, {});
    return await this.serialized<z.infer<typeof BrowseProjectResponseSchema>>(
      "process",
      idempotencyKey,
      operation,
      hash,
      BrowseProjectResponseSchema,
      async () => {
        const prior = this.store.readReceipt(
          "process",
          idempotencyKey,
          operation,
          hash,
          browseReceiptSchema,
        );
        if (prior !== null)
          return prior.outcome === "cancelled"
            ? { outcome: "cancelled" as const }
            : {
                outcome: "selected" as const,
                project: await this.projectDto(
                  this.requireProject(prior.projectId),
                ),
              };
        const selected = await chooseDirectory();
        if (selected === null) {
          this.store.withReceipt(
            "process",
            idempotencyKey,
            operation,
            hash,
            browseReceiptSchema,
            () => ({ outcome: "cancelled" as const }),
          );
          return { outcome: "cancelled" as const };
        }
        const canonical = await this.canonicalProject(selected);
        const receipt = this.store.withReceipt(
          "process",
          idempotencyKey,
          operation,
          hash,
          browseReceiptSchema,
          () => ({
            outcome: "selected" as const,
            projectId: this.store.registerProject(canonical).id,
          }),
        );
        if (receipt.response.outcome === "cancelled")
          return { outcome: "cancelled" as const };
        return {
          outcome: "selected" as const,
          project: await this.projectDto(
            this.requireProject(receipt.response.projectId),
          ),
        };
      },
    );
  }

  public async setProjectExpanded(
    projectId: ProjectId,
    expanded: boolean,
    idempotencyKey: string,
  ): Promise<Project> {
    const operation = "update-project";
    const hash = canonicalRequestHash(operation, { projectId, expanded });
    return await this.serialized(
      projectId,
      idempotencyKey,
      operation,
      hash,
      ProjectSchema,
      async () => {
        const prior = this.store.readReceipt(
          projectId,
          idempotencyKey,
          operation,
          hash,
          ProjectIdSchema,
        );
        if (prior !== null)
          return await this.projectDto(this.requireProject(prior));
        const receipt = this.store.withReceipt(
          projectId,
          idempotencyKey,
          operation,
          hash,
          ProjectIdSchema,
          () => {
            this.requireProject(projectId);
            this.store.setProjectExpanded(projectId, expanded);
            return projectId;
          },
        );
        return await this.projectDto(this.requireProject(receipt.response));
      },
    );
  }

  public async removeProject(
    projectId: ProjectId,
    idempotencyKey: string,
  ): Promise<void> {
    const operation = "remove-project";
    const hash = canonicalRequestHash(operation, { projectId });
    await this.serialized(
      projectId,
      idempotencyKey,
      operation,
      hash,
      removedReceiptSchema,
      async () => {
        const prior = this.store.readReceipt(
          projectId,
          idempotencyKey,
          operation,
          hash,
          removedReceiptSchema,
        );
        if (prior !== null) return { removed: true as const };
        const project = this.requireProject(projectId);
        this.removingProjects.add(project.id);
        try {
          for (const [threadId, preflight] of this.preflightPrompts) {
            if (preflight.projectId !== project.id) continue;
            this.requestPreflightStop(preflight);
            if (this.preflightPrompts.get(threadId) === preflight)
              this.preflightPrompts.delete(threadId);
            this.activeThreads.delete(threadId);
            const thread = this.store.getThread(project.id, threadId);
            if (
              thread?.worktree_id !== null &&
              thread?.worktree_id !== undefined
            )
              this.activeWorktrees.delete(thread.worktree_id);
          }
          this.interruptRunsForProjectRemoval(project.id);
          for (const thread of this.store.listThreads(project.id))
            await this.disposeThread(thread.id);
          this.store.withReceipt(
            projectId,
            idempotencyKey,
            operation,
            hash,
            removedReceiptSchema,
            () => {
              this.store.removeProject(projectId);
              return { removed: true as const };
            },
          );
          this.terminalCleanup.terminate(projectId);
          return { removed: true as const };
        } finally {
          this.removingProjects.delete(project.id);
        }
      },
    );
  }

  private interruptRunsForProjectRemoval(projectId: ProjectId): void {
    for (const run of this.store.runningRunsForProject(projectId)) {
      const owner = this.runtimes.get(run.thread_id);
      if (owner !== undefined) {
        try {
          void owner.runtime.stop().catch(() => undefined);
        } catch {
          // Removing a project must release its persisted run lease even if the
          // in-memory runtime can no longer be interrupted.
        }
      }
      if (this.store.runningRunForThread(run.thread_id)?.id !== run.id)
        continue;
      const settled = runDto(
        this.store.settleRun(
          run.id,
          "interrupted",
          "project_removed",
          "Interrupted because the project was removed.",
        ),
      );
      this.activeThreads.delete(run.thread_id);
      if (run.worktree_id !== null)
        this.activeWorktrees.delete(run.worktree_id);
      this.broker.publish(run.thread_id, "completion", settled);
    }
  }

  private requestPreflightStop(preflight: PendingPreflight): void {
    if (preflight.stopRequested || preflight.runtime === undefined) return;
    preflight.stopRequested = true;
    try {
      void preflight.runtime.stop().catch(() => undefined);
    } catch {
      // A removed project must release its preflight lease even if the native
      // runtime cannot be interrupted.
    }
  }

  public async preflightContinuation(
    projectId: ProjectId,
    sourceThreadId: ThreadId,
  ): Promise<{ available: true; imageInput: ImageInputCapability }> {
    const source = this.requireThread(projectId, sourceThreadId);
    const context = await this.executionContexts.resolve(source);
    if (context.worktree === null) throw new Error("worktree_required");
    if (
      this.activeWorktrees.has(context.worktree.id) ||
      this.store.runningRunForWorktree(context.worktree.id) !== null
    )
      throw new Error("workspace_busy");
    return {
      available: true as const,
      imageInput: await inspectImageInput(
        this.adapters.get(source.runtime),
        context.executionRoot,
      ),
    };
  }

  public async continueThread(
    projectId: ProjectId,
    sourceThreadId: ThreadId,
    input: ParsedChatInput,
    idempotencyKey: string,
  ) {
    const text = input.text;
    const operationName = "continue-thread";
    const hash = canonicalRequestHash(
      operationName,
      input.images.length === 0
        ? { projectId, sourceThreadId, text }
        : { projectId, sourceThreadId, input: canonicalInput(input) },
    );
    return await this.serialized(
      projectId,
      idempotencyKey,
      operationName,
      hash,
      StartThreadResponseSchema,
      async () => {
        let operation = this.store.getContinuation(projectId, idempotencyKey);
        if (operation !== null && operation.request_hash !== hash)
          throw new ReceiptConflictError();
        if (operation?.run_id !== null && operation?.run_id !== undefined) {
          const thread = this.requireThread(
            projectId,
            operation.thread_id ?? "",
          );
          const run = this.store.getRun(operation.run_id);
          if (run?.project_id !== projectId || run.thread_id !== thread.id)
            throw new Error("continuation_run_mismatch");
          return StartThreadResponseSchema.parse({
            thread: this.threadDto(thread),
            run: runDto(run),
          });
        }
        if (
          operation?.thread_id !== null &&
          operation?.thread_id !== undefined &&
          operation.prompt_command_id !== null
        ) {
          const promptHash = canonicalRequestHash(
            "prompt",
            input.images.length === 0
              ? { projectId, threadId: operation.thread_id, text }
              : {
                  projectId,
                  threadId: operation.thread_id,
                  input: canonicalInput(input),
                },
          );
          const receipt = this.store.readReceipt(
            projectId,
            operation.prompt_command_id,
            "prompt",
            promptHash,
            RunSchema,
          );
          if (receipt !== null) {
            if (receipt.threadId !== operation.thread_id)
              throw new Error("continuation_run_mismatch");
            operation = this.store.attachContinuationRun(
              projectId,
              idempotencyKey,
              receipt.id,
            );
            return StartThreadResponseSchema.parse({
              thread: this.threadDto(
                this.requireThread(projectId, operation.thread_id ?? ""),
              ),
              run: receipt,
            });
          }
        }
        const source = this.requireThread(projectId, sourceThreadId);
        const context = await this.executionContexts.resolve(source);
        if (context.worktree === null) throw new Error("worktree_required");
        const adapter = await this.adapters.usable(source.runtime);
        if (
          input.images.length > 0 &&
          (await inspectImageInput(adapter, context.executionRoot)) ===
            "unsupported"
        )
          throw new Error("chat_image_input_unsupported");
        const worktreeId = context.worktree.id;
        if (
          this.activeWorktrees.has(worktreeId) ||
          this.store.runningRunForWorktree(worktreeId) !== null
        )
          throw new Error("workspace_busy");
        this.activeWorktrees.add(worktreeId);
        let leaseTransferred = false;
        try {
          operation = this.store.reserveContinuation({
            projectId,
            sourceThreadId,
            worktreeId,
            idempotencyKey,
            requestHash: hash,
          });
          if (operation.title === null) {
            let suggested: TitleSuggestion = { outcome: "unavailable" };
            try {
              suggested =
                (await adapter.suggestTitle?.(context.executionRoot, text)) ??
                suggested;
            } catch {
              // Naming is optional; use the deterministic product fallback.
            }
            operation = this.store.nameContinuation(
              projectId,
              idempotencyKey,
              suggested.outcome === "available"
                ? suggested.title
                : fallbackTitle(text),
            );
          }
          if (operation.runtime_session_id === null) {
            const created = await adapter.create(
              context.executionRoot,
              operation.title ?? fallbackTitle(text),
              operation.id,
            );
            operation = this.store.attachContinuationSession(
              projectId,
              idempotencyKey,
              created.sessionId,
            );
          }
          const thread = this.store.finishContinuation(
            projectId,
            idempotencyKey,
          );
          operation = this.store.getContinuation(projectId, idempotencyKey);
          if (
            operation?.prompt_command_id === null ||
            operation?.prompt_command_id === undefined ||
            operation.initial_prompt_dispatch_id === null
          )
            throw new Error("continuation_prompt_missing");
          const dispatch = { id: operation.initial_prompt_dispatch_id };
          const recovered = await (
            await this.openRuntime(thread)
          ).recoverPrompt(runtimeInput(input), dispatch);
          const run =
            recovered.outcome === "accepted"
              ? this.store.acceptRecoveredContinuationPrompt(
                  projectId,
                  idempotencyKey,
                  thread.id,
                )
              : await this.prompt(
                  projectId,
                  thread.id,
                  input,
                  operation.prompt_command_id,
                  dispatch,
                  worktreeId,
                );
          leaseTransferred = recovered.outcome !== "accepted";
          this.store.attachContinuationRun(projectId, idempotencyKey, run.id);
          return StartThreadResponseSchema.parse({
            thread: this.threadDto(this.requireThread(projectId, thread.id)),
            run,
          });
        } finally {
          if (!leaseTransferred) this.activeWorktrees.delete(worktreeId);
        }
      },
    );
  }

  public async createThread(
    projectId: ProjectId,
    title?: string,
    idempotencyKey?: string,
    runtime: RuntimeKind = this.adapters.defaultKind,
  ): Promise<ThreadSummary> {
    if (idempotencyKey === undefined)
      return await this.createThreadUnprotected(projectId, title, runtime);
    const operation = "create-thread";
    const hash = canonicalRequestHash(operation, {
      projectId,
      title,
      runtime,
    });
    return await this.serialized(
      projectId,
      idempotencyKey,
      operation,
      hash,
      ThreadSummarySchema,
      async () => {
        const prior = this.store.readReceipt(
          projectId,
          idempotencyKey,
          operation,
          hash,
          ThreadIdSchema,
        );
        if (prior !== null) {
          await this.adapters.refresh(runtime);
          return this.threadDto(this.requireThread(projectId, prior));
        }
        const created = await (
          await this.adapters.usable(runtime)
        ).create(await this.requireProjectRoot(projectId));
        const receipt = this.store.withReceipt(
          projectId,
          idempotencyKey,
          operation,
          hash,
          ThreadIdSchema,
          () =>
            this.store.createThread(
              projectId,
              runtime,
              created.sessionId,
              title,
            ).id,
        );
        return this.threadDto(this.requireThread(projectId, receipt.response));
      },
    );
  }

  private async createThreadUnprotected(
    projectId: ProjectId,
    title?: string,
    runtime: RuntimeKind = this.adapters.defaultKind,
  ): Promise<ThreadSummary> {
    const created = await (
      await this.adapters.usable(runtime)
    ).create(await this.requireProjectRoot(projectId));
    return this.threadDto(
      this.store.createThread(projectId, runtime, created.sessionId, title),
    );
  }

  public async importThread(
    projectId: ProjectId,
    sessionId: string,
    title?: string,
    idempotencyKey?: string,
    runtime: RuntimeKind = this.adapters.defaultKind,
  ): Promise<ThreadSummary> {
    if (idempotencyKey !== undefined) {
      const operation = "import-thread";
      const hash = canonicalRequestHash(operation, {
        projectId,
        sessionId,
        title,
        runtime,
      });
      return await this.serialized(
        projectId,
        idempotencyKey,
        operation,
        hash,
        ThreadSummarySchema,
        async () => {
          const prior = this.store.readReceipt(
            projectId,
            idempotencyKey,
            operation,
            hash,
            ThreadIdSchema,
          );
          if (prior !== null) {
            await this.adapters.refresh(runtime);
            return this.threadDto(this.requireThread(projectId, prior));
          }
          const sessions = await (
            await this.adapters.usable(runtime)
          ).discover(await this.requireProjectRoot(projectId));
          const descriptor = sessions.sessions.find(
            (session) => session.id === sessionId,
          );
          if (descriptor === undefined) throw new Error("session_not_found");
          const receipt = this.store.withReceipt(
            projectId,
            idempotencyKey,
            operation,
            hash,
            ThreadIdSchema,
            () =>
              this.store.createThread(
                projectId,
                runtime,
                descriptor.id,
                title ??
                  descriptor.name ??
                  (descriptor.preview.slice(0, 80) || "Imported thread"),
              ).id,
          );
          return this.threadDto(
            this.requireThread(projectId, receipt.response),
          );
        },
      );
    }
    const sessions = await (
      await this.adapters.usable(runtime)
    ).discover(await this.requireProjectRoot(projectId));
    const descriptor = sessions.sessions.find(
      (session) => session.id === sessionId,
    );
    if (descriptor === undefined) throw new Error("session_not_found");
    return this.threadDto(
      this.store.createThread(
        projectId,
        runtime,
        descriptor.id,
        title ??
          descriptor.name ??
          (descriptor.preview.slice(0, 80) || "Imported thread"),
      ),
    );
  }

  public async agentBackends(): Promise<AgentBackendsResponse> {
    return {
      defaultRuntime: this.adapters.defaultKind,
      backends: await this.adapters.availability(),
    };
  }

  public async discoverSessions(projectId: ProjectId) {
    const projectRoot = await this.requireProjectRoot(projectId);
    // A session identifier is only unique within its backend, so "already
    // imported" is keyed by both (AGB-01, AGB-09).
    const imported = new Set(
      this.store
        .listThreads(projectId, { includeArchived: true })
        .map((thread) => `${thread.runtime}:${thread.runtime_session_id}`),
    );
    const sessions: (SessionDescriptor & {
      runtime: RuntimeKind;
      imported: boolean;
    })[] = [];
    const diagnostics: string[] = [];
    // Every installed backend is listed, each labelled with the one that owns
    // it. One backend being unusable must not hide the others.
    for (const kind of this.adapters.kinds()) {
      try {
        const result = await this.adapters.get(kind).discover(projectRoot);
        for (const session of result.sessions)
          sessions.push({
            ...session,
            runtime: kind,
            imported: imported.has(`${kind}:${session.id}`),
          });
        diagnostics.push(...result.diagnostics);
      } catch (error) {
        diagnostics.push(
          `${kind === "codex" ? "Codex" : "Pi"} sessions could not be listed: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        );
      }
    }
    return { sessions, diagnostics };
  }

  public async archiveThread(
    projectId: ProjectId,
    threadId: ThreadId,
    idempotencyKey: string,
  ): Promise<z.infer<typeof ArchiveThreadResponseSchema>> {
    const operation = "archive-thread";
    const hash = canonicalRequestHash(operation, { projectId, threadId });
    return await this.serialized(
      projectId,
      idempotencyKey,
      operation,
      hash,
      ArchiveThreadResponseSchema,
      () =>
        Promise.resolve().then(() => {
          const prior = this.store.readReceipt(
            projectId,
            idempotencyKey,
            operation,
            hash,
            ArchiveThreadResponseSchema,
          );
          if (prior !== null) return prior;
          const thread = this.store.getThread(projectId, threadId, {
            includeArchived: true,
          });
          if (thread === null) throw new Error("thread_not_found");
          const alreadyArchived = thread.archived_at !== null;
          if (
            !alreadyArchived &&
            (this.activeThreads.has(threadId) ||
              this.preflightPrompts.has(threadId) ||
              this.store.runningRunForThread(threadId) !== null)
          )
            throw new Error("thread_busy");
          const receipt = this.store.withReceipt(
            projectId,
            idempotencyKey,
            operation,
            hash,
            ArchiveThreadResponseSchema,
            () => {
              if (
                !alreadyArchived &&
                !this.store.archiveThread(projectId, threadId)
              )
                throw new Error("thread_busy");
              return { archived: true as const };
            },
          );
          if (!alreadyArchived && !receipt.replayed) {
            void this.disposeThread(threadId).catch(() => {
              // Durable archival succeeded and runtime ownership was released;
              // cleanup failure must not turn the accepted command into an error.
            });
          }
          return receipt.response;
        }),
    );
  }

  // Archived threads are hidden from every other listing, so restoring one
  // needs its own read path. Ordered like the sidebar's live list.
  public async listArchivedThreads(
    projectId: ProjectId,
  ): Promise<ThreadSummary[]> {
    this.requireProject(projectId);
    const archived = this.store
      .listThreadResults(projectId, { includeArchived: true })
      .flatMap((result) =>
        result.record?.archived_at == null ? [] : [result.record],
      );
    await Promise.all(
      [...new Set(archived.map((thread) => thread.runtime))].map(
        async (runtime) => await this.adapters.refresh(runtime),
      ),
    );
    return archived.map((thread) => this.threadDto(thread));
  }

  // The inverse of archiveThread, and the reason archive is no longer a
  // one-way door. Idempotent through the same receipt machinery: replaying
  // the same command, or restoring a thread that is already live, both
  // succeed without a second write.
  public async unarchiveThread(
    projectId: ProjectId,
    threadId: ThreadId,
    idempotencyKey: string,
  ): Promise<z.infer<typeof UnarchiveThreadResponseSchema>> {
    const operation = "unarchive-thread";
    const hash = canonicalRequestHash(operation, { projectId, threadId });
    return await this.serialized(
      projectId,
      idempotencyKey,
      operation,
      hash,
      UnarchiveThreadResponseSchema,
      () =>
        Promise.resolve().then(() => {
          const prior = this.store.readReceipt(
            projectId,
            idempotencyKey,
            operation,
            hash,
            UnarchiveThreadResponseSchema,
          );
          if (prior !== null) return prior;
          const thread = this.store.getThread(projectId, threadId, {
            includeArchived: true,
          });
          if (thread === null) throw new Error("thread_not_found");
          const receipt = this.store.withReceipt(
            projectId,
            idempotencyKey,
            operation,
            hash,
            UnarchiveThreadResponseSchema,
            () => {
              if (
                thread.archived_at !== null &&
                !this.store.unarchiveThread(projectId, threadId)
              )
                throw new Error("thread_not_found");
              return { archived: false as const };
            },
          );
          return receipt.response;
        }),
    );
  }

  public renameThread(
    projectId: ProjectId,
    threadId: ThreadId,
    title: string,
    idempotencyKey?: string,
  ): ThreadSummary {
    if (idempotencyKey !== undefined) {
      const operation = "rename-thread";
      const hash = canonicalRequestHash(operation, {
        projectId,
        threadId,
        title,
      });
      const prior = this.store.readReceipt(
        projectId,
        idempotencyKey,
        operation,
        hash,
        ThreadIdSchema,
      );
      if (prior !== null)
        return this.threadDto(this.requireThread(projectId, prior));
      const receipt = this.store.withReceipt(
        projectId,
        idempotencyKey,
        operation,
        hash,
        ThreadIdSchema,
        () => {
          this.requireThread(projectId, threadId);
          return this.store.renameThread(projectId, threadId, title).id;
        },
      );
      return this.threadDto(this.requireThread(projectId, receipt.response));
    }
    this.requireThread(projectId, threadId);
    return this.threadDto(this.store.renameThread(projectId, threadId, title));
  }

  private async openRuntime(thread: ThreadRecord): Promise<OpenRuntimeSession> {
    const current = this.runtimes.get(thread.id);
    if (current !== undefined) return current.runtime;
    const context = await this.executionContexts.resolve(thread);
    let runtime: OpenRuntimeSession;
    try {
      runtime = await (
        await this.adapters.usable(thread.runtime)
      ).open(context.executionRoot, thread.runtime_session_id);
    } catch (error) {
      this.runtimeUnavailableReasons.set(
        thread.id,
        error instanceof Error
          ? error.message
          : "The native agent session is unavailable or malformed.",
      );
      throw error;
    }
    this.runtimeUnavailableReasons.delete(thread.id);
    const unsubscribe = runtime.subscribe((event) => {
      this.onRuntimeEvent(thread, event);
    });
    const owner: {
      runtime: OpenRuntimeSession;
      unsubscribe: () => void;
      unsubscribeUnavailable: () => void;
    } = {
      runtime,
      unsubscribe,
      unsubscribeUnavailable: () => undefined,
    };
    owner.unsubscribeUnavailable =
      runtime.onUnavailable?.(() => {
        this.invalidateRuntime(thread.id, owner);
      }) ?? (() => undefined);
    this.runtimes.set(thread.id, owner);
    return runtime;
  }

  private invalidateRuntime(
    threadId: ThreadId,
    owner: {
      runtime: OpenRuntimeSession;
      unsubscribe: () => void;
      unsubscribeUnavailable: () => void;
    },
  ): void {
    // An old session can report its delayed disconnect after a fresh one has
    // been opened. Only its own cache entry may be evicted.
    if (this.runtimes.get(threadId) !== owner) return;
    this.runtimes.delete(threadId);
    owner.unsubscribe();
    owner.unsubscribeUnavailable();
    void owner.runtime.dispose().catch(() => undefined);
  }

  private onRuntimeEvent(thread: ThreadRecord, event: RuntimeEvent): void {
    if (event.type === "transcript" || event.type === "transcript-update") {
      this.broker.publish(thread.id, "transcript", event.item);
    } else if (event.type === "diagnostic") {
      this.broker.publish(thread.id, "diagnostic", event);
    }
  }

  public async snapshot(
    projectId: ProjectId,
    threadId: ThreadId,
  ): Promise<ThreadSnapshot> {
    const thread = this.requireThread(projectId, threadId);
    const project = this.requireProject(projectId);
    this.store.setLastOpenedThread(projectId, threadId);
    let transcriptPage: TranscriptPage = {
      items: [],
      olderCursor: null,
      atLatest: true,
    };
    let imageInput: ImageInputCapability = "unknown";
    const diagnostics: string[] = [];
    try {
      const runtime = await this.openRuntime(thread);
      let nativeSnapshot:
        Awaited<ReturnType<OpenRuntimeSession["snapshot"]>> | undefined;
      if (runtime.readImage !== undefined) {
        nativeSnapshot = await runtime.snapshot();
        imageInput = nativeSnapshot.imageInput ?? "unknown";
        diagnostics.push(...nativeSnapshot.diagnostics);
      } else imageInput = "unsupported";
      if (runtime.latestTranscriptPage !== undefined)
        transcriptPage = await runtime.latestTranscriptPage();
      else {
        nativeSnapshot ??= await runtime.snapshot();
        const pager = this.fallbackPager(threadId);
        transcriptPage = pager.latest(nativeSnapshot.transcript);
        diagnostics.push(...nativeSnapshot.diagnostics);
      }
      this.transcriptPages.set(threadId, transcriptPage);
      this.runtimeUnavailableReasons.delete(threadId);
      this.adapters.recordAvailable(thread.runtime);
    } catch (error) {
      transcriptPage = this.transcriptPages.get(threadId) ?? transcriptPage;
      const reason =
        error instanceof Error
          ? error.message
          : "The native agent session is unavailable or malformed.";
      this.runtimeUnavailableReasons.set(threadId, reason);
      diagnostics.push(reason);
    }
    const latest = this.store.latestRun(threadId);
    const current = latest?.state === "running" ? latest : null;
    const cursor = this.broker.cursor(threadId);
    return ThreadSnapshotSchema.parse({
      version: 2,
      project: await this.projectDto(project),
      thread: this.threadDto(thread),
      transcriptPage,
      currentRun: current === null ? null : runDto(current),
      lastRun: latest === null ? null : runDto(latest),
      epoch: cursor.epoch,
      highWaterSequence: cursor.sequence,
      capabilities: {
        prompt:
          current === null && !this.runtimeUnavailableReasons.has(threadId),
        steer:
          current !== null && !this.runtimeUnavailableReasons.has(threadId),
        stop: current !== null && !this.runtimeUnavailableReasons.has(threadId),
        ...(imageInput === "unknown" ? {} : { imageInput }),
      },
      diagnostics,
    });
  }

  public async readImage(
    projectId: ProjectId,
    threadId: ThreadId,
    imageId: ChatImageId,
  ) {
    const thread = this.requireThread(projectId, threadId);
    const runtime = await this.openRuntime(thread);
    if (runtime.readImage === undefined)
      throw new Error("chat_image_not_found");
    try {
      return ChatImageResponseSchema.parse(await runtime.readImage(imageId));
    } catch (error) {
      if (error instanceof Error && error.message === "chat_image_not_found")
        throw error;
      throw new Error("chat_image_not_found", { cause: error });
    }
  }

  public async olderTranscriptPage(
    projectId: ProjectId,
    threadId: ThreadId,
    cursor: TranscriptCursor,
  ): Promise<TranscriptPage> {
    const thread = this.requireThread(projectId, threadId);
    const runtime = await this.openRuntime(thread);
    const page =
      runtime.olderTranscriptPage !== undefined
        ? TranscriptPageSchema.parse(await runtime.olderTranscriptPage(cursor))
        : TranscriptPageSchema.parse(
            this.fallbackPager(threadId).older(
              (await runtime.snapshot()).transcript,
              cursor,
            ),
          );
    this.runtimeUnavailableReasons.delete(threadId);
    this.adapters.recordAvailable(thread.runtime);
    return page;
  }

  private fallbackPager(threadId: ThreadId): TranscriptPager {
    const existing = this.fallbackPagers.get(threadId);
    if (existing !== undefined) return existing;
    const pager = new TranscriptPager();
    this.fallbackPagers.set(threadId, pager);
    return pager;
  }

  public async prompt(
    projectId: ProjectId,
    threadId: ThreadId,
    input: ParsedChatInput,
    idempotencyKey: string,
    dispatch?: { id: string },
    preownedWorktreeId?: WorktreeId,
  ): Promise<Run> {
    const operation = "prompt";
    const hash = canonicalRequestHash(
      operation,
      input.images.length === 0
        ? { projectId, threadId, text: input.text }
        : { projectId, threadId, input: canonicalInput(input) },
    );
    return await this.serialized(
      projectId,
      idempotencyKey,
      operation,
      hash,
      RunSchema,
      async () => {
        if (this.removingProjects.has(projectId))
          throw new Error("project_not_found");
        const prior = this.store.readReceipt(
          projectId,
          idempotencyKey,
          operation,
          hash,
          RunSchema,
        );
        if (prior !== null) return prior;
        const thread = this.requireThread(projectId, threadId);
        const worktreeId = thread.worktree_id;
        if (
          this.activeThreads.has(threadId) ||
          this.store.runningRunForThread(threadId) !== null
        )
          throw new Error("project_busy");
        if (
          worktreeId !== null &&
          worktreeId !== preownedWorktreeId &&
          (this.activeWorktrees.has(worktreeId) ||
            this.store.runningRunForWorktree(worktreeId) !== null)
        )
          throw new Error("workspace_busy");
        this.activeThreads.add(threadId);
        if (worktreeId !== null) this.activeWorktrees.add(worktreeId);
        const preflight: PendingPreflight = {
          projectId: thread.project_id,
          runtime: undefined,
          stopRequested: false,
        };
        this.preflightPrompts.set(threadId, preflight);
        let pendingAcceptance: PromptAcceptance | undefined;
        let acceptedRuntime: OpenRuntimeSession | undefined;
        try {
          let initialTitle: string | null = null;
          if (thread.initial_title_pending === 1) {
            const context = await this.executionContexts.resolve(thread);
            let suggested: TitleSuggestion = { outcome: "unavailable" };
            try {
              suggested =
                (await this.adapters
                  .get(thread.runtime)
                  .suggestTitle?.(context.executionRoot, input.text)) ??
                suggested;
            } catch {
              // Naming is optional; use the deterministic product fallback.
            }
            initialTitle =
              suggested.outcome === "available"
                ? suggested.title
                : fallbackTitle(input.text);
          }
          const runtime = await this.openRuntime(thread);
          acceptedRuntime = runtime;
          preflight.runtime = runtime;
          if (this.preflightPrompts.get(threadId) !== preflight) {
            this.requestPreflightStop(preflight);
            throw new Error("project_not_found");
          }
          const acceptance = await runtime.prompt(
            runtimeInput(input),
            dispatch,
          );
          pendingAcceptance = acceptance;
          if (!acceptance.accepted) throw new Error("prompt_rejected");
          if (this.preflightPrompts.get(threadId) !== preflight)
            throw new Error("project_not_found");
          const receipt = this.store.withReceipt(
            projectId,
            idempotencyKey,
            operation,
            hash,
            RunSchema,
            () => {
              const created = this.store.createRunIfProjectActive(
                projectId,
                threadId,
                idempotencyKey,
              );
              if (created === null) throw new Error("project_not_found");
              if (initialTitle !== null)
                this.store.applyInitialTitle(projectId, threadId, initialTitle);
              return runDto(created);
            },
          );
          const run = RunSchema.parse(receipt.response);
          if (this.preflightPrompts.get(threadId) === preflight)
            this.preflightPrompts.delete(threadId);
          this.broker.publish(threadId, "run", run);
          acceptance.releaseEvents();
          pendingAcceptance = undefined;
          acceptedRuntime = undefined;
          void acceptance.settlement
            .then((outcome) => {
              if (this.store.runningRunForThread(threadId)?.id !== run.id)
                return;
              const state =
                outcome === "completed"
                  ? "completed"
                  : outcome === "interrupted"
                    ? "interrupted"
                    : "failed";
              const settled = runDto(
                this.store.settleRun(
                  run.id,
                  state,
                  state === "failed" ? "runtime_failure" : null,
                  state === "failed" ? "Agent execution failed." : null,
                ),
              );
              this.activeThreads.delete(threadId);
              if (worktreeId !== null) this.activeWorktrees.delete(worktreeId);
              this.broker.publish(threadId, "completion", settled);
            })
            .catch(() => {
              if (this.store.runningRunForThread(threadId)?.id !== run.id)
                return;
              const settled = runDto(
                this.store.settleRun(
                  run.id,
                  "failed",
                  "runtime_failure",
                  "Agent execution failed.",
                ),
              );
              this.activeThreads.delete(threadId);
              if (worktreeId !== null) this.activeWorktrees.delete(worktreeId);
              this.broker.publish(threadId, "completion", settled);
            });
          return run;
        } catch (error) {
          const ownsPreflightLease =
            this.preflightPrompts.get(threadId) === preflight;
          if (ownsPreflightLease) this.preflightPrompts.delete(threadId);
          if (
            pendingAcceptance?.accepted &&
            acceptedRuntime !== undefined &&
            !preflight.stopRequested
          ) {
            try {
              await acceptedRuntime.stop();
            } catch {
              // Preserve the persistence failure that left this prompt untracked.
            }
          }
          pendingAcceptance?.discardEvents();
          if (ownsPreflightLease) {
            this.activeThreads.delete(threadId);
            if (worktreeId !== null) this.activeWorktrees.delete(worktreeId);
          }
          throw error;
        }
      },
    );
  }

  public async steer(
    projectId: ProjectId,
    threadId: ThreadId,
    input: ParsedChatInput,
    idempotencyKey: string,
  ): Promise<Run> {
    const operation = "steer";
    const hash = canonicalRequestHash(
      operation,
      input.images.length === 0
        ? { projectId, threadId, text: input.text }
        : { projectId, threadId, input: canonicalInput(input) },
    );
    return await this.serialized(
      projectId,
      idempotencyKey,
      operation,
      hash,
      RunSchema,
      async () => {
        const prior = this.store.readReceipt(
          projectId,
          idempotencyKey,
          operation,
          hash,
          RunSchema,
        );
        if (prior !== null) return prior;
        const thread = this.requireThread(projectId, threadId);
        const run = this.store.runningRunForThread(threadId);
        if (run?.project_id !== projectId) throw new Error("run_not_active");
        await (await this.openRuntime(thread)).steer(runtimeInput(input));
        return this.store.withReceipt(
          projectId,
          idempotencyKey,
          operation,
          hash,
          RunSchema,
          () => runDto(run),
        ).response;
      },
    );
  }

  public async stop(
    projectId: ProjectId,
    threadId: ThreadId,
    idempotencyKey: string,
  ): Promise<Run> {
    const operation = "stop";
    const hash = canonicalRequestHash(operation, { projectId, threadId });
    return await this.serialized(
      projectId,
      idempotencyKey,
      operation,
      hash,
      RunSchema,
      async () => {
        const prior = this.store.readReceipt(
          projectId,
          idempotencyKey,
          operation,
          hash,
          RunSchema,
        );
        if (prior !== null) return prior;
        const thread = this.requireThread(projectId, threadId);
        const run = this.store.runningRunForThread(threadId);
        if (run?.project_id !== projectId) throw new Error("run_not_active");
        // A Stop that could not be confirmed is not a Stop that worked, and
        // the run row is what tells the reader which. Settling it
        // `interrupted` here would say "stopped by the user" about an agent
        // that is, as far as anything here knows, still running -- so the run
        // is left exactly as it is and the caller gets an error naming that.
        // Nothing is lost by waiting for the truth: `agent.abort()` has
        // already been delivered, and the prompt's own settlement handler
        // settles the row the moment the agent does come to rest.
        await withDeadline(
          (await this.openRuntime(thread)).stop(),
          STOP_TIMEOUT_MS,
          () => new Error("stop_timed_out"),
        );
        const settlesCapturedRun =
          this.store.runningRunForThread(threadId)?.id === run.id;
        const settled = this.store.withReceipt(
          projectId,
          idempotencyKey,
          operation,
          hash,
          RunSchema,
          () =>
            runDto(
              this.store.settleRun(
                run.id,
                "interrupted",
                "user_stop",
                "Stopped by the user.",
              ),
            ),
        ).response;
        if (settlesCapturedRun) {
          this.activeThreads.delete(threadId);
          if (thread.worktree_id !== null)
            this.activeWorktrees.delete(thread.worktree_id);
        }
        this.broker.publish(threadId, "completion", settled);
        return settled;
      },
    );
  }

  public markViewed(
    projectId: ProjectId,
    threadId: ThreadId,
    runId: string,
    idempotencyKey: string,
  ): void {
    const operation = "mark-viewed";
    const parsedRunId = RunIdSchema.parse(runId);
    const hash = canonicalRequestHash(operation, {
      projectId,
      threadId,
      runId: parsedRunId,
    });
    const prior = this.store.readReceipt(
      projectId,
      idempotencyKey,
      operation,
      hash,
      viewedReceiptSchema,
    );
    if (prior !== null) return;
    this.store.withReceipt(
      projectId,
      idempotencyKey,
      operation,
      hash,
      viewedReceiptSchema,
      () => {
        this.requireThread(projectId, threadId);
        this.store.markViewed(projectId, threadId, parsedRunId);
        return { viewed: true as const };
      },
    );
  }

  public requireProject(id: string): ProjectRecord {
    const parsed = ProjectIdSchema.parse(id);
    const project = this.store.getProject(parsed);
    if (project === null) throw new Error("project_not_found");
    return project;
  }

  public async requireProjectRoot(id: string): Promise<string> {
    const root = await parseProjectRoot(this.requireProject(id).canonical_path);
    if (root === null) throw new Error("project_unavailable");
    return root;
  }

  public async threadExecutionContext(
    projectId: string,
    threadId: string,
  ): Promise<ThreadExecutionContext> {
    return await this.executionContexts.resolve(
      this.requireThread(projectId, threadId),
    );
  }

  public async requireThreadRoot(
    projectId: string,
    threadId: string,
  ): Promise<string> {
    return (await this.threadExecutionContext(projectId, threadId))
      .executionRoot;
  }

  public requireThread(projectId: string, threadId: string): ThreadRecord {
    const project = ProjectIdSchema.parse(projectId);
    const thread = ThreadIdSchema.parse(threadId);
    const record = this.store.getThread(project, thread);
    if (record === null) throw new Error("thread_not_found");
    return record;
  }

  public async disposeThread(threadId: ThreadId): Promise<void> {
    this.fallbackPagers.delete(threadId);
    const owner = this.runtimes.get(threadId);
    if (owner === undefined) return;
    this.runtimes.delete(threadId);
    owner.unsubscribe();
    owner.unsubscribeUnavailable();
    await owner.runtime.dispose();
  }

  public async close(): Promise<void> {
    const owners = [...this.runtimes.values()];
    this.runtimes.clear();
    this.fallbackPagers.clear();
    await Promise.allSettled(
      owners.map(async (owner) => {
        owner.unsubscribe();
        owner.unsubscribeUnavailable();
        await owner.runtime.dispose();
      }),
    );
    await this.adapters.close();
  }
}
