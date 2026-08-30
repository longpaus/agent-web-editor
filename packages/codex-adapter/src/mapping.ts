import type {
  RuntimeEvent,
  RuntimeSessionDescriptor,
} from "@pi-web/agent-runtime";
import {
  CHAT_IMAGE_MAX_COUNT,
  type ChatImageRef,
  type TranscriptItem,
} from "@pi-web/contracts";
import { z } from "zod";

/**
 * Caps come from `TranscriptItemSchema`. Codex output is unbounded — a long
 * build log or a huge diff will exceed them — so text is truncated here rather
 * than allowed to fail the parse and lose the item entirely.
 */
const MESSAGE_TEXT_MAX = 2_000_000;
const TOOL_INPUT_MAX = 200_000;
const TOOL_OUTPUT_MAX = 1_000_000;
const DIAGNOSTIC_TEXT_MAX = 2_000;
const NAME_MAX = 200;
const CWD_MAX = 500;
const ID_MAX = 200;
const PREVIEW_MAX = 500;

const ELLIPSIS = "\n…truncated…";

function clamp(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, Math.max(0, max - ELLIPSIS.length)) + ELLIPSIS;
}

function instant(atMs: number | null | undefined): string | null {
  if (typeof atMs !== "number" || !Number.isFinite(atMs)) return null;
  const date = new Date(atMs);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Codex items always carry a string id; without one nothing can be updated. */
const identifiedSchema = z.object({
  type: z.string().min(1),
  id: z.string().min(1).max(ID_MAX),
});

const userMessageSchema = z.object({
  type: z.literal("userMessage"),
  id: z.string().min(1).max(ID_MAX),
  clientId: z.string().nullish(),
  content: z.array(z.unknown()).default([]),
});
const textPartSchema = z.object({ type: z.literal("text"), text: z.string() });
const localImagePartSchema = z.object({
  type: z.literal("localImage"),
  path: z.string(),
});

export type ImageReferenceResolver = (path: string) => ChatImageRef | null;

const agentMessageSchema = z.object({
  type: z.literal("agentMessage"),
  id: z.string().min(1).max(ID_MAX),
  text: z.string(),
});
const planSchema = z.object({
  type: z.literal("plan"),
  id: z.string().min(1).max(ID_MAX),
  text: z.string(),
});
const reasoningSchema = z.object({
  type: z.literal("reasoning"),
  id: z.string().min(1).max(ID_MAX),
  summary: z.array(z.string()).default([]),
  content: z.array(z.string()).default([]),
});
const commandExecutionSchema = z.object({
  type: z.literal("commandExecution"),
  id: z.string().min(1).max(ID_MAX),
  command: z.string().default(""),
  cwd: z.string().nullish(),
  status: z.string().default("inProgress"),
  aggregatedOutput: z.string().nullish(),
  exitCode: z.number().int().nullish(),
});
const patchChangeSchema = z.object({
  path: z.string().default(""),
  kind: z.object({ type: z.string() }).nullish(),
  diff: z.string().nullish(),
});
const fileChangeSchema = z.object({
  type: z.literal("fileChange"),
  id: z.string().min(1).max(ID_MAX),
  status: z.string().default("inProgress"),
  changes: z.array(patchChangeSchema).default([]),
});
const mcpToolCallSchema = z.object({
  type: z.literal("mcpToolCall"),
  id: z.string().min(1).max(ID_MAX),
  server: z.string().default("mcp"),
  tool: z.string().default("call"),
  status: z.string().default("inProgress"),
  arguments: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
});
const dynamicToolCallSchema = z.object({
  type: z.literal("dynamicToolCall"),
  id: z.string().min(1).max(ID_MAX),
  namespace: z.string().default("tool"),
  tool: z.string().default("call"),
  status: z.string().default("inProgress"),
  arguments: z.unknown().optional(),
  contentItems: z.unknown().optional(),
});
const webSearchSchema = z.object({
  type: z.literal("webSearch"),
  id: z.string().min(1).max(ID_MAX),
  query: z.string().default(""),
});

/** Codex's four states collapse onto the transcript contract's three. */
function toolStatus(value: string): "running" | "completed" | "failed" {
  if (value === "completed") return "completed";
  if (value === "inProgress") return "running";
  // "declined" is a sandbox or approval refusal. It is a visible failure, never
  // a pending state, so a blocked run always settles (AGB-06, AGB-07).
  return "failed";
}

function stringify(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    // TypeScript types this as `string`, but JSON.stringify genuinely returns
    // undefined for a function or symbol, which Codex could hand us inside an
    // arbitrary tool payload.
    const encoded = JSON.stringify(value) as string | undefined;
    return encoded ?? "";
  } catch {
    return "";
  }
}

