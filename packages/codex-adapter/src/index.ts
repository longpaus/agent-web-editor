import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import {
  RuntimeFailure,
  type AgentRuntime,
  type OpenRuntimeSession,
  type PromptAcceptance,
  type PromptRecovery,
  type RuntimeImageContent,
  type RuntimeEvent,
  type RuntimePromptDispatch,
  type RuntimeSessionDescriptor,
  type RuntimeSnapshot,
  type RuntimeUserInput,
} from "@pi-web/agent-runtime";
import {
  type ChatImageId,
  type ImageInputCapability,
  TranscriptCursorSchema,
  TranscriptPageSchema,
  type TranscriptCursor,
  type TranscriptItem,
  type TranscriptPage,
} from "@pi-web/contracts";
import { z } from "zod";

import { CodexClient, type CodexTransport } from "./client.js";
import { CodexImageStore, type PreparedCodexInput } from "./images.js";
import {
  mapNotification,
  sessionDescriptor,
  transcriptFromThread,
  transcriptTurnsFromThread,
  type TranscriptTurn,
} from "./mapping.js";
import { RolloutReader, locateRollout } from "./rollout/index.js";
import { spawnCodexTransport } from "./spawn.js";

export { spawnCodexTransport } from "./spawn.js";
export { CodexClient, type CodexTransport } from "./client.js";

/**
 * The workspace has no surface for answering an agent's permission prompt, so
 * approvals are disabled outright rather than routed nowhere. Anything Codex
 * would have asked about either proceeds inside the sandbox or fails visibly.
 * This is a property of the workspace and is deliberately not configurable.
 */
const APPROVAL_POLICY = "never";

export type CodexSandbox =
  "read-only" | "workspace-write" | "danger-full-access";

export interface CodexAgentRuntimeOptions {
  /** Executable to run; defaults to `codex` on PATH. */
  command?: string;
  /** File and network boundary for every Codex chat. */
  sandbox?: CodexSandbox;
  /** Root containing `sessions/`; defaults to CODEX_HOME or ~/.codex. */
  codexHome?: string;
  /** Emergency switch for Codex's private rollout format. */
  replayTools?: boolean;
  /** Test seam: supply a transport instead of spawning Codex. */
  connect?: () => Promise<CodexTransport>;
}

/** Parses the Codex state-root boundary before either the CLI or replay reads it. */
export function parseCodexHome(configuredHome?: string): string {
  const rawHome = configuredHome ?? process.env.CODEX_HOME;
  if (rawHome === undefined) return join(homedir(), ".codex");
  if (!isAbsolute(rawHome))
    throw new Error("CODEX_HOME must be an absolute path");
  return resolve(rawHome);
}

const CODEX_PROCESS_ENVIRONMENT_KEYS = [
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TMPDIR",
  "TEMP",
  "TMP",
  "SYSTEMROOT",
  "SystemRoot",
  "COMSPEC",
  "ComSpec",
  "PATHEXT",
] as const;

/**
 * Constructs the deliberately narrow environment available to Codex and the
 * commands it runs. Server configuration and credentials must not cross this
 * process boundary through an inherited environment.
 */
export function createCodexProcessEnvironment(
  codexHome: string,
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const codexEnvironment: NodeJS.ProcessEnv = { CODEX_HOME: codexHome };
  for (const key of CODEX_PROCESS_ENVIRONMENT_KEYS) {
    const value = environment[key];
    if (value !== undefined) codexEnvironment[key] = value;
  }
  return codexEnvironment;
}

const DISCOVERY_PAGE_LIMIT = 100;
const DISCOVERY_MAX_PAGES = 50;
const CREATION_MARKER_PREFIX = "pi-web:create:";

