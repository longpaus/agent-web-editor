// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectId, ThreadId } from "@pi-web/contracts";

const api = vi.hoisted(() => ({
  getAgentBackends: vi.fn(),
  getWorkspace: vi.fn(),
  getWorkspacePreflight: vi.fn(),
  preflightContinuation: vi.fn(),
  startThread: vi.fn(),
  continueThread: vi.fn(),
}));

vi.mock("../../api/client.js", async (importOriginal) => {
  const client = await importOriginal<typeof import("../../api/client.js")>();
  return { ...client, ...api };
});

import {
  continuationCreationKey,
  newChatDraftKey,
  readDraft,
} from "./drafts.js";
import {
  NewChatPane,
  partitionBranches,
  branchLabels,
  shortBranchLabel,
} from "./NewChatPane.js";
import { BACKEND_PREFERENCE_KEY } from "../settings/backendPreferences.js";

const projectId = "10000000-0000-4000-8000-000000000001" as ProjectId;
const threadId = "20000000-0000-4000-8000-000000000001" as ThreadId;
const paneId = "pane-1";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
});

function renderNewChat(
  preflight: Record<string, unknown> = {},
  continuationOrBackendPending: ThreadId | null | boolean = null,
  backendMetadata?: {
    defaultRuntime: "pi" | "codex";
    backends: {
      kind: "pi" | "codex";
      available: boolean;
      reason: string | null;
    }[];
  },
) {
  const continuationSourceThreadId =
    typeof continuationOrBackendPending === "string"
      ? continuationOrBackendPending
      : null;
  const backendMetadataPending = continuationOrBackendPending === true;
  if (backendMetadataPending)
    api.getAgentBackends.mockImplementation(
      async () => await new Promise<never>(() => undefined),
    );
  else
    api.getAgentBackends.mockResolvedValue(
      backendMetadata ?? {
        defaultRuntime: "pi",
        backends: [
          { kind: "pi", available: true, reason: null },
          { kind: "codex", available: true, reason: null },
        ],
      },
    );
  api.getWorkspace.mockResolvedValue({
    projects: [
      {
        id: projectId,
        displayName: "Example project",
        displayPath: "example",
        createdAt: "2026-01-01T00:00:00.000Z",
        available: true,
        gitAvailable: true,
        sidebarExpanded: true,
        unreadCount: 0,
        lastOpenedThreadId: null,
      },
    ],
    threads:
      continuationSourceThreadId === null
        ? []
        : [{ id: continuationSourceThreadId, runtime: "pi" }],
    diagnostics: [],
  });
  api.preflightContinuation.mockResolvedValue({
    available: true,
    imageInput: "unknown",
  });
  api.getWorkspacePreflight.mockResolvedValue({
    worktreeAvailable: true,
    unavailableReason: null,
    currentBranch: "master",
    branches: ["master"],
    changes: null,
    ...preflight,
  });
  const onThreadStarted = vi.fn();
  const onFocus = vi.fn();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <NewChatPane
          projectId={projectId}
          paneId={paneId}
          continuationSourceThreadId={continuationSourceThreadId}
          focused
          onFocus={onFocus}
          onClose={vi.fn()}
          onSplit={vi.fn()}
          onThreadStarted={onThreadStarted}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { onThreadStarted, onFocus };
}

