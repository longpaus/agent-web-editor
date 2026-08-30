import { existsSync } from "node:fs";
import { resolve } from "node:path";

import multipart from "@fastify/multipart";
import staticPlugin from "@fastify/static";
import websocket from "@fastify/websocket";
import { RuntimeFailure, type AgentRuntime } from "@pi-web/agent-runtime";
import type { RuntimeKind } from "@pi-web/contracts";
import type { RawData } from "ws";
import {
  ArchiveThreadRequestSchema,
  UnarchiveThreadRequestSchema,
  AddProjectRequestSchema,
  BrowseProjectRequestSchema,
  ChatCommandMultipartMetadataSchema,
  ChatImageIdSchema,
  CommandRequestSchema,
  ContinueThreadRequestSchema,
  ImportThreadRequestSchema,
  LiveSubscribeSchema,
  ProjectIdSchema,
  PromptRequestSchema,
  RelativePathSchema,
  RemoveProjectRequestSchema,
  RenameThreadRequestSchema,
  RunIdSchema,
  StartThreadMultipartMetadataSchema,
  StartThreadRequestSchema,
  SteerRequestSchema,
  TERMINAL_MAX_PER_SCOPE,
  TerminalClientFrameSchema,
  TerminalServerFrameSchema,
  TerminalsResponseSchema,
  ThreadIdSchema,
  TranscriptPageQuerySchema,
  UpdateProjectRequestSchema,
  WorkspacePreflightQuerySchema,
  type TerminalErrorCode,
  type TerminalServerFrame,
} from "@pi-web/contracts";
import { CodexAgentRuntime } from "@pi-web/codex-adapter";
import { PiAgentRuntime } from "@pi-web/pi-adapter";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { z, ZodError } from "zod";

import {
  checkHost,
  checkOrigin,
  enforceRequestPolicy,
} from "./request-policy.js";
import { parseMultipartChatInput, parseTextChatInput } from "./chat-images.js";
import { parseConfig, type ServerConfig } from "./config.js";
import { MetadataStore, ReceiptConflictError } from "./db/store.js";
import {
  createNativeDirectoryPicker,
  type DirectoryPicker,
} from "./directory-picker/native.js";
import { RuntimeRegistry } from "./domain/runtimes.js";
import { WorkspaceService } from "./domain/workspace.js";
import { previewProjectFile, listProjectFiles } from "./inspector/files.js";
import { getGitDiff, getGitStatus } from "./inspector/git.js";
import { LiveBroker } from "./live/broker.js";
import {
  ProjectTerminalManager,
  TerminalRejection,
  type PtyFactory,
} from "./terminal/manager.js";

const projectParamsSchema = z.object({ projectId: ProjectIdSchema });
const threadParamsSchema = z.object({
  projectId: ProjectIdSchema,
  threadId: ThreadIdSchema,
});
const runParamsSchema = z.object({
  projectId: ProjectIdSchema,
  threadId: ThreadIdSchema,
  runId: RunIdSchema,
});
const imageParamsSchema = z.object({
  projectId: ProjectIdSchema,
  threadId: ThreadIdSchema,
  imageId: ChatImageIdSchema,
});
const fileQuerySchema = z.object({
  path: z.string().default(""),
  search: z.string().max(500).default(""),
  // `"full"` by default so the parameter is additive: a browser built before
  // the file tree, or one that drops the parameter, still receives the whole
  // recursive listing it expects (WSP-05 as revised by specification
  // version 2).
  depth: z.enum(["1", "full"]).default("full"),
  // A query string carries no booleans, so the flag is an exact pair of
  // spellings rather than a truthiness test: `?showIgnored=0` must not
  // reveal a dependency tree because "0" is a non-empty string.
  showIgnored: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
});

export interface BuildServerOptions {
  config?: ServerConfig;
  store?: MetadataStore;
  /**
   * Test seam: a single adapter registered as every backend, so existing
   * fixtures keep working without knowing about the registry.
   */
  runtime?: AgentRuntime;
  /** Explicit per-backend adapters; takes precedence over `runtime`. */
  runtimes?: Partial<Record<RuntimeKind, AgentRuntime>>;
  ptyFactory?: PtyFactory;
  directoryPicker?: DirectoryPicker;
  logger?: boolean;
}

