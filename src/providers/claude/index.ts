import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { config } from '../../config';
import type { BlurMessage, DeleteSessionInput, DeleteSessionResult, DesktopProvider, DesktopSession, PreparedSessionInput, ProviderName, ProviderSession, ReadbackMode, ReadLatestResult, SendInput, SpawnInput, SpawnResult } from '../../types/provider';
import { afterSince, latestTimestamp, normalizeMessage, normalizeToolCall, normalizeToolResult } from '../readback';

const bridgeRequire = createRequire(path.join(config.bridgeRoot, 'package.json'));
const claudeShield = bridgeRequire('./lib/platform/claude-shield.js') as {
  createSession(text: string, opts?: Record<string, unknown>): Promise<{ success: boolean; error?: string }>;
  send(query: string, text: string, opts?: Record<string, unknown>): Promise<{ success: boolean; error?: string }>;
  renameCurrent(title: string, opts?: Record<string, unknown>): Promise<{ success: boolean; error?: string }>;
  spawnFromParent(query: string, opts?: Record<string, unknown>): Promise<{ success: boolean; error?: string }>;
  deleteSession(query: string, opts?: Record<string, unknown>): Promise<{ success: boolean; error?: string }>;
};
const claudeSessions = bridgeRequire('./lib/core/sessions.js') as {
  listSessions(opts?: { limit?: number; provider?: string }): Array<{
    sessionId: string;
    source?: string | null;
    title?: string | null;
    sessionType?: string | null;
    status?: string | null;
    cwd?: string | null;
    isArchived?: boolean;
    jsonlPath?: string | null;
    metadataPath?: string | null;
    lastActivityAt?: string | number | null;
    modifiedAt?: string | number | null;
  }>;
  readSession(jsonlPath: string, opts?: { maxMessages?: number; afterIso?: string }): Promise<Array<{ uuid?: string; parentUuid?: string | null; role?: string; type?: string; content?: unknown; timestamp?: string; toolUse?: ClaudeToolUse | ClaudeToolUse[] | null }>>;
  // Returns the bridge's turn-state health snapshot. The `resolved` +
  // `newestHumanUuid` fields are the authoritative turn-end signals
  // documented in bridge/docs/claude-turn-end-signal.md — every return path
  // is contractually obliged to populate them. resolved: tri-state — null
  // means "no transcript / unknown"; false means mid-turn; true means turn
  // complete. newestHumanUuid: uuid of the newest non-interruption human
  // entry in the tail window; null when none observed.
  readSessionHealth(jsonlPath: string): Promise<{
    status?: string;
    message?: string;
    detail?: string;
    resolved?: boolean | null;
    newestHumanUuid?: string | null;
  }>;
};
const claudeArchive = bridgeRequire('./lib/providers/claude/archive-flow.js') as {
  setArchived(sessionId: string, archive: boolean, ctx: Record<string, unknown>): Promise<{ success: boolean; error?: string }>;
};

const DEFAULT_TIMEOUT_SECONDS = 90;
const CLI_TIMEOUT_MS = Number(process.env.CLAUDE_CLI_TIMEOUT_MS || 30 * 60 * 1000);
type ClaudeTransport = 'desktop' | 'cli';

export class ClaudeProvider implements DesktopProvider {
  name: ProviderName;
  private transport: ClaudeTransport;

  constructor(opts: { name?: ProviderName; transport?: ClaudeTransport } = {}) {
    this.name = opts.name || 'claude';
    this.transport = opts.transport || (this.name === 'claude-cli' ? 'cli' : 'desktop');
  }

  async createPreparedSession(input: PreparedSessionInput): Promise<ProviderSession> {
    if (this.transport === 'cli') {
      const result = await runClaudeCli({
        cwd: input.workspaceDir,
        text: input.prompt,
        title: input.title,
        model: input.providerModel || null,
        timeoutMs: CLI_TIMEOUT_MS,
      });
      if (!result.sessionId) throw new Error('Claude CLI did not report a session_id');
      return {
        providerSessionId: result.sessionId,
        providerSessionTitle: input.title,
      };
    }

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
    if (this.transport === 'cli') {
      if (!input.providerSessionId) throw new Error('Claude CLI send requires providerSessionId');
      await runClaudeCli({
        cwd: input.workspaceDir,
        text: input.prompt,
        sessionId: input.providerSessionId,
        model: input.providerModel || null,
        timeoutMs: CLI_TIMEOUT_MS,
      });
      return;
    }

    const result = await claudeShield.send(input.providerSessionTitle, input.prompt, {
      timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
    });
    if (!result.success) throw new Error(result.error || 'Claude send automation failed');
  }

