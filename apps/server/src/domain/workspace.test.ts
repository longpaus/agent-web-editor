import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  AgentRuntime,
  OpenRuntimeSession,
  PromptAcceptance,
  RuntimeEvent,
} from "@pi-web/agent-runtime";
import { TranscriptPageSchema } from "@pi-web/contracts";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MetadataStore } from "../db/store.js";
import { LiveBroker } from "../live/broker.js";
import {
  ProjectTerminalManager,
  type PtyFactory,
  type PtyProcess,
} from "../terminal/manager.js";
import { WorkspaceService } from "./workspace.js";

const roots: string[] = [];
const emptyTranscriptPage = TranscriptPageSchema.parse({
  items: [],
  olderCursor: null,
  newerCursor: null,
  resumeCursor: "empty-transcript-page",
  atLatest: true,
});
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

class ControlledSession implements OpenRuntimeSession {
  public promptCount = 0;
  public steerCount = 0;
  public stopCount = 0;
  public discardCount = 0;
  public disposeCount = 0;
  public recoveredPrompts = false;

  public constructor(public readonly id: string) {}
  private settle:
    ((value: "completed" | "failed" | "interrupted") => void) | undefined;
  private readonly listeners = new Set<(event: RuntimeEvent) => void>();
  public promptGate: Promise<void> | undefined;
  public stopGate:
    ((stopCount: number) => Promise<void> | undefined) | undefined;
  public disposeGate: Promise<void> | undefined;
  public snapshot() {
    return Promise.resolve({
      sessionId: this.id,
      transcriptPage: emptyTranscriptPage,
      diagnostics: [],
    });
  }
  public transcriptPage() {
    return Promise.resolve(emptyTranscriptPage);
  }
  public async prompt(): Promise<PromptAcceptance> {
    this.promptCount += 1;
    this.recoveredPrompts = true;
    await this.promptGate;
    const settlement = new Promise<"completed" | "failed" | "interrupted">(
      (resolve) => {
        this.settle = resolve;
      },
    );
    return {
      accepted: true,
      settlement,
      releaseEvents: () => undefined,
      discardEvents: () => {
        this.discardCount += 1;
      },
    };
  }
  public recoverPrompt() {
    return Promise.resolve(
      this.recoveredPrompts
        ? ({ outcome: "accepted" } as const)
        : ({ outcome: "not_accepted" } as const),
    );
  }
  public steer() {
    this.steerCount += 1;
    return Promise.resolve();
  }
  public async stop(): Promise<void> {
    this.stopCount += 1;
    await this.stopGate?.(this.stopCount);
    this.settle?.("interrupted");
  }
  public subscribe(listener: (event: RuntimeEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  public async dispose(): Promise<void> {
    this.disposeCount += 1;
    await this.disposeGate;
  }
  public complete(): void {
    this.settle?.("completed");
  }
}

class ControlledRuntime implements AgentRuntime {
  private readonly sessions = new Map<string, ControlledSession>();
  public created = 0;
  public createFailure: Error | undefined;

  public get session(): ControlledSession {
    const session = this.sessions.values().next().value;
    if (session === undefined) throw new Error("no controlled session exists");
    return session;
  }
  public sessionById(sessionId: string): ControlledSession {
    const session = this.sessions.get(sessionId);
    if (session === undefined) throw new Error("controlled session not found");
    return session;
  }
  public discover() {
    return Promise.resolve({ sessions: [], diagnostics: [] });
  }
  public create() {
    if (this.createFailure !== undefined)
      return Promise.reject(this.createFailure);
    this.created += 1;
    const sessionId = `10000000-0000-4000-8000-${String(this.created).padStart(12, "0")}`;
    this.sessions.set(sessionId, new ControlledSession(sessionId));
    return Promise.resolve({ sessionId });
  }
  public open(_projectPath: string, sessionId: string) {
    return Promise.resolve(this.sessionById(sessionId));
  }
}

class DeferredPty implements PtyProcess {
  public killed = false;
  public write(): void {
    return undefined;
  }
  public resize(): void {
    return undefined;
  }
  public kill(): void {
    this.killed = true;
  }
  public onData(): { dispose(): void } {
    return { dispose: () => undefined };
  }
  public onExit(): { dispose(): void } {
    return { dispose: () => undefined };
  }
}

class DeferredPtyFactory implements PtyFactory {
  public readonly processes: DeferredPty[] = [];
  private resolve: ((process: PtyProcess) => void) | undefined;
  public spawn(): Promise<PtyProcess> {
    const process = new DeferredPty();
    this.processes.push(process);
    return new Promise((resolve) => {
      this.resolve = resolve;
    });
  }
  public release(): void {
    const process = this.processes.at(-1);
    if (process === undefined || this.resolve === undefined)
      throw new Error("deferred PTY was not created");
    this.resolve(process);
  }
}

async function fixture(terminalCleanup?: {
  terminate(projectId: string): void;
}) {
  const root = await mkdtemp(join(tmpdir(), "pi-web-runs-"));
  roots.push(root);
  const state = join(root, "state");
  const projectPath = join(root, "project");
  await mkdir(state, { mode: 0o700 });
  await mkdir(projectPath);
  const store = await MetadataStore.open({ stateDirectory: state });
  const runtime = new ControlledRuntime();
  const service = new WorkspaceService(
    store,
    runtime,
    new LiveBroker(),
    terminalCleanup,
  );
  const project = await service.registerSelectedProject(projectPath);
  const first = await service.createThread(project.id);
  const second = await service.createThread(project.id);
  return { store, runtime, service, project, projectPath, first, second };
}

function sessionFor(
  context: Awaited<ReturnType<typeof fixture>>,
  threadId: string,
): ControlledSession {
  const thread = context.store.getThread(context.project.id, threadId);
  if (thread === null) throw new Error("fixture thread not found");
  return context.runtime.sessionById(thread.runtime_session_id);
}

describe("run coordination", () => {
  it("replays the original start run after a later run exists", async () => {
    const context = await fixture();
    const key = "90000000-0000-4000-8000-000000000001";
    const initial = await context.service.startThread(
      context.project.id,
      "Implement an idempotent start",
      { mode: "shared" },
      key,
    );
    const initialThread = context.store.getThread(
      context.project.id,
      initial.thread.id,
    );
    if (initialThread === null)
      throw new Error("initial thread was not stored");
    context.runtime.sessionById(initialThread.runtime_session_id).complete();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const later = await context.service.prompt(
      context.project.id,
      initial.thread.id,
      "A later request",
      "90000000-0000-4000-8000-000000000002",
    );
    const replay = await context.service.startThread(
      context.project.id,
      "Implement an idempotent start",
      { mode: "shared" },
      key,
    );
    expect(later.id).not.toBe(initial.run.id);
    expect(replay.thread.id).toBe(initial.thread.id);
    expect(replay.run.id).toBe(initial.run.id);
    await context.service.close();
    context.store.close();
  });

  it("recovers an accepted initial prompt without dispatching it again", async () => {
    const context = await fixture();
    const key = "90000000-0000-4000-8000-000000000099";
    const attach = vi
      .spyOn(context.store, "attachCreationRun")
      .mockImplementationOnce(() => {
        throw new Error("crash_after_acceptance");
      });

    await expect(
      context.service.startThread(
        context.project.id,
        "Recover one prompt",
        { mode: "shared" },
        key,
      ),
    ).rejects.toThrow("crash_after_acceptance");
    attach.mockRestore();
    await context.service.close();
    const restarted = new WorkspaceService(
      context.store,
      context.runtime,
      new LiveBroker(),
    );
    const recovered = await restarted.startThread(
      context.project.id,
      "Recover one prompt",
      { mode: "shared" },
      key,
    );
    const thread = context.store.getThread(
      context.project.id,
      recovered.thread.id,
    );
    if (thread === null) throw new Error("recovered thread was not stored");
    expect(
      context.runtime.sessionById(thread.runtime_session_id).promptCount,
    ).toBe(1);
    expect(recovered.run.id).toBeTruthy();
    expect(
      context.store.getThreadCreation(context.project.id, key)?.run_id,
    ).toBe(recovered.run.id);
    await restarted.close();
    context.store.close();
  });

  it("retains healthy list entries when persisted project or thread rows are corrupt", async () => {
    const context = await fixture();
    const healthyPath = join(context.projectPath, "healthy");
    await mkdir(healthyPath);
    const healthyProject =
      await context.service.registerSelectedProject(healthyPath);
    const healthyThread = await context.service.createThread(healthyProject.id);
    await context.service.close();
    context.store.close();

    const database = new Database(
      join(context.store.stateDirectory, "metadata.sqlite"),
    );
    database
      .prepare("UPDATE projects SET display_name = '' WHERE id = ?")
      .run(context.project.id);
    database
      .prepare("UPDATE threads SET title = '' WHERE id = ?")
      .run(context.first.id);
    database.close();

    const store = await MetadataStore.open({
      stateDirectory: context.store.stateDirectory,
    });
    const service = new WorkspaceService(
      store,
      context.runtime,
      new LiveBroker(),
    );
    const listed = await service.list();
    expect(listed.projects.map((project) => project.id)).toEqual([
      healthyProject.id,
    ]);
    expect(listed.threads.map((thread) => thread.id)).toContain(
      healthyThread.id,
    );
    expect(listed.diagnostics).toEqual([
      "A malformed stored project record was omitted.",
      "A malformed stored thread record was omitted.",
    ]);
    await service.close();
    store.close();
  });

  it("cleans a pending terminal when its project is removed", async () => {
    const factory = new DeferredPtyFactory();
    const terminals = new ProjectTerminalManager(factory);
    const context = await fixture(terminals);
    const attach = terminals.attach(context.project.id, context.projectPath, {
      send: () => undefined,
    });

    await vi.waitFor(() => {
      expect(factory.processes).toHaveLength(1);
    });
    await context.service.removeProject(
      context.project.id,
      "70000000-0000-4000-8000-000000000001",
    );
    factory.release();

    await expect(attach).rejects.toThrow("terminal_gone");
    const discarded = factory.processes[0];
    if (discarded === undefined)
      throw new Error("deferred PTY was not created");
    expect(discarded.killed).toBe(true);
    await context.service.close();
    context.store.close();
  });

  it("does not persist thread metadata when native session creation fails", async () => {
    const context = await fixture();
    const priorThreads = context.store.listThreads(context.project.id);
    context.runtime.createFailure = new Error("session_create_failed");

    await expect(
      context.service.createThread(context.project.id),
    ).rejects.toThrow("session_create_failed");
    expect(context.store.listThreads(context.project.id)).toEqual(priorThreads);

    await context.service.close();
    context.store.close();
  });

  it("archives an inactive thread idempotently and disposes its open runtime", async () => {
    const context = await fixture();
    const session = sessionFor(context, context.first.id);
    await context.service.snapshot(context.project.id, context.first.id);
    session.disposeGate = Promise.reject(new Error("runtime_dispose_failed"));

    const key = "19000000-0000-4000-8000-000000000001";
    await expect(
      context.service.archiveThread(context.project.id, context.first.id, key),
    ).resolves.toEqual({ archived: true });
    await expect(
      context.service.archiveThread(context.project.id, context.first.id, key),
    ).resolves.toEqual({ archived: true });
    expect(session.disposeCount).toBe(1);
    expect(
      (await context.service.list()).threads.map((thread) => thread.id),
    ).toEqual([context.second.id]);
    await expect(
      context.service.snapshot(context.project.id, context.first.id),
    ).rejects.toThrow("thread_not_found");

    await context.service.close();
    context.store.close();
  });

  it("does not block archival when runtime disposal never settles", async () => {
    const context = await fixture();
    const session = sessionFor(context, context.first.id);
    await context.service.snapshot(context.project.id, context.first.id);
    session.disposeGate = new Promise<void>(() => undefined);

    await expect(
      context.service.archiveThread(
        context.project.id,
        context.first.id,
        "19000000-0000-4000-8000-000000000002",
      ),
    ).resolves.toEqual({ archived: true });
    await vi.waitFor(() => {
      expect(session.disposeCount).toBe(1);
    });
    expect(
      (await context.service.list()).threads.map((thread) => thread.id),
    ).toEqual([context.second.id]);

    await context.service.close();
    context.store.close();
  });

  it("rejects archival while a run or prompt preflight is active", async () => {
    const context = await fixture();
    await context.service.prompt(
      context.project.id,
      context.first.id,
      "Running work",
      "19000000-0000-4000-8000-000000000010",
    );
    await expect(
      context.service.archiveThread(
        context.project.id,
        context.first.id,
        "19000000-0000-4000-8000-000000000011",
      ),
    ).rejects.toThrow("thread_busy");

    let release: (() => void) | undefined;
    const secondSession = sessionFor(context, context.second.id);
    secondSession.promptGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = context.service.prompt(
      context.project.id,
      context.second.id,
      "Preflight work",
      "19000000-0000-4000-8000-000000000012",
    );
    await vi.waitFor(() => {
      expect(secondSession.promptCount).toBe(1);
    });
    await expect(
      context.service.archiveThread(
        context.project.id,
        context.second.id,
        "19000000-0000-4000-8000-000000000013",
      ),
    ).rejects.toThrow("thread_busy");

    release?.();
    await pending;
    await context.service.stop(
      context.project.id,
      context.first.id,
      "19000000-0000-4000-8000-000000000014",
    );
    await context.service.stop(
      context.project.id,
      context.second.id,
      "19000000-0000-4000-8000-000000000015",
    );
    await context.service.close();
    context.store.close();
  });

  it("runs project threads independently while enforcing each thread lease", async () => {
    const context = await fixture();
    const firstSession = sessionFor(context, context.first.id);
    const secondSession = sessionFor(context, context.second.id);
    const key = "20000000-0000-4000-8000-000000000001";
    const firstRun = await context.service.prompt(
      context.project.id,
      context.first.id,
      "Do the work",
      key,
    );
    const retry = await context.service.prompt(
      context.project.id,
      context.first.id,
      "Do the work",
      key,
    );
    expect(retry.id).toBe(firstRun.id);
    expect(firstSession.promptCount).toBe(1);

    const secondRun = await context.service.prompt(
      context.project.id,
      context.second.id,
      "Other work",
      "20000000-0000-4000-8000-000000000002",
    );
    expect(secondRun.state).toBe("running");
    expect(secondSession.promptCount).toBe(1);
    await expect(
      context.service.prompt(
        context.project.id,
        context.first.id,
        "Conflicting work",
        "20000000-0000-4000-8000-000000000003",
      ),
    ).rejects.toThrow("project_busy");

    await context.service.steer(
      context.project.id,
      context.first.id,
      "Adjust first",
      "20000000-0000-4000-8000-000000000004",
    );
    await context.service.steer(
      context.project.id,
      context.second.id,
      "Adjust second",
      "20000000-0000-4000-8000-000000000005",
    );
    expect(firstSession.steerCount).toBe(1);
    expect(secondSession.steerCount).toBe(1);

    firstSession.complete();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(context.store.latestRun(context.first.id)).toMatchObject({
      id: firstRun.id,
      state: "completed",
    });
    expect(context.store.latestRun(context.second.id)).toMatchObject({
      id: secondRun.id,
      state: "running",
    });
    await context.service.stop(
      context.project.id,
      context.second.id,
      "20000000-0000-4000-8000-000000000006",
    );
    expect(secondSession.stopCount).toBe(1);
    expect(context.store.unreadCount(context.project.id)).toBe(2);
    await context.service.close();
    context.store.close();
  });

  it("preflights different project threads concurrently", async () => {
    const context = await fixture();
    const firstSession = sessionFor(context, context.first.id);
    const secondSession = sessionFor(context, context.second.id);
    let releaseFirst: (() => void) | undefined;
    let releaseSecond: (() => void) | undefined;
    firstSession.promptGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    secondSession.promptGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });

    const first = context.service.prompt(
      context.project.id,
      context.first.id,
      "First work",
      "21000000-0000-4000-8000-000000000001",
    );
    const second = context.service.prompt(
      context.project.id,
      context.second.id,
      "Second work",
      "21000000-0000-4000-8000-000000000002",
    );
    await vi.waitFor(() => {
      expect(firstSession.promptCount).toBe(1);
      expect(secondSession.promptCount).toBe(1);
    });

    releaseFirst?.();
    releaseSecond?.();
    await Promise.all([first, second]);
    await context.service.stop(
      context.project.id,
      context.first.id,
      "21000000-0000-4000-8000-000000000003",
    );
    await context.service.stop(
      context.project.id,
      context.second.id,
      "21000000-0000-4000-8000-000000000004",
    );
    await context.service.close();
    context.store.close();
  });

  it("rejects a distinct same-thread prompt while preflight is pending", async () => {
    const context = await fixture();
    const firstSession = sessionFor(context, context.first.id);
    let release: (() => void) | undefined;
    firstSession.promptGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = context.service.prompt(
      context.project.id,
      context.first.id,
      "First work",
      "22000000-0000-4000-8000-000000000001",
    );
    await vi.waitFor(() => {
      expect(firstSession.promptCount).toBe(1);
    });

    await expect(
      context.service.prompt(
        context.project.id,
        context.first.id,
        "Conflicting work",
        "22000000-0000-4000-8000-000000000002",
      ),
    ).rejects.toThrow("project_busy");

    release?.();
    await first;
    await context.service.stop(
      context.project.id,
      context.first.id,
      "22000000-0000-4000-8000-000000000003",
    );
    await context.service.close();
    context.store.close();
  });

  it("does not release a replacement preflight lease after a stale stop", async () => {
    const context = await fixture();
    const session = sessionFor(context, context.first.id);
    await context.service.prompt(
      context.project.id,
      context.first.id,
      "Initial work",
      "22000000-0000-4000-8000-000000000010",
    );

    let releaseFirstStop: (() => void) | undefined;
    let releaseSecondStop: (() => void) | undefined;
    const firstStopGate = new Promise<void>((resolve) => {
      releaseFirstStop = resolve;
    });
    const secondStopGate = new Promise<void>((resolve) => {
      releaseSecondStop = resolve;
    });
    session.stopGate = (stopCount) => {
      if (stopCount === 1) return firstStopGate;
      if (stopCount === 2) return secondStopGate;
      return undefined;
    };
    const firstStop = context.service.stop(
      context.project.id,
      context.first.id,
      "22000000-0000-4000-8000-000000000011",
    );
    const secondStop = context.service.stop(
      context.project.id,
      context.first.id,
      "22000000-0000-4000-8000-000000000012",
    );
    await vi.waitFor(() => {
      expect(session.stopCount).toBe(2);
    });

    releaseFirstStop?.();
    await firstStop;
    let releaseReplacement: (() => void) | undefined;
    session.promptGate = new Promise<void>((resolve) => {
      releaseReplacement = resolve;
    });
    const replacement = context.service.prompt(
      context.project.id,
      context.first.id,
      "Replacement work",
      "22000000-0000-4000-8000-000000000013",
    );
    await vi.waitFor(() => {
      expect(session.promptCount).toBe(2);
    });

    releaseSecondStop?.();
    await secondStop;
    await expect(
      context.service.prompt(
        context.project.id,
        context.first.id,
        "Conflicting work",
        "22000000-0000-4000-8000-000000000014",
      ),
    ).rejects.toThrow("project_busy");
    expect(session.promptCount).toBe(2);

    releaseReplacement?.();
    await replacement;
    await context.service.stop(
      context.project.id,
      context.first.id,
      "22000000-0000-4000-8000-000000000015",
    );
    await context.service.close();
    context.store.close();
  });

  it("joins a concurrent prompt retry while runtime preflight is pending", async () => {
    const context = await fixture();
    let release: (() => void) | undefined;
    context.runtime.session.promptGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const key = "40000000-0000-4000-8000-000000000001";
    const first = context.service.prompt(
      context.project.id,
      context.first.id,
      "Work",
      key,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const retry = context.service.prompt(
      context.project.id,
      context.first.id,
      "Work",
      key,
    );
    release?.();
    const [run, replay] = await Promise.all([first, retry]);
    expect(replay.id).toBe(run.id);
    expect(context.runtime.session.promptCount).toBe(1);
    await context.service.close();
    context.store.close();
  });

  it.each([
    [
      "another operation",
      (context: Awaited<ReturnType<typeof fixture>>, key: string) =>
        context.service.createThread(context.project.id, "Different", key),
    ],
    [
      "a different prompt payload",
      (context: Awaited<ReturnType<typeof fixture>>, key: string) =>
        context.service.prompt(
          context.project.id,
          context.first.id,
          "Different",
          key,
        ),
    ],
  ])(
    "conflicts a concurrent command sharing an idempotency key with %s",
    async (_name, second) => {
      const context = await fixture();
      let release: (() => void) | undefined;
      context.runtime.session.promptGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const key = "41000000-0000-4000-8000-000000000001";
      const first = context.service.prompt(
        context.project.id,
        context.first.id,
        "Work",
        key,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      const conflicting = second(context, key);
      release?.();
      await first;
      await expect(conflicting).rejects.toThrow("Idempotency key was reused");
      expect(context.runtime.created).toBe(2);
      expect(context.runtime.session.promptCount).toBe(1);
      await context.service.stop(
        context.project.id,
        context.first.id,
        "41000000-0000-4000-8000-000000000002",
      );
      await context.service.close();
      context.store.close();
    },
  );

  it("stops an accepted prompt when durable run finalization fails", async () => {
    const context = await fixture();
    const key = "60000000-0000-4000-8000-000000000001";
    const cursor = context.service.broker.cursor(context.first.id);
    vi.spyOn(context.store, "createRunIfProjectActive").mockImplementationOnce(
      () => {
        throw new Error("storage_failed");
      },
    );

    await expect(
      context.service.prompt(context.project.id, context.first.id, "Work", key),
    ).rejects.toThrow("storage_failed");

    expect(context.runtime.session.stopCount).toBe(1);
    expect(context.store.latestRun(context.first.id)).toBeNull();
    expect(context.service.broker.cursor(context.first.id)).toEqual(cursor);

    const replacement = await context.service.prompt(
      context.project.id,
      context.second.id,
      "Tracked work",
      "60000000-0000-4000-8000-000000000002",
    );
    expect(replacement.state).toBe("running");
    await context.service.stop(
      context.project.id,
      context.second.id,
      "60000000-0000-4000-8000-000000000003",
    );
    await context.service.close();
    context.store.close();
  });

  it("replays concurrent thread creation and a stop without repeating runtime work", async () => {
    const context = await fixture();
    const createKey = "30000000-0000-4000-8000-000000000001";
    const [first, replay] = await Promise.all([
      context.service.createThread(context.project.id, "Replay", createKey),
      context.service.createThread(context.project.id, "Replay", createKey),
    ]);
    expect(replay).toEqual(first);
    expect(context.runtime.created).toBe(3);
    await expect(
      context.service.createThread(context.project.id, "Changed", createKey),
    ).rejects.toThrow("Idempotency key was reused");

    const run = await context.service.prompt(
      context.project.id,
      context.first.id,
      "Stop this",
      "30000000-0000-4000-8000-000000000002",
    );
    const stopKey = "30000000-0000-4000-8000-000000000003";
    const stopped = await context.service.stop(
      context.project.id,
      context.first.id,
      stopKey,
    );
    const retried = await context.service.stop(
      context.project.id,
      context.first.id,
      stopKey,
    );
    expect(stopped).toEqual(retried);
    expect(stopped.id).toBe(run.id);
    expect(context.runtime.session.stopCount).toBe(1);
    await context.service.close();
    context.store.close();
  });

  it("releases every active run when its project is removed and restored", async () => {
    const context = await fixture();
    const firstSession = sessionFor(context, context.first.id);
    const secondSession = sessionFor(context, context.second.id);
    const firstRun = await context.service.prompt(
      context.project.id,
      context.first.id,
      "Remove this project",
      "50000000-0000-4000-8000-000000000001",
    );
    const secondRun = await context.service.prompt(
      context.project.id,
      context.second.id,
      "Also remove this",
      "50000000-0000-4000-8000-000000000002",
    );

    await context.service.removeProject(
      context.project.id,
      "50000000-0000-4000-8000-000000000003",
    );

    expect(context.store.latestRun(context.first.id)).toMatchObject({
      id: firstRun.id,
      state: "interrupted",
      failure_code: "project_removed",
      failure_message: "Interrupted because the project was removed.",
    });
    expect(context.store.latestRun(context.second.id)).toMatchObject({
      id: secondRun.id,
      state: "interrupted",
      failure_code: "project_removed",
      failure_message: "Interrupted because the project was removed.",
    });
    expect(firstSession.stopCount).toBe(1);
    expect(secondSession.stopCount).toBe(1);

    const restored = await context.service.registerSelectedProject(
      context.projectPath,
    );
    expect(restored.id).toBe(context.project.id);

    const replacement = await context.service.prompt(
      restored.id,
      context.first.id,
      "Start again",
      "50000000-0000-4000-8000-000000000004",
    );
    expect(replacement.state).toBe("running");
    await context.service.stop(
      restored.id,
      context.first.id,
      "50000000-0000-4000-8000-000000000005",
    );
    await context.service.close();
    context.store.close();
  });

  it("keeps a project usable when runtime disposal aborts removal", async () => {
    const context = await fixture();
    const firstSession = sessionFor(context, context.first.id);
    await context.service.prompt(
      context.project.id,
      context.first.id,
      "Start and cache the runtime",
      "53000000-0000-4000-8000-000000000001",
    );
    vi.spyOn(firstSession, "dispose").mockRejectedValueOnce(
      new Error("dispose_failed"),
    );

    await expect(
      context.service.removeProject(
        context.project.id,
        "53000000-0000-4000-8000-000000000002",
      ),
    ).rejects.toThrow("dispose_failed");

    const replacement = await context.service.prompt(
      context.project.id,
      context.second.id,
      "Continue after failed removal",
      "53000000-0000-4000-8000-000000000003",
    );
    expect(replacement.state).toBe("running");
    await context.service.stop(
      context.project.id,
      context.second.id,
      "53000000-0000-4000-8000-000000000004",
    );
    await context.service.close();
    context.store.close();
  });

  it("rejects prompts that start while project removal is disposing runtimes", async () => {
    const context = await fixture();
    const firstSession = sessionFor(context, context.first.id);
    const original = await context.service.prompt(
      context.project.id,
      context.first.id,
      "Remove this project",
      "52000000-0000-4000-8000-000000000001",
    );
    let releaseDisposal: (() => void) | undefined;
    firstSession.disposeGate = new Promise<void>((resolve) => {
      releaseDisposal = resolve;
    });

    const removal = context.service.removeProject(
      context.project.id,
      "52000000-0000-4000-8000-000000000002",
    );
    await vi.waitFor(() => {
      expect(firstSession.disposeCount).toBe(1);
    });

    await expect(
      context.service.prompt(
        context.project.id,
        context.second.id,
        "Too late",
        "52000000-0000-4000-8000-000000000003",
      ),
    ).rejects.toThrow("project_not_found");
    expect(sessionFor(context, context.second.id).promptCount).toBe(0);

    releaseDisposal?.();
    await removal;
    expect(context.store.runningRunsForProject(context.project.id)).toEqual([]);

    const restored = await context.service.registerSelectedProject(
      context.projectPath,
    );
    expect(context.store.runningRunsForProject(restored.id)).toEqual([]);
    const replacement = await context.service.prompt(
      restored.id,
      context.second.id,
      "Fresh prompt",
      "52000000-0000-4000-8000-000000000004",
    );
    expect(replacement.state).toBe("running");
    expect(context.store.latestRun(context.first.id)).toMatchObject({
      id: original.id,
      state: "interrupted",
    });
    await context.service.stop(
      restored.id,
      context.second.id,
      "52000000-0000-4000-8000-000000000005",
    );
    await context.service.close();
    context.store.close();
  });

  it("releases removed preflight leases without disturbing a replacement run", async () => {
    const context = await fixture();
    const firstSession = sessionFor(context, context.first.id);
    const secondSession = sessionFor(context, context.second.id);
    let releaseFirst: (() => void) | undefined;
    let releaseSecond: (() => void) | undefined;
    firstSession.promptGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    secondSession.promptGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });

    const first = context.service.prompt(
      context.project.id,
      context.first.id,
      "First blocked prompt",
      "51000000-0000-4000-8000-000000000001",
    );
    const second = context.service.prompt(
      context.project.id,
      context.second.id,
      "Second blocked prompt",
      "51000000-0000-4000-8000-000000000002",
    );
    await vi.waitFor(() => {
      expect(firstSession.promptCount).toBe(1);
      expect(secondSession.promptCount).toBe(1);
    });

    await context.service.removeProject(
      context.project.id,
      "51000000-0000-4000-8000-000000000003",
    );
    expect(firstSession.stopCount).toBe(1);
    expect(secondSession.stopCount).toBe(1);

    const restored = await context.service.registerSelectedProject(
      context.projectPath,
    );
    firstSession.promptGate = undefined;
    const replacement = await context.service.prompt(
      restored.id,
      context.first.id,
      "Fresh prompt",
      "51000000-0000-4000-8000-000000000004",
    );
    expect(replacement.state).toBe("running");
    releaseFirst?.();
    releaseSecond?.();

    await expect(first).rejects.toThrow("project_not_found");
    await expect(second).rejects.toThrow("project_not_found");
    expect(context.store.latestRun(context.first.id)).toMatchObject({
      id: replacement.id,
      state: "running",
    });
    expect(context.store.latestRun(context.second.id)).toBeNull();
    expect(firstSession.discardCount).toBe(1);
    expect(secondSession.discardCount).toBe(1);
    expect(context.service.broker.cursor(context.first.id).sequence).toBe(1);
    expect(context.service.broker.cursor(context.second.id).sequence).toBe(0);
    await context.service.stop(
      restored.id,
      context.first.id,
      "51000000-0000-4000-8000-000000000005",
    );
    await context.service.close();
    context.store.close();
  });
});