const threadEnvelopeSchema = z.object({ thread: z.object({ id: z.uuid() }) });
const resumedThreadEnvelopeSchema = z.object({
  thread: z.object({ id: z.uuid() }),
  model: z.string().min(1).optional(),
});
const startedThreadEnvelopeSchema = z.object({
  thread: z.object({ id: z.uuid(), threadSource: z.string() }),
});
const threadListSchema = z.object({
  data: z.array(z.unknown()).default([]),
  nextCursor: z.string().nullish(),
});
const creationLookupThreadSchema = z.object({
  id: z.uuid(),
  threadSource: z.string().nullish(),
});
const threadReadSchema = z.object({
  thread: z.looseObject({ path: z.string().nullish() }),
});
const turnEnvelopeSchema = z.object({
  turn: z.object({ id: z.string().min(1) }),
});
const threadScopedSchema = z.object({ threadId: z.string().min(1) });
const turnCompletionSchema = z.object({
  threadId: z.string().min(1),
  turn: z.object({ id: z.string().min(1) }),
});
const userMessageWithClientIdSchema = z.object({
  type: z.literal("userMessage"),
  clientId: z.string().nullish(),
  content: z.array(z.unknown()).default([]),
});
const textPartSchema = z.object({ type: z.literal("text"), text: z.string() });
const turnsSchema = z.object({
  turns: z
    .array(z.object({ items: z.array(z.unknown()).default([]) }))
    .default([]),
});
const modelListSchema = z.object({
  data: z.array(z.unknown()).default([]),
  nextCursor: z.string().nullish(),
});
const modelSchema = z.object({
  id: z.string().min(1),
  model: z.string().min(1),
  isDefault: z.boolean().default(false),
  inputModalities: z.array(z.enum(["text", "image", "audio"])).optional(),
});
const localImagePartSchema = z.object({
  type: z.literal("localImage"),
  path: z.string(),
});

type CodexUserInputItem =
  | { type: "text"; text: string; text_elements: [] }
  | { type: "localImage"; path: string };

function sameUserInput(
  recorded: unknown[],
  expected: readonly CodexUserInputItem[],
): boolean {
  if (recorded.length !== expected.length) return false;
  return recorded.every((rawPart, index) => {
    const expectedPart = expected[index];
    if (expectedPart === undefined) return false;
    if (expectedPart.type === "text") {
      const parsed = textPartSchema.safeParse(rawPart);
      return parsed.success && parsed.data.text === expectedPart.text;
    }
    const parsed = localImagePartSchema.safeParse(rawPart);
    return parsed.success && parsed.data.path === expectedPart.path;
  });
}

export class CodexAgentRuntime implements AgentRuntime {
  private readonly client: CodexClient;
  private readonly sandbox: CodexSandbox;
  private readonly codexHome: string;
  private readonly replayTools: boolean;
  private readonly imageStore: CodexImageStore;

  public constructor(options: CodexAgentRuntimeOptions = {}) {
    this.sandbox = options.sandbox ?? "workspace-write";
    this.codexHome = parseCodexHome(options.codexHome);
    this.replayTools = options.replayTools ?? true;
    this.imageStore = new CodexImageStore(this.codexHome);
    const command = options.command ?? "codex";
    const connect =
      options.connect ??
      (() =>
        spawnCodexTransport(command, ["app-server"], {
          env: createCodexProcessEnvironment(this.codexHome),
        }));
    this.client = new CodexClient({ connect });
    // Registered once for the whole process: every approval Codex raises is
    // declined immediately so no run can wait on an answer nothing can give.
    this.client.onServerRequest((method) =>
      isApprovalRequest(method) ? { decision: "denied" } : null,
    );
  }

  public inspectImageInput(): Promise<ImageInputCapability> {
    return this.inspectModelImageInput();
  }

  private async inspectModelImageInput(
    selectedModel?: string,
  ): Promise<ImageInputCapability> {
    try {
      let cursor: string | undefined;
      for (let page = 0; page < DISCOVERY_MAX_PAGES; page += 1) {
        const raw = await this.client.request("model/list", {
          limit: DISCOVERY_PAGE_LIMIT,
          ...(cursor === undefined ? {} : { cursor }),
        });
        const parsed = modelListSchema.safeParse(raw);
        if (!parsed.success) return "unknown";
        for (const entry of parsed.data.data) {
          const model = modelSchema.safeParse(entry);
          if (!model.success) continue;
          const selected =
            selectedModel === undefined
              ? model.data.isDefault
              : model.data.id === selectedModel ||
                model.data.model === selectedModel;
          if (!selected) continue;
          // Older app-server versions omit this field and historically exposed
          // text + image input, so absence retains that compatible behaviour.
          const modalities = model.data.inputModalities ?? ["text", "image"];
          return modalities.includes("image") ? "supported" : "unsupported";
        }
        const next = parsed.data.nextCursor;
        if (next === null || next === undefined || next === "") break;
        cursor = next;
      }
      return "unknown";
    } catch {
      return "unknown";
    }
  }

