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

export interface DesktopProvider {
  name: ProviderName;
  createPreparedSession(input: PreparedSessionInput): Promise<ProviderSession>;
  send(input: SendInput): Promise<void>;
  spawn?(input: SpawnInput): Promise<SpawnResult>;
  rename?(session: SendInput, title: string): Promise<void>;
  archive?(session: SendInput): Promise<void>;
  unarchive?(session: SendInput): Promise<void>;
  readLatest?(sessionId: string, sinceIso?: string, prompt?: string): Promise<{ status?: string; outputText?: string | null; highWaterIso?: string | null }>;
  listSessions(): Promise<DesktopSession[]>;
}
