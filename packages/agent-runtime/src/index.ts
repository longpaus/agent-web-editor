import type {
  TranscriptItem,
  TranscriptPage,
  TranscriptPageRequest,
} from "@pi-web/contracts";

export type RuntimeFailureCode =
  | "unavailable"
  | "malformed"
  | "unauthorized"
  | "busy"
  | "rejected"
  | "provider"
  | "tool"
  | "interrupted"
  | "stale";

export class RuntimeFailure extends Error {
  public constructor(
    public readonly code: RuntimeFailureCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RuntimeFailure";
  }
}

export interface RuntimeSessionDescriptor {
  id: string;
  name: string | null;
  createdAt: string;
  modifiedAt: string;
  messageCount: number;
  preview: string;
  creationId?: string;
}

export interface TranscriptPageLimits {
  readonly maxItems: number;
  readonly targetBytes: number;
}

export interface RuntimeSnapshot {
  sessionId: string;
  transcriptPage: TranscriptPage;
  diagnostics: string[];
}

export type TitleSuggestion =
  { outcome: "available"; title: string } | { outcome: "unavailable" };

export type RuntimeEvent =
  | { type: "transcript"; item: TranscriptItem }
  | { type: "transcript-update"; item: TranscriptItem }
  | { type: "diagnostic"; level: "info" | "warning" | "error"; message: string }
  | {
      type: "settled";
      outcome: "completed" | "failed" | "interrupted";
      message?: string;
    };

export interface PromptAcceptance {
  accepted: boolean;
  reason?: string;
  settlement: Promise<"completed" | "failed" | "interrupted">;
  releaseEvents(): void;
  discardEvents(): void;
}

/** A durable caller-owned identity for a prompt that may need recovery. */
export interface RuntimePromptDispatch {
  id: string;
}

export type PromptRecovery =
  { outcome: "accepted" } | { outcome: "not_accepted" };

export interface OpenRuntimeSession {
  readonly id: string;
  snapshot(limits: TranscriptPageLimits): Promise<RuntimeSnapshot>;
  transcriptPage(
    request: TranscriptPageRequest,
    limits: TranscriptPageLimits,
  ): Promise<TranscriptPage>;
  prompt(
    text: string,
    dispatch?: RuntimePromptDispatch,
  ): Promise<PromptAcceptance>;
  recoverPrompt(
    text: string,
    dispatch: RuntimePromptDispatch,
  ): Promise<PromptRecovery>;
  steer(text: string): Promise<void>;
  stop(): Promise<void>;
  subscribe(listener: (event: RuntimeEvent) => void): () => void;
  dispose(): Promise<void>;
}

export interface AgentRuntime {
  suggestTitle?(projectPath: string, prompt: string): Promise<TitleSuggestion>;
  discover(
    projectPath: string,
  ): Promise<{ sessions: RuntimeSessionDescriptor[]; diagnostics: string[] }>;
  create(
    projectPath: string,
    title?: string,
    creationId?: string,
  ): Promise<{ sessionId: string }>;
  open(projectPath: string, sessionId: string): Promise<OpenRuntimeSession>;
}