  public async discover(
    projectPath: string,
  ): Promise<{ sessions: RuntimeSessionDescriptor[]; diagnostics: string[] }> {
    const sessions: RuntimeSessionDescriptor[] = [];
    const diagnostics: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < DISCOVERY_MAX_PAGES; page += 1) {
      const raw = await this.client.request("thread/list", {
        cwd: projectPath,
        limit: DISCOVERY_PAGE_LIMIT,
        ...(cursor === undefined ? {} : { cursor }),
      });
      const parsed = threadListSchema.safeParse(raw);
      if (!parsed.success)
        throw new RuntimeFailure(
          "malformed",
          "Codex returned an unreadable session list.",
        );
      for (const entry of parsed.data.data) {
        const descriptor = sessionDescriptor(entry);
        if (descriptor === null)
          diagnostics.push("Skipped an unreadable Codex session entry.");
        else sessions.push(descriptor);
      }
      const next = parsed.data.nextCursor;
      if (next === null || next === undefined || next === "") break;
      cursor = next;
      if (page === DISCOVERY_MAX_PAGES - 1)
        diagnostics.push(
          "Stopped listing Codex sessions after reaching the page limit.",
        );
    }
    return { sessions, diagnostics };
  }

  public async create(
    projectPath: string,
    title?: string,
    creationId?: string,
  ): Promise<{ sessionId: string }> {
    const marker =
      creationId === undefined ? undefined : creationMarkerFrom(creationId);
    if (marker !== undefined) {
      const existing = await this.findCreatedThread(projectPath, marker);
      if (existing !== undefined) return { sessionId: existing };
    }
    const raw = await this.client.request("thread/start", {
      cwd: projectPath,
      approvalPolicy: APPROVAL_POLICY,
      sandbox: this.sandbox,
      ...(marker === undefined ? {} : { threadSource: marker }),
    });
    const parsed = threadEnvelopeSchema.safeParse(raw);
    if (!parsed.success)
      throw new RuntimeFailure(
        "malformed",
        "Codex did not return a usable thread identifier.",
      );
    if (marker !== undefined) {
      const started = startedThreadEnvelopeSchema.safeParse(raw);
      if (!started.success || started.data.thread.threadSource !== marker)
        throw new RuntimeFailure(
          "malformed",
          "Codex did not preserve the thread creation marker.",
        );
    }
    const sessionId = parsed.data.thread.id;
    if (title !== undefined && title !== "")
      await this.client.request("thread/name/set", {
        threadId: sessionId,
        name: title,
      });
    return { sessionId };
  }

  /** Finds exactly one persisted native thread for a caller-owned creation. */
  private async findCreatedThread(
    projectPath: string,
    marker: string,
  ): Promise<string | undefined> {
    const matches: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < DISCOVERY_MAX_PAGES; page += 1) {
      const raw = await this.client.request("thread/list", {
        cwd: projectPath,
        limit: DISCOVERY_PAGE_LIMIT,
        ...(cursor === undefined ? {} : { cursor }),
      });
      const parsed = threadListSchema.safeParse(raw);
      if (!parsed.success)
        throw new RuntimeFailure(
          "malformed",
          "Codex returned an unreadable session list.",
        );
      for (const entry of parsed.data.data) {
        const thread = creationLookupThreadSchema.safeParse(entry);
        if (!thread.success)
          throw new RuntimeFailure(
            "malformed",
            "Codex returned an unreadable thread creation marker.",
          );
        if (
          thread.data.threadSource === undefined ||
          thread.data.threadSource === null
        )
          continue;
        const returnedMarker = parseCreationMarker(thread.data.threadSource);
        if (
          returnedMarker === null &&
          thread.data.threadSource.startsWith(CREATION_MARKER_PREFIX)
        )
          throw new RuntimeFailure(
            "malformed",
            "Codex returned an invalid thread creation marker.",
          );
        if (thread.data.threadSource === marker) matches.push(thread.data.id);
      }
      const next = parsed.data.nextCursor;
      if (next === null || next === undefined || next === "") {
        if (matches.length > 1)
          throw new RuntimeFailure(
            "malformed",
            "Codex returned multiple threads for one creation marker.",
          );
        return matches[0];
      }
      if (page === DISCOVERY_MAX_PAGES - 1)
        throw new RuntimeFailure(
          "rejected",
          "Codex session lookup reached its safe page limit.",
        );
      cursor = next;
    }
    throw new RuntimeFailure(
      "rejected",
      "Codex session lookup reached its safe page limit.",
    );
  }

  public async open(
    projectPath: string,
    sessionId: string,
  ): Promise<OpenRuntimeSession> {
    const raw = await this.client.request("thread/resume", {
      threadId: sessionId,
      cwd: projectPath,
      approvalPolicy: APPROVAL_POLICY,
      sandbox: this.sandbox,
    });
    const resumed = resumedThreadEnvelopeSchema.safeParse(raw);
    if (!resumed.success || resumed.data.thread.id !== sessionId)
      throw new RuntimeFailure(
        "malformed",
        "Codex did not resume the requested thread.",
      );
    return new CodexOpenSession(
      this.client,
      sessionId,
      this.codexHome,
      this.replayTools,
      this.imageStore,
      resumed.data.model,
      (model) => this.inspectModelImageInput(model),
    );
  }

  /**
   * Reports whether Codex can actually run here. Used to show the backend
   * disabled with a reason rather than letting chat creation fail (AGB-03).
   */
  public async probe(): Promise<{ available: boolean; reason?: string }> {
    try {
      await this.client.ready();
      return { available: true };
    } catch (error) {
      return {
        available: false,
        reason:
          error instanceof Error
            ? error.message
            : "Codex is not available on this machine.",
      };
    }
  }

  /** Releases the shared app-server process. */
  public close(): Promise<void> {
    return this.client.dispose();
  }
}

