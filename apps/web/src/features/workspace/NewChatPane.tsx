import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  IdempotencyKeySchema,
  type ProjectId,
  type RuntimeKind,
  type ThreadId,
} from "@pi-web/contracts";

import {
  commandId,
  continueThread,
  getAgentBackends,
  getWorkspace,
  getWorkspacePreflight,
  preflightContinuation,
  startThread,
} from "../../api/client.js";
import { ActivityStep } from "../../components/Activity.js";
import {
  readBackendChoice,
  resolveDefaultBackend,
} from "../settings/backendPreferences.js";
import { ErrorNotice } from "../../components/ErrorNotice.js";
import { Markdown } from "../../components/Markdown.js";
import {
  continuationCreationKey,
  newChatDraftKey,
  readDraft,
  removeDraft,
  writeDraft,
} from "./drafts.js";
import type { PaneId } from "./layoutTree.js";
import { isReleaseKey, releaseFocusToPane } from "./paneFocus.js";
import { PaneHeader } from "./PaneHeader.js";
import { useAutoGrow } from "../../components/useAutoGrow.js";
import { ChatAttachmentStrip, useChatAttachments } from "./chatAttachments.js";

/**
 * Example first messages, written for what this tool actually is: a coding
 * agent pointed at a local git checkout. They are deliberately things you
 * would only ask an agent that can read the tree, run commands and read
 * history — not generic "ask me anything" filler, which would tell a first-
 * time user nothing about what the box in front of them is for.
 *
 * The base branch is interpolated so the third one names this project's real
 * branch rather than a placeholder.
 */
function starterPrompts(
  baseBranch: string,
): readonly { id: string; text: string }[] {
  return [
    {
      id: "layout",
      text: "Walk the repository and tell me how it is laid out. Do not change anything yet.",
    },
    { id: "tests", text: "Run the test suite, then fix whatever fails." },
    {
      // Keyed by identity, not by text: the branch name arrives with the
      // preflight query, so this one's text changes from "this branch" to the
      // real branch a moment after mount. Keying on the text would remount the
      // button at that moment and drop focus to <body> if it held it.
      id: "history",
      text: `Summarise the last ten commits on ${baseBranch || "this branch"} and what they were for.`,
    },
  ];
}

/**
 * A branch name short enough to survive the 200px select, with both ends
 * intact.
 *
 * Every worktree thread creates a branch `pi/<slug>-<hash>`, so this list
 * grows by one long, machine-generated name per thread and never shrinks.
 * Head truncation (the browser's default) makes them indistinguishable --
 * they all begin `pi/` and the slug is the prompt's first words, which for
 * threads started from the same starter prompt are identical. The trailing
 * hash is the only part that tells two of them apart, so it is the part that
 * must survive: the middle goes, not the tail.
 *
 * Keeping both ends is what makes `pi/*` names distinguishable, but it does
 * not make ALL names distinguishable: any two branches that agree on their
 * first 14 and last 9 characters collapse onto one label, and
 * `release/2024-01-01/hotfix-alpha` and `release/2024-02-01/hotfix-alpha`
 * both do. Use `branchLabels` rather than this function directly -- it knows
 * the whole list and can tell when a label has stopped identifying one
 * branch.
 *
 * Exported for the test that pins the `pi/*` property.
 */
export function shortBranchLabel(branch: string, max = 24): string {
  if (branch.length <= max) return branch;
  // Long enough for `-` plus the 8-character hash the worktree manager
  // appends, so a `pi/*` name keeps the field that disambiguates it.
  const tail = branch.slice(-9);
  return `${branch.slice(0, Math.max(1, max - tail.length - 1))}…${tail}`;
}

/**
 * A label for every branch in a list, with distinctness guaranteed.
 *
 * Two branches that shorten to the same label are shown in FULL instead: a
 * long option is a nuisance, two options that read identically are a wrong
 * choice waiting to happen, and this control creates a worktree from the
 * branch it names.
 *
 * The full name is a real fix rather than a fallback because it is the popup
 * that has to distinguish them, and a native `<select>` popup sizes itself to
 * its content -- the 200px that motivated shortening constrains the CLOSED
 * control, where only the selected option is drawn. `title={branch}` was the
 * stated mitigation and is not one on this loop's target platform: Chrome on
 * macOS draws `<select>` popups with the native menu, which does not surface
 * option titles at all. The attribute stays because it costs nothing and does
 * work elsewhere, but nothing depends on it now.
 *
 * Collisions are resolved across the WHOLE list, not per optgroup: "Previous
 * Pi runs" is a heading inside one select, not a separate control.
 */