describe("pending same-worktree continuation", () => {
  it("reuses the persisted first-prompt identity after a pending-page reload", async () => {
    const persistedKey = "90000000-0000-4000-8000-000000000090";
    localStorage.setItem(
      continuationCreationKey(projectId, paneId),
      persistedKey,
    );
    localStorage.setItem(
      newChatDraftKey(projectId, paneId),
      "Continue after reload",
    );
    api.continueThread.mockResolvedValue({
      thread: { id: threadId },
      run: { id: "30000000-0000-4000-8000-000000000001" },
    });
    const user = userEvent.setup();
    renderNewChat({}, threadId);

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Create chat and send" }),
      ).toBeEnabled();
    });
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(api.continueThread).toHaveBeenCalledWith(
        projectId,
        threadId,
        "Continue after reload",
        persistedKey,
        [],
      );
    });
  });

  it("creates the durable thread only when its first real prompt is submitted", async () => {
    api.continueThread.mockResolvedValue({
      thread: { id: threadId },
      run: { id: "30000000-0000-4000-8000-000000000001" },
    });
    const user = userEvent.setup();
    const { onThreadStarted } = renderNewChat({}, threadId);

    expect(
      await screen.findByText("Same managed worktree"),
    ).toBeInTheDocument();
    expect(
      screen.queryByLabelText("Execution location"),
    ).not.toBeInTheDocument();
    expect(api.continueThread).not.toHaveBeenCalled();

    const composer = screen.getByRole("textbox", { name: "First message" });
    await user.type(composer, "Continue implementation");
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(api.continueThread).toHaveBeenCalledWith(
        projectId,
        threadId,
        "Continue implementation",
        expect.any(String),
        [],
      );
    });
    expect(api.startThread).not.toHaveBeenCalled();
    expect(onThreadStarted).toHaveBeenCalledWith(threadId);
  });

  it("sends photos with the first prompt of an inherited Pi chat", async () => {
    api.continueThread.mockResolvedValue({
      thread: { id: threadId },
      run: { id: "30000000-0000-4000-8000-000000000001" },
    });
    const user = userEvent.setup();
    renderNewChat({}, threadId);
    const image = new File([new Uint8Array([1, 2, 3])], "context.png", {
      type: "image/png",
    });

    const composer = await screen.findByRole("textbox", {
      name: "First message",
    });
    const form = composer.closest("form");
    if (form === null) throw new Error("Expected a composer form");
    fireEvent.drop(form, {
      dataTransfer: { types: ["Files"], files: [image] },
    });
    expect(
      await screen.findByRole("list", { name: "Attached photos" }),
    ).toBeInTheDocument();
    await user.type(
      screen.getByRole("textbox", { name: "First message" }),
      "Use this screenshot",
    );
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(api.continueThread).toHaveBeenCalledWith(
        projectId,
        threadId,
        "Use this screenshot",
        expect.any(String),
        [image],
      );
    });
  });
});