function creationMarkerFrom(creationId: string): string {
  const parsed = z.uuid().safeParse(creationId);
  if (!parsed.success)
    throw new RuntimeFailure(
      "malformed",
      "The thread creation identity is invalid.",
    );
  return `${CREATION_MARKER_PREFIX}${parsed.data}`;
}

function parseCreationMarker(value: string): string | null {
  const prefix = value.startsWith(CREATION_MARKER_PREFIX);
  if (!prefix) return null;
  const parsed = z.uuid().safeParse(value.slice(CREATION_MARKER_PREFIX.length));
  return parsed.success ? parsed.data : null;
}

function isApprovalRequest(method: string): boolean {
  return /approval/i.test(method) || /elicitation/i.test(method);
}

interface CodexPagePosition {
  turnEnd: number;
  itemEnd?: number;
}

interface StoredCodexPagePosition {
  position: CodexPagePosition;
  boundaryTurnId: string | null;
  page?: TranscriptPage;
  pageLoad?: Promise<TranscriptPage>;
}

const PAGE_ITEM_LIMIT = 100;
const PAGE_BYTE_TARGET = 1_048_576;
const CURSOR_LIMIT = 2_000;

class CodexOpenSession implements OpenRuntimeSession {
  private readonly listeners = new Set<(event: RuntimeEvent) => void>();
  private readonly unavailableListeners = new Set<(reason: string) => void>();
  private readonly pageCursors = new Map<
    TranscriptCursor,
    StoredCodexPagePosition
  >();
  private bufferedEvents: RuntimeEvent[] | null = null;
  private activeTurnId: string | null = null;
  private turns: TranscriptTurn[] | null = null;
  private rollout: RolloutReader | null = null;
  private replayDiagnostic: TranscriptItem | null = null;
  private replayWarningAdded = false;
  private settleActiveTurn:
    ((outcome: "completed" | "failed" | "interrupted") => void) | undefined;
  private promptPreflight:
    | {
        settle: (outcome: "completed" | "failed" | "interrupted") => void;
        terminal:
          | { turnId: string; outcome: "completed" | "failed" | "interrupted" }
          | undefined;
      }
    | undefined;
  private disposed = false;
  private unavailable = false;
  private readonly unsubscribeNotifications: () => void;
  private readonly unsubscribeDisconnect: () => void;

