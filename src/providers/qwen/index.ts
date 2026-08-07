import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  BlurMessage, DesktopProvider, DesktopSession, PreparedSessionInput,
  ProviderName, ProviderSession, ReadbackMode, ReadLatestResult, SendInput,
} from '../../types/provider';
import { normalizeMessage } from '../readback';

// Qwen Code (qwen-code) provider — drives the self-contained `qwen` CLI directly
// (no bridge needed), modeled on the mimo-cli provider. Each turn runs
// `qwen -p <prompt> --output-format stream-json --yolo` (headless): the CLI emits
// line-delimited JSON events — system/session_start (carries session_id),
// assistant (message), result (turn end). We capture session_id to resume later
// with `--resume <id>`. Readback parses the same stream-json when re-run, and
// listSessions uses the built-in `qwen sessions list`.
//
// Contract verified live on box3 (qwen v0.21.6): see
// Proceeding-1/test-cases/tools/qwen-cli-invocation.md. Auth (an API key in
// ~/.qwen/settings.json or env) is an operator step — qwen returns a
// well-formed result event with is_error when unauthenticated.

const RUN_TIMEOUT_MS = Number(process.env.QWEN_RUN_TIMEOUT_MS || 300000);

/** Locate the `qwen` binary (npm global bin, brew, or PATH). */
function findQwenCli(): string {
  if (process.env.QWEN_BIN) return process.env.QWEN_BIN;
  const candidates = [
    path.join(os.homedir(), '.npm-global', 'bin', 'qwen'),
    '/usr/local/bin/qwen',
    '/opt/homebrew/bin/qwen',
    '/usr/bin/qwen',
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch { /* ignore */ }
  }
  return 'qwen';
}

const QWEN = findQwenCli();

/** Map a gateway model suffix to a qwen `--model` id. Empty → the token-plan default. */
function qwenModelId(providerModel?: string | null): string {
  const m = (providerModel || '').trim();
  if (!m) return QWEN_DEFAULT_MODEL;
  // Friendly short aliases → full ids (extend as the plan's model list changes).
  const map: Record<string, string> = {
    max: 'qwen3.8-max',
    'plus': 'qwen3.7-plus',
    coder: 'qwen3-coder-plus',
    flash: 'qwen3.6-flash',
    deepseek: 'deepseek-v4-pro',
    'deepseek-flash': 'deepseek-v4-flash-0731',
    glm: 'glm-5.2',
  };
  return map[m] || m; // otherwise pass the model id through verbatim
}

// Default model for a bare `qwen-cli` / `qwen`. qwen3.8-max is the flagship on
// the Alibaba token plan (Text + Reasoning + Visual). Override per-request with
// a `qwen-cli-<model>` model string.
const QWEN_DEFAULT_MODEL = process.env.QWEN_DEFAULT_MODEL || 'qwen3.8-max';

/**
 * Run the `qwen` CLI headless with stdin CLOSED. Returns raw stdout (the
 * stream-json line stream). Auto-approves tool calls (--yolo) for headless runs;
 * without it a tool call would block on an unanswerable confirmation and hang.
 */