// F7. Starting the first thread creates a git worktree, measured at 1.6-2.6s.
// For all of that time the typed text sat in the composer, the header still
// said "New chat", and the only feedback was an 11.5px grey hint -- it read
// as "my Enter key did not register".
describe("NewChatPane while the workspace is being prepared", () => {
  it("preflights image support for the selected Codex runtime", async () => {
    renderNewChat({ imageInput: "supported" }, false, {
      defaultRuntime: "codex",
      backends: [
        { kind: "pi", available: true, reason: null },
        { kind: "codex", available: true, reason: null },
      ],
    });
    await screen.findByRole("textbox", { name: "First message" });
    await waitFor(() => {
      expect(api.getWorkspacePreflight).toHaveBeenCalledWith(
        projectId,
        "codex",
      );
    });
    expect(screen.queryByLabelText("＋ Add photos")).not.toBeInTheDocument();
  });

  it("falls back to Pi when the default Codex backend is unavailable", async () => {
    const user = userEvent.setup();
    api.startThread.mockResolvedValue({ thread: { id: threadId } });
    renderNewChat({}, false, {
      defaultRuntime: "codex",
      backends: [
        { kind: "pi", available: true, reason: null },
        { kind: "codex", available: false, reason: "Codex CLI missing" },
      ],
    });

    await user.type(
      await screen.findByRole("textbox", { name: "First message" }),
      "Use Pi",
    );
    await user.keyboard("{Enter}");
    await waitFor(() => {
      expect(api.startThread).toHaveBeenCalled();
    });
    expect(api.startThread.mock.calls[0]?.[4]).toBe("pi");
  });

  it("lets the server select the machine default before backend metadata loads", async () => {
    const user = userEvent.setup();
    localStorage.setItem(
      BACKEND_PREFERENCE_KEY,
      JSON.stringify({ version: 1, choice: "follow-machine" }),
    );
    api.startThread.mockResolvedValue({ thread: { id: threadId } });
    renderNewChat({}, true);

    const composer = await screen.findByRole("textbox", {
      name: "First message",
    });
    await user.type(composer, "Use the machine default");
    await user.keyboard("{Enter}");
    await waitFor(() => {
      expect(api.startThread).toHaveBeenCalled();
    });
    expect(api.startThread.mock.calls[0]?.[4]).toBeUndefined();
  });

  it("clears the composer and echoes the message the moment it is sent", async () => {
    const user = userEvent.setup();
    let release: ((value: { thread: { id: ThreadId } }) => void) | undefined;
    api.startThread.mockImplementation(
      async () =>
        await new Promise<{ thread: { id: ThreadId } }>((resolve) => {
          release = resolve;
        }),
    );
    const { onThreadStarted } = renderNewChat();

    const composer = await screen.findByRole("textbox", {
      name: "First message",
    });
    await user.type(composer, "Build a Pomodoro timer");
    await user.keyboard("{Enter}");

    // The message is on screen and the composer is empty before the server
    // has answered anything.
    expect(screen.getByText("Build a Pomodoro timer")).toBeInTheDocument();
    expect(composer).toHaveValue("");
    expect(onThreadStarted).not.toHaveBeenCalled();

    // Worktree preparation is a step in the transcript, not a grey hint.
    expect(screen.getByText("Preparing")).toBeInTheDocument();
    expect(screen.getByLabelText("Running")).toBeInTheDocument();

    release?.({ thread: { id: threadId } });
    await waitFor(() => {
      expect(onThreadStarted).toHaveBeenCalledWith(threadId);
    });
  });

  it("sends what was typed, not the cleared composer", async () => {
    const user = userEvent.setup();
    api.startThread.mockResolvedValue({ thread: { id: threadId } });
    renderNewChat();

    const composer = await screen.findByRole("textbox", {
      name: "First message",
    });
    await user.type(composer, "Explain the repository layout");
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(api.startThread).toHaveBeenCalled();
    });
    expect(api.startThread.mock.calls[0]?.[1]).toBe(
      "Explain the repository layout",
    );
  });

  // S1. `requestSubmit()` ignores the disabled submit button, so Enter still
  // reaches the handler while the worktree is being created. Clearing the
  // composer removed the accidental protection that used to cover this: the
  // resent text was identical and carried the same idempotency key, so the
  // server deduplicated it. Typing again regenerates that key.
  it("cannot start a second thread while the first is still being created", async () => {
    const user = userEvent.setup();
    api.startThread.mockImplementation(
      async () => await new Promise<never>(() => undefined),
    );
    renderNewChat();

    const composer = await screen.findByRole("textbox", {
      name: "First message",
    });
    await user.type(composer, "First intent");
    await user.keyboard("{Enter}");
    expect(api.startThread).toHaveBeenCalledTimes(1);

    // Typing during the creation window regenerates the idempotency key, so
    // nothing downstream would collapse these into one thread.
    await user.type(composer, "Second intent");
    await user.keyboard("{Enter}");

    expect(api.startThread).toHaveBeenCalledTimes(1);
  });

  // S2. The tester called out draft persistence across a full page reload as
  // something that already worked. Clearing the composer must not narrow it:
  // until the thread exists, storage is the only copy of the message.
  it("keeps the typed message in storage for the whole creation window", async () => {
    const user = userEvent.setup();
    let release: ((value: { thread: { id: ThreadId } }) => void) | undefined;
    api.startThread.mockImplementation(
      async () =>
        await new Promise<{ thread: { id: ThreadId } }>((resolve) => {
          release = resolve;
        }),
    );
    renderNewChat();

    const composer = await screen.findByRole("textbox", {
      name: "First message",
    });
    await user.type(composer, "Survives a reload");
    await user.keyboard("{Enter}");

    expect(composer).toHaveValue("");
    expect(readDraft(newChatDraftKey(projectId, paneId))).toBe(
      "Survives a reload",
    );

    release?.({ thread: { id: threadId } });
    await waitFor(() => {
      expect(readDraft(newChatDraftKey(projectId, paneId))).toBe("");
    });
  });

  it("gives the draft back instead of eating it when the submit fails", async () => {
    const user = userEvent.setup();
    api.startThread.mockRejectedValue(new Error("worktree_create_failed"));
    renderNewChat();

    const composer = await screen.findByRole("textbox", {
      name: "First message",
    });
    await user.type(composer, "Start a risky thread");
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(composer).toHaveValue("Start a risky thread");
    });
    expect(readDraft(newChatDraftKey(projectId, paneId))).toBe(
      "Start a risky thread",
    );
    // Only one copy of the text: the echo is withdrawn when the send fails.
    expect(screen.queryByText("Preparing")).toBeNull();
  });
});