  public constructor(
    private readonly client: CodexClient,
    public readonly id: string,
    private readonly codexHome: string,
    private readonly replayTools: boolean,
    private readonly imageStore: CodexImageStore,
    private readonly model: string | undefined,
    private readonly inspectModelImageInput: (
      model: string | undefined,
    ) => Promise<ImageInputCapability>,
  ) {
    this.unsubscribeNotifications = client.onNotification((method, params) => {
      this.receive(method, params);
    });
    // A dead app-server can never complete an in-flight turn, so settle it as
    // failed rather than leaving the run hanging.
    this.unsubscribeDisconnect = client.onDisconnect((reason) => {
      this.unavailable = true;
      this.emit({ type: "diagnostic", level: "error", message: reason });
      this.settle("failed");
      for (const listener of this.unavailableListeners) listener(reason);
    });
  }

  public async snapshot(): Promise<RuntimeSnapshot> {
    const thread = await this.readThread();
    const imageInput = await this.inspectModelImageInput(this.model);
    return {
      sessionId: this.id,
      transcript: transcriptFromThread(thread, (path) =>
        this.imageStore.referenceForPath(this.id, path),
      ),
      diagnostics: [],
      ...(imageInput === "unknown" ? {} : { imageInput }),
    };
  }

  public async latestTranscriptPage(): Promise<TranscriptPage> {
    const thread = await this.readThread();
    this.turns = transcriptTurnsFromThread(thread, (path) =>
      this.imageStore.referenceForPath(this.id, path),
    );
    this.rollout = null;
    this.replayDiagnostic = null;
    this.replayWarningAdded = false;
    if (this.replayTools) {
      try {
        const path = await locateRollout(thread.path, this.codexHome);
        this.rollout = await RolloutReader.open(path);
      } catch {
        this.replayDiagnostic = {
          id: "codex-tool-replay-unavailable",
          kind: "diagnostic",
          level: "info",
          text: "Earlier tool activity could not be restored for this chat.",
          timestamp: null,
        };
      }
    }
    return await this.buildPage({ turnEnd: this.turns.length }, true);
  }

  public async olderTranscriptPage(
    cursor: TranscriptCursor,
  ): Promise<TranscriptPage> {
    const stored = this.pageCursors.get(cursor);
    if (stored === undefined || this.turns === null)
      throw new RuntimeFailure("rejected", "The transcript position is stale.");
    const currentBoundary = this.turns[stored.position.turnEnd - 1]?.id ?? null;
    if (currentBoundary !== stored.boundaryTurnId)
      throw new RuntimeFailure("rejected", "The transcript position is stale.");
    if (stored.page !== undefined) return stored.page;
    if (stored.pageLoad !== undefined) return await stored.pageLoad;
    const pageLoad = this.buildPage(stored.position, false);
    stored.pageLoad = pageLoad;
    try {
      const page = await pageLoad;
      stored.page = page;
      return page;
    } finally {
      delete stored.pageLoad;
    }
  }

  private async readThread(): Promise<
    z.infer<typeof threadReadSchema>["thread"]
  > {
    // `includeTurns` defaults to false, which returns metadata with no items.
    const raw = await this.client.request("thread/read", {
      threadId: this.id,
      includeTurns: true,
    });
    const parsed = threadReadSchema.safeParse(raw);
    if (!parsed.success)
      throw new RuntimeFailure(
        "malformed",
        "Codex returned an unreadable thread.",
      );
    return parsed.data.thread;
  }