export interface ServerContext {
  config: ServerConfig;
  store: MetadataStore;
  workspace: WorkspaceService;
  /**
   * The live terminals of this server.
   *
   * Exposed because a terminal deliberately outlives the browser that opened
   * it (WSP-07), which means an end-to-end suite driving one server through
   * many pages accumulates shells against a shared execution scope until the
   * per-scope cap refuses the next one. A suite needs a way to put the
   * server back as it found it; nothing here is reachable over HTTP.
   */
  terminals: ProjectTerminalManager;
  launchUrl: string;
}

export type WorkspaceServer = FastifyInstance & {
  workspaceContext: ServerContext;
};

function safeError(error: unknown): {
  status: number;
  code: string;
  message: string;
} {
  if (error instanceof ZodError)
    return {
      status: 400,
      code: "invalid_request",
      message: "The request is malformed.",
    };
  if (error instanceof RuntimeFailure)
    return error.code === "rejected"
      ? {
          status: 409,
          code: "stale_transcript",
          message:
            "Conversation history changed. Return to the latest messages and try again.",
        }
      : {
          status: 502,
          code: "runtime_failure",
          message: error.message,
        };
  if (error instanceof ReceiptConflictError)
    return {
      status: 409,
      code: "idempotency_conflict",
      message: error.message,
    };
  if (error instanceof Error) {
    const known: Record<
      string,
      { status: number; code: string; message: string }
    > = {
      project_not_found: {
        status: 404,
        code: "project_not_found",
        message: "Project was not found.",
      },
      thread_not_found: {
        status: 404,
        code: "thread_not_found",
        message: "Thread was not found in this project.",
      },
      thread_busy: {
        status: 409,
        code: "thread_busy",
        message: "A running thread cannot be archived.",
      },
      session_not_found: {
        status: 404,
        code: "session_not_found",
        message: "Runtime session was not found in this project.",
      },
      project_already_registered: {
        status: 409,
        code: "project_already_registered",
        message: "This directory is already registered.",
      },
      project_not_directory: {
        status: 400,
        code: "project_not_directory",
        message: "That path is a file, not a directory.",
      },
      // A typo, and by far the likeliest failure now that a path can be
      // typed. It has to say THAT, not "unavailable or inaccessible", which
      // sends the reader hunting a permissions problem they do not have.
      project_path_not_found: {
        status: 404,
        code: "project_path_not_found",
        message: "There is nothing at that path.",
      },
      // Distinct from not-found on purpose: the directory is there and the
      // fix is a permissions one, not a spelling one.
      project_not_readable: {
        status: 403,
        code: "project_not_readable",
        message: "That directory exists, but its contents cannot be read.",
      },
      project_path_relative: {
        status: 400,
        code: "project_path_relative",
        message:
          "Enter the full path to the directory, starting from the root.",
      },
      project_path_invalid: {
        status: 400,
        code: "project_path_invalid",
        message: "That is not a usable path.",
      },
      project_unavailable: {
        status: 400,
        code: "project_unavailable",
        message: "The selected directory is unavailable or inaccessible.",
      },
      directory_picker_unsupported: {
        status: 501,
        code: "directory_picker_unsupported",
        message: "Folder browsing is supported on macOS and Windows.",
      },
      directory_picker_failed: {
        status: 500,
        code: "directory_picker_failed",
        message: "The folder browser could not be opened.",
      },
      project_busy: {
        status: 409,
        code: "project_busy",
        message: "Another agent run is active in this thread.",
      },
      workspace_busy: {
        status: 409,
        code: "workspace_busy",
        message: "Another agent run is active in this worktree.",
      },
      worktree_required: {
        status: 409,
        code: "worktree_required",
        message: "The /new command requires a managed worktree chat.",
      },
      run_not_active: {
        status: 409,
        code: "run_not_active",
        message: "There is no matching active run.",
      },
      // 504 rather than 500: the stop was dispatched and it is the agent
      // downstream that did not answer. The message says what is true of the
      // run afterwards, because the run row still says `running` and the
      // reader is looking at it -- "stopped" would be a claim nothing here
      // can support.
      stop_timed_out: {
        status: 504,
        code: "stop_timed_out",
        message:
          "Stop was sent, but the agent did not come to rest. The run is still active — try again.",
      },
      prompt_rejected: {
        status: 409,
        code: "prompt_rejected",
        message: "The runtime rejected this prompt.",
      },
      chat_input_empty: {
        status: 400,
        code: "chat_input_empty",
        message: "Add a message or at least one photo.",
      },
      chat_metadata_missing: {
        status: 400,
        code: "invalid_request",
        message: "The image message metadata is missing.",
      },
      chat_metadata_invalid: {
        status: 400,
        code: "invalid_request",
        message: "The image message metadata is malformed.",
      },
      chat_multipart_malformed: {
        status: 400,
        code: "invalid_request",
        message: "The image message is malformed.",
      },
      chat_image_unsupported: {
        status: 415,
        code: "chat_image_unsupported",
        message: "Use a JPEG, PNG, or WebP image.",
      },
      chat_image_input_unsupported: {
        status: 409,
        code: "chat_image_input_unsupported",
        message: "The selected agent model or settings cannot receive images.",
      },
      chat_image_count_exceeded: {
        status: 413,
        code: "chat_image_count_exceeded",
        message: "A message can include at most four photos.",
      },
      chat_image_too_large: {
        status: 413,
        code: "chat_image_too_large",
        message: "Each photo must be 10 MiB or smaller.",
      },
      chat_image_pixels_exceeded: {
        status: 413,
        code: "chat_image_pixels_exceeded",
        message: "That photo has too many pixels.",
      },
      chat_image_limit_exceeded: {
        status: 413,
        code: "chat_image_limit_exceeded",
        message: "The attached photos exceed the message limits.",
      },
      chat_image_total_too_large: {
        status: 413,
        code: "chat_image_total_too_large",
        message: "The attached photos exceed the message size limit.",
      },
      chat_image_empty: {
        status: 400,
        code: "chat_image_malformed",
        message: "An attached photo is empty.",
      },
      chat_image_malformed: {
        status: 400,
        code: "chat_image_malformed",
        message: "An attached photo could not be read.",
      },
      chat_image_part_invalid: {
        status: 400,
        code: "invalid_request",
        message: "The image message is malformed.",
      },
      chat_image_name_too_long: {
        status: 400,
        code: "chat_image_name_too_long",
        message: "An attached photo name is too long.",
      },
      chat_image_not_found: {
        status: 404,
        code: "chat_image_not_found",
        message: "That conversation image is unavailable.",
      },
      chat_image_processing_failed: {
        status: 400,
        code: "chat_image_processing_failed",
        message: "An attached photo could not be prepared for Pi.",
      },
      chat_image_processing_busy: {
        status: 503,
        code: "chat_image_processing_busy",
        message:
          "Image processing is busy. Keep your photos attached and retry.",
      },
      path_escape: {
        status: 400,
        code: "invalid_path",
        message: "The requested path is not permitted.",
      },
      // `.git` is excluded from every file route in both modes, whether it
      // is walked into or asked for by name (H2).
      path_excluded: {
        status: 403,
        code: "path_excluded",
        message: "The requested path is not available.",
      },
      path_ignored: {
        status: 403,
        code: "path_ignored",
        message:
          "The requested path is hidden by this workspace's ignore rules.",
      },
      // A directory that was expanded and persisted, and then deleted (H6).
      path_not_found: {
        status: 404,
        code: "path_not_found",
        message: "The requested path was not found.",
      },
      path_not_directory: {
        status: 400,
        code: "path_not_directory",
        message: "The requested path is not a directory.",
      },
      path_unreadable: {
        status: 403,
        code: "path_unreadable",
        message: "The requested path could not be read.",
      },
      file_not_regular: {
        status: 400,
        code: "file_not_regular",
        message: "The requested path is not a regular file.",
      },
      git_unavailable: {
        status: 409,
        code: "git_unavailable",
        message: "Git is unavailable for this project.",
      },
      git_path_not_changed: {
        status: 404,
        code: "git_path_not_changed",
        message: "The file is not in the current change set.",
      },
      source_changed: {
        status: 409,
        code: "source_changed",
        message: "Local changes changed after review. Refresh and try again.",
      },
      source_changes_unsupported: {
        status: 409,
        code: "source_changes_unsupported",
        message: "These local changes cannot be transferred safely.",
      },
      source_transfer_failed: {
        status: 409,
        code: "source_transfer_failed",
        message: "Local changes could not be applied to the worktree.",
      },
      source_transfer_mismatch: {
        status: 409,
        code: "source_transfer_mismatch",
        message: "The transferred worktree did not match the reviewed changes.",
      },
      worktree_unavailable: {
        status: 409,
        code: "worktree_unavailable",
        message: "The thread worktree is unavailable.",
      },
      worktree_create_failed: {
        status: 409,
        code: "worktree_create_failed",
        message: "Git could not create the worktree.",
      },
      worktree_recovery_required: {
        status: 409,
        code: "worktree_recovery_required",
        message: "Worktree setup needs manual recovery before retrying.",
      },
      worktree_not_clean: {
        status: 409,
        code: "worktree_not_clean",
        message: "The new worktree was not clean after checkout.",
      },
      worktree_identity_failed: {
        status: 409,
        code: "worktree_identity_failed",
        message: "The worktree did not match its expected repository identity.",
      },
    };
    const mapped = known[error.message];
    if (mapped !== undefined) return mapped;
    if (error.message.includes("UNIQUE constraint failed: runs.thread_id"))
      return known.project_busy as {
        status: number;
        code: string;
        message: string;
      };
    if (error.message.includes("UNIQUE constraint failed: runs.worktree_id"))
      return known.workspace_busy as {
        status: number;
        code: string;
        message: string;
      };
  }
  return {
    status: 500,
    code: "internal_error",
    message: "The operation could not be completed.",
  };
}