export function branchLabels(
  branches: readonly string[],
  max = 24,
): Map<string, string> {
  const claimants = new Map<string, Set<string>>();
  for (const branch of branches) {
    const label = shortBranchLabel(branch, max);
    const claimed = claimants.get(label);
    if (claimed === undefined) claimants.set(label, new Set([branch]));
    else claimed.add(branch);
  }
  const labels = new Map<string, string>();
  for (const [label, claimed] of claimants)
    for (const branch of claimed)
      labels.set(branch, claimed.size === 1 ? label : branch);
  return labels;
}

/**
 * Splits the branch list into the branches a person made and the ones this
 * app made behind them.
 *
 * Order is preserved inside each part; only the partition is new.
 */
export function partitionBranches(branches: readonly string[]): {
  project: string[];
  generated: string[];
} {
  const project: string[] = [];
  const generated: string[] = [];
  for (const branch of branches)
    (branch.startsWith("pi/") ? generated : project).push(branch);
  return { project, generated };
}

function BranchOptions({
  branches,
  labels,
}: {
  branches: readonly string[];
  labels: ReadonlyMap<string, string>;
}) {
  return (
    <>
      {branches.map((branch) => (
        // `value` is always the real branch; only the label is shortened.
        <option key={branch} value={branch} title={branch}>
          {labels.get(branch) ?? branch}
        </option>
      ))}
    </>
  );
}

export interface NewChatPaneProps {
  projectId: ProjectId;
  paneId: PaneId;
  continuationSourceThreadId?: ThreadId | null;
  focused: boolean;
  onFocus(): void;
  onClose(): void;
  onSplit(): void;
  onThreadStarted(threadId: ThreadId): void;
}

const AGENT_OPTIONS: readonly { value: RuntimeKind; label: string }[] = [
  { value: "codex", label: "Codex" },
  { value: "pi", label: "Pi" },
];

