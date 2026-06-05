import type { DesktopProvider, DesktopSession, PreparedSessionInput, ProviderSession, SendInput } from '../../types/provider';

export class ClaudeProvider implements DesktopProvider {
  name = 'claude' as const;

  async createPreparedSession(_input: PreparedSessionInput): Promise<ProviderSession> {
    throw new Error('Claude provider is not implemented yet');
  }

  async send(_input: SendInput): Promise<void> {
    throw new Error('Claude provider is not implemented yet');
  }

  async listSessions(): Promise<DesktopSession[]> {
    return [];
  }
}