function runCli(args: string[], cwd: string | undefined, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(QWEN, args, {
      cwd: cwd && fs.existsSync(cwd) ? cwd : os.tmpdir(),
      // Suppress the "--yolo without sandbox" stderr warning for clean logs; the
      // gateway spawn is the trusted automation context that warning targets.
      env: { ...process.env, QWEN_CODE_SUPPRESS_YOLO_WARNING: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(new Error(`qwen timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', e => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } });
    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Exit non-zero with no stdout is a hard failure; qwen also emits a
      // result event with is_error on stdout for softer failures (surfaced by
      // the caller). Keep stdout even on non-zero so the caller can parse it.
      if (code !== 0 && !stdout.trim()) {
        reject(new Error(`qwen exited ${code}: ${stderr.trim().slice(0, 400)}`));
      } else {
        resolve(stdout);
      }
    });
  });
}

interface QwenRun {
  sessionId: string | null;
  text: string;
  isError: boolean;
  errorMessage: string | null;
}

/**
 * Parse qwen's stream-json (line-delimited) stdout into session id + answer +
 * status. Verified events (box3, qwen 0.21.6):
 *   system/init          → carries session_id (a uuid)
 *   assistant            → message.content[] of {type:"thinking"|"text", …};
 *                          "thinking" is chain-of-thought — EXCLUDE it.
 *   result/success|error → is_error + a top-level `result` string = the final
 *                          answer, already assembled (preferred source).
 */
function parseStreamJson(stdout: string): QwenRun {
  let sessionId: string | null = null;
  let assistantText = '';
  let resultText: string | null = null;
  let isError = false;
  let errorMessage: string | null = null;
  for (const line of stdout.split('\n')) {
    const s = line.trim();
    if (!s || s[0] !== '{') continue;
    let o: any;
    try { o = JSON.parse(s); } catch { continue; }
    if (o.session_id && !sessionId) sessionId = o.session_id;
    if (o.type === 'assistant') {
      const content = o.message?.content;
      if (typeof content === 'string') assistantText += content;
      else if (Array.isArray(content)) {
        for (const part of content) {
          if (typeof part === 'string') { assistantText += part; continue; }
          // Skip reasoning parts; keep only real answer text.
          if (part && part.type === 'thinking') continue;
          if (part && typeof part.text === 'string') assistantText += part.text;
        }
      } else if (typeof o.message?.text === 'string') assistantText += o.message.text;
    } else if (o.type === 'result') {
      if (o.is_error) { isError = true; errorMessage = o.error?.message || o.result || 'qwen run failed'; }
      else if (typeof o.result === 'string') resultText = o.result;
    }
  }
  // Prefer the assembled result string; fall back to concatenated assistant text.
  return { sessionId, text: resultText ?? assistantText, isError, errorMessage };
}

/** Run a qwen turn; returns session id + concatenated answer text. */
async function runQwen(extraArgs: string[], prompt: string, cwd?: string, model?: string | null): Promise<QwenRun> {
  const args = [
    '-p', prompt,
    '--output-format', 'stream-json',
    '--yolo',
    '-m', qwenModelId(model),
    ...extraArgs,
  ];
  const stdout = await runCli(args, cwd, RUN_TIMEOUT_MS);
  return parseStreamJson(stdout);
}

export class QwenProvider implements DesktopProvider {
  name: ProviderName = 'qwen-cli';

  async createPreparedSession(input: PreparedSessionInput): Promise<ProviderSession> {
    const run = await runQwen([], input.prompt, input.workspaceDir, input.providerModel);
    if (run.isError) throw new Error(run.errorMessage || 'qwen run failed');
    if (!run.sessionId) throw new Error('qwen run returned no session id');
    return { providerSessionId: run.sessionId, providerSessionTitle: input.title };
  }

  async send(input: SendInput): Promise<void> {
    const sid = input.providerSessionId;
    // Resume the existing session so context carries; else start fresh.
    const extra = sid ? ['--resume', sid] : [];
    const run = await runQwen(extra, input.prompt, input.workspaceDir, input.providerModel);
    if (run.isError) throw new Error(run.errorMessage || 'qwen send failed');
  }

  async readLatest(
    sessionId: string,
    sinceIso?: string,
    _prompt?: string,
    opts?: { mode?: ReadbackMode; responseId?: string; responseCreatedAtIso?: string; maxMessages?: number },
  ): Promise<ReadLatestResult> {
    const sinceMs = sinceIso ? Date.parse(sinceIso) : 0;
    const wantMessages = opts?.mode === 'messages' || opts?.mode === 'events';
    const fromFile = readSessionJsonl(sessionId, sinceMs, {
      wantMessages,
      maxMessages: opts?.maxMessages,
      responseId: opts?.responseId,
    });
    if (fromFile) return fromFile;
    // No transcript on disk yet (chat-recording off, or not created) — report
    // processing so the gateway keeps polling rather than completing empty.
    return { status: 'Processing...', outputText: null, highWaterIso: null };
  }

  async listSessions(): Promise<DesktopSession[]> {
    // First: the JSONL store (fast, no spawn) — same shape readLatest reads.
    const fromStore = listSessionsFromStore();
    if (fromStore && fromStore.length) return fromStore;
    // Fallback: the built-in lister (spawns the CLI).
    try {
      const stdout = await runCli(['sessions', 'list'], undefined, 30000);
      const out: DesktopSession[] = [];
      // `qwen sessions list` prints a human table; also try JSON if present.
      for (const line of stdout.split('\n')) {
        const s = line.trim();
        // JSON line form
        if (s.startsWith('{')) {
          try {
            const o = JSON.parse(s);
            if (o.id || o.session_id) {
              out.push({ id: o.id || o.session_id, title: (o.title || o.summary || o.id || o.session_id) + '', provider: this.name, status: 'idle' });
              continue;
            }
          } catch { /* not json */ }
        }
        // Table form: "<uuid>  <title...>"
        const mm = s.match(/^([0-9a-f]{8}-[0-9a-f-]{27,})\s+(.*)$/i);
        if (mm) out.push({ id: mm[1], title: (mm[2] || '').trim() || mm[1], provider: this.name, status: 'idle' });
      }
      return out;
    } catch {
      return [];
    }
  }
}

// ── Session store (project-scoped JSONL under ~/.qwen/projects/<cwd>/chats) ──
//
// qwen stores conversation history as line-delimited JSON per session. The exact
// record schema is best-effort here (verified live once auth is configured; see
// the invocation doc). We read defensively: pull role + text + timestamp from
// the common field shapes and skip anything unrecognised, so a schema drift
// degrades to "fewer messages", never a crash.

function qwenProjectsRoot(): string {
  return process.env.QWEN_PROJECTS_DIR || path.join(os.homedir(), '.qwen', 'projects');
}

/** Find the chats dir + jsonl file for a session id across all project dirs. */
function findSessionFile(sessionId: string): string | null {
  const root = qwenProjectsRoot();
  let projects: string[];
  try { projects = fs.readdirSync(root); } catch { return null; }
  for (const proj of projects) {
    const chats = path.join(root, proj, 'chats');
    let files: string[];
    try { files = fs.readdirSync(chats); } catch { continue; }
    // File is typically named by session id (uuid) with a .jsonl extension.
    const match = files.find(f => f.includes(sessionId) && f.endsWith('.jsonl'));
    if (match) return path.join(chats, match);
  }
  return null;
}

// Extract the human-visible text from a qwen JSONL record. Verified schema
// (box3, qwen 0.21.6): text lives in message.parts[] as {text[, thought]}.
// A part with `thought: true` is the model's internal reasoning (chain of
// thought) — EXCLUDE it so the transcript shows answers, not the model
// thinking out loud. Falls back to the older content/text shapes defensively.
function extractText(rec: any): string {
  const parts = rec.message?.parts;
  if (Array.isArray(parts)) {
    return parts
      .filter((p: any) => p && typeof p.text === 'string' && p.thought !== true)
      .map((p: any) => p.text)
      .join('');
  }
  if (typeof rec.text === 'string') return rec.text;
  const content = rec.content ?? rec.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p: any) => (typeof p === 'string' ? p : (p && typeof p.text === 'string' ? p.text : ''))).join('');
  }
  if (typeof rec.message?.text === 'string') return rec.message.text;
  return '';
}

function recTimeMs(rec: any): number {
  const t = rec.timestamp ?? rec.time ?? rec.created_at ?? rec.ts;
  if (typeof t === 'number') return t;
  if (typeof t === 'string') { const p = Date.parse(t); return Number.isNaN(p) ? 0 : p; }
  return 0;
}

function readSessionJsonl(
  sessionId: string,
  sinceMs: number,
  opts?: { wantMessages?: boolean; maxMessages?: number; responseId?: string },
): ReadLatestResult | null {
  const file = findSessionFile(sessionId);
  if (!file) return null;
  let lines: string[];
  try { lines = fs.readFileSync(file, 'utf8').split('\n'); } catch { return null; }

  let best: { text: string; t: number } | null = null;
  let contextTokens: number | null = null;
  const messages: BlurMessage[] = [];
  for (const line of lines) {
    const s = line.trim();
    if (!s || s[0] !== '{') continue;
    let rec: any;
    try { rec = JSON.parse(s); } catch { continue; }
    // qwen records are keyed by top-level `type` (user/assistant/system). Only
    // user/assistant carry chat text; system events (session_start, etc.) skip.
    const kind = rec.type;
    if (kind !== 'user' && kind !== 'assistant') continue;
    // Context-window usage: assistant records carry usageMetadata.promptTokenCount
    // (tokens currently in context). Keep the latest — surfaces as the token chip.
    const promptTokens = rec.usageMetadata?.promptTokenCount;
    if (kind === 'assistant' && typeof promptTokens === 'number') contextTokens = promptTokens;
    const text = extractText(rec);
    if (!text.trim()) continue;
    const t = recTimeMs(rec);
    const afterMark = !(sinceMs && t && t <= sinceMs);
    if (kind === 'assistant' && afterMark) best = { text, t };
    if (opts?.wantMessages && afterMark) {
      const msg = normalizeMessage({
        provider: 'qwen-cli',
        providerSessionId: sessionId,
        responseId: opts.responseId,
        role: kind, // normalize to user/assistant (record.message.role is user/model)
        text,
        timestamp: t ? new Date(t).toISOString() : null,
        nativeType: 'qwen.message',
        nativeId: rec.uuid || null,
      });
      if (msg) messages.push(msg);
    }
  }

  const result: ReadLatestResult = best
    ? { status: 'completed', outputText: best.text, highWaterIso: best.t ? new Date(best.t).toISOString() : null }
    : { status: 'Processing...', outputText: null, highWaterIso: null };
  if (contextTokens != null) result.contextTokens = contextTokens;
  if (opts?.wantMessages) {
    const max = opts.maxMessages;
    result.messages = max && messages.length > max ? messages.slice(messages.length - max) : messages;
  }
  return result;
}

/** List sessions by scanning the JSONL store (id from filename, title from first user msg). */
function listSessionsFromStore(): DesktopSession[] | null {
  const root = qwenProjectsRoot();
  let projects: string[];
  try { projects = fs.readdirSync(root); } catch { return null; }
  const out: DesktopSession[] = [];
  for (const proj of projects) {
    const chats = path.join(root, proj, 'chats');
    let files: string[];
    try { files = fs.readdirSync(chats); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const id = f.replace(/\.jsonl$/, '');
      let title = id;
      try {
        // First user message → title; cheap read of the head only.
        const head = fs.readFileSync(path.join(chats, f), 'utf8').split('\n');
        for (const line of head) {
          const s = line.trim();
          if (!s || s[0] !== '{') continue;
          let rec: any; try { rec = JSON.parse(s); } catch { continue; }
          if (rec.type === 'user') { const t = extractText(rec).trim(); if (t) { title = t.slice(0, 80); break; } }
        }
      } catch { /* keep id as title */ }
      let mtime = 0;
      try { mtime = fs.statSync(path.join(chats, f)).mtimeMs; } catch { /* ignore */ }
      out.push({ id, title, provider: 'qwen-cli', status: 'idle', workspaceDir: proj });
      (out[out.length - 1] as any)._mtime = mtime;
    }
  }
  out.sort((a, b) => ((b as any)._mtime || 0) - ((a as any)._mtime || 0));
  out.forEach(s => { delete (s as any)._mtime; });
  return out;
}