export function NewChatPane(props: NewChatPaneProps) {
  const { projectId, paneId, focused } = props;
  const continuationSourceThreadId = props.continuationSourceThreadId ?? null;
  const draftKey = newChatDraftKey(projectId, paneId);
  const creationStorageKey = continuationCreationKey(projectId, paneId);
  const initialCreationKey = () => {
    if (continuationSourceThreadId !== null) {
      const stored = IdempotencyKeySchema.safeParse(
        readDraft(creationStorageKey),
      );
      if (stored.success) return stored.data;
    }
    return commandId();
  };
  const queryClient = useQueryClient();
  const workspace = useQuery({
    queryKey: ["workspace"],
    queryFn: getWorkspace,
  });
  const continuationPreflight = useQuery({
    queryKey: ["continuation-preflight", projectId, continuationSourceThreadId],
    queryFn: () => {
      if (continuationSourceThreadId === null)
        throw new Error("Continuation source is required");
      return preflightContinuation(projectId, continuationSourceThreadId);
    },
    enabled: continuationSourceThreadId !== null,
  });
  const [mode, setMode] = useState<"worktree" | "shared">("worktree");
  const [sourceChanges, setSourceChanges] = useState<
    "none" | "tracked_and_untracked"
  >("none");
  const [baseBranch, setBaseBranch] = useState("");
  const [creationKey, setCreationKey] = useState(initialCreationKey);
  const backends = useQuery({
    queryKey: ["agent-backends"],
    queryFn: getAgentBackends,
  });
  // Non-sticky by design: a new composer opens on the resolved default every
  // time, so an incidental one-off pick never becomes a standing choice.
  const backendChoice = readBackendChoice();
  const resolvedDefault = resolveDefaultBackend(
    backendChoice,
    backends.data?.defaultRuntime,
  );
  const [runtime, setRuntime] = useState<RuntimeKind | null>(null);
  const backendFor = (kind: RuntimeKind) =>
    backends.data?.backends.find((backend) => backend.kind === kind);
  const resolvedDefaultBackend = backendFor(resolvedDefault);
  const fallbackRuntime = backends.data?.backends.find(
    (backend) => backend.available,
  )?.kind;
  const selectedRuntime =
    runtime ??
    (resolvedDefaultBackend?.available === false
      ? (fallbackRuntime ?? resolvedDefault)
      : resolvedDefault);
  const preflightRuntime =
    runtime === null &&
    backendChoice === "follow-machine" &&
    backends.data === undefined
      ? undefined
      : selectedRuntime;
  const preflight = useQuery({
    queryKey: ["workspace-preflight", projectId, preflightRuntime],
    queryFn: () => getWorkspacePreflight(projectId, preflightRuntime),
    enabled: continuationSourceThreadId === null,
  });
  const continuationThread = workspace.data?.threads.find(
    (thread) => thread.id === continuationSourceThreadId,
  );
  // A continuation inherits its source chat's immutable backend. A brand-new
  // chat uses the selectable machine/default policy above.
  const effectiveRuntime = continuationThread?.runtime ?? selectedRuntime;
  const selectedBackend = backendFor(effectiveRuntime);
  const waitingForContinuationSource =
    continuationSourceThreadId !== null && workspace.data === undefined;
  const continuationSourceMissing =
    continuationSourceThreadId !== null &&
    workspace.data !== undefined &&
    continuationThread === undefined;
  const selectedUnavailable =
    waitingForContinuationSource ||
    continuationSourceMissing ||
    selectedBackend?.available === false;
  const selectedUnavailableReason = continuationSourceMissing
    ? "The source chat is no longer available."
    : (selectedBackend?.reason ?? "This agent backend is unavailable.");
  const agentLabel = effectiveRuntime === "codex" ? "Codex" : "Pi";
  const imageInputCapability =
    continuationSourceThreadId === null
      ? (preflight.data?.imageInput ?? "unknown")
      : continuationThread === undefined
        ? "unknown"
        : (continuationPreflight.data?.imageInput ?? "unknown");
  const [text, setText] = useState(() => readDraft(draftKey));
  const textareaRef = useAutoGrow<HTMLTextAreaElement>(text);
  const attachments = useChatAttachments(imageInputCapability, () => {
    props.onFocus();
    textareaRef.current?.focus();
  });
  const attachmentKey = attachments.images.map((image) => image.id).join(":");
  const previousAttachmentKey = useRef(attachmentKey);
  useEffect(() => {
    if (previousAttachmentKey.current === attachmentKey) return;
    previousAttachmentKey.current = attachmentKey;
    setCreationKey(commandId());
  }, [attachmentKey]);
  // The prompt the user has already committed to but that has no thread yet.
  // Starting the first thread creates a git worktree, which takes 1.6-2.6s;
  // leaving the text sitting in the composer for that long reads as "Enter
  // did not register", so the message is echoed here the moment it is sent.
  const [sentPrompt, setSentPrompt] = useState<string | null>(null);
  useEffect(() => {
    setMode("worktree");
    setSourceChanges("none");
    setBaseBranch("");
    setCreationKey(initialCreationKey());
    setSentPrompt(null);
    attachments.clear();
    setText(readDraft(newChatDraftKey(projectId, paneId)));
  }, [continuationSourceThreadId, paneId, projectId, attachments.clear]);
  useEffect(() => {
    if (continuationSourceThreadId === null) removeDraft(creationStorageKey);
    else writeDraft(creationStorageKey, creationKey);
  }, [continuationSourceThreadId, creationKey, creationStorageKey]);
  useEffect(() => {
    if (preflight.data?.currentBranch !== null && baseBranch === "")
      setBaseBranch(preflight.data?.currentBranch ?? "");
  }, [baseBranch, preflight.data?.currentBranch]);
  // Submitting clears the visible composer, but the draft must not go with
  // it: until the thread exists, storage is the only copy of what was typed,
  // and creating the worktree takes 1.6-2.6s (longer if the request hangs).
  // `onSuccess` removes it once there is a thread to hold the message.
  useEffect(() => {
    writeDraft(
      draftKey,
      text === "" && sentPrompt !== null ? sentPrompt : text,
    );
  }, [draftKey, sentPrompt, text]);
  const create = useMutation({
    mutationFn: async (promptText: string) =>
      continuationSourceThreadId === null
        ? await startThread(
            projectId,
            promptText,
            mode === "shared"
              ? { mode: "shared" }
              : {
                  mode: "worktree",
                  baseBranch,
                  sourceChanges,
                  ...(sourceChanges === "tracked_and_untracked" &&
                  preflight.data?.changes !== null &&
                  preflight.data?.changes !== undefined
                    ? { sourceStateToken: preflight.data.changes.token }
                    : {}),
                },
            creationKey,
            runtime === null &&
              backendChoice === "follow-machine" &&
              backends.data === undefined
              ? undefined
              : selectedRuntime,
            attachments.files,
          )
        : await continueThread(
            projectId,
            continuationSourceThreadId,
            promptText,
            creationKey,
            attachments.files,
          ),
    onSuccess: async (result) => {
      setSentPrompt(null);
      attachments.clear();
      removeDraft(draftKey);
      removeDraft(creationStorageKey);
      await queryClient.invalidateQueries({ queryKey: ["workspace"] });
      props.onThreadStarted(result.thread.id);
    },
  });
  const project = workspace.data?.projects.find(
    (candidate) => candidate.id === projectId,
  );
  const currentBranch = preflight.data?.currentBranch ?? null;
  const allBranches = preflight.data?.branches ?? [];
  const branchGroups = partitionBranches(allBranches);
  const branchLabelsByBranch = branchLabels(allBranches);
  const send = (value: string) => {
    // `requestSubmit()` with no argument ignores the disabled submit button,
    // so Enter still reaches this while a thread is being created. That used
    // to be harmless because the composer still held the original text and
    // the unchanged `creationKey` deduplicated it server-side -- but the
    // composer is cleared now, so typing again regenerates the key and a
    // second Enter would create a second thread and a second git worktree.
    if (
      create.isPending ||
      selectedUnavailable ||
      (attachments.images.length > 0 && imageInputCapability === "unsupported")
    )
      return;
    if (
      (value.trim() === "" && attachments.images.length === 0) ||
      (continuationSourceThreadId === null &&
        mode === "worktree" &&
        (!preflight.data?.worktreeAvailable || baseBranch === ""))
    )
      return;
    setSentPrompt(value);
    setText("");
    create.mutate(value, {
      onError: () => {
        // A failed submit must never eat what was typed: the composer gets
        // the text back byte for byte, draft included, and the echo goes
        // away so there is only one copy of it on screen.
        setSentPrompt(null);
        setText(value);
        writeDraft(draftKey, value);
      },
    });
  };
  const submit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    send(text);
  };
  return (
    <section
      className={`pane new-chat-pane ${focused ? "focused" : "dim"}`}
      aria-label="New chat"
      aria-current={focused ? "true" : undefined}
      // Escape in the composer parks focus here (see paneFocus.ts). Not in
      // the tab order -- this is a landing site, not a stop.
      tabIndex={-1}
      onClick={() => {
        props.onFocus();
      }}
    >
      <PaneHeader
        status={null}
        elapsed={null}
        title="New chat"
        projectLabel={project?.displayName ?? ""}
        runtime={null}
        focused={focused}
        detail={
          <span className="pane-meta">
            {continuationSourceThreadId === null
              ? `Pick where ${agentLabel} runs, then describe the work.`
              : `Same managed worktree · fresh ${agentLabel} conversation`}
          </span>
        }
        onSplit={() => {
          props.onSplit();
        }}
        onClose={() => {
          props.onClose();
        }}
      />
      <main className="center new-chat">
        {sentPrompt === null && continuationSourceThreadId === null && (
          // ~450px of empty white sat here: a header, a composer, and nothing
          // in between, on the screen where a first-time user decides what
          // this tool is. Two things fill it, and both are things the pane
          // could not say any other way -- the examples show what a good
          // first message to a coding agent looks like, and the second block
          // explains the three selects, whose options are otherwise invisible
          // until you open each dropdown. Both go away the moment a message
          // is sent; they are orientation, not chrome.
          <div className="new-chat-intro">
            {/* role="group", not the landmark a named <section> would
                imply: these are orientation inside a pane, and a screen
                reader's landmark list should hold the pane, not two more
                entries per empty pane. The heading still names them. */}
            <section
              className="new-chat-block"
              role="group"
              aria-labelledby={`new-chat-examples-${paneId}`}
            >
              <h2
                className="new-chat-block-title"
                id={`new-chat-examples-${paneId}`}
              >
                Example first messages
              </h2>
              <ul className="new-chat-examples">
                {starterPrompts(baseBranch).map((example) => (
                  <li key={example.id}>
                    <button
                      type="button"
                      className="new-chat-example"
                      // Deliberately NOT stopping propagation. The pane shell's
                      // onClick is this component's only call site for
                      // onFocus(), so swallowing the click here left the
                      // workspace believing a different pane was focused: the
                      // pane rendered `dim` while you typed in it, the panel
                      // kept following the other pane, and Escape-then-split
                      // acted on that other pane -- F9 defeated by F8 on the
                      // one surface where they meet.
                      onClick={() => {
                        setText(example.text);
                        setCreationKey(commandId());
                        textareaRef.current?.focus();
                      }}
                    >
                      {example.text}
                    </button>
                  </li>
                ))}
              </ul>
              <p className="new-chat-block-note">
                Clicking one fills the box below. Nothing is sent until you
                press Enter.
              </p>
            </section>
            <section
              className="new-chat-block"
              role="group"
              aria-labelledby={`new-chat-choices-${paneId}`}
            >
              <h2
                className="new-chat-block-title"
                id={`new-chat-choices-${paneId}`}
              >
                The three choices below
              </h2>
              <dl className="new-chat-choices">
                <dt>New worktree</dt>
                <dd>
                  A second checkout of this project in its own directory, cut
                  from the base branch you pick. {agentLabel}&apos;s edits never
                  touch the files you have open.
                </dd>
                <dt>Local checkout</dt>
                <dd>
                  The directory you added. {agentLabel} writes to the same files
                  you have open, on the branch you have checked out. Nothing is
                  copied first and there is no undo.
                </dd>
                <dt>Clean start</dt>
                <dd>
                  Begins at the last commit on the base branch. Nothing
                  uncommitted comes across.
                </dd>
                <dt>Include local changes</dt>
                <dd>
                  Copies your uncommitted tracked and untracked files in first.
                  Offered only when the base branch is the one you have checked
                  out and there is something to copy.
                </dd>
              </dl>
            </section>
          </div>
        )}
        {sentPrompt !== null && (
          // Sits on the same reading column as the card below it, so the
          // echoed message lands where the transcript will render it a moment
          // later. Worktree preparation is a step in that transcript now, not
          // an 11px grey hint in the corner of the composer.
          <div className="transcript-column" aria-label="Conversation">
            <div className="u-row">
              <div className="u-bubble">
                <span className="sr-only">You</span>
                {attachments.images.length > 0 && (
                  <div
                    className="pending-transcript-images"
                    aria-label="Attached images"
                  >
                    {attachments.images.map((image) =>
                      image.previewUrl === "" ? null : (
                        <img
                          key={image.id}
                          src={image.previewUrl}
                          alt={`Preview of ${image.label}`}
                        />
                      ),
                    )}
                  </div>
                )}
                {sentPrompt !== "" && (
                  <div className="markdown">
                    <Markdown>{sentPrompt}</Markdown>
                  </div>
                )}
              </div>
            </div>
            <ActivityStep
              label={{
                action: "Preparing",
                target:
                  continuationSourceThreadId !== null
                    ? "same managed worktree"
                    : mode === "worktree"
                      ? "new git worktree"
                      : (project?.displayPath ?? "local checkout"),
                meta: "naming the thread",
              }}
              status="running"
            >
              {/* Facts about the workspace being prepared. Deliberately not
                  labelled "Input" and not a synthetic command line: every
                  other <pre> on this surface shows a command that actually
                  ran, and this step is not a command. */}
              <section>
                <h3>Workspace</h3>
                <pre>
                  {mode === "worktree"
                    ? `${baseBranch || "HEAD"} · ${
                        sourceChanges === "none"
                          ? "clean start"
                          : "including local changes"
                      }`
                    : (project?.displayPath ?? "local checkout")}
                </pre>
              </section>
            </ActivityStep>
          </div>
        )}
        <form
          className={`new-chat-card${attachments.dragging ? " image-dragging" : ""}`}
          onSubmit={submit}
          onDragEnterCapture={(event) => {
            if (
              !create.isPending ||
              !event.dataTransfer.types.includes("Files")
            )
              return;
            event.preventDefault();
            event.stopPropagation();
          }}
          onDragOverCapture={(event) => {
            if (
              !create.isPending ||
              !event.dataTransfer.types.includes("Files")
            )
              return;
            event.preventDefault();
            event.stopPropagation();
          }}
          onDropCapture={(event) => {
            if (
              !create.isPending ||
              !event.dataTransfer.types.includes("Files")
            )
              return;
            event.preventDefault();
            event.stopPropagation();
          }}
          {...attachments.dropHandlers}
        >
          {attachments.dragging && (
            <div className="chat-drop-overlay" aria-hidden="true">
              Drop photos here
            </div>
          )}
          {continuationSourceThreadId !== null ? (
            <div
              className="new-chat-toolbar"
              aria-label="Same-worktree chat configuration"
            >
              <span>Same managed worktree</span>
            </div>
          ) : (
            <div
              className="new-chat-toolbar"
              aria-label="New chat configuration"
            >
              <label>
                <span className="sr-only">Agent</span>
                <select
                  aria-label="Agent"
                  value={selectedRuntime}
                  onChange={(event) => {
                    setRuntime(event.target.value === "pi" ? "pi" : "codex");
                    setCreationKey(commandId());
                  }}
                >
                  {AGENT_OPTIONS.map((option) => {
                    const backend = backendFor(option.value);
                    const unusable =
                      backend !== undefined && !backend.available;
                    return (
                      <option
                        key={option.value}
                        value={option.value}
                        disabled={unusable}
                      >
                        {unusable
                          ? `${option.label} — ${backend.reason ?? "unavailable"}`
                          : option.label}
                      </option>
                    );
                  })}
                </select>
              </label>
              <label>
                <span className="sr-only">Execution location</span>
                <select
                  aria-label="Execution location"
                  value={mode}
                  onChange={(event) => {
                    setMode(
                      event.target.value === "shared" ? "shared" : "worktree",
                    );
                    setSourceChanges("none");
                    setCreationKey(commandId());
                  }}
                >
                  <option
                    value="worktree"
                    disabled={preflight.data?.worktreeAvailable === false}
                  >
                    New worktree
                  </option>
                  <option value="shared">Local checkout</option>
                </select>
              </label>
              <label>
                <span className="sr-only">Starting state</span>
                <select
                  aria-label="Starting state"
                  value={mode === "shared" ? "current" : sourceChanges}
                  disabled={mode === "shared"}
                  onChange={(event) => {
                    setSourceChanges(
                      event.target.value === "tracked_and_untracked"
                        ? "tracked_and_untracked"
                        : "none",
                    );
                    setCreationKey(commandId());
                  }}
                >
                  {mode === "shared" && (
                    <option value="current">Current local files</option>
                  )}
                  {mode === "worktree" && (
                    <>
                      <option value="none">Clean start</option>
                      <option
                        value="tracked_and_untracked"
                        disabled={
                          baseBranch !==
                            (preflight.data === undefined
                              ? null
                              : preflight.data.currentBranch) ||
                          (preflight.data?.changes?.files.length ?? 0) === 0
                        }
                      >
                        Include local changes
                      </option>
                    </>
                  )}
                </select>
              </label>
              <label>
                <span className="sr-only">Base branch</span>
                <select
                  aria-label="Base branch"
                  // In shared mode this control does not apply, and a greyed
                  // select still DISPLAYING a branch reads as "it will use
                  // master" rather than "branch does not apply". The shared
                  // option states the fact instead: whatever is checked out
                  // now is what Pi works on, and it is not a choice made here.
                  value={mode === "shared" ? "current" : baseBranch}
                  disabled={mode === "shared"}
                  onChange={(event) => {
                    setBaseBranch(event.target.value);
                    setSourceChanges("none");
                    setCreationKey(commandId());
                  }}
                >
                  {mode === "shared" ? (
                    <option value="current">
                      {currentBranch === null
                        ? "Whatever is checked out"
                        : `Already on ${currentBranch}`}
                    </option>
                  ) : (
                    <>
                      <BranchOptions
                        branches={branchGroups.project}
                        labels={branchLabelsByBranch}
                      />
                      {branchGroups.generated.length > 0 && (
                        // Grouped, not hidden: these are real branches a user
                        // may legitimately want to branch from again. They just
                        // must not bury the handful of branches a person named.
                        <optgroup label="Previous Pi runs">
                          <BranchOptions
                            branches={branchGroups.generated}
                            labels={branchLabelsByBranch}
                          />
                        </optgroup>
                      )}
                    </>
                  )}
                </select>
              </label>
            </div>
          )}
          {selectedUnavailable && !waitingForContinuationSource && (
            <p className="new-chat-note" role="alert">
              {selectedUnavailableReason}
            </p>
          )}
          {continuationSourceThreadId === null && (
            <>
              {mode === "worktree" &&
                preflight.data?.worktreeAvailable === false && (
                  <p className="new-chat-note" role="alert">
                    {preflight.data.unavailableReason}
                  </p>
                )}
              {mode === "worktree" && sourceChanges === "none" && (
                <p className="new-chat-note">
                  Starts from committed {baseBranch || "HEAD"}. Local changes
                  are not copied.
                </p>
              )}
              {mode === "worktree" &&
                sourceChanges === "tracked_and_untracked" && (
                  <div className="new-chat-note warning">
                    <p>
                      Including{" "}
                      {String(preflight.data?.changes?.files.length ?? 0)} local
                      changes. Ignored files are excluded.
                    </p>
                    <details>
                      <summary>Review files</summary>
                      <ul>
                        {preflight.data?.changes?.files.map((path) => (
                          <li key={path}>{path}</li>
                        ))}
                      </ul>
                    </details>
                  </div>
                )}
              {mode === "shared" && (
                // The old note read "Pi will work directly in the existing
                // checkout and see its current files." Every word of that was
                // about READING. Verified against the server: a shared thread
                // resolves its execution root to the project's own canonical
                // path (ThreadExecutionContextResolver.resolve, worktree_id
                // null) and Pi's tools run there with the user's permissions,
                // no approval step and no sandbox -- so it edits, creates and
                // deletes files in the directory the user has open, on whatever
                // branch is checked out, with their uncommitted work in place.
                // That is the defining property of the mode and the one
                // irreversible choice on this screen, so it is what the note
                // says first.
                // `status`, not `alert`: it appears in response to the user's own
                // choice, so it should be announced, but politely -- and not
                // `note`, which is silent on appearance.
                <p className="new-chat-note warning" role="status">
                  {selectedRuntime === "codex" ? (
                    <>
                      <strong>Codex starts in your project directory.</strong>{" "}
                      It runs without application approval inside the boundary
                      this server was configured with.
                    </>
                  ) : (
                    <>
                      <strong>Pi writes to your project directory.</strong> It
                      edits, creates and deletes files in{" "}
                      {project?.displayPath ?? "this project"}
                      {currentBranch === null
                        ? ""
                        : ` on your current branch, ${currentBranch},`}{" "}
                      alongside your uncommitted changes. Nothing is copied
                      first and there is no undo.
                    </>
                  )}
                </p>
              )}
            </>
          )}
          <div className="composer-input new-chat-input">
            <ChatAttachmentStrip
              images={attachments.images}
              error={attachments.error}
              onRemove={attachments.remove}
            />
            <textarea
              ref={textareaRef}
              aria-label="First message"
              placeholder={`Ask ${agentLabel} to work in ${project?.displayName ?? "this project"}…`}
              rows={1}
              autoFocus
              value={text}
              onChange={(event) => {
                setText(event.target.value);
                setCreationKey(commandId());
              }}
              onPasteCapture={(event) => {
                if (
                  create.isPending &&
                  [...event.clipboardData.items].some(
                    (item) =>
                      item.kind === "file" && item.type.startsWith("image/"),
                  )
                ) {
                  event.preventDefault();
                  event.stopPropagation();
                }
              }}
              onPaste={attachments.onPaste}
              readOnly={create.isPending}
              onKeyDown={(event) => {
                if (isReleaseKey(event)) {
                  event.preventDefault();
                  releaseFocusToPane(event.currentTarget);
                  return;
                }
                if (
                  event.key !== "Enter" ||
                  event.shiftKey ||
                  event.nativeEvent.isComposing
                )
                  return;
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }}
            />
            <div className="composer-actions">
              <span>
                {create.isPending
                  ? "Naming and preparing workspace…"
                  : "Enter to send · Shift + Enter for a new line · Esc to leave the composer"}
              </span>
              <button
                type="submit"
                className="send"
                aria-label="Create chat and send"
                disabled={
                  create.isPending ||
                  selectedUnavailable ||
                  (attachments.images.length > 0 &&
                    imageInputCapability === "unsupported") ||
                  (text.trim() === "" && attachments.images.length === 0)
                }
              >
                <span aria-hidden="true">↑</span>
              </button>
            </div>
          </div>
          {create.error !== null && (
            <ErrorNotice
              error={create.error}
              onRetry={() => {
                send(text);
              }}
            />
          )}
        </form>
      </main>
    </section>
  );
}