function textParts(content: unknown[]): string {
  return content
    .map((part) => textPartSchema.safeParse(part))
    .filter((parsed) => parsed.success)
    .map((parsed) => parsed.data.text)
    .join("\n");
}

/**
 * Projects one Codex thread item onto the shared transcript contract.
 * Returns null when the item carries nothing worth showing.
 */
export function mapThreadItem(
  raw: unknown,
  atMs: number | null | undefined,
  resolveImage?: ImageReferenceResolver,
): TranscriptItem | null {
  const identified = identifiedSchema.safeParse(raw);
  if (!identified.success) return null;
  const timestamp = instant(atMs);
  const id = identified.data.id;

  const user = userMessageSchema.safeParse(raw);
  if (user.success) {
    const images =
      resolveImage === undefined
        ? []
        : user.data.content
            .map((part) => localImagePartSchema.safeParse(part))
            .filter((part) => part.success)
            .map((part) => resolveImage(part.data.path))
            .filter((image): image is ChatImageRef => image !== null)
            .slice(0, CHAT_IMAGE_MAX_COUNT);
    return {
      id,
      kind: "message",
      role: "user",
      text: clamp(textParts(user.data.content), MESSAGE_TEXT_MAX),
      ...(images.length === 0 ? {} : { images }),
      timestamp,
    };
  }

  const agent = agentMessageSchema.safeParse(raw);
  if (agent.success)
    return {
      id,
      kind: "message",
      role: "assistant",
      text: clamp(agent.data.text, MESSAGE_TEXT_MAX),
      timestamp,
    };

  const plan = planSchema.safeParse(raw);
  if (plan.success)
    return {
      id,
      kind: "message",
      role: "assistant",
      text: clamp(plan.data.text, MESSAGE_TEXT_MAX),
      timestamp,
    };

  const reasoning = reasoningSchema.safeParse(raw);
  if (reasoning.success) {
    // The summary is what Codex itself surfaces; raw content is not shown.
    const text = reasoning.data.summary.join("\n").trim();
    if (text === "") return null;
    return {
      id,
      kind: "message",
      role: "assistant",
      text: clamp(text, MESSAGE_TEXT_MAX),
      timestamp,
    };
  }

  const command = commandExecutionSchema.safeParse(raw);
  if (command.success)
    return {
      id,
      kind: "tool",
      name: "shell",
      status: toolStatus(command.data.status),
      input: clamp(command.data.command, TOOL_INPUT_MAX),
      output: clamp(command.data.aggregatedOutput ?? "", TOOL_OUTPUT_MAX),
      cwd:
        typeof command.data.cwd === "string"
          ? clamp(command.data.cwd, CWD_MAX)
          : null,
      exitCode: command.data.exitCode ?? null,
      timestamp,
    };

  const patch = fileChangeSchema.safeParse(raw);
  if (patch.success)
    return {
      id,
      kind: "tool",
      name: "apply_patch",
      status: toolStatus(patch.data.status),
      input: clamp(
        patch.data.changes
          .map((change) => `${change.kind?.type ?? "update"} ${change.path}`)
          .join("\n"),
        TOOL_INPUT_MAX,
      ),
      output: clamp(
        patch.data.changes.map((change) => change.diff ?? "").join("\n"),
        TOOL_OUTPUT_MAX,
      ),
      cwd: null,
      exitCode: null,
      timestamp,
    };

  const mcp = mcpToolCallSchema.safeParse(raw);
  if (mcp.success)
    return {
      id,
      kind: "tool",
      name: clamp(`${mcp.data.server}.${mcp.data.tool}`, NAME_MAX),
      status: toolStatus(mcp.data.status),
      input: clamp(stringify(mcp.data.arguments), TOOL_INPUT_MAX),
      output: clamp(
        mcp.data.error === undefined
          ? stringify(mcp.data.result)
          : stringify(mcp.data.error),
        TOOL_OUTPUT_MAX,
      ),
      cwd: null,
      exitCode: null,
      timestamp,
    };

  const dynamic = dynamicToolCallSchema.safeParse(raw);
  if (dynamic.success)
    return {
      id,
      kind: "tool",
      name: clamp(`${dynamic.data.namespace}.${dynamic.data.tool}`, NAME_MAX),
      status: toolStatus(dynamic.data.status),
      input: clamp(stringify(dynamic.data.arguments), TOOL_INPUT_MAX),
      output: clamp(stringify(dynamic.data.contentItems), TOOL_OUTPUT_MAX),
      cwd: null,
      exitCode: null,
      timestamp,
    };

  const search = webSearchSchema.safeParse(raw);
  if (search.success)
    return {
      id,
      kind: "tool",
      name: "web_search",
      status: "completed",
      input: clamp(search.data.query, TOOL_INPUT_MAX),
      output: "",
      cwd: null,
      exitCode: null,
      timestamp,
    };

  // An unrecognised type means Codex grew a capability this adapter predates.
  // Say so in the transcript rather than dropping it, so the gap is visible.
  return {
    id,
    kind: "diagnostic",
    level: "info",
    text: clamp(
      `Unsupported Codex item type: ${identified.data.type}`,
      DIAGNOSTIC_TEXT_MAX,
    ),
    timestamp,
  };
}

