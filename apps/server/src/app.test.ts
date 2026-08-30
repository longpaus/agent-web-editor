import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type {
  AgentRuntime,
  OpenRuntimeSession,
  PromptAcceptance,
  RuntimeImageContent,
  RuntimeSnapshot,
} from "@pi-web/agent-runtime";
import {
  ArchiveThreadResponseSchema,
  ArchivedThreadsResponseSchema,
  UnarchiveThreadResponseSchema,
  BrowseProjectResponseSchema,
  ChatImageIdSchema,
  ChatImageResponseSchema,
  FilePreviewResponseSchema,
  FileTreeResponseSchema,
  GitDiffResponseSchema,
  GitStatusResponseSchema,
  ProjectMutationResponseSchema,
  ProjectsResponseSchema,
  AgentBackendsResponseSchema,
  StartThreadResponseSchema,
  ThreadSnapshotSchema,
  TranscriptPageSchema,
  TerminalServerFrameSchema,
  TerminalsResponseSchema,
  type ChatImageId,
  type TerminalServerFrame,
} from "@pi-web/contracts";
import { WebSocket, type RawData } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildServer } from "./app.js";
import { parseTextChatInput } from "./chat-images.js";
import type { DirectoryPicker } from "./directory-picker/native.js";
import { parseConfig } from "./config.js";
import type { PtyFactory, PtyProcess } from "./terminal/manager.js";
import { GitWorktreeManager } from "./worktrees/manager.js";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

class FakeRuntime implements AgentRuntime {
  public discover() {
    return Promise.resolve({ sessions: [], diagnostics: [] });
  }
  public create() {
    return Promise.resolve({
      sessionId: "10000000-0000-4000-8000-000000000001",
    });
  }
  public open(): Promise<OpenRuntimeSession> {
    return Promise.reject(new Error("not used"));
  }
}

class ImageCapabilityRuntime extends FakeRuntime {
  public constructor(
    private readonly capability: "supported" | "unsupported" | "unknown",
  ) {
    super();
  }

  public inspectImageInput() {
    return Promise.resolve(this.capability);
  }
}

class PromptingSession implements OpenRuntimeSession {
  public readonly id = "10000000-0000-4000-8000-000000000001";

  public snapshot(): Promise<RuntimeSnapshot> {
    return Promise.resolve({
      sessionId: this.id,
      transcript: [],
      diagnostics: [],
    });
  }

  public prompt(): Promise<PromptAcceptance> {
    return Promise.resolve({
      accepted: true,
      settlement: new Promise<"completed" | "failed" | "interrupted">(
        () => undefined,
      ),
      releaseEvents: () => undefined,
      discardEvents: () => undefined,
    });
  }

  public recoverPrompt() {
    return Promise.resolve({ outcome: "not_accepted" } as const);
  }

  public steer(): Promise<void> {
    return Promise.resolve();
  }

  public readImage(imageId: ChatImageId): Promise<RuntimeImageContent> {
    const expected = ChatImageIdSchema.parse("a".repeat(64));
    return imageId === expected
      ? Promise.resolve({
          id: expected,
          mimeType: "image/png",
          data: "iVBORw0KGgo=",
        })
      : Promise.reject(new Error("chat_image_not_found"));
  }

  public stop(): Promise<void> {
    return Promise.resolve();
  }

  public subscribe(): () => void {
    return () => undefined;
  }

  public dispose(): Promise<void> {
    return Promise.resolve();
  }
}

class PromptingRuntime implements AgentRuntime {
  private readonly session = new PromptingSession();
  public createdPath: string | null = null;
  public createdTitle: string | null = null;
  public openedPath: string | null = null;
  public createCount = 0;
  public namingCount = 0;

  public suggestTitle(): Promise<{ outcome: "available"; title: string }> {
    this.namingCount += 1;
    return Promise.resolve({
      outcome: "available",
      title: "Implement thread workspaces",
    });
  }

  public discover(): Promise<{
    sessions: [];
    diagnostics: [];
  }> {
    return Promise.resolve({ sessions: [], diagnostics: [] });
  }

  public create(path: string, title?: string): Promise<{ sessionId: string }> {
    this.createCount += 1;
    this.createdPath = path;
    this.createdTitle = title ?? null;
    return Promise.resolve({ sessionId: this.session.id });
  }

  public open(path: string): Promise<OpenRuntimeSession> {
    this.openedPath = path;
    return Promise.resolve(this.session);
  }
}

class HistorySession extends PromptingSession {
  public override snapshot(): Promise<RuntimeSnapshot> {
    return Promise.resolve({
      sessionId: this.id,
      transcript: Array.from({ length: 250 }, (_, index) => ({
        id: `message-${String(index)}`,
        kind: "message" as const,
        role: "assistant" as const,
        text: `message ${String(index)}`,
        timestamp: null,
      })),
      diagnostics: [],
    });
  }
}

class HistoryRuntime extends PromptingRuntime {
  private readonly history = new HistorySession();

  public override open(path: string): Promise<OpenRuntimeSession> {
    this.openedPath = path;
    return Promise.resolve(this.history);
  }
}

async function directories(): Promise<{ state: string; project: string }> {
  const root = await mkdtemp(join(tmpdir(), "pi-web-http-"));
  roots.push(root);
  const state = join(root, "state");
  const project = join(root, "project");
  await mkdir(state, { mode: 0o700 });
  await mkdir(project);
  return { state, project };
}

const host = "127.0.0.1:3001";
const origin = "http://127.0.0.1:5173";

