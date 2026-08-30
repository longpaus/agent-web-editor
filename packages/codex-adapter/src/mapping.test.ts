import { describe, expect, it } from "vitest";

import { ChatImageIdSchema, TranscriptItemSchema } from "@pi-web/contracts";

import {
  mapNotification,
  mapThreadItem,
  sessionDescriptor,
  transcriptFromThread,
} from "./mapping.js";

const at = 1_755_000_000_000; // 2025-08-12T12:40:00.000Z

/** Everything mapped must satisfy the shared contract, not merely resemble it. */
function contractual(item: unknown) {
  const parsed = TranscriptItemSchema.safeParse(item);
  if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues));
  return parsed.data;
}

describe("mapThreadItem", () => {
  it("maps a user message from its text parts", () => {
    const item = contractual(
      mapThreadItem(
        {
          type: "userMessage",
          id: "i1",
          clientId: "c1",
          content: [
            { type: "text", text: "first" },
            { type: "image", url: "https://example.invalid/x.png" },
            { type: "text", text: "second" },
          ],
        },
        at,
      ),
    );
    expect(item).toMatchObject({
      kind: "message",
      role: "user",
      text: "first\nsecond",
    });
  });

  it("maps only adapter-owned local images through the supplied resolver", () => {
    const trustedPath = "/codex-owned/a.png";
    const item = contractual(
      mapThreadItem(
        {
          type: "userMessage",
          id: "image-message",
          content: [
            { type: "text", text: "look" },
            { type: "localImage", path: trustedPath },
            { type: "localImage", path: "/tmp/untrusted.png" },
            { type: "image", url: "https://example.invalid/remote.png" },
          ],
        },
        at,
        (path) =>
          path === trustedPath
            ? {
                id: ChatImageIdSchema.parse("a".repeat(64)),
                mimeType: "image/png",
              }
            : null,
      ),
    );
    expect(item).toMatchObject({
      kind: "message",
      role: "user",
      text: "look",
      images: [{ id: "a".repeat(64), mimeType: "image/png" }],
    });
  });

  it("maps an assistant message", () => {
    expect(
      contractual(
        mapThreadItem({ type: "agentMessage", id: "i2", text: "done" }, at),
      ),
    ).toMatchObject({ kind: "message", role: "assistant", text: "done" });
  });

  it("renders reasoning from its summary and drops empty reasoning", () => {
    expect(
      contractual(
        mapThreadItem(
          {
            type: "reasoning",
            id: "i3",
            summary: ["Weighing options"],
            content: [],
          },
          at,
        ),
      ),
    ).toMatchObject({
      kind: "message",
      role: "assistant",
      text: "Weighing options",
    });
    expect(
      mapThreadItem(
        { type: "reasoning", id: "i4", summary: [], content: [] },
        at,
      ),
    ).toBeNull();
  });

  it("maps a shell command with its cwd, exit code, and output", () => {
    const item = contractual(
      mapThreadItem(
        {
          type: "commandExecution",
          id: "i5",
          command: "pnpm test",
          cwd: "/repo",
          status: "completed",
          aggregatedOutput: "ok",
          exitCode: 0,
        },
        at,
      ),
    );
    expect(item).toMatchObject({
      kind: "tool",
      name: "shell",
      status: "completed",
      input: "pnpm test",
      output: "ok",
      cwd: "/repo",
      exitCode: 0,
    });
  });

  it("translates every command status onto the contract's three", () => {
    const status = (value: string) => {
      const item = mapThreadItem(
        {
          type: "commandExecution",
          id: "s",
          command: "x",
          cwd: "/r",
          status: value,
          aggregatedOutput: "",
          exitCode: null,
        },
        at,
      );
      return item !== null && item.kind === "tool" ? item.status : null;
    };
    expect(status("inProgress")).toBe("running");
    expect(status("completed")).toBe("completed");
    expect(status("failed")).toBe("failed");
    // A sandbox refusal is a visible failure, never a silent stall (AGB-06).
    expect(status("declined")).toBe("failed");
  });

  it("maps a file change to its paths and diffs", () => {
    const item = contractual(
      mapThreadItem(
        {
          type: "fileChange",
          id: "i6",
          status: "completed",
          changes: [
            {
              path: "a.ts",
              kind: { type: "update", move_path: null },
              diff: "@@ -1 +1 @@",
            },
            { path: "b.ts", kind: { type: "add" }, diff: "+new" },
          ],
        },
        at,
      ),
    );
    expect(item).toMatchObject({
      kind: "tool",
      name: "apply_patch",
      status: "completed",
    });
    if (item.kind !== "tool") throw new Error("expected a tool item");
    expect(item.input).toContain("update a.ts");
    expect(item.input).toContain("add b.ts");
    expect(item.output).toContain("+new");
  });

  it("maps an MCP tool call under a server-qualified name", () => {
    const item = contractual(
      mapThreadItem(
        {
          type: "mcpToolCall",
          id: "i7",
          server: "docs",
          tool: "search",
          status: "failed",
          arguments: { q: "zod" },
          error: "no such index",
        },
        at,
      ),
    );
    expect(item).toMatchObject({
      kind: "tool",
      name: "docs.search",
      status: "failed",
    });
    if (item.kind !== "tool") throw new Error("expected a tool item");
    expect(item.input).toContain("zod");
    expect(item.output).toContain("no such index");
  });

  it("maps a web search to its query", () => {
    expect(
      contractual(
        mapThreadItem(
          { type: "webSearch", id: "i8", query: "zod refine", action: null },
          at,
        ),
      ),
    ).toMatchObject({ kind: "tool", name: "web_search", input: "zod refine" });
  });

  it("reports an unrecognised item as a diagnostic instead of discarding it", () => {
    const item = contractual(
      mapThreadItem({ type: "somethingNewInCodex", id: "i9" }, at),
    );
    expect(item).toMatchObject({ kind: "diagnostic", level: "info" });
    if (item.kind !== "diagnostic") throw new Error("expected a diagnostic");
    expect(item.text).toContain("somethingNewInCodex");
  });

  it("rejects an item with no usable id", () => {
    expect(mapThreadItem({ type: "agentMessage", text: "x" }, at)).toBeNull();
    expect(mapThreadItem("not an object", at)).toBeNull();
    expect(mapThreadItem(null, at)).toBeNull();
  });

  it("truncates text that would exceed the contract's caps", () => {
    const huge = "x".repeat(3_000_000);
    const message = contractual(
      mapThreadItem({ type: "agentMessage", id: "i10", text: huge }, at),
    );
    if (message.kind !== "message") throw new Error("expected a message");
    expect(message.text.length).toBeLessThanOrEqual(2_000_000);

    const command = contractual(
      mapThreadItem(
        {
          type: "commandExecution",
          id: "i11",
          command: huge,
          cwd: "/".padEnd(900, "d"),
          status: "completed",
          aggregatedOutput: huge,
          exitCode: 0,
        },
        at,
      ),
    );
    if (command.kind !== "tool") throw new Error("expected a tool item");
    expect(command.input.length).toBeLessThanOrEqual(200_000);
    expect(command.output.length).toBeLessThanOrEqual(1_000_000);
    expect(command.cwd?.length ?? 0).toBeLessThanOrEqual(500);
  });

  it("carries the item timestamp as an ISO instant", () => {
    const item = contractual(
      mapThreadItem({ type: "agentMessage", id: "i12", text: "hi" }, at),
    );
    expect(item.timestamp).toBe(new Date(at).toISOString());
    const undated = contractual(
      mapThreadItem({ type: "agentMessage", id: "i13", text: "hi" }, null),
    );
    expect(undated.timestamp).toBeNull();
  });
});