// F8. The pane had a header, a composer, and ~450px of nothing in between --
// on the screen where a first-time user decides what this tool is. The empty
// space now carries the two things the pane could not say any other way.
describe("NewChatPane's starter block", () => {
  it("offers example first messages that put themselves in the composer", async () => {
    const user = userEvent.setup();
    renderNewChat();

    const composer = await screen.findByRole("textbox", {
      name: "First message",
    });
    const examples = screen.getAllByRole("button", {
      name: /^(Walk the repository|Run the test suite|Summarise the last)/,
    });
    expect(examples).toHaveLength(3);

    const example = examples[1];
    if (example === undefined) throw new Error("expected an example");
    const text = example.textContent;
    await user.click(example);

    // Filled and focused, but NOT sent -- clicking an example is a way to
    // start writing, not a way to launch a run.
    expect(composer).toHaveValue(text);
    expect(composer).toHaveFocus();
    expect(api.startThread).not.toHaveBeenCalled();
  });

  // S3. The click used to call stopPropagation(), which cancelled the pane
  // shell's onClick -- this component's ONLY onFocus() call site. The pane you
  // were typing into was then not the pane the workspace considered focused:
  // it rendered `dim`, the panel followed a different pane, and Escape then
  // split acted on that other pane. F9 defeated by F8.
  it("focuses its own pane when a starter prompt is clicked", async () => {
    const user = userEvent.setup();
    const { onFocus } = renderNewChat();
    await screen.findByRole("textbox", { name: "First message" });

    await user.click(
      screen.getByRole("button", { name: /^Run the test suite/ }),
    );

    expect(onFocus).toHaveBeenCalled();
  });

  // The third example names the project's real base branch, so it reads as a
  // thing to ask about THIS repository rather than a placeholder.
  it("names the real base branch in the history example", async () => {
    renderNewChat();
    // The branch arrives with the preflight query, so the example starts on
    // the neutral "this branch" and adopts the real one when it lands.
    expect(
      await screen.findByRole("button", { name: /Summarise the last ten/ }),
    ).toHaveTextContent("the last ten commits on this branch");

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Summarise the last ten/ }),
      ).toHaveTextContent("the last ten commits on master");
    });
  });

  // The explanation must describe options that actually exist. The option
  // labels are read from the rendered selects rather than restated here, so
  // the copy cannot advertise a mode the app does not offer.
  it("explains every option the two mode selects actually offer", async () => {
    renderNewChat();
    await screen.findByRole("textbox", { name: "First message" });

    const optionLabels = ["Execution location", "Starting state"].flatMap(
      (name) =>
        [
          ...screen.getByRole("combobox", { name }).querySelectorAll("option"),
        ].map((option) => option.textContent),
    );
    expect(optionLabels).toEqual([
      "New worktree",
      "Local checkout",
      "Clean start",
      "Include local changes",
    ]);

    const terms = [...document.querySelectorAll(".new-chat-choices dt")].map(
      (term) => term.textContent,
    );
    for (const label of optionLabels) expect(terms).toContain(label);
  });

  it("gets out of the way once a message is sent", async () => {
    const user = userEvent.setup();
    api.startThread.mockImplementation(
      async () => await new Promise<never>(() => undefined),
    );
    renderNewChat();

    const composer = await screen.findByRole("textbox", {
      name: "First message",
    });
    await user.type(composer, "Go");
    await user.keyboard("{Enter}");

    expect(
      screen.queryByRole("button", { name: /^Walk the repository/ }),
    ).toBeNull();
    expect(document.querySelector(".new-chat-intro")).toBeNull();
  });
});

