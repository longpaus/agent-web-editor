import { existsSync } from "node:fs";
import { resolve } from "node:path";

import staticPlugin from "@fastify/static";
import websocket from "@fastify/websocket";
import { RuntimeFailure, type AgentRuntime } from "@pi-web/agent-runtime";
import type { RawData } from "ws";
import {
  ArchiveThreadRequestSchema,
  BrowseProjectRequestSchema,
  CommandRequestSchema,
  ImportThreadRequestSchema,
  LiveSubscribeSchema,
  ProjectIdSchema,
  PromptRequestSchema,
  RelativePathSchema,
  RemoveProjectRequestSchema,
  RenameThreadRequestSchema,
  RunIdSchema,
  StartThreadRequestSchema,
  SteerRequestSchema,
  TerminalClientFrameSchema,
  ThreadIdSchema,
  TranscriptPageRequestSchema,
  UpdateProjectRequestSchema,
} from "@pi-web/contracts";
import { PiAgentRuntime } from "@pi-web/pi-adapter";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { z, ZodError } from "zod";

import {
  checkHost,
  checkOrigin,
  enforceRequestPolicy,
} from "./request-policy.js";
import { parseConfig, type ServerConfig } from "./config.js";
import { MetadataStore, ReceiptConflictError } from "./db/store.js";
import {
  createNativeDirectoryPicker,
  type DirectoryPicker,
} from "./directory-picker/native.js";
import { WorkspaceService } from "./domain/workspace.js";
import { previewProjectFile, listProjectFiles } from "./inspector/files.js";
import { getGitDiff, getGitStatus } from "./inspector/git.js";
import { LiveBroker } from "./live/broker.js";
import { ProjectTerminalManager, type PtyFactory } from "./terminal/manager.js";

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
const fileQuerySchema = z.object({
  path: z.string().default(""),
  search: z.string().max(500).default(""),
});

export interface BuildServerOptions {
  config?: ServerConfig;
  store?: MetadataStore;
  runtime?: AgentRuntime;
  ptyFactory?: PtyFactory;
  directoryPicker?: DirectoryPicker;
  logger?: boolean;
}

export interface ServerContext {
  config: ServerConfig;
  store: MetadataStore;
  workspace: WorkspaceService;
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
  if (error instanceof RuntimeFailure && error.code === "stale")
    return {
      status: 409,
      code: "stale_transcript_cursor",
      message: "The saved transcript position is no longer available.",
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
        message: "The selected item is not a directory.",
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
      run_not_active: {
        status: 409,
        code: "run_not_active",
        message: "There is no matching active run.",
      },
      prompt_rejected: {
        status: 409,
        code: "prompt_rejected",
        message: "The runtime rejected this prompt.",
      },
      path_escape: {
        status: 400,
        code: "invalid_path",
        message: "The requested path is not permitted.",
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
    options.runtime ?? new PiAgentRuntime(undefined, config.namingModel),
    broker,
    terminals,
  );
  const directoryPicker =
    options.directoryPicker ?? createNativeDirectoryPicker();
  const launchPort = config.production ? config.port : config.devPort;
  const launchUrl = `http://127.0.0.1:${String(launchPort)}/`;
  const context: ServerContext = { config, store, workspace, launchUrl };
  const server: WorkspaceServer = Object.assign(
    Fastify({ logger: options.logger ?? true, bodyLimit: config.bodyLimit }),
    { workspaceContext: context },
  );

  await server.register(websocket, {
    options: { maxPayload: config.bodyLimit },
  });
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
      return await workspace.workspacePreflight(params.projectId);
    },
  );
  server.post("/api/projects/:projectId/threads/start", async (request) => {
    const params = projectParamsSchema.parse(request.params);
    const body = StartThreadRequestSchema.parse(request.body);
    return await workspace.startThread(
      params.projectId,
      body.prompt,
      body.workspace,
      body.idempotencyKey,
    );
  });

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
  server.get("/api/projects/:projectId/threads/:threadId", async (request) => {
    const params = threadParamsSchema.parse(request.params);
    return await workspace.snapshot(params.projectId, params.threadId);
  });
  server.get(
    "/api/projects/:projectId/threads/:threadId/metadata",
    (request) => {
      const params = threadParamsSchema.parse(request.params);
      return workspace.threadLiveMetadata(params.projectId, params.threadId);
    },
  );
  server.get(
    "/api/projects/:projectId/threads/:threadId/transcript",
    async (request) => {
      const params = threadParamsSchema.parse(request.params);
      const query = TranscriptPageRequestSchema.parse(request.query);
      return await workspace.transcriptPage(
        params.projectId,
        params.threadId,
        query,
      );
    },
  );

  server.post(
    "/api/projects/:projectId/threads/:threadId/prompt",
    async (request) => {
      const params = threadParamsSchema.parse(request.params);
      const body = PromptRequestSchema.parse(request.body);
      return {
        run: await workspace.prompt(
          params.projectId,
          params.threadId,
          body.prompt,
          body.idempotencyKey,
        ),
      };
    },
  );
  server.post(
    "/api/projects/:projectId/threads/:threadId/steer",
    async (request) => {
      const params = threadParamsSchema.parse(request.params);
      const body = SteerRequestSchema.parse(request.body);
      return {
        run: await workspace.steer(
          params.projectId,
          params.threadId,
          body.prompt,
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
      if (query.path !== "") RelativePathSchema.parse(query.path);
      const target =
        query.path === ""
          ? root
          : (
              await (
                await import("./inspector/files.js")
              ).resolveContained(root, query.path, true)
            ).target;
      return await listProjectFiles(target, query.search);
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
          if (frame.type === "attach") {
            detach?.();
            detach = await terminals.attach(
              frame.projectId,
              root,
              {
                send: (message) => {
                  socket.send(JSON.stringify(message));
                },
              },
              scopeId,
            );
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
            await terminals.restart(frame.projectId, frame.terminalId, scopeId);
          else terminals.terminate(frame.projectId, frame.terminalId, scopeId);
        } catch {
          socket.send(
            JSON.stringify({
              version: 1,
              type: "error",
              message: "Terminal command was rejected.",
            }),
          );
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
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws:; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'",
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
