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
import {
  ArchiveThreadResponseSchema,
  BrowseProjectResponseSchema,
  ProjectIdSchema,
  ProjectSchema,
  RunIdSchema,
  RunSchema,
  StartThreadResponseSchema,
  ThreadIdSchema,
  ThreadLiveMetadataSchema,
  ThreadSnapshotSchema,
  TranscriptPageSchema,
  ThreadWorkspaceRequestSchema,
  ThreadSummarySchema,
  type Project,
  type ProjectId,
  type Run,
  type ThreadId,
  type ThreadLiveMetadata,
  type ThreadSnapshot,
  type ThreadSummary,
  type TranscriptPage,
  type TranscriptPageRequest,
  type WorktreeId,
} from "@pi-web/contracts";
import { z } from "zod";

import {
  canonicalRequestHash,
  MetadataStore,
  type ProjectRecord,
  type RunRecord,
  type ThreadRecord,
} from "../db/store.js";
import { LiveBroker } from "../live/broker.js";
import { GitWorktreeManager, worktreeSlug } from "../worktrees/manager.js";
import {
  ThreadExecutionContextResolver,
  type ThreadExecutionContext,
} from "./execution-context.js";

const transcriptPageLimits = {
  maxItems: 100,
  targetBytes: 1_048_576,
} as const;

interface PendingRuntimeOpen {
  cancelled: boolean;
  promise: Promise<OpenRuntimeSession>;
}