  private cursor(position: CodexPagePosition): TranscriptCursor {
    const cursor = TranscriptCursorSchema.parse(
      randomBytes(24).toString("base64url"),
    );
    this.pageCursors.set(cursor, {
      position,
      boundaryTurnId: this.turns?.[position.turnEnd - 1]?.id ?? null,
    });
    while (this.pageCursors.size > CURSOR_LIMIT) {
      const oldest = this.pageCursors.keys().next().value;
      if (oldest === undefined) break;
      this.pageCursors.delete(oldest);
    }
    return cursor;
  }

  private async turnItems(turn: TranscriptTurn): Promise<TranscriptItem[]> {
    if (this.rollout === null) return [...turn.items];
    let projection: Awaited<ReturnType<RolloutReader["projectTurn"]>>;
    try {
      projection = await this.rollout.projectTurn(turn.id);
    } catch {
      this.rollout = null;
      if (this.replayWarningAdded) return [...turn.items];
      this.replayWarningAdded = true;
      return [
        ...turn.items,
        {
          id: `codex-tool-replay-error-${turn.id}`.slice(0, 200),
          kind: "diagnostic",
          level: "info",
          text: "Earlier tool activity could not be restored for this chat.",
          timestamp: null,
        },
      ];
    }
    if (
      projection.entries.length === 0 &&
      !projection.incomplete &&
      !projection.unknownDialect
    )
      return [...turn.items];
    const messages = new Map(turn.items.map((item) => [item.id, item]));
    const emitted = new Set<string>();
    const result: TranscriptItem[] = [];
    for (const entry of projection.entries) {
      if (entry.item !== undefined) result.push(entry.item);
      else if (entry.messageId !== undefined) {
        const message = messages.get(entry.messageId);
        if (message !== undefined && !emitted.has(message.id)) {
          result.push(message);
          emitted.add(message.id);
        }
      }
    }
    for (const message of turn.items)
      if (!emitted.has(message.id)) result.push(message);
    if (
      (projection.incomplete || projection.unknownDialect) &&
      !this.replayWarningAdded
    ) {
      this.replayWarningAdded = true;
      result.unshift({
        id: `${
          projection.incomplete
            ? "codex-tool-replay-boundary"
            : "codex-tool-replay-unknown"
        }-${turn.id}`.slice(0, 200),
        kind: "diagnostic",
        level: "info",
        text: projection.incomplete
          ? "Earlier tool activity could not be restored beyond this point."
          : "Earlier tool activity could not be restored for this chat.",
        timestamp: null,
      });
    }
    return result;
  }

  private async buildPage(
    position: CodexPagePosition,
    atLatest: boolean,
  ): Promise<TranscriptPage> {
    const turns = this.turns;
    if (turns === null)
      throw new RuntimeFailure("rejected", "The transcript position is stale.");
    const items: TranscriptItem[] = [];
    let bytes = 0;
    const diagnosticCount = atLatest && this.replayDiagnostic !== null ? 1 : 0;
    if (this.replayDiagnostic !== null && diagnosticCount === 1) {
      items.push(this.replayDiagnostic);
      bytes = Buffer.byteLength(JSON.stringify(this.replayDiagnostic));
    }
    let turnIndex = position.turnEnd - 1;
    let requestedItemEnd = position.itemEnd;
    let older: CodexPagePosition | null = null;

    while (turnIndex >= 0) {
      const turn = turns[turnIndex];
      if (turn === undefined) break;
      const turnItems = await this.turnItems(turn);
      let itemIndex =
        Math.min(requestedItemEnd ?? turnItems.length, turnItems.length) - 1;
      requestedItemEnd = undefined;
      while (itemIndex >= 0) {
        const item = turnItems[itemIndex];
        if (item === undefined) {
          itemIndex -= 1;
          continue;
        }
        const itemBytes = Buffer.byteLength(JSON.stringify(item));
        if (
          items.length >= PAGE_ITEM_LIMIT ||
          (items.length > diagnosticCount &&
            bytes + itemBytes > PAGE_BYTE_TARGET)
        ) {
          older = { turnEnd: turnIndex + 1, itemEnd: itemIndex + 1 };
          break;
        }
        items.unshift(item);
        bytes += itemBytes;
        itemIndex -= 1;
      }
      if (older !== null) break;
      this.rollout?.releaseTurn(turn.id);
      turnIndex -= 1;
    }
    if (older === null && turnIndex >= 0) older = { turnEnd: turnIndex + 1 };
    return TranscriptPageSchema.parse({
      items,
      olderCursor: older === null ? null : this.cursor(older),
      atLatest,
    });
  }

