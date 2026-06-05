import path from 'node:path';
import { createRequire } from 'node:module';
import { config } from '../../config';
import type { BlurMessage, DesktopProvider, DesktopSession, PreparedSessionInput, ProviderSession, ReadbackMode, ReadLatestResult, SendInput, SpawnInput, SpawnResult } from '../../types/provider';
import { afterSince, latestTimestamp, normalizeMessage, normalizeToolCall, normalizeToolResult } from '../readback';

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
  readSession(jsonlPath: string, opts?: { maxMessages?: number }): Promise<Array<{ uuid?: string; parentUuid?: string | null; role?: string; type?: string; content?: unknown; timestamp?: string; toolUse?: ClaudeToolUse | ClaudeToolUse[] | null }>>;
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
    // ONE atomic shield call: Ctrl+3 -> Ctrl+N -> inject prompt -> rename, all
    // under a single held HID lock (no inter-step interleaving; safe against
    // concurrent processes/providers). The title is bundled into the call.
    const createResult = await claudeShield.createSession(input.prompt, {
      title: input.title,
      timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
    });
    if (!createResult.success) throw new Error(createResult.error || 'Claude new-session automation failed');

    // The bundled rename is still occasionally flaky; verify it applied and, if
    // not, retry with a standalone rename (non-OCR; metadata is the truth).
    await this.renameWithVerify(input.title, before);

    return await this.findCreatedSession(input.title, before);
  }

  private async renameWithVerify(title: string, beforeIds: Set<string>, attempts = 2): Promise<boolean> {
    const stable = (id: string | null | undefined): id is string =>
      typeof id === 'string' && id.startsWith('local_');
    const applied = () => claudeSessions.listSessions({ limit: 500, provider: 'claude' })
      .some(s => s.title === title && stable(s.sessionId) && !beforeIds.has(s.sessionId));
    // The atomic create already attempts the rename — verify BEFORE re-doing it.
    await new Promise(resolve => setTimeout(resolve, 800));
    if (applied()) return true;
    let lastErr: string | undefined;
    for (let i = 0; i < attempts; i++) {
      const rr = await claudeShield.renameCurrent(title, { timeoutSeconds: 45 });
      if (!rr.success) lastErr = rr.error;
      await new Promise(resolve => setTimeout(resolve, 800));
      if (applied()) return true;
    }
    // Best-effort: the session is still resolvable by stable id / its actual
    // title via findCreatedSession, so a missed rename is non-fatal.
    console.warn(`[claude] rename did not apply after atomic create + ${attempts} retries (title="${title}"${lastErr ? `, lastErr=${lastErr}` : ''})`);
    return false;
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

  async readLatest(sessionId: string, sinceIso?: string, prompt?: string, opts: { mode?: ReadbackMode; responseId?: string } = {}): Promise<ReadLatestResult> {
    const session = findSessionById(sessionId);
    if (!session?.jsonlPath) return { outputText: null, highWaterIso: null };

    const sinceMs = sinceIso ? Date.parse(sinceIso) : 0;
    const mode = opts.mode || 'text';
    const messages = await claudeSessions.readSession(session.jsonlPath, { maxMessages: 200 });
    const health = await claudeSessions.readSessionHealth(session.jsonlPath).catch(() => null);
    const startIndex = prompt ? messages.findIndex(message => {
      const role = message.role || message.type;
      if (role !== 'user') return false;
      const text = contentToText(message.content);
      if (!text.includes(prompt)) return false;
      if (!sinceMs || !message.timestamp) return true;
      const ts = Date.parse(message.timestamp);
      return Number.isFinite(ts) && ts > sinceMs;
    }) : -1;
    const searchSpace = startIndex >= 0 ? messages.slice(startIndex + 1) : messages;
    const assistantMessages = searchSpace.filter(message => {
      const role = message.role || message.type;
      if (role !== 'assistant') return false;
      const text = contentToText(message.content);
      if (!text) return false;
      if (!sinceMs || !message.timestamp) return true;
      const ts = Date.parse(message.timestamp);
      return Number.isFinite(ts) && ts > sinceMs;
    });
    const assistant = startIndex >= 0 ? assistantMessages[0] : assistantMessages.at(-1);
    const richMessages = mode === 'text' ? undefined : normalizeClaudeMessages(messages, {
      mode,
      sinceMs,
      providerSessionId: sessionId,
      responseId: opts.responseId,
    });
    return {
      status: health?.status || health?.message,
      outputText: assistant ? contentToText(assistant.content) : health?.detail || null,
      highWaterIso: richMessages?.length ? latestTimestamp(richMessages) : assistant?.timestamp || null,
      messages: richMessages,
    };
  }

  private async findCreatedSession(title: string, beforeIds: Set<string>): Promise<ProviderSession> {
    // Only accept a STABLE bridge session id (local_<uuid>). A freshly created
    // session briefly surfaces under a transient bare-uuid id before Claude
    // promotes it to its canonical local_ id; capturing that transient id breaks
    // later id-based operations (notably archive, which resolves by sessionId).
    // Poll until the stable id appears, then fall through to null.
    const stable = (id: string | null | undefined): id is string =>
      typeof id === 'string' && id.startsWith('local_');
    for (let i = 0; i < 20; i++) {
      const sessions = claudeSessions.listSessions({ limit: 500, provider: 'claude' });
      const byTitle = sessions.find(s => s.title === title && stable(s.sessionId));
      if (byTitle) return { providerSessionId: byTitle.sessionId, providerSessionTitle: title };
      const fresh = sessions.find(s => stable(s.sessionId) && !beforeIds.has(s.sessionId));
      if (fresh) return { providerSessionId: fresh.sessionId, providerSessionTitle: fresh.title || title };
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    return { providerSessionId: null, providerSessionTitle: title };
  }
}

type ClaudeToolUse = { name?: string; toolName?: string; callId?: string; id?: string; input?: unknown };

function normalizeClaudeMessages(
  messages: Array<{ uuid?: string; parentUuid?: string | null; role?: string; type?: string; content?: unknown; timestamp?: string; toolUse?: ClaudeToolUse | ClaudeToolUse[] | null }>,
  opts: { mode: ReadbackMode; sinceMs: number; providerSessionId: string; responseId?: string },
): BlurMessage[] {
  const normalized: BlurMessage[] = [];
  for (const message of messages) {
    if (!afterSince(message.timestamp, opts.sinceMs)) continue;
    const role = message.role || message.type || '';
    if (role === 'user' || role === 'assistant') {
      const item = normalizeMessage({
        provider: 'claude',
        providerSessionId: opts.providerSessionId,
        responseId: opts.responseId,
        role,
        text: contentToText(message.content),
        timestamp: message.timestamp || null,
        nativeType: `claude:${message.type || role}`,
        nativeId: message.uuid || null,
        turnId: message.parentUuid || message.uuid || null,
      });
      if (item) normalized.push(item);
    }
    if (opts.mode === 'events' && message.toolUse) {
      const uses = Array.isArray(message.toolUse) ? message.toolUse : [message.toolUse];
      uses.forEach((toolUse, index) => {
        normalized.push(normalizeToolCall({
          provider: 'claude',
          providerSessionId: opts.providerSessionId,
          responseId: opts.responseId,
          timestamp: message.timestamp || null,
          nativeType: 'claude:tool_use',
          nativeId: message.uuid ? `${message.uuid}:${index}` : null,
          turnId: message.parentUuid || message.uuid || null,
          toolCallId: toolUse.callId || toolUse.id || (message.uuid ? `${message.uuid}:${index}` : null),
          toolName: toolUse.name || toolUse.toolName || null,
          args: toolUse.input,
        }));
      });
    }
    if (opts.mode === 'events' && role === 'tool') {
      normalized.push(normalizeToolResult({
        provider: 'claude',
        providerSessionId: opts.providerSessionId,
        responseId: opts.responseId,
        timestamp: message.timestamp || null,
        nativeType: `claude:${message.type || role}`,
        nativeId: message.uuid || null,
        turnId: message.parentUuid || message.uuid || null,
        resultText: contentToText(message.content),
      }));
    }
  }
  return normalized.sort((a, b) => Date.parse(a.timestamp || '') - Date.parse(b.timestamp || ''));
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