  async spawn(input: SpawnInput): Promise<SpawnResult> {
    if (this.transport === 'cli') {
      if (!input.parentSessionId) throw new Error('Claude CLI spawn requires parentSessionId');
      const result = await runClaudeCli({
        text: input.prompt || 'Continue.',
        sessionId: input.parentSessionId,
        title: input.title || undefined,
        model: input.model || null,
        fork: true,
        timeoutMs: CLI_TIMEOUT_MS,
      });
      if (!result.sessionId) throw new Error('Claude CLI fork did not report a session_id');
      return {
        providerSessionId: result.sessionId,
        providerSessionTitle: input.title || result.sessionId,
        forkedFrom: input.parentSessionId,
      };
    }

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
    if (this.transport === 'cli') {
      // Claude CLI does not currently expose a metadata-only rename operation
      // for persisted sessions. The gateway updates its own chain metadata.
      return;
    }
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
      .filter(s => this.transport === 'cli' ? s.source === 'cli' : !s.isArchived)
      .map(s => ({
        id: s.sessionId,
        title: s.title || s.sessionId,
        provider: this.name,
        status: s.status || undefined,
        workspaceDir: s.cwd || undefined,
        archived: Boolean(s.isArchived),
        jsonlPath: s.jsonlPath || null,
        metadataPath: s.metadataPath || null,
        jsonlUpdatedAt: jsonlUpdatedAt(s.jsonlPath, s.modifiedAt || s.lastActivityAt),
      }));
  }

  async deleteSession(input: DeleteSessionInput): Promise<DeleteSessionResult> {
    const result = await claudeShield.deleteSession(input.providerSessionTitle || input.expectedTitle, {
      expectedTitle: input.expectedTitle,
      commit: input.commit,
      timeoutSeconds: 75,
    });
    if (!result.success) throw new Error(result.error || 'Claude delete failed');
    return result;
  }

