import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  DesktopProvider, DesktopSession, PreparedSessionInput,
  ProviderName, ProviderSession, ReadLatestResult, SendInput,
} from '../../types/provider';

// MiMo Code (Xiaomi) provider — drives the self-contained `mimo` CLI directly
// (no bridge needed). Each turn runs `mimo run --format json` (synchronous: the
// assistant reply is written to the session DB before it returns). Readback reads
// mimo's SQLite DB directly via node:sqlite (see getMimoDb) instead of spawning
// `mimo export` every poll. Mirrors the codex-cli provider's create/send/read shape.

const RUN_TIMEOUT_MS = Number(process.env.MIMO_RUN_TIMEOUT_MS || 300000);

/** Locate the `mimo` binary (installed by Xiaomi's installer under ~/.mimocode/bin). */
function findMimoCli(): string {
  if (process.env.MIMO_BIN) return process.env.MIMO_BIN;
  const candidates = [
    path.join(os.homedir(), '.mimocode', 'bin', 'mimo'),
    '/usr/local/bin/mimo',
    '/opt/homebrew/bin/mimo',
    '/usr/bin/mimo',
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch { /* ignore */ }
  }
  return 'mimo';
}

const MIMO = findMimoCli();

/** Locate mimo's SQLite session DB (tables: session/message/part). */
function mimoDbPath(): string {
  if (process.env.MIMO_DB) return process.env.MIMO_DB;
  return path.join(os.homedir(), '.local', 'share', 'mimocode', 'mimocode.db');
}

// Lazily-opened read-only handle to mimo's DB via Node's built-in `node:sqlite`.
// Reading the DB directly for readback avoids spawning `mimo export` on every poll:
// mimo is a ~100MB Bun binary that unpacks a ~4MB .so into /tmp on each launch, so
// per-poll spawns burned CPU and leaked disk (a 5-min hang = ~150 leaked .so files).
// Returns null when node:sqlite is unavailable (older Node) or the DB can't be
// opened yet, so callers transparently fall back to `mimo export` — no regression.
let _mimoDb: any = null;
let _sqliteUnavailable = false;
function getMimoDb(): any {
  if (_mimoDb) return _mimoDb;
  if (_sqliteUnavailable) return null;
  let DatabaseSync: any;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch {
    _sqliteUnavailable = true; // runtime without node:sqlite → always use export
    return null;
  }
  try {
    const p = mimoDbPath();
    if (!fs.existsSync(p)) return null; // DB not created yet; retry cheaply later
    // Open read-write (not readOnly): mimo runs the DB in WAL mode, and a readOnly
    // open fails with SQLITE_CANTOPEN because it can't create the -shm file. We only
    // ever SELECT, and `query_only` makes the connection reject any write anyway.
    const db = new DatabaseSync(p);
    db.exec('PRAGMA busy_timeout = 2000');
    db.exec('PRAGMA query_only = TRUE');
    _mimoDb = db;
    return _mimoDb;
  } catch {
    return null; // transient open failure → fall back this call
  }
}

/**
 * Run the `mimo` CLI with stdin CLOSED (stdio 'ignore'). mimo reads stdin and
 * would hang on an open pipe (as Node leaves it), so we give it immediate EOF.
 */