  public async prompt(
    input: RuntimeUserInput | string,
    dispatch?: RuntimePromptDispatch,
  ): Promise<PromptAcceptance> {
    if (this.disposed)
      throw new RuntimeFailure("unavailable", "Runtime session is closed.");
    const prepared = await this.prepareInput(input, true);
    if (this.bufferedEvents !== null)
      throw new RuntimeFailure("busy", "A prompt preflight is already active.");
    const buffer: RuntimeEvent[] = [];
    this.bufferedEvents = buffer;

    let settleResolve:
      ((outcome: "completed" | "failed" | "interrupted") => void) | undefined;
    const settlement = new Promise<"completed" | "failed" | "interrupted">(
      (resolve) => {
        settleResolve = resolve;
      },
    );
    if (settleResolve === undefined)
      throw new RuntimeFailure(
        "provider",
        "Codex prompt settlement was not initialized.",
      );
    const preflight: NonNullable<typeof this.promptPreflight> = {
      settle: settleResolve,
      terminal: undefined,
    };
    this.promptPreflight = preflight;

    const discardEvents = () => {
      if (this.bufferedEvents === buffer) this.bufferedEvents = null;
      buffer.length = 0;
    };
    const releaseEvents = () => {
      if (this.bufferedEvents !== buffer) return;
      this.bufferedEvents = null;
      for (const event of buffer) this.emit(event);
      buffer.length = 0;
    };

    let turnId: string;
    try {
      const raw = await this.client.request("turn/start", {
        threadId: this.id,
        input: this.appServerInput(prepared),
        ...(dispatch === undefined ? {} : { clientUserMessageId: dispatch.id }),
      });
      const parsed = turnEnvelopeSchema.safeParse(raw);
      if (!parsed.success) throw new RuntimeFailure("malformed", "no turn");
      turnId = parsed.data.turn.id;
    } catch (error) {
      if (error instanceof RuntimeFailure && error.code === "provider")
        await this.imageStore.discardCreated(prepared);
      if (this.promptPreflight === preflight) this.promptPreflight = undefined;
      discardEvents();
      settleResolve("failed");
      return {
        accepted: false,
        reason:
          error instanceof Error ? error.message : "Codex refused the prompt.",
        settlement,
        releaseEvents,
        discardEvents,
      };
    }

    this.activeTurnId = turnId;
    this.settleActiveTurn = settleResolve;
    if (this.promptPreflight === preflight) this.promptPreflight = undefined;
    if (preflight.terminal?.turnId === turnId)
      this.settle(preflight.terminal.outcome);
    return { accepted: true, settlement, releaseEvents, discardEvents };
  }

  public async recoverPrompt(
    input: RuntimeUserInput | string,
    dispatch: RuntimePromptDispatch,
  ): Promise<PromptRecovery> {
    const prepared = await this.prepareInput(input, false);
    const expected = this.appServerInput(prepared);
    const raw = await this.client.request("thread/read", {
      threadId: this.id,
      includeTurns: true,
    });
    const envelope = threadReadSchema.safeParse(raw);
    if (!envelope.success) return { outcome: "not_accepted" };
    const thread = turnsSchema.safeParse(envelope.data.thread);
    if (!thread.success) return { outcome: "not_accepted" };
    // Codex echoes the caller's clientUserMessageId back on the stored user
    // message, which is the durable evidence that this dispatch arrived.
    for (const turn of thread.data.turns)
      for (const item of turn.items) {
        const parsed = userMessageWithClientIdSchema.safeParse(item);
        if (!parsed.success || parsed.data.clientId !== dispatch.id) continue;
        if (sameUserInput(parsed.data.content, expected))
          return { outcome: "accepted" };
      }
    return { outcome: "not_accepted" };
  }

