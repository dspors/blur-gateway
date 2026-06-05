export type ProviderName = 'codex' | 'claude';

export type PreparedSessionInput = {
  chainId: string;
  responseId: string;
  title: string;
  workspaceDir: string;
  prompt: string;
};

export type SendInput = {
  chainId: string;
  responseId: string;
  providerSessionId?: string | null;
  providerSessionTitle: string;
  workspaceDir: string;
  prompt: string;
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
};

export interface DesktopProvider {
  name: ProviderName;
  createPreparedSession(input: PreparedSessionInput): Promise<ProviderSession>;
  send(input: SendInput): Promise<void>;
  spawn?(input: SpawnInput): Promise<SpawnResult>;
  rename?(session: SendInput, title: string): Promise<void>;
  archive?(session: SendInput): Promise<void>;
  unarchive?(session: SendInput): Promise<void>;
  readLatest?(sessionId: string, sinceIso?: string, prompt?: string, opts?: { mode?: ReadbackMode; responseId?: string; responseCreatedAtIso?: string }): Promise<ReadLatestResult>;
  listSessions(): Promise<DesktopSession[]>;
}