function runCli(args: string[], cwd: string | undefined, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(MIMO, args, {
      cwd: cwd && fs.existsSync(cwd) ? cwd : os.tmpdir(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(new Error(`mimo timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', e => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } });
    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0 && !stdout.trim()) {
        reject(new Error(`mimo exited ${code}: ${stderr.trim().slice(0, 400)}`));
      } else {
        resolve(stdout);
      }
    });
  });
}

/** Map a gateway model suffix to a MiMo `provider/model` id. Default = free auto channel. */
function mimoModelId(providerModel?: string | null): string {
  const m = (providerModel || '').trim();
  if (!m) return 'mimo/mimo-auto';
  if (m.includes('/')) return m; // already a provider/model id
  const map: Record<string, string> = {
    auto: 'mimo/mimo-auto',
    'mimo-auto': 'mimo/mimo-auto',
    flash: 'xiaomi/mimo-v2-flash',
    omni: 'xiaomi/mimo-v2-omni',
    pro: 'xiaomi/mimo-v2-pro',
    'v2.5': 'xiaomi/mimo-v2.5',
    'v2.5-pro': 'xiaomi/mimo-v2.5-pro',
    'v2.5-pro-ultraspeed': 'xiaomi/mimo-v2.5-pro-ultraspeed',
  };
  if (m === 'deepseek') return 'deepseek/deepseek-v4-pro';
  if (m.startsWith('deepseek')) return `deepseek/${m}`;
  return map[m] || `xiaomi/${m}`;
}

/** Run `mimo run --format json …`; return session id + concatenated answer text. */
async function runMimo(extraArgs: string[], prompt: string, cwd?: string): Promise<{ sessionId: string | null; text: string }> {
  // --dangerously-skip-permissions: mimo is an agentic coder that invokes tools
  // (bash, file read/write). Run headless (no TTY, stdin closed), an un-approved
  // tool call blocks on a confirmation prompt that can never be answered, so the
  // turn hangs until RUN_TIMEOUT_MS fires ("mimo timed out"). Auto-approving lets
  // tool-using prompts actually complete. Mirrors codex --yolo / claude skip-perms.
  const stdout = await runCli(['run', '--format', 'json', '--dangerously-skip-permissions', ...extraArgs, prompt], cwd, RUN_TIMEOUT_MS);
  let sessionId: string | null = null;
  let text = '';
  for (const line of stdout.split('\n')) {
    const s = line.trim();
    if (!s || s[0] !== '{') continue;
    let o: any;
    try { o = JSON.parse(s); } catch { continue; }
    if (o.sessionID) sessionId = o.sessionID;
    if (o.type === 'text' && o.part && typeof o.part.text === 'string') text += o.part.text;
  }
  return { sessionId, text };
}

/** `mimo export <id>` → parsed session JSON (output has a header line before the JSON). */
async function exportSession(sessionId: string): Promise<any | null> {
  try {
    const stdout = await runCli(['export', sessionId], undefined, 60000);
    const idx = stdout.indexOf('{');
    return idx < 0 ? null : JSON.parse(stdout.slice(idx));
  } catch {
    return null;
  }
}

function assistantText(parts: any[]): string {
  return (parts || [])
    .filter(p => p && p.type === 'text' && typeof p.text === 'string')
    .map(p => p.text)
    .join('');
}

/**
 * Readback straight from mimo's SQLite DB: the latest assistant message (after
 * sinceMs) and its concatenated text parts. Returns null to signal "DB
 * unavailable — fall back to `mimo export`"; a {status:'Processing...'} result
 * means the DB was read fine but no assistant turn has landed yet.
 */
function readLatestFromDb(sessionId: string, sinceMs: number): ReadLatestResult | null {
  const db = getMimoDb();
  if (!db) return null;
  try {
    const msgs = db.prepare(
      `SELECT id, data FROM message WHERE session_id = ? AND json_extract(data,'$.role') = 'assistant' ORDER BY time_created ASC`,
    ).all(sessionId) as Array<{ id: string; data: string }>;
    const partStmt = db.prepare(
      'SELECT data FROM part WHERE message_id = ? ORDER BY time_created ASC, id ASC',
    );
    let best: { text: string; t: number } | null = null;
    for (const m of msgs) {
      let info: any;
      try { info = JSON.parse(m.data); } catch { continue; }
      const t = (info.time && (info.time.completed || info.time.created)) || 0;
      let text = '';
      for (const p of partStmt.all(m.id) as Array<{ data: string }>) {
        try {
          const pd = JSON.parse(p.data);
          if (pd.type === 'text' && typeof pd.text === 'string') text += pd.text;
        } catch { /* skip malformed part */ }
      }
      if (!text.trim()) continue;
      if (sinceMs && t && t <= sinceMs) continue; // only turns at/after the mark
      best = { text, t }; // oldest->newest; keep the latest match
    }
    if (!best) return { status: 'Processing...', outputText: null, highWaterIso: null };
    return {
      status: 'completed',
      outputText: best.text,
      highWaterIso: best.t ? new Date(best.t).toISOString() : null,
    };
  } catch {
    // Locked / schema drift / stale handle — drop it so it reopens, fall back now.
    try { db.close(); } catch { /* ignore */ }
    _mimoDb = null;
    return null;
  }
}

/** Original export-based readback; fallback when the DB can't be read directly. */
async function readLatestViaExport(sessionId: string, sinceMs: number): Promise<ReadLatestResult> {
  const data = await exportSession(sessionId);
  if (!data || !Array.isArray(data.messages)) {
    return { status: 'Processing...', outputText: null, highWaterIso: null };
  }
  let best: { text: string; t: number } | null = null;
  for (const m of data.messages) {
    if (!m || !m.info || m.info.role !== 'assistant') continue;
    const t = (m.info.time && (m.info.time.completed || m.info.time.created)) || 0;
    const text = assistantText(m.parts);
    if (!text.trim()) continue;
    if (sinceMs && t && t <= sinceMs) continue;
    best = { text, t };
  }
  if (!best) return { status: 'Processing...', outputText: null, highWaterIso: null };
  return {
    status: 'completed',
    outputText: best.text,
    highWaterIso: best.t ? new Date(best.t).toISOString() : null,
  };
}

export class MimoProvider implements DesktopProvider {
  name: ProviderName = 'mimo-cli';

  async createPreparedSession(input: PreparedSessionInput): Promise<ProviderSession> {
    const model = mimoModelId(input.providerModel);
    const { sessionId } = await runMimo(['-m', model, '--title', input.title], input.prompt, input.workspaceDir);
    if (!sessionId) throw new Error('mimo run returned no session id');
    return { providerSessionId: sessionId, providerSessionTitle: input.title };
  }

  async send(input: SendInput): Promise<void> {
    const model = mimoModelId(input.providerModel);
    const sid = input.providerSessionId;
    const extra = sid ? ['-s', sid, '-m', model] : ['-m', model];
    await runMimo(extra, input.prompt, input.workspaceDir);
  }

  async readLatest(sessionId: string, sinceIso?: string): Promise<ReadLatestResult> {
    const sinceMs = sinceIso ? Date.parse(sinceIso) : 0;
    // Fast path: read mimo's SQLite DB directly — no `mimo export` spawn per poll.
    const fromDb = readLatestFromDb(sessionId, sinceMs);
    if (fromDb) return fromDb;
    // Fallback: original export-based readback (older Node / DB unreadable).
    return readLatestViaExport(sessionId, sinceMs);
  }

  async listSessions(): Promise<DesktopSession[]> {
    try {
      const stdout = await runCli(['session', 'list'], undefined, 30000);
      const out: DesktopSession[] = [];
      for (const line of stdout.split('\n')) {
        const mm = line.match(/^(ses_\S+)\s+(.*?)\s{2,}\S.*$/);
        if (!mm) continue;
        out.push({ id: mm[1], title: (mm[2] || '').trim() || mm[1], provider: this.name, status: 'idle' });
      }
      return out;
    } catch {
      return [];
    }
  }
}
