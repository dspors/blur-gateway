import path from 'node:path';
import { createRequire } from 'node:module';
import { config } from '../../config';
import type { DesktopProvider, DesktopSession, PreparedSessionInput, ProviderSession, SendInput, SpawnInput, SpawnResult } from '../../types/provider';

const bridgeRequire = createRequire(path.join(config.bridgeRoot, 'package.json'));
const claudeShield = bridgeRequire('./lib/platform/claude-shield.js') as {
  createSession(text: string, opts?: Record<string, unknown>): Promise<{ success: boolean; error?: string }>;
  send(query: string, text: string, opts?: Record<string, unknown>): Promise<{ success: boolean; error?: string }>;
  renameCurrent(title: string, opts?: Record<string, unknown>): Promise<{ success: boolean; error?: string }>;
  spawnFromParent(query: string, opts?: Record<string, unknown>): Promise<{ success: boolean; error?: string }>;
};
const claudeSessions = bridgeRequire('./lib/core/sessions.js') as {
  listSessions(opts?: { limit?: number; provider?: string }): Array<{
    sessionId: string;
    title?: string | null;
    sessionType?: string | null;
    status?: string | null;
    cwd?: string | null;
    isArchived?: boolean;
    jsonlPath?: string | null;
    lastActivityAt?: string | number | null;
    modifiedAt?: string | number | null;
  }>;
  readSession(jsonlPath: string, opts?: { maxMessages?: number }): Promise<Array<{ role?: string; type?: string; content?: unknown; timestamp?: string }>>;
  readSessionHealth(jsonlPath: string): Promise<{ status?: string; message?: string; detail?: string }>;
};
const claudeArchive = bridgeRequire('./lib/providers/claude/archive-flow.js') as {
  setArchived(sessionId: string, archive: boolean, ctx: Record<string, unknown>): Promise<{ success: boolean; error?: string }>;
};

const DEFAULT_TIMEOUT_SECONDS = 90;

export class ClaudeProvider implements DesktopProvider {
  name = 'claude' as const;

  async createPreparedSession(input: PreparedSessionInput): Promise<ProviderSession> {
    const before = snapshotSessionIds();
    const createResult = await claudeShield.createSession(input.prompt, {
      timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
    });
    if (!createResult.success) throw new Error(createResult.error || 'Claude new-session automation failed');

    const renameResult = await claudeShield.renameCurrent(input.title, {
      timeoutSeconds: 45,
    });
    if (!renameResult.success) throw new Error(renameResult.error || 'Claude rename automation failed');

    return await this.findCreatedSession(input.title, before);
  }

  async send(input: SendInput): Promise<void> {
    const result = await claudeShield.send(input.providerSessionTitle, input.prompt, {
      timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
    });
    if (!result.success) throw new Error(result.error || 'Claude send automation failed');
  }

  async spawn(input: SpawnInput): Promise<SpawnResult> {
    const before = snapshotSessionIds();
    const result = await claudeShield.spawnFromParent(input.parentSessionTitle, {
      renameTitle: input.title || undefined,
      promptAfter: input.prompt || undefined,
      timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
    });
    if (!result.success) throw new Error(result.error || 'Claude spawn automation failed');
    const session = await this.findCreatedSession(input.title || '', before);
    return {
      ...session,
      forkedFrom: input.parentSessionId,
    };
  }

  async rename(input: SendInput, title: string): Promise<void> {
    await this.send({ ...input, prompt: `/rename ${title}` });
  }

  async archive(input: SendInput): Promise<void> {
    const sessionId = input.providerSessionId || input.responseId;
    const result = await claudeArchive.setArchived(sessionId, true, {
      sessions: claudeSessions,
      reqId: `blur-gateway-${input.responseId}`,
    });
    if (!result.success) throw new Error(result.error || 'Claude archive failed');
  }

  async unarchive(input: SendInput): Promise<void> {
    const sessionId = input.providerSessionId || input.responseId;
    const result = await claudeArchive.setArchived(sessionId, false, {
      sessions: claudeSessions,
      reqId: `blur-gateway-${input.responseId}`,
    });
    if (!result.success) throw new Error(result.error || 'Claude unarchive failed');
  }

  async listSessions(): Promise<DesktopSession[]> {
    return claudeSessions.listSessions({ limit: 500, provider: 'claude' })
      .filter(s => !s.isArchived)
      .map(s => ({
        id: s.sessionId,
        title: s.title || s.sessionId,
        provider: 'claude',
        status: s.status || undefined,
        workspaceDir: s.cwd || undefined,
      }));
  }

  async readLatest(sessionId: string, sinceIso?: string, prompt?: string): Promise<{ status?: string; outputText?: string | null }> {
    const session = findSessionById(sessionId);
    if (!session?.jsonlPath) return { outputText: null };

    const sinceMs = sinceIso ? Date.parse(sinceIso) : 0;
    const messages = await claudeSessions.readSession(session.jsonlPath, { maxMessages: 200 });
    const health = await claudeSessions.readSessionHealth(session.jsonlPath).catch(() => null);
    const startIndex = prompt ? messages.findIndex(message => {
      const role = message.role || message.type;
      if (role !== 'user') return false;
      const text = contentToText(message.content);
      if (!text.includes(prompt)) return false;
      if (!sinceMs || !message.timestamp) return true;
      const ts = Date.parse(message.timestamp);
      return Number.isFinite(ts) && ts >= sinceMs;
    }) : -1;
    const searchSpace = startIndex >= 0 ? messages.slice(startIndex + 1) : messages;
    const assistantMessages = searchSpace.filter(message => {
      const role = message.role || message.type;
      if (role !== 'assistant') return false;
      const text = contentToText(message.content);
      if (!text) return false;
      if (!sinceMs || !message.timestamp) return true;
      const ts = Date.parse(message.timestamp);
      return Number.isFinite(ts) && ts >= sinceMs;
    });
    const assistant = startIndex >= 0 ? assistantMessages[0] : assistantMessages.at(-1);
    return {
      status: health?.status || health?.message,
      outputText: assistant ? contentToText(assistant.content) : health?.detail || null,
    };
  }

  private async findCreatedSession(title: string, beforeIds: Set<string>): Promise<ProviderSession> {
    for (let i = 0; i < 20; i++) {
      const sessions = claudeSessions.listSessions({ limit: 500, provider: 'claude' });
      const byTitle = sessions.find(s => s.title === title);
      if (byTitle) return { providerSessionId: byTitle.sessionId, providerSessionTitle: title };
      const fresh = sessions.find(s => !beforeIds.has(s.sessionId));
      if (fresh?.sessionId) return { providerSessionId: fresh.sessionId, providerSessionTitle: fresh.title || title };
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    return { providerSessionId: null, providerSessionTitle: title };
  }
}

function snapshotSessionIds(): Set<string> {
  return new Set(claudeSessions.listSessions({ limit: 500, provider: 'claude' }).map(s => s.sessionId));
}

function findSessionById(sessionId: string) {
  return claudeSessions.listSessions({ limit: 500, provider: 'claude' }).find(s => s.sessionId === sessionId);
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!content) return '';
  if (Array.isArray(content)) {
    return content.map(part => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object') return '';
      const record = part as Record<string, unknown>;
      if (typeof record.text === 'string') return record.text;
      if (typeof record.content === 'string') return record.content;
      return '';
    }).filter(Boolean).join('\n');
  }
  if (typeof content === 'object') {
    const record = content as Record<string, unknown>;
    if (typeof record.text === 'string') return record.text;
    if (typeof record.content === 'string') return record.content;
  }
  return '';
}