// F9. Escape used to leave both the value and document.activeElement
// untouched, so once you were in a composer Tab was the only way out and
// every pane shortcut the Settings page advertises was unreachable.
describe("NewChatPane's composer on Escape", () => {
  it("hands focus to the pane and keeps the draft", async () => {
    const user = userEvent.setup();
    renderNewChat();

    const composer = await screen.findByRole("textbox", {
      name: "First message",
    });
    await user.click(composer);
    await user.paste("draft line one\ndraft line two");
    expect(composer).toHaveFocus();

    await user.keyboard("{Escape}");

    const pane = screen.getByRole("region", { name: "New chat" });
    expect(pane).toHaveFocus();
    // The pane is a landing site for Escape, not a Tab stop.
    expect(pane).toHaveAttribute("tabindex", "-1");
    // Escape releases focus; it does not discard work.
    expect(composer).toHaveValue("draft line one\ndraft line two");
    expect(readDraft(newChatDraftKey(projectId, paneId))).toBe(
      "draft line one\ndraft line two",
    );
  });

  // Only a BARE Escape. A modified Escape is not this app's to claim, and the
  // hint and the Settings row both promise "Esc", not "any Escape".
  it("ignores a modified Escape", async () => {
    const user = userEvent.setup();
    renderNewChat();

    const composer = await screen.findByRole("textbox", {
      name: "First message",
    });
    await user.click(composer);

    for (const chord of ["{Shift>}{Escape}{/Shift}", "{Alt>}{Escape}{/Alt}"])
      await user.keyboard(chord);

    expect(composer).toHaveFocus();
  });
});

// G7. The Local-checkout note read "Pi will work directly in the existing
// checkout and see its current files." Every word of that is about READING.
// Verified against the server: a shared thread's execution root IS the
// project's own directory, and Pi's tools run there with the user's
// permissions and no approval step -- it writes. That is the defining
// property of the mode, and it is the one irreversible choice on this screen.
describe("NewChatPane's local-checkout warning", () => {
  async function chooseLocalCheckout(
    preflight: Record<string, unknown> = {},
  ): Promise<HTMLElement> {
    const user = userEvent.setup();
    renderNewChat(preflight);
    await screen.findByRole("textbox", { name: "First message" });
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Execution location" }),
      "shared",
    );
    return await screen.findByRole("status");
  }

  it("says that Pi writes, names the directory and names the branch", async () => {
    const note = await chooseLocalCheckout();

    expect(note).toHaveTextContent("Pi writes to your project directory");
    expect(note).toHaveTextContent(/edits, creates and deletes files/);
    expect(note).toHaveTextContent("example");
    expect(note).toHaveTextContent("master");
    expect(note).toHaveTextContent(/no undo/);
    // The old sentence claimed only that Pi would SEE the files.
    expect(note.textContent).not.toMatch(/see its current files/);
  });

  it("still names the write when the project has no current branch", async () => {
    const note = await chooseLocalCheckout({ currentBranch: null });

    expect(note).toHaveTextContent("Pi writes to your project directory");
    expect(note.textContent).not.toMatch(/current branch/);
  });

  // The disabled Base branch select kept DISPLAYING "master", which reads as
  // "it will use master" rather than "this control does not apply".
  it("stops the disabled base-branch select showing a branch it will not use", async () => {
    await chooseLocalCheckout();

    const branch = screen.getByRole("combobox", { name: "Base branch" });
    expect(branch).toBeDisabled();
    expect(branch).toHaveTextContent("Already on master");
    expect(branch.textContent).not.toBe("master");
  });
});