function socketText(raw: RawData): string {
  if (typeof raw === "string") return raw;
  if (Buffer.isBuffer(raw)) return raw.toString("utf8");
  if (Array.isArray(raw)) return Buffer.concat(raw).toString("utf8");
  return Buffer.from(raw).toString("utf8");
}

/**
 * What the browser is told about a terminal command that was refused.
 *
 * The message is the server's own prose in every case: nothing from the
 * error, which could carry a path or a command line. What the code adds is
 * WHICH refusal it was, for the three the tab has to render differently.
 */
function terminalRefusal(error: unknown): TerminalServerFrame {
  if (!(error instanceof TerminalRejection))
    return TerminalServerFrameSchema.parse({
      version: 1,
      type: "error",
      message: "Terminal command was rejected.",
    });
  const messages: Record<TerminalErrorCode, string> = {
    terminal_limit_reached: `Up to ${String(TERMINAL_MAX_PER_SCOPE)} terminals can run in one worktree. Close one to open another.`,
    terminal_gone: "That terminal is no longer running.",
    terminal_cwd_invalid:
      "That directory is not available in this worktree, so no terminal was started there.",
  };
  return TerminalServerFrameSchema.parse({
    version: 1,
    type: "error",
    message: messages[error.code],
    code: error.code,
  });
}

