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
  rename?(session: SendInput, title: string): Promise<void>;
  archive?(session: SendInput): Promise<void>;
  listSessions(): Promise<DesktopSession[]>;
}