// G11. Every worktree thread creates a branch `pi/<slug>-<hash>`, and the
// select was built from every local head -- so the list grew by one long,
// machine-generated name per thread, forever, in a 200px control.
describe("NewChatPane's base branch list", () => {
  const generated = [
    "pi/explore-this-repository-before-changing-anything-1909c1f5",
    "pi/explore-this-repository-before-changing-anything-2a3b4c5d",
  ];

  it("puts the branches a person named ahead of the ones this app made", async () => {
    renderNewChat({
      branches: ["master", generated[0], "feature/login", generated[1]],
    });
    await screen.findByRole("textbox", { name: "First message" });
    await screen.findByRole("option", { name: "feature/login" });

    const select = screen.getByRole("combobox", { name: "Base branch" });
    const values = [...select.querySelectorAll("option")].map(
      (option) => option.value,
    );
    expect(values).toEqual(["master", "feature/login", ...generated]);
    expect(select.querySelector("optgroup")).toHaveAttribute(
      "label",
      "Previous Pi runs",
    );
  });

  it("keeps the hash that tells two generated branches apart", async () => {
    renderNewChat({ branches: ["master", ...generated] });
    await screen.findByRole("textbox", { name: "First message" });
    await screen.findByRole("option", { name: "master" });

    const labels = [
      ...screen
        .getByRole("combobox", { name: "Base branch" })
        .querySelectorAll("option"),
    ].map((option) => option.textContent);
    // Head truncation -- the browser's default in a 200px control -- leaves
    // these two identical.
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels[1]).toMatch(/1909c1f5$/);
    expect(labels[2]).toMatch(/2a3b4c5d$/);
    for (const label of labels) expect(label.length).toBeLessThanOrEqual(24);
  });

  it("shortens only what has to be shortened", () => {
    expect(shortBranchLabel("master")).toBe("master");
    expect(shortBranchLabel("feature/a-fairly-long-name")).toBe(
      "feature/a-fair…long-name",
    );
    expect(partitionBranches(["master", "pi/a-1", "dev"])).toEqual({
      project: ["master", "dev"],
      generated: ["pi/a-1"],
    });
  });

  // SF6. Keeping both ends saves the `pi/*` hash, but it does not make every
  // pair distinguishable: two branches that agree on their first 14 and last
  // 9 characters shorten onto one label, and the same function is applied to
  // the user's own branches. This control creates a worktree from the branch
  // it names, so two options that read alike are a wrong choice waiting to
  // happen.
  it("never gives two branches the same label", () => {
    const colliding = [
      "release/2024-01-01/hotfix-alpha",
      "release/2024-02-01/hotfix-alpha",
    ];
    expect(shortBranchLabel(colliding[0] ?? "")).toBe(
      shortBranchLabel(colliding[1] ?? ""),
    );

    const labels = branchLabels(colliding);
    // Shown in full: it is the POPUP that has to tell them apart, and a
    // native select popup sizes itself to its content.
    expect(labels.get(colliding[0] ?? "")).toBe(colliding[0]);
    expect(labels.get(colliding[1] ?? "")).toBe(colliding[1]);
    expect(new Set(labels.values()).size).toBe(2);
  });

  it("still shortens the branches that a label does identify", () => {
    const labels = branchLabels([
      "master",
      "release/2024-01-01/hotfix-alpha",
      "release/2024-02-01/hotfix-alpha",
      "pi/explore-this-repository-before-changing-anything-1909c1f5",
    ]);
    expect(labels.get("master")).toBe("master");
    expect(
      labels.get(
        "pi/explore-this-repository-before-changing-anything-1909c1f5",
      ),
    ).toBe("pi/explore-thi…-1909c1f5");
  });

  it("shows colliding branches in full in the control itself", async () => {
    const colliding = [
      "release/2024-01-01/hotfix-alpha",
      "release/2024-02-01/hotfix-alpha",
    ];
    renderNewChat({ branches: ["master", ...colliding] });
    await screen.findByRole("textbox", { name: "First message" });
    await screen.findByRole("option", { name: colliding[0] ?? "" });

    const labels = [
      ...screen
        .getByRole("combobox", { name: "Base branch" })
        .querySelectorAll("option"),
    ].map((option) => option.textContent);
    expect(labels).toEqual(["master", ...colliding]);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