function requireSocketPolicy(
  request: FastifyRequest,
  context: ServerContext,
): void {
  if (
    !checkHost(request, context.config.allowedHosts) ||
    !checkOrigin(request, context.config.allowedOrigins)
  )
    throw new Error("socket_forbidden");
}

export async function buildServer(
  options: BuildServerOptions = {},
): Promise<WorkspaceServer> {
  const config = options.config ?? parseConfig();
  const ownedStore = options.store === undefined;
  const store =
    options.store ??
    (await MetadataStore.open({ stateDirectory: config.stateDirectory }));
  const broker = new LiveBroker();
  const terminals = new ProjectTerminalManager(options.ptyFactory);
  const workspace = new WorkspaceService(
    store,
    new RuntimeRegistry(
      options.runtimes ??
        (options.runtime === undefined
          ? {
              pi: new PiAgentRuntime(undefined, config.namingModel),
              codex: new CodexAgentRuntime({
                command: config.codexCommand,
                sandbox: config.codexSandbox,
                ...(config.codexHome === undefined
                  ? {}
                  : { codexHome: config.codexHome }),
                replayTools: config.codexReplayTools,
              }),
            }
          : { pi: options.runtime, codex: options.runtime }),
      config.defaultRuntime,
    ),
    broker,
    terminals,
  );
  const directoryPicker =
    options.directoryPicker ?? createNativeDirectoryPicker();
  const launchPort = config.production ? config.port : config.devPort;
  const launchUrl = `http://127.0.0.1:${String(launchPort)}/`;
  const context: ServerContext = {
    config,
    store,
    workspace,
    terminals,
    launchUrl,
  };
  const server: WorkspaceServer = Object.assign(
    Fastify({ logger: options.logger ?? true, bodyLimit: config.bodyLimit }),
    { workspaceContext: context },
  );

  await server.register(websocket, {
    options: { maxPayload: config.bodyLimit },
  });
  await server.register(multipart);
  server.addHook(
    "onRequest",
    enforceRequestPolicy({
      allowedHosts: config.allowedHosts,
      allowedOrigins: config.allowedOrigins,
    }),
  );
  server.addHook("onClose", async () => {
    terminals.close();
    broker.clear();
    await workspace.close();
    if (ownedStore) store.close();
  });
  server.setErrorHandler(async (error, _request, reply) => {
    const mapped = safeError(error);
    if (mapped.status >= 500)
      server.log.error({ err: error }, "request failed");
    await reply
      .code(mapped.status)
      .send({ error: { code: mapped.code, message: mapped.message } });
  });

  server.get("/api/ready", () => ({ ready: true }));

  server.get("/api/projects", async () => await workspace.list());
  server.post("/api/projects/browse", async (request) => {
    const body = BrowseProjectRequestSchema.parse(request.body);
    return await workspace.browseProject(
      body.idempotencyKey,
      async () => await directoryPicker.chooseDirectory(),
    );
  });
  // The second way in. `/browse` calls a native OS folder chooser, which is
  // the better route when it works and the only route there was: the dialog
  // opens as a separate window that can land behind the browser or on another
  // desktop, and when it failed the app said so and offered nothing else.
  // Adding a project is the first thing anyone must do and it had no
  // alternative.
  //
  // Nothing is relaxed here. The path goes through the same
  // `canonicalProject` gate the picker's result does, and this server is
  // loopback-only running with the user's own permissions -- a path typed
  // into this field reaches nothing the picker could not have chosen. It
  // shells out to nothing.
  server.post("/api/projects", async (request) => {
    const body = AddProjectRequestSchema.parse(request.body);
    return {
      project: await workspace.addProjectByPath(body.path, body.idempotencyKey),
    };
  });
  server.patch("/api/projects/:projectId", async (request) => {
    const params = projectParamsSchema.parse(request.params);
    const body = UpdateProjectRequestSchema.parse(request.body);
    return {
      project: await workspace.setProjectExpanded(
        params.projectId,
        body.sidebarExpanded,
        body.idempotencyKey,
      ),
    };
  });
  server.delete("/api/projects/:projectId", async (request) => {
    const params = projectParamsSchema.parse(request.params);
    const body = RemoveProjectRequestSchema.parse(request.body);
    await workspace.removeProject(params.projectId, body.idempotencyKey);
    return { removed: true };
  });

  server.get(
    "/api/projects/:projectId/workspace-preflight",
    async (request) => {
      const params = projectParamsSchema.parse(request.params);
      const query = WorkspacePreflightQuerySchema.parse(request.query);
      return await workspace.workspacePreflight(
        params.projectId,
        query.runtime,
      );
    },
  );
  server.post("/api/projects/:projectId/threads/start", async (request) => {
    const params = projectParamsSchema.parse(request.params);
    if (request.isMultipart()) {
      const parsed = await parseMultipartChatInput(
        request,
        StartThreadMultipartMetadataSchema,
      );
      return await workspace.startThread(
        params.projectId,
        parsed.input,
        parsed.metadata.workspace,
        parsed.metadata.idempotencyKey,
        parsed.metadata.runtime,
      );
    }
    const body = StartThreadRequestSchema.parse(request.body);
    return await workspace.startThread(
      params.projectId,
      parseTextChatInput(body.prompt),
      body.workspace,
      body.idempotencyKey,
      body.runtime,
    );
  });

  server.get(
    "/api/projects/:projectId/threads/:threadId/continue/preflight",
    async (request) => {
      const params = threadParamsSchema.parse(request.params);
      return await workspace.preflightContinuation(
        params.projectId,
        params.threadId,
      );
    },
  );

  server.post(
    "/api/projects/:projectId/threads/:threadId/continue",
    async (request) => {
      const params = threadParamsSchema.parse(request.params);
      if (request.isMultipart()) {
        const parsed = await parseMultipartChatInput(
          request,
          ChatCommandMultipartMetadataSchema,
        );
        return await workspace.continueThread(
          params.projectId,
          params.threadId,
          parsed.input,
          parsed.metadata.idempotencyKey,
        );
      }
      const body = ContinueThreadRequestSchema.parse(request.body);
      return await workspace.continueThread(
        params.projectId,
        params.threadId,
        parseTextChatInput(body.prompt),
        body.idempotencyKey,
      );
    },
  );

  server.get(
    "/api/agent-backends",
    async () => await workspace.agentBackends(),
  );
  server.get("/api/projects/:projectId/sessions", async (request) => {
    const params = projectParamsSchema.parse(request.params);
    return await workspace.discoverSessions(params.projectId);
  });
  server.post("/api/projects/:projectId/threads/import", async (request) => {
    const params = projectParamsSchema.parse(request.params);
    const body = ImportThreadRequestSchema.parse(request.body);
    return {
      thread: await workspace.importThread(
        params.projectId,
        body.runtimeSessionId,
        body.title,
        body.idempotencyKey,
        body.runtime,
      ),
    };
  });
  server.patch("/api/projects/:projectId/threads/:threadId", (request) => {
    const params = threadParamsSchema.parse(request.params);
    const body = RenameThreadRequestSchema.parse(request.body);
    return {
      thread: workspace.renameThread(
        params.projectId,
        params.threadId,
        body.title,
        body.idempotencyKey,
      ),
    };
  });
  server.post(
    "/api/projects/:projectId/threads/:threadId/archive",
    async (request) => {
      const params = threadParamsSchema.parse(request.params);
      const body = ArchiveThreadRequestSchema.parse(request.body);
      return await workspace.archiveThread(
        params.projectId,
        params.threadId,
        body.idempotencyKey,
      );
    },
  );
  server.post(
    "/api/projects/:projectId/threads/:threadId/unarchive",
    async (request) => {
      const params = threadParamsSchema.parse(request.params);
      const body = UnarchiveThreadRequestSchema.parse(request.body);
      return await workspace.unarchiveThread(
        params.projectId,
        params.threadId,
        body.idempotencyKey,
      );
    },
  );
  // Deliberately not `/threads/archived`: that would sit under the
  // `:threadId` param route and depend on segment-priority rules to resolve.
  server.get("/api/projects/:projectId/archived-threads", async (request) => {
    const params = projectParamsSchema.parse(request.params);
    return { threads: await workspace.listArchivedThreads(params.projectId) };
  });
  server.get("/api/projects/:projectId/threads/:threadId", async (request) => {
    const params = threadParamsSchema.parse(request.params);
    return await workspace.snapshot(params.projectId, params.threadId);
  });
  server.get(
    "/api/projects/:projectId/threads/:threadId/images/:imageId",
    async (request) => {
      const params = imageParamsSchema.parse(request.params);
      return await workspace.readImage(
        params.projectId,
        params.threadId,
        params.imageId,
      );
    },
  );
  server.get(
    "/api/projects/:projectId/threads/:threadId/transcript",
    async (request) => {
      const params = threadParamsSchema.parse(request.params);
      const query = TranscriptPageQuerySchema.parse(request.query);
      return await workspace.olderTranscriptPage(
        params.projectId,
        params.threadId,
        query.cursor,
      );
    },
  );

  server.post(
    "/api/projects/:projectId/threads/:threadId/prompt",
    async (request) => {
      const params = threadParamsSchema.parse(request.params);
      if (request.isMultipart()) {
        const parsed = await parseMultipartChatInput(
          request,
          ChatCommandMultipartMetadataSchema,
        );
        return {
          run: await workspace.prompt(
            params.projectId,
            params.threadId,
            parsed.input,
            parsed.metadata.idempotencyKey,
          ),
        };
      }
      const body = PromptRequestSchema.parse(request.body);
      return {
        run: await workspace.prompt(
          params.projectId,
          params.threadId,
          parseTextChatInput(body.prompt),
          body.idempotencyKey,
        ),
      };
    },
  );
  server.post(
    "/api/projects/:projectId/threads/:threadId/steer",
    async (request) => {
      const params = threadParamsSchema.parse(request.params);
      if (request.isMultipart()) {
        const parsed = await parseMultipartChatInput(
          request,
          ChatCommandMultipartMetadataSchema,
        );
        return {
          run: await workspace.steer(
            params.projectId,
            params.threadId,
            parsed.input,
            parsed.metadata.idempotencyKey,
          ),
        };
      }
      const body = SteerRequestSchema.parse(request.body);
      return {
        run: await workspace.steer(
          params.projectId,
          params.threadId,
          parseTextChatInput(body.prompt),
          body.idempotencyKey,
        ),
      };
    },
  );
  server.post(
    "/api/projects/:projectId/threads/:threadId/stop",
    async (request) => {
      const params = threadParamsSchema.parse(request.params);
      const body = CommandRequestSchema.parse(request.body);
      return {
        run: await workspace.stop(
          params.projectId,
          params.threadId,
          body.idempotencyKey,
        ),
      };
    },
  );
  server.post(
    "/api/projects/:projectId/threads/:threadId/runs/:runId/viewed",
    (request) => {
      const params = runParamsSchema.parse(request.params);
      const body = CommandRequestSchema.parse(request.body);
      workspace.markViewed(
        params.projectId,
        params.threadId,
        params.runId,
        body.idempotencyKey,
      );
      return { viewed: true };
    },
  );

  server.get(
    "/api/projects/:projectId/threads/:threadId/files",
    async (request) => {
      const params = threadParamsSchema.parse(request.params);
      const query = fileQuerySchema.parse(request.query);
      const root = await workspace.requireThreadRoot(
        params.projectId,
        params.threadId,
      );
      // Containment is `listProjectFiles`' own first step, through the same
      // `resolveContained` this route used to call: the listed directory is
      // proven to be the execution root or under it before a single entry is
      // read, and entry paths come back relative to that root.
      return await listProjectFiles(root, {
        search: query.search,
        depth: query.depth,
        showIgnored: query.showIgnored,
        path: query.path,
      });
    },
  );
  server.get(
    "/api/projects/:projectId/threads/:threadId/file",
    async (request) => {
      const params = threadParamsSchema.parse(request.params);
      const query = z.object({ path: RelativePathSchema }).parse(request.query);
      return await previewProjectFile(
        await workspace.requireThreadRoot(params.projectId, params.threadId),
        query.path,
      );
    },
  );
  server.get(
    "/api/projects/:projectId/threads/:threadId/git/status",
    async (request) => {
      const params = threadParamsSchema.parse(request.params);
      return await getGitStatus(
        await workspace.requireThreadRoot(params.projectId, params.threadId),
      );
    },
  );
  server.get(
    "/api/projects/:projectId/threads/:threadId/git/diff",
    async (request) => {
      const params = threadParamsSchema.parse(request.params);
      const query = z.object({ path: RelativePathSchema }).parse(request.query);
      return await getGitDiff(
        await workspace.requireThreadRoot(params.projectId, params.threadId),
        query.path,
      );
    },
  );

  server.get("/api/live", { websocket: true }, (socket, request) => {
    try {
      requireSocketPolicy(request, server.workspaceContext);
    } catch {
      socket.close(1008, "Not permitted");
      return;
    }
    let unsubscribe: (() => void) | undefined;
    socket.on("message", (raw: RawData) => {
      try {
        const text = socketText(raw);
        if (Buffer.byteLength(text) > config.bodyLimit)
          throw new Error("frame_too_large");
        const command = LiveSubscribeSchema.parse(JSON.parse(text));
        if (workspace.store.getThreadById(command.threadId) === null)
          throw new Error("thread_not_found");
        unsubscribe?.();
        unsubscribe = broker.subscribe(
          command.threadId,
          socket,
          command.epoch,
          command.cursor,
        );
      } catch {
        socket.close(1008, "Malformed subscription");
      }
    });
    socket.on("close", () => unsubscribe?.());
  });

  // WSP-07: a reloaded browser reclaims its own shells by identity rather
  // than orphaning them, which it can only do if it can ask what is live.
  // The answer is scoped to the requesting thread's execution scope, and it
  // is a read, so it needs only the exact Host every other read needs.
  server.get(
    "/api/projects/:projectId/threads/:threadId/terminals",
    async (request) => {
      const params = threadParamsSchema.parse(request.params);
      const context = await workspace.threadExecutionContext(
        params.projectId,
        params.threadId,
      );
      return TerminalsResponseSchema.parse({
        terminals: terminals.list(context.projectId, context.scopeId),
      });
    },
  );

  server.get("/api/terminal", { websocket: true }, (socket, request) => {
    try {
      requireSocketPolicy(request, server.workspaceContext);
    } catch {
      socket.close(1008, "Not permitted");
      return;
    }
    let detach: (() => void) | undefined;
    socket.on("message", (raw: RawData) => {
      void (async () => {
        try {
          const text = socketText(raw);
          if (Buffer.byteLength(text) > config.bodyLimit)
            throw new Error("frame_too_large");
          const frame = TerminalClientFrameSchema.parse(JSON.parse(text));
          const context = await workspace.threadExecutionContext(
            frame.projectId,
            frame.threadId,
          );
          const root = context.executionRoot;
          const scopeId = context.scopeId;
          if (frame.type === "attach" || frame.type === "create") {
            detach?.();
            detach = await terminals.attach({
              projectId: frame.projectId,
              scopeId,
              executionRoot: root,
              attachment: {
                send: (message) => {
                  socket.send(JSON.stringify(message));
                },
              },
              // `create` never names a terminal, and `attach` names one only
              // when it is reclaiming that exact shell (WSP-07).
              terminalId:
                frame.type === "attach" ? frame.terminalId : undefined,
              cwd: frame.cwd,
            });
          } else if (frame.type === "input")
            terminals.input(
              frame.projectId,
              frame.terminalId,
              frame.data,
              scopeId,
            );
          else if (frame.type === "resize")
            terminals.resize(
              frame.projectId,
              frame.terminalId,
              frame.columns,
              frame.rows,
              scopeId,
            );
          else if (frame.type === "restart")
            await terminals.restart(
              frame.projectId,
              frame.terminalId,
              scopeId,
              frame.cwd,
            );
          else terminals.terminate(frame.projectId, frame.terminalId, scopeId);
        } catch (error) {
          // A typed rejection reaches the tab as its own state — the cap
          // message, the restart action, the refused directory — rather than
          // as one string it would have to match on prose (D-2). Everything
          // else stays the single opaque refusal it has always been.
          socket.send(JSON.stringify(terminalRefusal(error)));
        }
      })();
    });
    socket.on("close", () => detach?.());
  });

  if (config.production) {
    const webRoot = resolve(import.meta.dirname, "../../web/dist");
    if (!existsSync(webRoot))
      throw new Error("Built web application is missing");
    await server.register(staticPlugin, {
      root: webRoot,
      wildcard: false,
      setHeaders(response) {
        response.raw.setHeader(
          "Content-Security-Policy",
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws:; img-src 'self' data: blob:; frame-ancestors 'none'; base-uri 'none'",
        );
        response.raw.setHeader("X-Frame-Options", "DENY");
        response.raw.setHeader("Referrer-Policy", "no-referrer");
      },
    });
    server.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith("/api/"))
        return await reply.code(404).send({
          error: { code: "not_found", message: "Endpoint was not found." },
        });
      return await reply.sendFile("index.html");
    });
  }

  return server;
}