interface PendingPreflight {
  projectId: ProjectId;
  runtime: OpenRuntimeSession | undefined;
  stopRequested: boolean;
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

function fallbackTitle(prompt: string): string {
  const words = prompt
    .replace(/[\r\n]+/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 7);
  const value = words.join(" ").slice(0, 60).trim();
  if (value === "") return "New coding task";
  return `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}

export class WorkspaceService {
  private readonly runtimes = new Map<
    ThreadId,
    { runtime: OpenRuntimeSession; unsubscribe: () => void }
  >();
  private readonly pendingRuntimeOpens = new Map<
    ThreadId,
    PendingRuntimeOpen
  >();
  private readonly activeThreads = new Set<ThreadId>();
  private readonly preflightPrompts = new Map<ThreadId, PendingPreflight>();
  private readonly removingProjects = new Set<ProjectId>();
  private readonly inFlightCommands = new Map<
    string,
    { operation: string; requestHash: string; pending: Promise<unknown> }
  >();

  private readonly executionContexts: ThreadExecutionContextResolver;

  public constructor(
    public readonly store: MetadataStore,
    private readonly runtime: AgentRuntime,
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
    return ThreadSummarySchema.parse({
      id: record.id,
      projectId: record.project_id,
      title: record.title,
      createdAt: record.created_at,
      lastActivityAt: record.last_activity_at,
      runState: latest?.state ?? null,
      unread: this.store.isUnread(record),
      runtimeAvailable:
        record.worktree_id === null || worktree?.state === "ready",
      workspace:
        worktree === null
          ? { mode: "shared", branchName: null, available: true }
          : {
              mode: "worktree",
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

  public async workspacePreflight(projectId: ProjectId) {
    return await this.worktreeManager.preflight(
      await this.requireProjectRoot(projectId),
    );
  }

  public async startThread(
    projectId: ProjectId,
    prompt: string,
    workspace: z.infer<typeof ThreadWorkspaceRequestSchema>,
    idempotencyKey: string,
  ) {
    const operation = "start-thread";
    const hash = canonicalRequestHash(operation, {
      projectId,
      prompt,
      workspace,
    });
    return await this.serialized(
      projectId,
      idempotencyKey,
      operation,
      hash,
      StartThreadResponseSchema,
      async () => {
        const projectRoot = await this.requireProjectRoot(projectId);
        const existingCreation = this.store.getThreadCreation(
          projectId,
          idempotencyKey,
        );
        if (existingCreation === null && workspace.mode === "worktree")
          await this.worktreeManager.authorizeBaseBranch(
            projectRoot,
            workspace.baseBranch,
          );
        let creation = this.store.beginThreadCreation({
          projectId,
          idempotencyKey,
          requestHash: hash,
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
            suggested =
              (await this.runtime.suggestTitle?.(projectRoot, prompt)) ??
              suggested;
          } catch {
            // Naming is optional; use the deterministic product fallback.
          }
          const title =
            suggested.outcome === "available"
              ? suggested.title
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
          const session = await this.runtime.create(
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
          const recovered = await runtime.recoverPrompt(prompt, dispatch);
          if (recovered.outcome === "accepted") {
            const receipt = this.store.readReceipt(
              projectId,
              creation.prompt_command_id,
              "prompt",
              canonicalRequestHash("prompt", {
                projectId,
                threadId: thread.id,
                text: prompt,
              }),
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
              prompt,
              creation.prompt_command_id,
              dispatch,
            );
            this.store.attachCreationRun(projectId, idempotencyKey, started.id);
            run = this.store.getRun(started.id);
          }
        }
        if (run === null) throw new Error("run_not_found");
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

  private async canonicalProject(path: string): Promise<string> {
    let canonical: string;
    try {
      canonical = await realpath(path);
    } catch {
      throw new Error("project_unavailable");
    }
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(canonical);
    } catch {
      throw new Error("project_unavailable");
    }
    if (!info.isDirectory()) throw new Error("project_not_directory");
    try {
      await access(canonical, constants.R_OK | constants.X_OK);
    } catch {
      throw new Error("project_unavailable");
    }
    return canonical;
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

  public async createThread(
    projectId: ProjectId,
    title?: string,
    idempotencyKey?: string,
  ): Promise<ThreadSummary> {
    if (idempotencyKey === undefined)
      return await this.createThreadUnprotected(projectId, title);
    const operation = "create-thread";
    const hash = canonicalRequestHash(operation, { projectId, title });
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
        if (prior !== null)
          return this.threadDto(this.requireThread(projectId, prior));
        const created = await this.runtime.create(
          await this.requireProjectRoot(projectId),
        );
        const receipt = this.store.withReceipt(
          projectId,
          idempotencyKey,
          operation,
          hash,
          ThreadIdSchema,
          () => this.store.createThread(projectId, created.sessionId, title).id,
        );
        return this.threadDto(this.requireThread(projectId, receipt.response));
      },
    );
  }

  private async createThreadUnprotected(
    projectId: ProjectId,
    title?: string,
  ): Promise<ThreadSummary> {
    const created = await this.runtime.create(
      await this.requireProjectRoot(projectId),
    );
    return this.threadDto(
      this.store.createThread(projectId, created.sessionId, title),
    );
  }

  public async importThread(
    projectId: ProjectId,
    sessionId: string,
    title?: string,
    idempotencyKey?: string,
  ): Promise<ThreadSummary> {
    if (idempotencyKey !== undefined) {
      const operation = "import-thread";
      const hash = canonicalRequestHash(operation, {
        projectId,
        sessionId,
        title,
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
          if (prior !== null)
            return this.threadDto(this.requireThread(projectId, prior));
          const sessions = await this.runtime.discover(
            await this.requireProjectRoot(projectId),
          );
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
    const sessions = await this.runtime.discover(
      await this.requireProjectRoot(projectId),
    );
    const descriptor = sessions.sessions.find(
      (session) => session.id === sessionId,
    );
    if (descriptor === undefined) throw new Error("session_not_found");
    return this.threadDto(
      this.store.createThread(
        projectId,
        descriptor.id,
        title ??
          descriptor.name ??
          (descriptor.preview.slice(0, 80) || "Imported thread"),
      ),
    );
  }

  public async discoverSessions(projectId: ProjectId) {
    const result = await this.runtime.discover(
      await this.requireProjectRoot(projectId),
    );
    const imported = new Set(
      this.store
        .listThreads(projectId, { includeArchived: true })
        .map((thread) => thread.runtime_session_id),
    );
    return {
      sessions: result.sessions.map((session) => ({
        ...session,
        imported: imported.has(session.id),
      })),
      diagnostics: result.diagnostics,
    };
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
    const existing = this.pendingRuntimeOpens.get(thread.id);
    if (existing !== undefined) return await existing.promise;
    const entry: PendingRuntimeOpen = {
      cancelled: false,
      promise: Promise.resolve(undefined as unknown as OpenRuntimeSession),
    };
    const promise = (async () => {
      const context = await this.executionContexts.resolve(thread);
      const opened = await this.runtime.open(
        context.executionRoot,
        thread.runtime_session_id,
      );
      if (
        entry.cancelled ||
        this.pendingRuntimeOpens.get(thread.id) !== entry
      ) {
        await opened.dispose();
        throw new Error("runtime_open_cancelled");
      }
      const unsubscribe = opened.subscribe((event) => {
        this.onRuntimeEvent(thread, event);
      });
      this.runtimes.set(thread.id, { runtime: opened, unsubscribe });
      return opened;
    })();
    entry.promise = promise;
    this.pendingRuntimeOpens.set(thread.id, entry);
    try {
      return await promise;
    } finally {
      if (this.pendingRuntimeOpens.get(thread.id) === entry)
        this.pendingRuntimeOpens.delete(thread.id);
    }
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
    let transcriptPage: TranscriptPage | null = null;
    const diagnostics: string[] = [];
    try {
      const runtime = await this.openRuntime(thread);
      const native = await runtime.snapshot(transcriptPageLimits);
      transcriptPage = native.transcriptPage;
      diagnostics.push(...native.diagnostics);
    } catch {
      diagnostics.push("The native agent session is unavailable or malformed.");
    }
    transcriptPage ??= TranscriptPageSchema.parse({
      items: [],
      olderCursor: null,
      newerCursor: null,
      resumeCursor: "unavailable-transcript",
      atLatest: true,
    });
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
        prompt: current === null,
        steer: current !== null,
        stop: current !== null,
      },
      diagnostics,
    });
  }

  public threadLiveMetadata(
    projectId: ProjectId,
    threadId: ThreadId,
  ): ThreadLiveMetadata {
    this.requireThread(projectId, threadId);
    const latest = this.store.latestRun(threadId);
    const current = latest?.state === "running" ? latest : null;
    const cursor = this.broker.cursor(threadId);
    return ThreadLiveMetadataSchema.parse({
      version: 1,
      currentRun: current === null ? null : runDto(current),
      lastRun: latest === null ? null : runDto(latest),
      epoch: cursor.epoch,
      highWaterSequence: cursor.sequence,
      capabilities: {
        prompt: current === null,
        steer: current !== null,
        stop: current !== null,
      },
    });
  }

  public async transcriptPage(
    projectId: ProjectId,
    threadId: ThreadId,
    request: TranscriptPageRequest,
  ): Promise<TranscriptPage> {
    const thread = this.requireThread(projectId, threadId);
    const runtime = await this.openRuntime(thread);
    return await runtime.transcriptPage(request, transcriptPageLimits);
  }

  public async prompt(
    projectId: ProjectId,
    threadId: ThreadId,
    text: string,
    idempotencyKey: string,
    dispatch?: { id: string },
  ): Promise<Run> {
    const operation = "prompt";
    const hash = canonicalRequestHash(operation, {
      projectId,
      threadId,
      text,
    });
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
        if (
          this.activeThreads.has(threadId) ||
          this.store.runningRunForThread(threadId) !== null
        )
          throw new Error("project_busy");
        this.activeThreads.add(threadId);
        const preflight: PendingPreflight = {
          projectId: thread.project_id,
          runtime: undefined,
          stopRequested: false,
        };
        this.preflightPrompts.set(threadId, preflight);
        let pendingAcceptance: PromptAcceptance | undefined;
        let acceptedRuntime: OpenRuntimeSession | undefined;
        try {
          const runtime = await this.openRuntime(thread);
          acceptedRuntime = runtime;
          preflight.runtime = runtime;
          if (this.preflightPrompts.get(threadId) !== preflight) {
            this.requestPreflightStop(preflight);
            throw new Error("project_not_found");
          }
          const acceptance = await runtime.prompt(text, dispatch);
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
          if (ownsPreflightLease) this.activeThreads.delete(threadId);
          throw error;
        }
      },
    );
  }

  public async steer(
    projectId: ProjectId,
    threadId: ThreadId,
    text: string,
    idempotencyKey: string,
  ): Promise<Run> {
    const operation = "steer";
    const hash = canonicalRequestHash(operation, { projectId, threadId, text });
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
        await (await this.openRuntime(thread)).steer(text);
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
        await (await this.openRuntime(thread)).stop();
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
        if (settlesCapturedRun) this.activeThreads.delete(threadId);
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
    const pending = this.pendingRuntimeOpens.get(threadId);
    if (pending !== undefined) {
      pending.cancelled = true;
      this.pendingRuntimeOpens.delete(threadId);
    }
    const owner = this.runtimes.get(threadId);
    if (owner !== undefined) {
      this.runtimes.delete(threadId);
      owner.unsubscribe();
      await owner.runtime.dispose();
    }
    if (pending !== undefined) await Promise.allSettled([pending.promise]);
  }

  public async close(): Promise<void> {
    const pending = [...this.pendingRuntimeOpens.values()];
    this.pendingRuntimeOpens.clear();
    for (const entry of pending) entry.cancelled = true;
    const owners = [...this.runtimes.values()];
    this.runtimes.clear();
    await Promise.allSettled([
      ...pending.map((entry) => entry.promise),
      ...owners.map(async (owner) => {
        owner.unsubscribe();
        await owner.runtime.dispose();
      }),
    ]);
  }
}
