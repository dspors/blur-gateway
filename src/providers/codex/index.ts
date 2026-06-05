import path from 'node:path';
import { createRequire } from 'node:module';
import { config } from '../../config';
import type { DesktopProvider, DesktopSession, PreparedSessionInput, ProviderSession, SendInput } from '../../types/provider';

const bridgeRequire = createRequire(path.join(config.bridgeRoot, 'package.json'));
const codexShield = bridgeRequire('./lib/platform/codex-shield.js') as {
  send(app: Record<string, unknown>, query: string, text: string, opts?: Record<string, unknown>): Promise<{ success: boolean; error?: string }>;
  createPreparedSession(app: Record<string, unknown>, opts: Record<string, unknown>): Promise<{ success: boolean; error?: string }>;
};
const codexSessions = bridgeRequire('./lib/providers/codex/sessions.js') as {
  listCodexSessions(opts?: { limit?: number }): Array<{ sessionId: string; title?: string; status?: string }>;
};

function profile(): Record<string, unknown> {
  return {
    appName: process.env.CODEX_APP_NAME || 'Codex',
    bundleId: process.env.CODEX_BUNDLE_ID || 'com.openai.codex',
    processName: process.env.CODEX_PROCESS_NAME || 'Codex',
    executableName: process.env.CODEX_EXE || 'Codex.exe',
    timings: {
      activateDelayMs: Number(process.env.CODEX_ACTIVATE_DELAY_MS || 350),
      searchAfterOpenMs: Number(process.env.CODEX_SEARCH_AFTER_OPEN_MS || 300),
      searchAfterPasteMs: Number(process.env.CODEX_SEARCH_AFTER_PASTE_MS || 200),
      primeAfterTypeMs: Number(process.env.CODEX_PRIME_AFTER_TYPE_MS || 75),
      pasteAfterPasteMs: Number(process.env.CODEX_PASTE_AFTER_PASTE_MS || 200),
    },
  };
}

export class CodexProvider implements DesktopProvider {
  name = 'codex' as const;

  async createPreparedSession(input: PreparedSessionInput): Promise<ProviderSession> {
    const result = await codexShield.createPreparedSession(profile(), {
      title: input.title,
      projectDir: input.workspaceDir,
      text: input.prompt,
      submit: true,
      timeoutSeconds: 60,
    });
    if (!result.success) throw new Error(result.error || 'Codex prepared-session automation failed');
    return this.findByTitle(input.title) || {
      providerSessionId: null,
      providerSessionTitle: input.title,
    };
  }

  async send(input: SendInput): Promise<void> {
    const result = await codexShield.send(profile(), input.providerSessionTitle, input.prompt, {
      submit: true,
      timeoutSeconds: 45,
    });
    if (!result.success) throw new Error(result.error || 'Codex send automation failed');
  }

  async rename(input: SendInput, title: string): Promise<void> {
    await this.send({ ...input, prompt: `/blur.rename ${title}` });
  }

  async archive(input: SendInput): Promise<void> {
    await this.send({ ...input, prompt: '/blur.archive' });
  }

  async listSessions(): Promise<DesktopSession[]> {
    return codexSessions.listCodexSessions({ limit: 200 }).map(s => ({
      id: s.sessionId,
      title: s.title || s.sessionId,
      provider: 'codex',
      status: s.status,
    }));
  }

  private findByTitle(title: string): ProviderSession | null {
    const sessions = codexSessions.listCodexSessions({ limit: 200 });
    const found = sessions.find(s => s.title === title);
    if (!found) return null;
    return { providerSessionId: found.sessionId, providerSessionTitle: found.title || title };
  }
}
