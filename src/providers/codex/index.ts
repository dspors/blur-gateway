import path from 'node:path';
import { createRequire } from 'node:module';
import { config } from '../../config';
import type { BlurMessage, DesktopProvider, DesktopSession, PreparedSessionInput, ProviderName, ProviderSession, ReadbackMode, ReadLatestResult, SendInput } from '../../types/provider';
import { afterSince, latestTimestamp, normalizeMessage, normalizeToolCall, timestampAfterSinceOrFallback } from '../readback';

const bridgeRequire = createRequire(path.join(config.bridgeRoot, 'package.json'));
const codexShield = bridgeRequire('./lib/platform/codex-shield.js') as {
  send(app: Record<string, unknown>, query: string, text: string, opts?: Record<string, unknown>): Promise<{ success: boolean; error?: string }>;
  sendToThread?(app: Record<string, unknown>, sessionId: string, text: string, opts?: Record<string, unknown>): Promise<{ success: boolean; error?: string; sessionId?: string; title?: string; outputText?: string | null }>;
  createPreparedSession(app: Record<string, unknown>, opts: Record<string, unknown>): Promise<{ success: boolean; error?: string; sessionId?: string; title?: string; outputText?: string | null }>;
};
const codexSessions = bridgeRequire('./lib/providers/codex/sessions.js') as {
  listCodexSessions(opts?: { limit?: number }): Array<{ sessionId: string; title?: string; status?: string }>;
  getCodexSession(sessionId: string): { status?: string; statusDetail?: string } | null;
  readTranscript(sessionId: string, opts?: { maxMessages?: number; mode?: string }): Array<{ role?: string; type?: string; content?: string; timestamp?: string; toolUse?: { name?: string; callId?: string; input?: unknown } }>;
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

type CodexTransport = 'cli' | 'desktop';

export class CodexProvider implements DesktopProvider {
  name: ProviderName;
  private transport: CodexTransport;

  constructor(opts: { name: ProviderName; transport: CodexTransport }) {
    this.name = opts.name;
    this.transport = opts.transport;
  }

  async createPreparedSession(input: PreparedSessionInput): Promise<ProviderSession> {
    const result = await codexShield.createPreparedSession(profile(), {
      title: input.title,
      projectDir: input.workspaceDir,
      text: input.prompt,
      submit: true,
      timeoutSeconds: 60,
      transport: this.transport === 'desktop' ? 'shield' : 'cli',
    });
    if (!result.success) throw new Error(result.error || 'Codex prepared-session automation failed');
    if (result.sessionId) {
      return {
        providerSessionId: result.sessionId,
        providerSessionTitle: result.title || input.title,
      };
    }
    return this.findByTitle(input.title) || {
      providerSessionId: null,
      providerSessionTitle: input.title,
    };
  }

  async send(input: SendInput): Promise<void> {
    const result = this.transport === 'cli' && input.providerSessionId && codexShield.sendToThread
      ? await codexShield.sendToThread(profile(), input.providerSessionId, input.prompt, {
        timeoutSeconds: 45,
        cwd: input.workspaceDir,
      })
      : await codexShield.send(profile(), input.providerSessionTitle, input.prompt, {
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
      provider: this.name,
      status: s.status,
    }));
  }

  async readLatest(sessionId: string, sinceIso?: string, prompt?: string, opts: { mode?: ReadbackMode; responseId?: string; responseCreatedAtIso?: string } = {}): Promise<ReadLatestResult> {
    const session = codexSessions.getCodexSession(sessionId);
    const sinceMs = sinceIso ? Date.parse(sinceIso) : 0;
    const fallbackBaseMs = Date.parse(opts.responseCreatedAtIso || '') || sinceMs || 0;
    const mode = opts.mode || 'text';
    const messages = codexSessions.readTranscript(sessionId, { maxMessages: 200, mode: mode === 'events' ? 'verbose' : 'normal' });
    const startIndex = prompt ? messages.findIndex(message => {
      if ((message.role || message.type) !== 'user') return false;
      if (!message.content) return false;
      if (!message.content.includes(prompt)) return false;
      if (!sinceMs || !message.timestamp) return true;
      const ts = Date.parse(message.timestamp);
      return Number.isFinite(ts) && ts > sinceMs;
    }) : -1;
    // If the just-submitted prompt is not visible yet, do not reuse an older
    // assistant message from the same thread. The caller is polling a new turn.
    const promptPending = Boolean(prompt) && startIndex < 0;
    const searchSpace = promptPending ? [] : (startIndex >= 0 ? messages.slice(startIndex + 1) : messages);
    const assistantMessages = searchSpace.filter(message => {
      if ((message.role || message.type) !== 'assistant') return false;
      if (!message.content) return false;
      if (!sinceMs || !message.timestamp) return true;
      const ts = Date.parse(message.timestamp);
      return Number.isFinite(ts) && ts > sinceMs;
    });
    const assistant = startIndex >= 0 ? assistantMessages[0] : assistantMessages.at(-1);
    const richMessages = mode === 'text' ? undefined : normalizeCodexMessages(messages, {
      mode,
      provider: this.name,
      sinceMs,
      fallbackBaseMs,
      providerSessionId: sessionId,
      responseId: opts.responseId,
    });
    return {
      status: promptPending ? 'Processing...' : session?.status,
      outputText: promptPending ? null : (assistant?.content || session?.statusDetail || null),
      highWaterIso: richMessages?.length ? latestTimestamp(richMessages) : assistant?.timestamp || null,
      messages: richMessages,
    };
  }

  private findByTitle(title: string): ProviderSession | null {
    const sessions = codexSessions.listCodexSessions({ limit: 200 });
    const found = sessions.find(s => s.title === title);
    if (!found) return null;
    return { providerSessionId: found.sessionId, providerSessionTitle: found.title || title };
  }
}

function normalizeCodexMessages(
  messages: Array<{ role?: string; type?: string; content?: string; timestamp?: string; toolUse?: { name?: string; callId?: string; input?: unknown } }>,
  opts: { mode: ReadbackMode; provider: ProviderName; sinceMs: number; fallbackBaseMs: number; providerSessionId: string; responseId?: string },
): BlurMessage[] {
  const normalized: BlurMessage[] = [];
  for (const [index, message] of messages.entries()) {
    const timestamp = timestampAfterSinceOrFallback({
      timestamp: message.timestamp,
      sinceMs: opts.sinceMs,
      fallbackBaseMs: opts.fallbackBaseMs,
      offset: index,
    });
    if (!timestamp) continue;
    const role = message.role || message.type || '';
    const nativeId = `codex:${index}:${message.type || role || 'message'}`;
    if (role === 'user' || role === 'assistant') {
      const item = normalizeMessage({
        provider: opts.provider,
        providerSessionId: opts.providerSessionId,
        responseId: opts.responseId,
        role,
        text: message.content || '',
        timestamp,
        nativeType: `codex:${message.type || role}`,
        nativeId,
      });
      if (item) normalized.push(item);
      continue;
    }
    if (opts.mode === 'events' && message.toolUse) {
      normalized.push(normalizeToolCall({
        provider: opts.provider,
        providerSessionId: opts.providerSessionId,
        responseId: opts.responseId,
        timestamp,
        nativeType: 'codex:tool_activity',
        nativeId,
        toolCallId: message.toolUse.callId || null,
        toolName: message.toolUse.name || null,
        args: message.toolUse.input,
        text: message.content || null,
      }));
    }
  }
  return normalized.sort((a, b) => Date.parse(a.timestamp || '') - Date.parse(b.timestamp || ''));
}