  async readLatest(sessionId: string, sinceIso?: string, prompt?: string, opts: { mode?: ReadbackMode; responseId?: string; maxMessages?: number } = {}): Promise<ReadLatestResult> {
    const session = findSessionById(sessionId);
    if (!session?.jsonlPath) return { outputText: null, highWaterIso: null };

    const sinceMs = sinceIso ? Date.parse(sinceIso) : 0;
    const mode = opts.mode || 'text';
    // Forward-drain from the mark (tkt_f76668e4): window to the FIRST 200 turns
    // AFTER `sinceIso` (oldest-first) so an advancing mark pages a >200 backlog
    // losslessly, rather than reading the newest-200 tail and post-filtering
    // (which silently drops the oldest backlog between the mark and tail-200).
    const messages = await claudeSessions.readSession(session.jsonlPath, { maxMessages: opts.maxMessages || 200, afterIso: sinceIso });
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
    // Match the codex provider (one consistent gateway path): if the just-
    // submitted prompt is not visible in the drained window yet, do NOT surface
    // an older assistant reply from the backlog as THIS turn's answer. The rich
    // backlog messages still flow (richMessages below uses the full window, so
    // the forward-drain keeps delivering + advancing the mark) — only
    // outputText/status stay "pending" until the driven reply actually lands.
    const promptPending = Boolean(prompt) && startIndex < 0;
    const searchSpace = promptPending ? [] : (startIndex >= 0 ? messages.slice(startIndex + 1) : messages);
    const assistantMessages = searchSpace.filter(message => {
      const role = message.role || message.type;
      if (role !== 'assistant') return false;
      const text = contentToText(message.content);
      if (!text) return false;
      if (!sinceMs || !message.timestamp) return true;
      const ts = Date.parse(message.timestamp);
      return Number.isFinite(ts) && ts > sinceMs;
    });
    const assistant = assistantMessages.at(-1);
    const richMessages = mode === 'text' ? undefined : normalizeClaudeMessages(messages, {
      mode,
      provider: this.name,
      sinceMs,
      providerSessionId: sessionId,
      responseId: opts.responseId,
    });
    const healthText = health?.message || health?.status;
    const healthProcessing = health?.resolved === false || /^Processing/i.test(healthText || '');
    const unresolvedDrivenTurn = Boolean(prompt) && Boolean(health) && health?.resolved !== true;
    const pendingDrivenTurn = promptPending || unresolvedDrivenTurn || (Boolean(prompt) && healthProcessing);
    const outputText = pendingDrivenTurn ? null : (assistant ? contentToText(assistant.content) : health?.detail || null);
    // Surface bridge's authoritative turn-end signals to the response-poll
    // loop in routes/responses.ts (tkt_57ef4311). Belt-and-suspenders with
    // upstream's pendingDrivenTurn output suppression above: that masks
    // outputText/highWaterIso to keep the legacy completion gate from firing
    // mid-turn; this exposes the signal for any consumer that wants to gate
    // explicitly (and benefits other providers like codex once equivalent
    // plumbing lands there). See bridge/docs/claude-turn-end-signal.md.
    const resolved = pendingDrivenTurn ? false : (health?.resolved ?? null);
    const newestHumanUuid = health?.newestHumanUuid ?? null;
    return {
      status: pendingDrivenTurn ? 'Processing...' : healthText,
      outputText,
      highWaterIso: richMessages?.length ? latestTimestamp(richMessages) : (pendingDrivenTurn ? null : assistant?.timestamp || null),
      messages: richMessages,
      resolved,
      newestHumanUuid,
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

type ClaudeCliResult = {
  sessionId: string | null;
  outputText: string | null;
  raw: unknown;
};

function findClaudeCli(): string {
  return process.env.CLAUDE_CLI || (process.platform === 'win32' ? 'claude.exe' : 'claude');
}

function runClaudeCli(opts: {
  cwd?: string | null;
  text: string;
  sessionId?: string | null;
  title?: string;
  model?: string | null;
  fork?: boolean;
  timeoutMs: number;
}): Promise<ClaudeCliResult> {
  const cli = findClaudeCli();
  const args = [
    '-p',
    opts.text,
    '--output-format',
    'json',
    '--permission-mode',
    process.env.CLAUDE_CLI_PERMISSION_MODE || 'bypassPermissions',
  ];
  if (opts.sessionId) {
    args.push('--resume', opts.sessionId);
    if (opts.fork) args.push('--fork-session');
  }
  if (opts.title) args.push('--name', opts.title);
  const providerEnv = claudeCliProviderEnv(opts.model);
  const model = providerEnv.modelArg || opts.model || process.env.CLAUDE_CLI_MODEL;
  if (model) args.push('--model', model);

  return new Promise((resolve, reject) => {
    const child = spawn(cli, args, {
      cwd: opts.cwd || undefined,
      env: {
        ...process.env,
        ...providerEnv.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(new Error(`Claude CLI timed out after ${opts.timeoutMs}ms`));
    }, opts.timeoutMs);
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', err => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const rawText = stdout.trim();
      let parsed: Record<string, unknown> | null = null;
      if (rawText) {
        try {
          parsed = JSON.parse(rawText) as Record<string, unknown>;
        } catch (err) {
          reject(new Error(`Claude CLI returned non-JSON output${stderr.trim() ? `; stderr=${stderr.trim().slice(0, 1000)}` : ''}; stdout=${rawText.slice(0, 1000)}`));
          return;
        }
      }
      if (code !== 0 || parsed?.is_error) {
        const detail = typeof parsed?.result === 'string' && parsed.result.trim()
          ? parsed.result.trim()
          : stderr.trim();
        reject(new Error(`Claude CLI exited ${code}${detail ? `: ${detail.slice(0, 1000)}` : ''}`));
        return;
      }
      resolve({
        sessionId: typeof parsed?.session_id === 'string' ? parsed.session_id : (opts.sessionId || null),
        outputText: typeof parsed?.result === 'string' ? parsed.result : null,
        raw: parsed,
      });
    });
  });
}

function claudeCliProviderEnv(model: string | null | undefined): { env: NodeJS.ProcessEnv; modelArg?: string } {
  const normalized = (model || '').toLowerCase().replace(/_/g, '-');
  if (normalized !== 'deepseek') return { env: {} };

  const deepseekModel = process.env.BLUR_CLAUDE_CLI_DEEPSEEK_MODEL || 'deepseek-v4-pro[1m]';
  const authToken = process.env.BLUR_CLAUDE_CLI_DEEPSEEK_AUTH_TOKEN || process.env.DEEPSEEK_API_KEY;
  const env: NodeJS.ProcessEnv = {
    ANTHROPIC_BASE_URL: process.env.BLUR_CLAUDE_CLI_DEEPSEEK_BASE_URL || 'https://api.deepseek.com/anthropic',
    ANTHROPIC_MODEL: deepseekModel,
    ANTHROPIC_DEFAULT_OPUS_MODEL: process.env.BLUR_CLAUDE_CLI_DEEPSEEK_OPUS_MODEL || deepseekModel,
    ANTHROPIC_DEFAULT_SONNET_MODEL: process.env.BLUR_CLAUDE_CLI_DEEPSEEK_SONNET_MODEL || deepseekModel,
    CLAUDE_CODE_EFFORT_LEVEL: process.env.BLUR_CLAUDE_CLI_DEEPSEEK_EFFORT_LEVEL || 'max',
  };
  if (authToken) env.ANTHROPIC_AUTH_TOKEN = authToken;
  return { env, modelArg: deepseekModel };
}

function normalizeClaudeMessages(
  messages: Array<{ uuid?: string; parentUuid?: string | null; role?: string; type?: string; content?: unknown; timestamp?: string; toolUse?: ClaudeToolUse | ClaudeToolUse[] | null }>,
  opts: { mode: ReadbackMode; provider: ProviderName; sinceMs: number; providerSessionId: string; responseId?: string },
): BlurMessage[] {
  const normalized: BlurMessage[] = [];
  for (const message of messages) {
    if (!afterSince(message.timestamp, opts.sinceMs)) continue;
    const role = message.role || message.type || '';
    if (role === 'user' || role === 'assistant') {
      const item = normalizeMessage({
        provider: opts.provider,
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
          provider: opts.provider,
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
        provider: opts.provider,
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

function jsonlUpdatedAt(jsonlPath?: string | null, fallback?: string | number | null): string | null {
  if (jsonlPath) {
    try {
      return fs.statSync(jsonlPath).mtime.toISOString();
    } catch {
    }
  }
  if (typeof fallback === 'number' && Number.isFinite(fallback) && fallback > 0) {
    return new Date(fallback).toISOString();
  }
  if (typeof fallback === 'string') {
    const ms = Date.parse(fallback);
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  return null;
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
