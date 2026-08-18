import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PiAgentRuntime } from "./index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("PiAgentRuntime persistent session creation", () => {
  it("opens a new thread from a fresh runtime before its first prompt", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-web-persistent-session-"));
    roots.push(root);
    const project = join(root, "project");
    const agentDirectory = join(root, "agent");
    await mkdir(project);
    await mkdir(agentDirectory);

    const created = await new PiAgentRuntime(agentDirectory).create(project);
    const restartedRuntime = new PiAgentRuntime(agentDirectory);

    await expect(restartedRuntime.discover(project)).resolves.toMatchObject({
      sessions: [
        {
          id: created.sessionId,
          name: "New thread",
          messageCount: 0,
          preview: "(no messages)",
        },
      ],
      diagnostics: [],
    });

    const opened = await restartedRuntime.open(project, created.sessionId);
    await expect(
      opened.snapshot({ maxItems: 100, targetBytes: 1_048_576 }),
    ).resolves.toMatchObject({
      sessionId: created.sessionId,
      transcriptPage: {
        items: [],
        olderCursor: null,
        newerCursor: null,
        atLatest: true,
      },
      diagnostics: [],
    });
    await opened.dispose();
  });
});