const itemLifecycleSchema = z.object({
  item: z.unknown(),
  completedAtMs: z.number().nullish(),
  startedAtMs: z.number().nullish(),
});
const turnSchema = z.object({
  id: z.string().min(1),
  status: z.string().default("inProgress"),
  error: z.object({ message: z.string() }).nullish(),
  items: z.array(z.unknown()).default([]),
});
const turnLifecycleSchema = z.object({ turn: turnSchema });
const errorNotificationSchema = z.object({
  error: z.object({ message: z.string() }),
});

/** Projects one app-server notification onto the shared runtime event union. */
export function mapNotification(
  method: string,
  params: unknown,
  resolveImage?: ImageReferenceResolver,
): RuntimeEvent | null {
  if (method === "item/completed" || method === "item/started") {
    const parsed = itemLifecycleSchema.safeParse(params);
    if (!parsed.success) return null;
    const item = mapThreadItem(
      parsed.data.item,
      parsed.data.completedAtMs ?? parsed.data.startedAtMs ?? null,
      resolveImage,
    );
    if (item === null) return null;
    // A started item is provisional: the same id is re-sent on completion, so
    // it must replace rather than append.
    return method === "item/started"
      ? { type: "transcript-update", item }
      : { type: "transcript", item };
  }

  if (method === "turn/completed") {
    const parsed = turnLifecycleSchema.safeParse(params);
    if (!parsed.success) return null;
    const { status, error } = parsed.data.turn;
    const outcome =
      status === "completed"
        ? ("completed" as const)
        : status === "interrupted"
          ? ("interrupted" as const)
          : ("failed" as const);
    return error?.message === undefined
      ? { type: "settled", outcome }
      : { type: "settled", outcome, message: error.message };
  }

  if (method === "error") {
    const parsed = errorNotificationSchema.safeParse(params);
    if (!parsed.success) return null;
    return {
      type: "diagnostic",
      level: "error",
      message: clamp(parsed.data.error.message, DIAGNOSTIC_TEXT_MAX),
    };
  }

  return null;
}

const threadSchema = z.object({
  id: z.uuid(),
  name: z.string().max(NAME_MAX).nullish(),
  preview: z.string().nullish(),
  cwd: z.string().nullish(),
  createdAt: z.number(),
  updatedAt: z.number(),
  turns: z.array(turnSchema).default([]),
});

export interface TranscriptTurn {
  id: string;
  status: string;
  items: TranscriptItem[];
}

/** Parses Codex turns while retaining the turn boundary needed for paging. */
export function transcriptTurnsFromThread(
  raw: unknown,
  resolveImage?: ImageReferenceResolver,
): TranscriptTurn[] {
  const thread = threadSchema.safeParse(raw);
  if (!thread.success) return [];
  return thread.data.turns.map((turn) => ({
    id: turn.id,
    status: turn.status,
    items: turn.items
      .map((item) => mapThreadItem(item, null, resolveImage))
      .filter((item): item is TranscriptItem => item !== null),
  }));
}

/** Flattens a thread's turns into one ordered transcript. */
export function transcriptFromThread(
  raw: unknown,
  resolveImage?: ImageReferenceResolver,
): TranscriptItem[] {
  return transcriptTurnsFromThread(raw, resolveImage).flatMap(
    (turn) => turn.items,
  );
}

/** Describes a thread for the session list, or null if it cannot be trusted. */
export function sessionDescriptor(
  raw: unknown,
): RuntimeSessionDescriptor | null {
  const thread = threadSchema.safeParse(raw);
  if (!thread.success) return null;
  const createdAt = instant(thread.data.createdAt);
  const modifiedAt = instant(thread.data.updatedAt);
  if (createdAt === null || modifiedAt === null) return null;
  const messageCount = thread.data.turns.reduce(
    (total, turn) =>
      total +
      turn.items.filter((item) => {
        const identified = identifiedSchema.safeParse(item);
        return (
          identified.success &&
          (identified.data.type === "userMessage" ||
            identified.data.type === "agentMessage")
        );
      }).length,
    0,
  );
  return {
    id: thread.data.id,
    name: thread.data.name ?? null,
    createdAt,
    modifiedAt,
    messageCount,
    preview: clamp(thread.data.preview ?? "", PREVIEW_MAX),
  };
}