function png(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

function multipartChatRequest(
  metadata: unknown,
  image: Buffer,
): { boundary: string; body: Buffer } {
  const boundary = "pi-web-app-image-boundary";
  return {
    boundary,
    body: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n${JSON.stringify(metadata)}\r\n`,
      ),
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="images"; filename="photo.png"\r\nContent-Type: image/png\r\n\r\n`,
      ),
      image,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}

describe("credential-free project API", () => {
  it("checks image support on the runtime selected by workspace preflight", async () => {
    const paths = await directories();
    const config = parseConfig({
      argv: [],
      environment: { PI_WEB_STATE_DIR: paths.state },
    });
    const server = await buildServer({
      config,
      runtimes: {
        pi: new ImageCapabilityRuntime("unsupported"),
        codex: new ImageCapabilityRuntime("supported"),
      },
      logger: false,
    });
    const project =
      await server.workspaceContext.workspace.registerSelectedProject(
        paths.project,
      );
    const response = await server.inject({
      method: "GET",
      url: `/api/projects/${project.id}/workspace-preflight?runtime=codex`,
      headers: { host },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ imageInput: "supported" });
    await server.close();
  });

  it("returns one bounded latest page and loads older history by opaque cursor", async () => {
    const paths = await directories();
    const config = parseConfig({
      argv: [],
      environment: { PI_WEB_STATE_DIR: paths.state },
    });
    const server = await buildServer({
      config,
      runtime: new HistoryRuntime(),
      logger: false,
    });
    const project =
      await server.workspaceContext.workspace.registerSelectedProject(
        paths.project,
      );
    const thread = await server.workspaceContext.workspace.createThread(
      project.id,
    );

    const snapshotResponse = await server.inject({
      method: "GET",
      url: `/api/projects/${project.id}/threads/${thread.id}`,
      headers: { host },
    });
    const snapshot = ThreadSnapshotSchema.parse(snapshotResponse.json());
    expect(snapshot.version).toBe(2);
    expect(snapshot.transcriptPage.items).toHaveLength(100);
    expect(snapshot.transcriptPage.items[0]?.id).toBe("message-150");
    expect(snapshot.transcriptPage.olderCursor).not.toBeNull();
    const cursor = snapshot.transcriptPage.olderCursor;
    if (cursor === null) throw new Error("Expected an older page");

    const olderResponse = await server.inject({
      method: "GET",
      url: `/api/projects/${project.id}/threads/${thread.id}/transcript?cursor=${encodeURIComponent(cursor)}`,
      headers: { host },
    });
    expect(olderResponse.statusCode).toBe(200);
    const older = TranscriptPageSchema.parse(olderResponse.json());
    expect(older.items).toHaveLength(100);
    expect(older.items[0]?.id).toBe("message-50");
    await server.close();
  });

  it("creates and names a shared thread from its first prompt", async () => {
    const paths = await directories();
    const config = parseConfig({
      argv: [],
      environment: { PI_WEB_STATE_DIR: paths.state },
    });
    const runtime = new PromptingRuntime();
    const server = await buildServer({ config, runtime, logger: false });
    const project =
      await server.workspaceContext.workspace.registerSelectedProject(
        paths.project,
      );
    const response = await server.inject({
      method: "POST",
      url: `/api/projects/${project.id}/threads/start`,
      headers: { host, origin, "x-pi-web-request": "1" },
      payload: {
        prompt: "Build thread worktree support",
        workspace: { mode: "shared" },
        idempotencyKey: "00000000-0000-4000-8000-000000000010",
      },
    });
    expect(response.statusCode).toBe(200);
    const parsed = StartThreadResponseSchema.parse(response.json());
    expect(parsed.thread.title).toBe("Implement thread workspaces");
    expect(parsed.thread.workspace.mode).toBe("shared");
    expect(parsed.run.state).toBe("running");
    const retry = await server.inject({
      method: "POST",
      url: `/api/projects/${project.id}/threads/start`,
      headers: { host, origin, "x-pi-web-request": "1" },
      payload: {
        prompt: "Build thread worktree support",
        workspace: { mode: "shared" },
        idempotencyKey: "00000000-0000-4000-8000-000000000010",
      },
    });
    expect(StartThreadResponseSchema.parse(retry.json())).toEqual(parsed);
    expect(runtime.namingCount).toBe(1);
    expect(runtime.createCount).toBe(1);
    await server.close();
  });

  it("keeps multipart retry identity content-aware", async () => {
    const paths = await directories();
    const config = parseConfig({
      argv: [],
      environment: { PI_WEB_STATE_DIR: paths.state },
    });
    const runtime = new PromptingRuntime();
    const server = await buildServer({ config, runtime, logger: false });
    const project =
      await server.workspaceContext.workspace.registerSelectedProject(
        paths.project,
      );
    const metadata = {
      prompt: "Inspect this",
      workspace: { mode: "shared" },
      idempotencyKey: "00000000-0000-4000-8000-000000000020",
    };
    const firstPayload = multipartChatRequest(metadata, png(1, 1));
    const request = async (payload: { boundary: string; body: Buffer }) =>
      await server.inject({
        method: "POST",
        url: `/api/projects/${project.id}/threads/start`,
        headers: {
          host,
          origin,
          "x-pi-web-request": "1",
          "content-type": `multipart/form-data; boundary=${payload.boundary}`,
        },
        payload: payload.body,
      });

    const first = await request(firstPayload);
    expect(first.statusCode).toBe(200);
    const retry = await request(firstPayload);
    expect(StartThreadResponseSchema.parse(retry.json())).toEqual(
      StartThreadResponseSchema.parse(first.json()),
    );
    expect(runtime.createCount).toBe(1);

    const changed = await request(multipartChatRequest(metadata, png(2, 1)));
    expect(changed.statusCode).toBe(409);
    expect(changed.json()).toMatchObject({
      error: { code: "idempotency_conflict" },
    });
    await server.close();
  });

  it("continues to reject an empty text-only JSON command", async () => {
    const paths = await directories();
    const config = parseConfig({
      argv: [],
      environment: { PI_WEB_STATE_DIR: paths.state },
    });
    const server = await buildServer({
      config,
      runtime: new PromptingRuntime(),
      logger: false,
    });
    const project =
      await server.workspaceContext.workspace.registerSelectedProject(
        paths.project,
      );
    const response = await server.inject({
      method: "POST",
      url: `/api/projects/${project.id}/threads/start`,
      headers: { host, origin, "x-pi-web-request": "1" },
      payload: {
        prompt: "",
        workspace: { mode: "shared" },
        idempotencyKey: "00000000-0000-4000-8000-000000000021",
      },
    });
    expect(response.statusCode).toBe(400);
    await server.close();
  });

  it("serves a native conversation image only through an authorized thread", async () => {
    const paths = await directories();
    const config = parseConfig({
      argv: [],
      environment: { PI_WEB_STATE_DIR: paths.state },
    });
    const server = await buildServer({
      config,
      runtime: new PromptingRuntime(),
      logger: false,
    });
    const project =
      await server.workspaceContext.workspace.registerSelectedProject(
        paths.project,
      );
    const start = await server.inject({
      method: "POST",
      url: `/api/projects/${project.id}/threads/start`,
      headers: { host, origin, "x-pi-web-request": "1" },
      payload: {
        prompt: "Inspect an image",
        workspace: { mode: "shared" },
        idempotencyKey: "00000000-0000-4000-8000-000000000019",
      },
    });
    const thread = StartThreadResponseSchema.parse(start.json()).thread;
    const imageId = "a".repeat(64);
    const response = await server.inject({
      method: "GET",
      url: `/api/projects/${project.id}/threads/${thread.id}/images/${imageId}`,
      headers: { host },
    });
    expect(response.statusCode).toBe(200);
    expect(ChatImageResponseSchema.parse(response.json())).toEqual({
      id: imageId,
      mimeType: "image/png",
      data: "iVBORw0KGgo=",
    });
    const absent = await server.inject({
      method: "GET",
      url: `/api/projects/${project.id}/threads/${thread.id}/images/${"b".repeat(64)}`,
      headers: { host },
    });
    expect(absent.statusCode).toBe(404);
    await server.close();
  });

  // WSP-05 as revised by specification version 2: the listing route gained a
  // depth bound and an ignore opt-in. Both are client-supplied strings, so
  // both are parsed rather than interpreted.
  it("bounds the file listing by depth and honours ignore rules", async () => {
    const paths = await directories();
    await mkdir(join(paths.project, "node_modules", "dep"), {
      recursive: true,
    });
    await mkdir(join(paths.project, "src"));
    await mkdir(join(paths.project, ".git"));
    await writeFile(join(paths.project, ".gitignore"), "node_modules\n");
    await writeFile(join(paths.project, "README.md"), "# The project\n");
    await writeFile(join(paths.project, "src", "main.ts"), "export const a=1;");
    await writeFile(
      join(paths.project, "node_modules", "dep", "README.md"),
      "# A dependency\n",
    );
    await writeFile(join(paths.project, ".git", "config"), "[core]\n");

    const config = parseConfig({
      argv: [],
      environment: { PI_WEB_STATE_DIR: paths.state },
    });
    const server = await buildServer({
      config,
      runtime: new PromptingRuntime(),
      logger: false,
    });
    const project =
      await server.workspaceContext.workspace.registerSelectedProject(
        paths.project,
      );
    const start = await server.inject({
      method: "POST",
      url: `/api/projects/${project.id}/threads/start`,
      headers: { host, origin, "x-pi-web-request": "1" },
      payload: {
        prompt: "Browse the files",
        workspace: { mode: "shared" },
        idempotencyKey: "00000000-0000-4000-8000-000000000031",
      },
    });
    const thread = StartThreadResponseSchema.parse(start.json()).thread;
    const base = `/api/projects/${project.id}/threads/${thread.id}/files`;
    const list = async (query: string) => {
      const response = await server.inject({
        method: "GET",
        url: `${base}${query}`,
        headers: { host },
      });
      const body: unknown = response.json();
      return { status: response.statusCode, body };
    };

    const oneLevel = await list("?depth=1");
    expect(oneLevel.status).toBe(200);
    const shallow = FileTreeResponseSchema.parse(oneLevel.body);
    expect(shallow.entries.map((entry) => entry.path)).toEqual([
      "src",
      ".gitignore",
      "README.md",
    ]);
    expect(shallow.ignoredHidden).toBe(true);

    // No `depth` at all is the whole recursive listing, exactly as before.
    const full = FileTreeResponseSchema.parse((await list("")).body);
    expect(full.entries.map((entry) => entry.path)).toContain("src/main.ts");

    // The scenario the milestone exists for.
    const search = FileTreeResponseSchema.parse(
      (await list("?search=README.md")).body,
    );
    expect(search.entries.map((entry) => entry.path)).toEqual(["README.md"]);

    const revealed = FileTreeResponseSchema.parse(
      (await list("?depth=1&showIgnored=true")).body,
    );
    expect(revealed.entries.map((entry) => entry.path)).toContain(
      "node_modules",
    );
    // The opt-in reveals ignored paths; `.git` is not one of them.
    expect(revealed.entries.map((entry) => entry.path)).not.toContain(".git");
    expect(revealed.ignoredHidden).toBe(false);

    // A nested listing addresses the same root-relative paths.
    const nested = FileTreeResponseSchema.parse(
      (await list("?depth=1&path=src")).body,
    );
    expect(nested.entries.map((entry) => entry.path)).toEqual(["src/main.ts"]);

    for (const rejected of [
      "?depth=2",
      "?depth=full%20",
      "?depth=",
      "?showIgnored=1",
      "?showIgnored=TRUE",
      "?depth=1&path=../escape",
    ]) {
      expect((await list(rejected)).status).toBe(400);
    }

    // The filter used to be applied to entries encountered while walking and
    // never to the requested root, so a directory with no row to click was
    // reachable by asking for it (H2). Each of these answered 200.
    const excluded = await list("?path=.git&depth=1");
    expect(excluded.status).toBe(403);
    expect(excluded.body).toEqual({
      error: {
        code: "path_excluded",
        message: "The requested path is not available.",
      },
    });
    expect((await list("?path=.git/config&depth=1")).status).toBe(403);
    expect((await list("?path=.git&depth=1&showIgnored=true")).status).toBe(
      403,
    );
    const ignoredRoot = await list("?path=node_modules&depth=1");
    expect(ignoredRoot.status).toBe(403);
    expect(ignoredRoot.body).toEqual({
      error: {
        code: "path_ignored",
        message:
          "The requested path is hidden by this workspace's ignore rules.",
      },
    });
    // ...and the opt-in that reveals it in a listing also opens it.
    expect(
      (await list("?path=node_modules&depth=1&showIgnored=true")).status,
    ).toBe(200);

    // A directory that was expanded, persisted, and then deleted (H6). This
    // answered 500 `internal_error`, which says nothing a client can act on.
    const missing = await list("?path=does/not/exist&depth=1");
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({
      error: {
        code: "path_not_found",
        message: "The requested path was not found.",
      },
    });
    expect((await list("?path=README.md&depth=1")).status).toBe(400);
    // Containment itself was never at fault and stays where it was.
    expect((await list("?path=../../../etc&depth=1")).status).toBe(400);

    const read = async (query: string) => {
      const response = await server.inject({
        method: "GET",
        url: `/api/projects/${project.id}/threads/${thread.id}/file${query}`,
        headers: { host },
      });
      return response.statusCode;
    };
    // `.git/config` returned the file, remote URL and all.
    expect(await read("?path=.git/config")).toBe(403);
    expect(await read("?path=does/not/exist")).toBe(404);
    expect(await read("?path=src")).toBe(400);
    await server.close();
  });

  it("creates a clean isolated thread and runs Pi in its worktree", async () => {
    const paths = await directories();
    await exec("git", ["init", "-b", "main"], { cwd: paths.project });
    await exec("git", ["config", "user.email", "test@example.invalid"], {
      cwd: paths.project,
    });
    await exec("git", ["config", "user.name", "Test"], {
      cwd: paths.project,
    });
    await writeFile(join(paths.project, "tracked.txt"), "committed\n");
    await exec("git", ["add", "."], { cwd: paths.project });
    await exec("git", ["commit", "-m", "initial"], { cwd: paths.project });
    await writeFile(join(paths.project, "tracked.txt"), "dirty\n");
    const runtime = new PromptingRuntime();
    const config = parseConfig({
      argv: [],
      environment: { PI_WEB_STATE_DIR: paths.state },
    });
    const server = await buildServer({ config, runtime, logger: false });
    const project =
      await server.workspaceContext.workspace.registerSelectedProject(
        paths.project,
      );
    const preflight = await server.inject({
      method: "GET",
      url: `/api/projects/${project.id}/workspace-preflight`,
      headers: { host },
    });
    expect(preflight.statusCode).toBe(200);
    const response = await server.inject({
      method: "POST",
      url: `/api/projects/${project.id}/threads/start`,
      headers: { host, origin, "x-pi-web-request": "1" },
      payload: {
        prompt: "Build isolated worktrees",
        workspace: {
          mode: "worktree",
          baseBranch: "main",
          sourceChanges: "none",
        },
        idempotencyKey: "00000000-0000-4000-8000-000000000011",
      },
    });
    expect(response.statusCode).toBe(200);
    const parsed = StartThreadResponseSchema.parse(response.json());
    expect(parsed.thread.workspace.mode).toBe("worktree");
    expect(runtime.createdPath).toContain(join("worktrees", project.id));
    expect(runtime.createdPath).not.toBe(paths.project);
    expect(runtime.openedPath).toBe(runtime.createdPath);
    expect(runtime.createdTitle).toBe("Implement thread workspaces");
    await server.close();
  });

  it("recovers a failed isolated provisioning retry only after proving its stored identity", async () => {
    const paths = await directories();
    await exec("git", ["init", "-b", "main"], { cwd: paths.project });
    await exec("git", ["config", "user.email", "test@example.invalid"], {
      cwd: paths.project,
    });
    await exec("git", ["config", "user.name", "Test"], {
      cwd: paths.project,
    });
    await writeFile(join(paths.project, "tracked.txt"), "committed\n");
    await exec("git", ["add", "."], { cwd: paths.project });
    await exec("git", ["commit", "-m", "initial"], { cwd: paths.project });
    const provision = vi
      .spyOn(GitWorktreeManager.prototype, "provision")
      .mockRejectedValueOnce(new Error("provision_failed"));
    const runtime = new PromptingRuntime();
    const server = await buildServer({
      config: parseConfig({
        argv: [],
        environment: { PI_WEB_STATE_DIR: paths.state },
      }),
      runtime,
      logger: false,
    });
    const project =
      await server.workspaceContext.workspace.registerSelectedProject(
        paths.project,
      );
    const payload = {
      prompt: "Recover an isolated worktree",
      workspace: {
        mode: "worktree" as const,
        baseBranch: "main",
        sourceChanges: "none" as const,
      },
      idempotencyKey: "00000000-0000-4000-8000-000000000016",
    };
    const first = await server.inject({
      method: "POST",
      url: `/api/projects/${project.id}/threads/start`,
      headers: { host, origin, "x-pi-web-request": "1" },
      payload,
    });
    expect(first.statusCode).toBe(500);
    const creation = server.workspaceContext.store.getThreadCreation(
      project.id,
      payload.idempotencyKey,
    );
    if (creation?.worktree_id === undefined || creation.worktree_id === null)
      throw new Error("failed worktree creation was not stored");
    expect(creation.state).toBe("failed");
    expect(
      server.workspaceContext.store.getWorktree(creation.worktree_id)?.state,
    ).toBe("failed");
    expect(runtime.createCount).toBe(0);

    const retry = await server.inject({
      method: "POST",
      url: `/api/projects/${project.id}/threads/start`,
      headers: { host, origin, "x-pi-web-request": "1" },
      payload,
    });
    expect(retry.statusCode).toBe(200);
    const parsed = StartThreadResponseSchema.parse(retry.json());
    const recovered = server.workspaceContext.store.getThreadCreation(
      project.id,
      payload.idempotencyKey,
    );
    expect(recovered?.state).toBe("prompt_accepted");
    expect(parsed.thread.id).toBe(recovered?.thread_id);
    expect(runtime.createCount).toBe(1);
    expect(provision).toHaveBeenCalledTimes(2);
    await server.close();
    provision.mockRestore();
  });

  it("retains a failed isolated creation when recovery proof fails", async () => {
    const paths = await directories();
    await exec("git", ["init", "-b", "main"], { cwd: paths.project });
    await exec("git", ["config", "user.email", "test@example.invalid"], {
      cwd: paths.project,
    });
    await exec("git", ["config", "user.name", "Test"], {
      cwd: paths.project,
    });
    await writeFile(join(paths.project, "tracked.txt"), "committed\n");
    await exec("git", ["add", "."], { cwd: paths.project });
    await exec("git", ["commit", "-m", "initial"], { cwd: paths.project });
    const provision = vi
      .spyOn(GitWorktreeManager.prototype, "provision")
      .mockRejectedValueOnce(new Error("provision_failed"));
    const runtime = new PromptingRuntime();
    const server = await buildServer({
      config: parseConfig({
        argv: [],
        environment: { PI_WEB_STATE_DIR: paths.state },
      }),
      runtime,
      logger: false,
    });
    const project =
      await server.workspaceContext.workspace.registerSelectedProject(
        paths.project,
      );
    const payload = {
      prompt: "Reject unproven recovery",
      workspace: {
        mode: "worktree" as const,
        baseBranch: "main",
        sourceChanges: "none" as const,
      },
      idempotencyKey: "00000000-0000-4000-8000-000000000017",
    };
    await server.inject({
      method: "POST",
      url: `/api/projects/${project.id}/threads/start`,
      headers: { host, origin, "x-pi-web-request": "1" },
      payload,
    });
    const recoveryPlan = vi
      .spyOn(GitWorktreeManager.prototype, "recoveryPlan")
      .mockRejectedValueOnce(new Error("worktree_identity_failed"));
    const retry = await server.inject({
      method: "POST",
      url: `/api/projects/${project.id}/threads/start`,
      headers: { host, origin, "x-pi-web-request": "1" },
      payload,
    });
    expect(retry.statusCode).toBe(409);
    expect(
      server.workspaceContext.store.getThreadCreation(
        project.id,
        payload.idempotencyKey,
      )?.state,
    ).toBe("failed");
    expect(runtime.createCount).toBe(0);
    await server.close();
    recoveryPlan.mockRestore();
    provision.mockRestore();
  });

  it("requires a thread and scopes inspector endpoints to its worktree", async () => {
    const paths = await directories();
    await exec("git", ["init", "-b", "main"], { cwd: paths.project });
    await exec("git", ["config", "user.email", "test@example.invalid"], {
      cwd: paths.project,
    });
    await exec("git", ["config", "user.name", "Test"], {
      cwd: paths.project,
    });
    await writeFile(join(paths.project, "tracked.txt"), "committed\n");
    await exec("git", ["add", "."], { cwd: paths.project });
    await exec("git", ["commit", "-m", "initial"], { cwd: paths.project });
    await writeFile(join(paths.project, "tracked.txt"), "source only\n");
    await writeFile(join(paths.project, "source-only.txt"), "source only\n");

    const runtime = new PromptingRuntime();
    const config = parseConfig({
      argv: [],
      environment: { PI_WEB_STATE_DIR: paths.state },
    });
    const server = await buildServer({ config, runtime, logger: false });
    const project =
      await server.workspaceContext.workspace.registerSelectedProject(
        paths.project,
      );
    const start = await server.inject({
      method: "POST",
      url: `/api/projects/${project.id}/threads/start`,
      headers: { host, origin, "x-pi-web-request": "1" },
      payload: {
        prompt: "Inspect an isolated worktree",
        workspace: {
          mode: "worktree",
          baseBranch: "main",
          sourceChanges: "none",
        },
        idempotencyKey: "00000000-0000-4000-8000-000000000012",
      },
    });
    const thread = StartThreadResponseSchema.parse(start.json()).thread;

    const files = await server.inject({
      method: "GET",
      url: `/api/projects/${project.id}/threads/${thread.id}/files?search=source-only`,
      headers: { host },
    });
    expect(files.statusCode).toBe(200);
    expect(FileTreeResponseSchema.parse(files.json()).entries).toEqual([]);

    const file = await server.inject({
      method: "GET",
      url: `/api/projects/${project.id}/threads/${thread.id}/file?path=tracked.txt`,
      headers: { host },
    });
    expect(file.statusCode).toBe(200);
    expect(FilePreviewResponseSchema.parse(file.json()).content).toBe(
      "committed\n",
    );

    const status = await server.inject({
      method: "GET",
      url: `/api/projects/${project.id}/threads/${thread.id}/git/status`,
      headers: { host },
    });
    expect(status.statusCode).toBe(200);
    expect(GitStatusResponseSchema.parse(status.json()).files).toEqual([]);

    if (runtime.createdPath === null)
      throw new Error("worktree was not created");
    await writeFile(join(runtime.createdPath, "tracked.txt"), "thread only\n");
    const diff = await server.inject({
      method: "GET",
      url: `/api/projects/${project.id}/threads/${thread.id}/git/diff?path=tracked.txt`,
      headers: { host },
    });
    expect(diff.statusCode).toBe(200);
    expect(GitDiffResponseSchema.parse(diff.json()).unstaged).toContain(
      "+thread only",
    );

    for (const url of [
      `/api/projects/${project.id}/files`,
      `/api/projects/${project.id}/file?path=tracked.txt`,
      `/api/projects/${project.id}/git/status`,
      `/api/projects/${project.id}/git/diff?path=tracked.txt`,
    ]) {
      const response = await server.inject({
        method: "GET",
        url,
        headers: { host },
      });
      expect(response.statusCode).toBe(404);
    }
    await server.close();
  });

  it("does not expose the legacy empty-thread creation route", async () => {
    const paths = await directories();
    const config = parseConfig({
      argv: [],
      environment: { PI_WEB_STATE_DIR: paths.state },
    });
    const server = await buildServer({
      config,
      runtime: new PromptingRuntime(),
      logger: false,
    });
    const project =
      await server.workspaceContext.workspace.registerSelectedProject(
        paths.project,
      );

    const response = await server.inject({
      method: "POST",
      url: `/api/projects/${project.id}/threads`,
      headers: { host, origin, "x-pi-web-request": "1" },
      payload: { idempotencyKey: "00000000-0000-4000-8000-000000000099" },
    });

    expect(response.statusCode).toBe(404);
    await server.close();
  });

  it("archives a thread through a strict idempotent endpoint", async () => {
    const paths = await directories();
    const config = parseConfig({
      argv: [],
      environment: { PI_WEB_STATE_DIR: paths.state },
    });
    const server = await buildServer({
      config,
      runtime: new FakeRuntime(),
      logger: false,
    });
    const project =
      await server.workspaceContext.workspace.registerSelectedProject(
        paths.project,
      );
    const thread = await server.workspaceContext.workspace.createThread(
      project.id,
    );
    const url = `/api/projects/${project.id}/threads/${thread.id}/archive`;
    const headers = { host, origin, "x-pi-web-request": "1" };

    const malformed = await server.inject({
      method: "POST",
      url,
      headers,
      payload: {
        idempotencyKey: "00000000-0000-4000-8000-000000000001",
        deleteHistory: true,
      },
    });
    expect(malformed.statusCode).toBe(400);

    const response = await server.inject({
      method: "POST",
      url,
      headers,
      payload: {
        idempotencyKey: "00000000-0000-4000-8000-000000000001",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(ArchiveThreadResponseSchema.parse(response.json())).toEqual({
      archived: true,
    });
    expect((await server.workspaceContext.workspace.list()).threads).toEqual(
      [],
    );
    const snapshot = await server.inject({
      method: "GET",
      url: `/api/projects/${project.id}/threads/${thread.id}`,
      headers: { host },
    });
    expect(snapshot.statusCode).toBe(404);
    await server.close();
  });

  // The other half of the archive door: an archived thread must be listable
  // and restorable, or archiving is irreversible from the UI.
  it("lists archived threads and restores one through a strict idempotent endpoint", async () => {
    const paths = await directories();
    const config = parseConfig({
      argv: [],
      environment: { PI_WEB_STATE_DIR: paths.state },
    });
    const server = await buildServer({
      config,
      runtime: new FakeRuntime(),
      logger: false,
    });
    const project =
      await server.workspaceContext.workspace.registerSelectedProject(
        paths.project,
      );
    const thread = await server.workspaceContext.workspace.createThread(
      project.id,
    );
    const headers = { host, origin, "x-pi-web-request": "1" };
    await server.workspaceContext.workspace.archiveThread(
      project.id,
      thread.id,
      "00000000-0000-4000-8000-000000000011",
    );

    const listed = await server.inject({
      method: "GET",
      url: `/api/projects/${project.id}/archived-threads`,
      headers: { host },
    });
    expect(listed.statusCode).toBe(200);
    expect(
      ArchivedThreadsResponseSchema.parse(listed.json()).threads.map(
        (entry) => entry.id,
      ),
    ).toEqual([thread.id]);

    const url = `/api/projects/${project.id}/threads/${thread.id}/unarchive`;
    const malformed = await server.inject({
      method: "POST",
      url,
      headers,
      payload: {
        idempotencyKey: "00000000-0000-4000-8000-000000000012",
        archived: false,
      },
    });
    expect(malformed.statusCode).toBe(400);

    const restored = await server.inject({
      method: "POST",
      url,
      headers,
      payload: { idempotencyKey: "00000000-0000-4000-8000-000000000012" },
    });
    expect(restored.statusCode).toBe(200);
    expect(UnarchiveThreadResponseSchema.parse(restored.json())).toEqual({
      archived: false,
    });
    expect(
      (await server.workspaceContext.workspace.list()).threads.map(
        (entry) => entry.id,
      ),
    ).toEqual([thread.id]);
    const afterList = await server.inject({
      method: "GET",
      url: `/api/projects/${project.id}/archived-threads`,
      headers: { host },
    });
    expect(
      ArchivedThreadsResponseSchema.parse(afterList.json()).threads,
    ).toEqual([]);
    const snapshot = await server.inject({
      method: "GET",
      url: `/api/projects/${project.id}/threads/${thread.id}`,
      headers: { host },
    });
    expect(snapshot.statusCode).toBe(200);
    await server.close();
  });

  it("maps a durable thread-run lease conflict to the busy response", async () => {
    const paths = await directories();
    const config = parseConfig({
      argv: [],
      environment: { PI_WEB_STATE_DIR: paths.state },
    });
    const server = await buildServer({
      config,
      runtime: new PromptingRuntime(),
      logger: false,
    });
    const project =
      await server.workspaceContext.workspace.registerSelectedProject(
        paths.project,
      );
    const thread = await server.workspaceContext.workspace.createThread(
      project.id,
    );
    vi.spyOn(
      server.workspaceContext.store,
      "createRunIfProjectActive",
    ).mockImplementationOnce(() => {
      throw new Error("UNIQUE constraint failed: runs.thread_id");
    });

    const response = await server.inject({
      method: "POST",
      url: `/api/projects/${project.id}/threads/${thread.id}/prompt`,
      headers: { host, origin, "x-pi-web-request": "1" },
      payload: {
        prompt: "Work",
        idempotencyKey: "00000000-0000-4000-8000-000000000001",
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: {
        code: "project_busy",
        message: "Another agent run is active in this thread.",
      },
    });
    await server.close();
  });

  it("prints a plain launch URL and accepts canonical default-port origins for mutations", async () => {
    const paths = await directories();
    const config = parseConfig({
      argv: ["--port", "80"],
      environment: { PI_WEB_STATE_DIR: paths.state },
    });
    const directoryPicker: DirectoryPicker = {
      chooseDirectory: vi.fn().mockResolvedValue(null),
    };
    const server = await buildServer({
      config,
      runtime: new FakeRuntime(),
      directoryPicker,
      logger: false,
    });
    expect(server.workspaceContext.launchUrl).toBe("http://127.0.0.1:5173/");
    const mutation = await server.inject({
      method: "POST",
      url: "/api/projects/browse",
      headers: {
        host: "127.0.0.1",
        origin: "http://127.0.0.1",
        "x-pi-web-request": "1",
      },
      payload: { idempotencyKey: "00000000-0000-4000-8000-000000000001" },
    });
    expect(mutation.statusCode).toBe(200);
    expect(mutation.headers["set-cookie"]).toBeUndefined();
    await server.close();
  });

  it("allows credential-free reads while requiring exact origin and CSRF signal for mutations", async () => {
    const paths = await directories();
    const config = parseConfig({
      argv: [],
      environment: { PI_WEB_STATE_DIR: paths.state },
    });
    const server = await buildServer({
      config,
      runtime: new FakeRuntime(),
      logger: false,
    });
    const listed = await server.inject({
      method: "GET",
      url: "/api/projects",
      headers: { host },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.headers["set-cookie"]).toBeUndefined();
    const forgedHost = await server.inject({
      method: "GET",
      url: "/api/projects",
      headers: { host: "hostile.invalid" },
    });
    expect(forgedHost.statusCode).toBe(403);
    const formerBootstrap = await server.inject({
      method: "POST",
      url: "/api/auth/bootstrap",
      headers: { host, origin, "x-pi-web-request": "1" },
      payload: { token: "x".repeat(32) },
    });
    expect(formerBootstrap.statusCode).toBe(404);
    const rejected = await server.inject({
      method: "POST",
      url: "/api/projects",
      headers: {
        host,
        origin: "http://hostile.invalid",
        "x-pi-web-request": "1",
      },
      payload: {
        path: paths.project,
        idempotencyKey: "00000000-0000-4000-8000-000000000001",
      },
    });
    expect(rejected.statusCode).toBe(403);
    const missingSignal = await server.inject({
      method: "POST",
      url: "/api/projects/browse",
      headers: { host, origin },
      payload: {
        idempotencyKey: "00000000-0000-4000-8000-000000000001",
      },
    });
    expect(missingSignal.statusCode).toBe(403);
    await server.close();
  });

  // R2-4. Served at http://localhost:<port> the whole app was read-only:
  // every mutation came back 403 forbidden_request because the allowlist held
  // only the 127.0.0.1 spelling of the same loopback address. Both directions
  // are asserted here -- the rejection is the important half, because the
  // allowlist is the app's DNS-rebinding defence.
  it("accepts mutations from every loopback origin and still rejects non-loopback ones", async () => {
    const paths = await directories();
    const config = parseConfig({
      argv: [],
      environment: { PI_WEB_STATE_DIR: paths.state },
    });
    const server = await buildServer({
      config,
      runtime: new FakeRuntime(),
      directoryPicker: { chooseDirectory: vi.fn().mockResolvedValue(null) },
      logger: false,
    });

    for (const loopback of ["127.0.0.1", "localhost", "[::1]"]) {
      const accepted = await server.inject({
        method: "POST",
        url: "/api/projects/browse",
        headers: {
          host: `${loopback}:3001`,
          origin: `http://${loopback}:5173`,
          "x-pi-web-request": "1",
        },
        payload: { idempotencyKey: "00000000-0000-4000-8000-000000000001" },
      });
      expect(accepted.statusCode, `${loopback} must be accepted`).toBe(200);
    }

    for (const hostile of [
      "http://hostile.invalid",
      "http://localhost.hostile.invalid:5173",
      "http://127.0.0.1.hostile.invalid:5173",
      "https://localhost:5173",
      "http://192.168.1.10:5173",
    ]) {
      const rejected = await server.inject({
        method: "POST",
        url: "/api/projects/browse",
        headers: { host, origin: hostile, "x-pi-web-request": "1" },
        payload: { idempotencyKey: "00000000-0000-4000-8000-000000000002" },
      });
      expect(rejected.statusCode, `${hostile} must be rejected`).toBe(403);
      expect(rejected.json()).toEqual({
        error: {
          code: "forbidden_request",
          message: "Request origin or CSRF signal is invalid.",
        },
      });
    }

    // A forged Host header is still refused outright, on reads too.
    const forgedHost = await server.inject({
      method: "GET",
      url: "/api/projects",
      headers: { host: "localhost.hostile.invalid:3001" },
    });
    expect(forgedHost.statusCode).toBe(403);

    await server.close();
  });

  it("accepts credential-free WebSocket upgrades from the configured origin", async () => {
    const paths = await directories();
    const config = parseConfig({
      argv: [],
      environment: { PI_WEB_STATE_DIR: paths.state },
    });
    const server = await buildServer({
      config,
      runtime: new FakeRuntime(),
      logger: false,
    });
    await server.ready();

    await expect(
      server.injectWS("/api/live", {
        headers: { host: "hostile.invalid", origin },
      }),
    ).rejects.toThrow(/403/);
    const rejectedSocket = await server.injectWS("/api/live", {
      headers: { host, origin: "http://hostile.invalid" },
    });
    const closeCode = await new Promise<number>((resolve) => {
      rejectedSocket.once("close", resolve);
    });
    expect(closeCode).toBe(1008);

    const socket = await server.injectWS("/api/live", {
      headers: { host, origin },
    });
    expect(socket.readyState).toBe(1);
    socket.close();
    await server.close();
  });

  it("registers a browsed directory without returning its native path", async () => {
    const paths = await directories();
    const config = parseConfig({
      argv: [],
      environment: { PI_WEB_STATE_DIR: paths.state },
    });
    const chooseDirectory = vi.fn().mockResolvedValue(paths.project);
    const directoryPicker: DirectoryPicker = { chooseDirectory };
    const server = await buildServer({
      config,
      runtime: new FakeRuntime(),
      directoryPicker,
      logger: false,
    });
    const response = await server.inject({
      method: "POST",
      url: "/api/projects/browse",
      headers: { host, origin, "x-pi-web-request": "1" },
      payload: {
        idempotencyKey: "00000000-0000-4000-8000-000000000001",
      },
    });

    expect(response.statusCode).toBe(200);
    const result = BrowseProjectResponseSchema.parse(response.json());
    expect(result.outcome).toBe("selected");
    expect(response.body).not.toContain(paths.project);
    const replay = await server.inject({
      method: "POST",
      url: "/api/projects/browse",
      headers: { host, origin, "x-pi-web-request": "1" },
      payload: { idempotencyKey: "00000000-0000-4000-8000-000000000001" },
    });
    expect(BrowseProjectResponseSchema.parse(replay.json())).toEqual(result);
    expect(chooseDirectory).toHaveBeenCalledOnce();
    await server.close();
  });

  it("treats browse cancellation as a no-op and parses the request strictly", async () => {
    const paths = await directories();
    const config = parseConfig({
      argv: [],
      environment: { PI_WEB_STATE_DIR: paths.state },
    });
    const chooseDirectory = vi.fn().mockResolvedValue(null);
    const directoryPicker: DirectoryPicker = { chooseDirectory };
    const server = await buildServer({
      config,
      runtime: new FakeRuntime(),
      directoryPicker,
      logger: false,
    });
    const cancelled = await server.inject({
      method: "POST",
      url: "/api/projects/browse",
      headers: { host, origin, "x-pi-web-request": "1" },
      payload: {
        idempotencyKey: "00000000-0000-4000-8000-000000000001",
      },
    });
    expect(BrowseProjectResponseSchema.parse(cancelled.json())).toEqual({
      outcome: "cancelled",
    });
    expect((await server.workspaceContext.workspace.list()).projects).toEqual(
      [],
    );

    const replay = await server.inject({
      method: "POST",
      url: "/api/projects/browse",
      headers: { host, origin, "x-pi-web-request": "1" },
      payload: { idempotencyKey: "00000000-0000-4000-8000-000000000001" },
    });
    expect(BrowseProjectResponseSchema.parse(replay.json())).toEqual({
      outcome: "cancelled",
    });

    const malformed = await server.inject({
      method: "POST",
      url: "/api/projects/browse",
      headers: { host, origin, "x-pi-web-request": "1" },
      payload: {
        idempotencyKey: "00000000-0000-4000-8000-000000000002",
        path: paths.project,
      },
    });
    expect(malformed.statusCode).toBe(400);
    expect(chooseDirectory).toHaveBeenCalledOnce();
    await server.close();
  });

  it("redacts native picker failures", async () => {
    const paths = await directories();
    const config = parseConfig({
      argv: [],
      environment: { PI_WEB_STATE_DIR: paths.state },
    });
    const directoryPicker: DirectoryPicker = {
      chooseDirectory: vi
        .fn()
        .mockRejectedValue(new Error("directory_picker_failed")),
    };
    const server = await buildServer({
      config,
      runtime: new FakeRuntime(),
      directoryPicker,
      logger: false,
    });
    const response = await server.inject({
      method: "POST",
      url: "/api/projects/browse",
      headers: { host, origin, "x-pi-web-request": "1" },
      payload: {
        idempotencyKey: "00000000-0000-4000-8000-000000000001",
      },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: {
        code: "directory_picker_failed",
        message: "The folder browser could not be opened.",
      },
    });
    expect(response.body).not.toContain(paths.project);
    await server.close();
  });

  // REPLACES "rejects browser-supplied paths without registering a project".
  //
  // That test guarded a posture that has since cost more than it bought: with
  // the native chooser as the ONLY way in, a dialog that failed to open, or
  // opened behind the window, left no way to add a project at all -- and
  // adding a project is the first thing anyone must do. The path route is a
  // fallback beside the chooser, not a replacement for it.
  //
  // It grants nothing: this server is loopback-only, has no client
  // authentication by design, and Pi already runs with the user's own
  // permissions, so a path typed into the sidebar reaches exactly what a path
  // chosen in the OS dialog reaches. The origin and CSRF checks that guard
  // every other mutation guard this one unchanged (see the 403 cases above).
  //
  // NOTE: `docs/product-specs/initial-workspace.md` still says the sidebar
  // presents "a single Browse control rather than a path text field". That
  // spec is approved and is NOT edited here; the change is flagged for
  // approval rather than made quietly.
  describe("adding a project by path", () => {
    const key = (n: number) =>
      `00000000-0000-4000-8000-00000000000${String(n)}`;
    const add = async (
      server: Awaited<ReturnType<typeof buildServer>>,
      path: string,
      idempotencyKey: string,
    ) =>
      await server.inject({
        method: "POST",
        url: "/api/projects",
        headers: { host, origin, "x-pi-web-request": "1" },
        payload: { path, idempotencyKey },
      });
    const start = async (state: string) =>
      await buildServer({
        config: parseConfig({
          argv: [],
          environment: { PI_WEB_STATE_DIR: state },
        }),
        runtime: new FakeRuntime(),
        logger: false,
      });

    it("registers an absolute path and lists it", async () => {
      const paths = await directories();
      const server = await start(paths.state);
      const added = await add(server, paths.project, key(1));
      expect(added.statusCode).toBe(200);
      const project = ProjectMutationResponseSchema.parse(added.json()).project;
      expect(project.displayName).toBe("project");
      const listed = await server.inject({
        method: "GET",
        url: "/api/projects",
        headers: { host },
      });
      const workspace = ProjectsResponseSchema.parse(listed.json());
      expect(workspace.projects.map((entry) => entry.id)).toEqual([project.id]);
      await server.close();
    });

    it("replays the same idempotency key instead of registering twice", async () => {
      const paths = await directories();
      const server = await start(paths.state);
      const first = await add(server, paths.project, key(1));
      const replay = await add(server, paths.project, key(1));
      expect(replay.statusCode).toBe(200);
      expect(
        ProjectMutationResponseSchema.parse(replay.json()).project.id,
      ).toBe(ProjectMutationResponseSchema.parse(first.json()).project.id);
      const listed = await server.inject({
        method: "GET",
        url: "/api/projects",
        headers: { host },
      });
      expect(ProjectsResponseSchema.parse(listed.json()).projects).toHaveLength(
        1,
      );
      await server.close();
    });

    it("reports a directory that is already registered", async () => {
      const paths = await directories();
      const server = await start(paths.state);
      await add(server, paths.project, key(1));
      const again = await add(server, paths.project, key(2));
      expect(again.statusCode).toBe(409);
      expect(again.json()).toEqual({
        error: {
          code: "project_already_registered",
          message: "This directory is already registered.",
        },
      });
      await server.close();
    });

    // The four honest refusals. Each says which of the four things is wrong,
    // because "unavailable or inaccessible" for all of them sends someone
    // hunting a permissions problem when they have made a typo.
    it("says a path does not exist rather than failing generically", async () => {
      const paths = await directories();
      const server = await start(paths.state);
      const missing = await add(
        server,
        join(paths.project, "no-such-directory"),
        key(1),
      );
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toEqual({
        error: {
          code: "project_path_not_found",
          message: "There is nothing at that path.",
        },
      });
      await server.close();
    });

    it("refuses a relative path", async () => {
      const paths = await directories();
      const server = await start(paths.state);
      const relative = await add(server, "some/relative/path", key(1));
      expect(relative.statusCode).toBe(400);
      expect(relative.json()).toEqual({
        error: {
          code: "project_path_relative",
          message:
            "Enter the full path to the directory, starting from the root.",
        },
      });
      await server.close();
    });

    it("refuses a file that is not a directory", async () => {
      const paths = await directories();
      const file = join(paths.project, "README.md");
      await writeFile(file, "not a directory\n");
      const server = await start(paths.state);
      const notDirectory = await add(server, file, key(1));
      expect(notDirectory.statusCode).toBe(400);
      expect(notDirectory.json()).toEqual({
        error: {
          code: "project_not_directory",
          message: "That path is a file, not a directory.",
        },
      });
      await server.close();
    });

    it("refuses an empty path and a path containing a NUL byte", async () => {
      const paths = await directories();
      const server = await start(paths.state);
      for (const path of ["", "   ", `${paths.project}\u0000/etc`]) {
        const refused = await add(server, path, key(1));
        expect(refused.statusCode).toBe(400);
        expect(refused.json()).toEqual({
          error: {
            code: "invalid_request",
            message: "The request is malformed.",
          },
        });
      }
      const listed = await server.inject({
        method: "GET",
        url: "/api/projects",
        headers: { host },
      });
      expect(ProjectsResponseSchema.parse(listed.json()).projects).toEqual([]);
      await server.close();
    });

    it("trims a pasted path's surrounding whitespace", async () => {
      const paths = await directories();
      const server = await start(paths.state);
      const added = await add(server, `  ${paths.project}\n`, key(1));
      expect(added.statusCode).toBe(200);
      await server.close();
    });

    // A directory with no Git repository in it is a PROJECT, not an error:
    // the new-chat pane already says so and offers the shared-checkout mode.
    it("accepts a directory that is not a Git working tree", async () => {
      const paths = await directories();
      const server = await start(paths.state);
      const added = await add(server, paths.project, key(1));
      expect(added.statusCode).toBe(200);
      expect(
        ProjectMutationResponseSchema.parse(added.json()).project.gitAvailable,
      ).toBe(false);
      await server.close();
    });
  });
});

/**
 * The terminal routes need a real socket, because that is the only way a
 * terminal comes into existence: the listing route reports what the socket
 * created. The PTY itself is a fake — this suite is about the wire and the
 * ownership rules, and `manager.test.ts` is about the process.
 */
class SocketFakePty implements PtyProcess {
  public readonly pid = null;
  public write(): void {
    return undefined;
  }
  public resize(): void {
    return undefined;
  }
  public kill(): void {
    return undefined;
  }
  public onData(): { dispose(): void } {
    return { dispose: () => undefined };
  }
  public onExit(): { dispose(): void } {
    return { dispose: () => undefined };
  }
}

class SocketFakePtyFactory implements PtyFactory {
  public readonly directories: string[] = [];
  public spawn(cwd: string): PtyProcess {
    this.directories.push(cwd);
    return new SocketFakePty();
  }
}

async function availablePort(): Promise<number> {
  return await new Promise<number>((settle, fail) => {
    const probe = createServer();
    probe.once("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        fail(new Error("Could not allocate a test port"));
        return;
      }
      const port = address.port;
      probe.close((error) => {
        if (error !== undefined) fail(error);
        else settle(port);
      });
    });
  });
}

/** A ws frame, whatever transport shape it arrived in, as text. */
function frameText(raw: RawData): string {
  if (typeof raw === "string") return raw;
  if (Buffer.isBuffer(raw)) return raw.toString("utf8");
  if (Array.isArray(raw)) return Buffer.concat(raw).toString("utf8");
  return Buffer.from(raw).toString("utf8");
}

/** One terminal socket, with the frames it has received so far. */
class TerminalClient {
  private readonly socket: WebSocket;
  public readonly frames: TerminalServerFrame[] = [];
  public constructor(port: number) {
    this.socket = new WebSocket(`ws://127.0.0.1:${String(port)}/api/terminal`, {
      headers: {
        host: `127.0.0.1:${String(port)}`,
        origin: `http://127.0.0.1:${String(port)}`,
      },
    });
    this.socket.on("message", (raw: RawData) => {
      this.frames.push(
        TerminalServerFrameSchema.parse(JSON.parse(frameText(raw))),
      );
    });
  }
  public async opened(): Promise<void> {
    await new Promise<void>((settle, fail) => {
      this.socket.once("open", () => {
        settle();
      });
      this.socket.once("error", fail);
    });
  }
  public send(frame: unknown): void {
    this.socket.send(JSON.stringify(frame));
  }
  /** The next frame of this type to arrive, or a timeout. */
  public async next<Type extends TerminalServerFrame["type"]>(
    type: Type,
  ): Promise<Extract<TerminalServerFrame, { type: Type }>> {
    const matches = (
      frame: TerminalServerFrame,
    ): frame is Extract<TerminalServerFrame, { type: Type }> =>
      frame.type === type;
    const seen = this.frames.filter(matches).length;
    let found: Extract<TerminalServerFrame, { type: Type }> | undefined;
    await vi.waitFor(() => {
      const matching = this.frames.filter(matches);
      expect(matching.length).toBeGreaterThan(seen);
      found = matching[seen];
    });
    if (found === undefined) throw new Error(`no ${type} frame arrived`);
    return found;
  }
  public close(): void {
    this.socket.close();
  }
}

describe("terminal routes", () => {
  async function serverWithThread(): Promise<{
    server: Awaited<ReturnType<typeof buildServer>>;
    factory: SocketFakePtyFactory;
    port: number;
    projectId: string;
    threadId: string;
    otherProjectId: string;
    otherThreadId: string;
    projectPath: string;
  }> {
    const paths = await directories();
    const otherProject = join(paths.project, "..", "other-project");
    await mkdir(otherProject);
    await mkdir(join(paths.project, "apps"));
    const port = await availablePort();
    const config = parseConfig({
      argv: ["--port", String(port)],
      environment: { PI_WEB_STATE_DIR: paths.state },
    });
    const factory = new SocketFakePtyFactory();
    const server = await buildServer({
      config,
      runtime: new PromptingRuntime(),
      ptyFactory: factory,
      logger: false,
    });
    const workspace = server.workspaceContext.workspace;
    const project = await workspace.registerSelectedProject(paths.project);
    const other = await workspace.registerSelectedProject(otherProject);
    const thread = await workspace.startThread(
      project.id,
      parseTextChatInput("Run a shell here"),
      { mode: "shared" },
      "00000000-0000-4000-8000-000000000101",
    );
    const otherThread = await workspace.startThread(
      other.id,
      parseTextChatInput("Run a shell there"),
      { mode: "shared" },
      "00000000-0000-4000-8000-000000000102",
    );
    await server.listen({ host: config.host, port });
    return {
      server,
      factory,
      port,
      projectId: project.id,
      threadId: thread.thread.id,
      otherProjectId: other.id,
      otherThreadId: otherThread.thread.id,
      projectPath: paths.project,
    };
  }

  // WSP-07: a reloaded browser reclaims its own shells by identity, so it
  // has to be able to ask which ones are live. The answer is scoped to the
  // thread that asked — another project's terminal is not reachable through
  // it, and is not even visible.
  it("lists the live terminals of the requesting thread's scope only", async () => {
    const fixture = await serverWithThread();
    const { server, port, projectId, threadId } = fixture;
    const client = new TerminalClient(port);
    await client.opened();

    const empty = await server.inject({
      method: "GET",
      url: `/api/projects/${projectId}/threads/${threadId}/terminals`,
      headers: { host: `127.0.0.1:${String(port)}` },
    });
    expect(empty.statusCode).toBe(200);
    expect(TerminalsResponseSchema.parse(empty.json()).terminals).toEqual([]);

    client.send({ version: 1, type: "create", projectId, threadId });
    const ready = await client.next("ready");

    const listed = await server.inject({
      method: "GET",
      url: `/api/projects/${projectId}/threads/${threadId}/terminals`,
      headers: { host: `127.0.0.1:${String(port)}` },
    });
    expect(TerminalsResponseSchema.parse(listed.json()).terminals).toEqual([
      { id: ready.terminalId, cwd: null },
    ]);

    // Another project's thread is a different execution scope, and sees
    // nothing of this one.
    const elsewhere = await server.inject({
      method: "GET",
      url: `/api/projects/${fixture.otherProjectId}/threads/${fixture.otherThreadId}/terminals`,
      headers: { host: `127.0.0.1:${String(port)}` },
    });
    expect(TerminalsResponseSchema.parse(elsewhere.json()).terminals).toEqual(
      [],
    );

    // And a thread that does not belong to the named project is not a route
    // that answers at all.
    const mismatched = await server.inject({
      method: "GET",
      url: `/api/projects/${fixture.otherProjectId}/threads/${threadId}/terminals`,
      headers: { host: `127.0.0.1:${String(port)}` },
    });
    expect(mismatched.statusCode).toBe(404);

    client.close();
    await server.close();
  });

  // Two terminals in one scope, then a re-attach by id: the reload path.
  it("creates several terminals in one scope and re-attaches to one by id", async () => {
    const fixture = await serverWithThread();
    const { server, port, projectId, threadId } = fixture;
    const first = new TerminalClient(port);
    const second = new TerminalClient(port);
    await first.opened();
    await second.opened();
    first.send({ version: 1, type: "create", projectId, threadId });
    const firstReady = await first.next("ready");
    second.send({ version: 1, type: "create", projectId, threadId });
    const secondReady = await second.next("ready");
    expect(firstReady.terminalId).not.toBe(secondReady.terminalId);

    // A reload: a new socket claiming the id it recorded.
    first.close();
    const reloaded = new TerminalClient(port);
    await reloaded.opened();
    reloaded.send({
      version: 1,
      type: "attach",
      projectId,
      threadId,
      terminalId: firstReady.terminalId,
    });
    expect((await reloaded.next("ready")).terminalId).toBe(
      firstReady.terminalId,
    );
    const listed = await server.inject({
      method: "GET",
      url: `/api/projects/${projectId}/threads/${threadId}/terminals`,
      headers: { host: `127.0.0.1:${String(port)}` },
    });
    // Two, not three: re-attaching reclaimed a shell rather than starting one.
    expect(TerminalsResponseSchema.parse(listed.json()).terminals).toHaveLength(
      2,
    );

    reloaded.close();
    second.close();
    await server.close();
  });

  // D-2: the refusals a tab must render differently arrive with a code, not
  // as one string it would have to match on prose.
  it("answers a stale id and a refused directory with their own codes", async () => {
    const fixture = await serverWithThread();
    const { server, port, projectId, threadId, factory } = fixture;
    const client = new TerminalClient(port);
    await client.opened();

    client.send({
      version: 1,
      type: "attach",
      projectId,
      threadId,
      terminalId: "50000000-0000-4000-8000-000000000009",
    });
    expect(await client.next("error")).toMatchObject({
      code: "terminal_gone",
    });

    client.send({
      version: 1,
      type: "create",
      projectId,
      threadId,
      cwd: "not-a-directory",
    });
    expect(await client.next("error")).toMatchObject({
      code: "terminal_cwd_invalid",
    });
    expect(factory.directories).toEqual([]);

    // And a directory that IS inside the execution root is spawned in.
    client.send({
      version: 1,
      type: "create",
      projectId,
      threadId,
      cwd: "apps",
    });
    await client.next("ready");
    expect(factory.directories).toEqual([
      join(await realpath(fixture.projectPath), "apps"),
    ]);

    client.close();
    await server.close();
  });
});

describe("agent backend selection over HTTP", () => {
  const headers = { host, origin, "x-pi-web-request": "1" };

  async function backendServer(defaultRuntime: string) {
    const paths = await directories();
    const config = parseConfig({
      argv: [],
      environment: {
        PI_WEB_STATE_DIR: paths.state,
        PI_WEB_DEFAULT_RUNTIME: defaultRuntime,
      },
    });
    const pi = new PromptingRuntime();
    const codex = new PromptingRuntime();
    const server = await buildServer({
      config,
      runtimes: { pi, codex },
      logger: false,
    });
    const project =
      await server.workspaceContext.workspace.registerSelectedProject(
        paths.project,
      );
    return { server, project, pi, codex };
  }

  function start(
    server: Awaited<ReturnType<typeof buildServer>>,
    projectId: string,
    payload: Record<string, unknown>,
  ) {
    return server.inject({
      method: "POST",
      url: `/api/projects/${projectId}/threads/start`,
      headers,
      payload: {
        prompt: "do the thing",
        workspace: { mode: "shared" },
        idempotencyKey: randomUUID(),
        ...payload,
      },
    });
  }

  it("runs a chat on the configured default when none is requested", async () => {
    const { server, project } = await backendServer("codex");
    const response = await start(server, project.id, {});
    expect(response.statusCode).toBe(200);
    expect(
      StartThreadResponseSchema.parse(response.json()).thread.runtime,
    ).toBe("codex");
    await server.close();
  });

  it("honours an explicit backend over the default", async () => {
    const { server, project } = await backendServer("codex");
    const response = await start(server, project.id, { runtime: "pi" });
    expect(
      StartThreadResponseSchema.parse(response.json()).thread.runtime,
    ).toBe("pi");
    await server.close();
  });

  it("rejects a backend the contract does not define", async () => {
    const { server, project } = await backendServer("codex");
    const response = await start(server, project.id, { runtime: "claude" });
    expect(response.statusCode).toBe(400);
    await server.close();
  });

  it("reports the machine default and which backends are usable", async () => {
    const { server } = await backendServer("pi");
    const response = await server.inject({
      method: "GET",
      url: "/api/agent-backends",
      headers,
    });
    expect(response.statusCode).toBe(200);
    const body = AgentBackendsResponseSchema.parse(response.json());
    expect(body.defaultRuntime).toBe("pi");
    expect(body.backends.map((backend) => backend.kind)).toEqual([
      "pi",
      "codex",
    ]);
    await server.close();
  });

  it("leaves no thread behind when the chosen backend is unusable", async () => {
    const paths = await directories();
    const config = parseConfig({
      argv: [],
      environment: {
        PI_WEB_STATE_DIR: paths.state,
        PI_WEB_DEFAULT_RUNTIME: "pi",
      },
    });
    const server = await buildServer({
      config,
      runtimes: { pi: new PromptingRuntime() },
      logger: false,
    });
    const project =
      await server.workspaceContext.workspace.registerSelectedProject(
        paths.project,
      );
    const response = await start(server, project.id, { runtime: "codex" });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);

    // A failed creation must leave nothing behind, not a half-made chat.
    expect(
      server.workspaceContext.store.listThreads(project.id, {
        includeArchived: true,
      }),
    ).toEqual([]);

    // The unavailable backend is reported as such rather than silently absent.
    const backends = await server.inject({
      method: "GET",
      url: "/api/agent-backends",
      headers,
    });
    const parsed = AgentBackendsResponseSchema.parse(backends.json());
    const codex = parsed.backends.find((entry) => entry.kind === "codex");
    expect(codex?.available).toBe(false);
    expect(codex?.reason).toMatch(/Codex/);
    await server.close();
  });
});