describe("mapNotification", () => {
  it("turns a completed item into a transcript event", () => {
    const event = mapNotification("item/completed", {
      threadId: "t1",
      turnId: "r1",
      completedAtMs: at,
      item: { type: "agentMessage", id: "i1", text: "hello" },
    });
    expect(event).toMatchObject({
      type: "transcript",
      item: { kind: "message", text: "hello" },
    });
  });

  it("turns a started item into an update so a running tool can be replaced", () => {
    const event = mapNotification("item/started", {
      threadId: "t1",
      turnId: "r1",
      item: {
        type: "commandExecution",
        id: "i2",
        command: "sleep 1",
        cwd: "/r",
        status: "inProgress",
        aggregatedOutput: "",
        exitCode: null,
      },
    });
    expect(event).toMatchObject({
      type: "transcript-update",
      item: { kind: "tool", status: "running" },
    });
  });

  it("settles a turn on completion, interruption, and failure", () => {
    expect(
      mapNotification("turn/completed", {
        threadId: "t1",
        turn: { id: "r1", status: "completed", items: [], error: null },
      }),
    ).toMatchObject({ type: "settled", outcome: "completed" });
    expect(
      mapNotification("turn/completed", {
        threadId: "t1",
        turn: { id: "r1", status: "interrupted", items: [], error: null },
      }),
    ).toMatchObject({ type: "settled", outcome: "interrupted" });
    expect(
      mapNotification("turn/completed", {
        threadId: "t1",
        turn: {
          id: "r1",
          status: "failed",
          items: [],
          error: { message: "model unavailable" },
        },
      }),
    ).toMatchObject({
      type: "settled",
      outcome: "failed",
      message: "model unavailable",
    });
  });

  it("reports an error notification as a diagnostic", () => {
    expect(
      mapNotification("error", {
        threadId: "t1",
        turnId: "r1",
        willRetry: false,
        error: { message: "rate limited" },
      }),
    ).toMatchObject({
      type: "diagnostic",
      level: "error",
      message: "rate limited",
    });
  });

  it("ignores notifications it has no mapping for", () => {
    expect(
      mapNotification("thread/tokenUsage/updated", { threadId: "t" }),
    ).toBeNull();
    expect(mapNotification("item/completed", { nonsense: true })).toBeNull();
  });
});