  public async steer(input: RuntimeUserInput | string): Promise<void> {
    const prepared = await this.prepareInput(input, true);
    const turnId = this.activeTurnId;
    if (turnId === null)
      throw new RuntimeFailure(
        "rejected",
        "There is no running Codex turn to steer.",
      );
    try {
      await this.client.request("turn/steer", {
        threadId: this.id,
        input: this.appServerInput(prepared),
        expectedTurnId: turnId,
      });
    } catch (error) {
      if (error instanceof RuntimeFailure && error.code === "provider")
        await this.imageStore.discardCreated(prepared);
      throw error;
    }
  }

  public readImage(imageId: ChatImageId): Promise<RuntimeImageContent> {
    return this.imageStore.read(this.id, imageId);
  }

  private async prepareInput(
    input: RuntimeUserInput | string,
    enforceCapability: boolean,
  ): Promise<PreparedCodexInput> {
    if (
      enforceCapability &&
      typeof input !== "string" &&
      input.images.length > 0 &&
      (await this.inspectModelImageInput(this.model)) === "unsupported"
    )
      throw new RuntimeFailure("rejected", "chat_image_input_unsupported");
    return await this.imageStore.prepare(this.id, input);
  }

  private appServerInput(prepared: PreparedCodexInput): CodexUserInputItem[] {
    return [
      ...(prepared.text === ""
        ? []
        : [
            {
              type: "text" as const,
              text: prepared.text,
              text_elements: [] as [],
            },
          ]),
      ...prepared.images.map((image) => ({
        type: "localImage" as const,
        path: image.path,
      })),
    ];
  }

  public async stop(): Promise<void> {
    const turnId = this.activeTurnId;
    if (turnId === null) return;
    await this.client.request("turn/interrupt", {
      threadId: this.id,
      turnId,
    });
  }

  public subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public onUnavailable(listener: (reason: string) => void): () => void {
    this.unavailableListeners.add(listener);
    return () => this.unavailableListeners.delete(listener);
  }

  public async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeNotifications();
    this.unsubscribeDisconnect();
    this.listeners.clear();
    this.unavailableListeners.clear();
    // The disconnect listener runs before a later request causes the shared
    // client to create its replacement app-server. Never send this stale
    // handle's unsubscribe through that replacement: its owner must resume
    // first, with the configured sandbox and approval policy.
    if (this.unavailable) return;
    try {
      await this.client.request("thread/unsubscribe", { threadId: this.id });
    } catch {
      // Detaching is best effort; the shared process outlives this session.
    }
  }

  private receive(method: string, params: unknown): void {
    if (this.disposed) return;
    // One app-server serves every thread, so a notification is only ours when
    // it names this thread.
    const scoped = threadScopedSchema.safeParse(params);
    if (!scoped.success || scoped.data.threadId !== this.id) return;
    const event = mapNotification(method, params, (path) =>
      this.imageStore.referenceForPath(this.id, path),
    );
    if (event === null) return;
    if (event.type === "settled") {
      const completion = turnCompletionSchema.safeParse(params);
      if (!completion.success) return;
      if (this.promptPreflight !== undefined && this.activeTurnId === null) {
        this.promptPreflight.terminal = {
          turnId: completion.data.turn.id,
          outcome: event.outcome,
        };
        return;
      }
      if (
        this.activeTurnId !== null &&
        completion.data.turn.id !== this.activeTurnId
      )
        return;
      this.settle(event.outcome);
      return;
    }
    this.emit(event);
  }

  private settle(outcome: "completed" | "failed" | "interrupted"): void {
    const resolve = this.settleActiveTurn;
    this.settleActiveTurn = undefined;
    this.activeTurnId = null;
    resolve?.(outcome);
  }

  private emit(event: RuntimeEvent): void {
    if (this.bufferedEvents !== null) {
      this.bufferedEvents.push(event);
      return;
    }
    for (const listener of this.listeners) listener(event);
  }
}
