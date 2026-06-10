export type ProviderName = 'claude' | 'claude-desktop' | 'claude-cli' | 'codex' | 'codex-desktop' | 'codex-cli';

export type PreparedSessionInput = {
  chainId: string;
  responseId: string;
  title: string;
  workspaceDir: string;
  prompt: string;
  providerModel?: string | null;
};

export type SendInput = {
  chainId: string;
  responseId: string;
  providerSessionId?: string | null;
  providerSessionTitle: string;
  workspaceDir: string;
  prompt: string;
  providerModel?: string | null;
};

export type ProviderSession = {
  providerSessionId: string | null;
  providerSessionTitle: string;
};

export type SpawnInput = {
  parentSessionId: string;
  parentSessionTitle: string;
  responseId: string;
  title?: string | null;
  model?: string | null;
  prompt?: string | null;
};

export type SpawnResult = ProviderSession & {
  forkedFrom?: string | null;
  steps?: unknown[];
  elapsedMs?: number;
};

export type DesktopSession = {
  id: string | null;
  title: string;
  provider: ProviderName;
  status?: string;
  workspaceDir?: string;
  jsonlUpdatedAt?: string | null;
  jsonlPath?: string | null;
  metadataPath?: string | null;
  archived?: boolean;
};

export type DeleteSessionInput = {
  providerSessionId: string;
  providerSessionTitle: string;
  expectedTitle: string;
  reason: string;
  commit: boolean;
};

export type DeleteSessionResult = {
  success: boolean;
  error?: string;
  [key: string]: unknown;
};

export type ReadbackMode = 'text' | 'messages' | 'events';

export type BlurMessage = {
  id: string;
  type: string;
  role: string;
  text?: string;
  timestamp?: string;
  turn_id?: string;
  provider: ProviderName;
  provider_session_id?: string | null;
  response_id?: string;
  native_type?: string;
  native_id?: string | null;
  tool_call_id?: string | null;
  tool_name?: string | null;
  arguments?: unknown;
  result_text?: string | null;
  status?: string | null;
  title?: string | null;
  parent_response_id?: string | null;
  subagent_response_id?: string | null;
  usage?: Record<string, unknown>;
  file_position?: Record<string, unknown>;
  revision?: number;
  final?: boolean;
};

export type ReadLatestResult = {
  status?: string;
  outputText?: string | null;
  highWaterIso?: string | null;
  messages?: BlurMessage[];
  // Authoritative turn-end signal, per bridge/docs/claude-turn-end-signal.md.
  //   true  → provider says the turn is done (stop_reason end_turn/stop_sequence
  //           on Claude; task_complete on codex when wired).
  //   false → provider says still mid-turn (tool_use cycle, mid-stream, etc).
  //   null / undefined → provider does not surface this signal; consumers MUST
  //           fall back to existing heuristics (treat as "unknown", never as
  //           "resolved").
  // The Claude provider populates this from bridge's readSessionHealth.resolved.
  resolved?: boolean | null;
  // uuid of the newest non-interruption human entry visible in the provider's
  // tail window. Used for race-free anchored completion: capture pre-inject,
  // require post-poll value to differ before treating `resolved` as "this turn
  // is done" (vs the previous turn that was already resolved).
  // null → no human entry in tail (e.g. >64KB-tail edge case on huge turns);
  //        consumers fall back to unanchored completion.
  newestHumanUuid?: string | null;
};

export interface DesktopProvider {
  name: ProviderName;
  createPreparedSession(input: PreparedSessionInput): Promise<ProviderSession>;
  send(input: SendInput): Promise<void>;
  spawn?(input: SpawnInput): Promise<SpawnResult>;
  rename?(session: SendInput, title: string): Promise<void>;
  archive?(session: SendInput): Promise<void>;
  unarchive?(session: SendInput): Promise<void>;
  deleteSession?(input: DeleteSessionInput): Promise<DeleteSessionResult>;
  readLatest?(sessionId: string, sinceIso?: string, prompt?: string, opts?: { mode?: ReadbackMode; responseId?: string; responseCreatedAtIso?: string; maxMessages?: number }): Promise<ReadLatestResult>;
  listSessions(): Promise<DesktopSession[]>;
}