describe("thread projections", () => {
  const thread = {
    id: "019fa011-c136-7dc0-8c67-e5f7926bd517",
    name: "Fix the parser",
    preview: "Fix the parser",
    cwd: "/repo",
    createdAt: at,
    updatedAt: at + 60_000,
    turns: [
      {
        id: "r1",
        status: "completed",
        error: null,
        items: [
          {
            type: "userMessage",
            id: "u1",
            clientId: "c1",
            content: [{ type: "text", text: "go" }],
          },
          { type: "agentMessage", id: "a1", text: "done" },
        ],
      },
    ],
  };

  it("projects a thread into a contract-valid transcript in order", () => {
    const transcript = transcriptFromThread(thread);
    for (const item of transcript) contractual(item);
    expect(transcript.map((item) => item.kind)).toEqual(["message", "message"]);
    expect(transcript[0]).toMatchObject({ role: "user", text: "go" });
    expect(transcript[1]).toMatchObject({ role: "assistant", text: "done" });
  });

  it("describes a thread for the session list", () => {
    const descriptor = sessionDescriptor(thread);
    expect(descriptor).toMatchObject({
      id: "019fa011-c136-7dc0-8c67-e5f7926bd517",
      name: "Fix the parser",
      messageCount: 2,
      preview: "Fix the parser",
    });
    expect(descriptor?.createdAt).toBe(new Date(at).toISOString());
    expect(descriptor?.modifiedAt).toBe(new Date(at + 60_000).toISOString());
  });

  it("skips a thread whose identity cannot be trusted", () => {
    expect(sessionDescriptor({ ...thread, id: "not-a-uuid" })).toBeNull();
    expect(sessionDescriptor({ ...thread, createdAt: "yesterday" })).toBeNull();
    expect(sessionDescriptor(null)).toBeNull();
  });

  it("treats a missing name as unnamed rather than failing", () => {
    const descriptor = sessionDescriptor({ ...thread, name: null });
    expect(descriptor?.name).toBeNull();
  });
});
