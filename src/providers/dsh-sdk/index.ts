import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  DesktopProvider, DesktopSession, PreparedSessionInput,
  ProviderName, ProviderSession, ReadbackMode, ReadLatestResult, SendInput,
} from '../../types/provider';

// deepseek-harness (dsh) provider over the SDK JSON-RPC transport — the RESUMABLE,
// cache-preserving worker path (the ACP provider in ../dsh is the one-shot fallback).
//
// One long-lived dsh runtime process multiplexes every chain by sessionId
// (getOrCreateSession). A follow-up reuses the same sessionId, so dsh continues the
// SAME agent with full context; with session persistence composed, that history
// survives a runtime/gateway restart (restored lazily from disk on the next prompt)
// AND the reconstructed prefix reuses DeepSeek's prompt cache. cwd/provider/model are
// set once in `initialize`; `session/prompt` carries only {sessionId, contentBlocks}.
// Assistant text streams as `session.event` (type assistant/message); the turn is done
// when the session goes `idle` after its assistant message.
//
// Requires the dsh source patch gateway-patches/sdk-server-resume.patch (stock dsh
// writes session logs but never resumes them — see ~/dsh/gateway-patches/).

const DSH_DIR = process.env.DSH_DIR || path.join(os.homedir(), 'dsh');
const DSH_BIN = process.env.DSH_SDK_BIN || 'packages/examples/jsonrpc-demo/src/bin.ts';
const DSH_CONFIG = process.env.DSH_SDK_CONFIG || 'examples/jsonrpc-agent/gateway-sqlite.cordis.yml';
const TURN_TIMEOUT_MS = Number(process.env.DSH_RUN_TIMEOUT_MS || 300000);
const INIT_TIMEOUT_MS = Number(process.env.DSH_INIT_TIMEOUT_MS || 60000);

const RUNTIME_HOME = path.join(process.env.BLUR_GATEWAY_HOME || path.join(os.homedir(), '.blur-gateway'), 'dsh-runtime');
const SESSION_ROOT = path.join(RUNTIME_HOME, 'sessions');   // dsh's own persistence (JSONL/sqlite)
const WORKSPACE = path.join(RUNTIME_HOME, 'workspace');     // shared cwd for the runtime's shell/fs tools
const STORE_DIR = path.join(RUNTIME_HOME, 'answers');       // our readback store (survives a gateway restart)

const PERSONA = process.env.DSH_SYSTEM_PROMPT
  || 'You are a capable worker with real shell and network access on macOS. Follow the user instructions exactly, verify by running commands when useful, and answer concisely and factually.';

/** DeepSeek creds from env or ~/.blur-gateway/dsh.env (FAST_* fallback). */
let _creds: { apiKey: string; baseUrl: string } | null = null;
function dshCreds(): { apiKey: string; baseUrl: string } {
  if (_creds) return _creds;
  const c: Record<string, string> = { ...process.env } as Record<string, string>;
  try {
    const envFile = path.join(process.env.BLUR_GATEWAY_HOME || path.join(os.homedir(), '.blur-gateway'), 'dsh.env');
    for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in c)) c[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* env only */ }
  const apiKey = c.DEEPSEEK_API_KEY || c.FAST_KEY || '';
  let baseUrl = c.DEEPSEEK_BASE_URL || c.FAST_BASE || 'https://api.deepseek.com';
  baseUrl = baseUrl.replace(/\/v1\/?$/, '').replace(/\/$/, '');
  _creds = { apiKey, baseUrl };
  return _creds;
}

type Turn = { textParts: string[]; sawAssistant: boolean; endError: string | null; resolve: (t: string) => void; reject: (e: Error) => void };

/** Singleton manager for the one long-lived dsh SDK runtime process + its JSON-RPC client. */
class DshRuntime {
  private child: ChildProcess | null = null;
  private ready: Promise<void> | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { res: (v: any) => void; rej: (e: Error) => void }>();
  private readonly turns = new Map<string, Turn>();   // sessionId -> in-flight turn
  private stderrTail = '';

  private async ensure(): Promise<void> {
    if (this.child && !this.child.killed && this.ready) return this.ready;
    this.ready = this.spawnAndInit();
    return this.ready;
  }

  private spawnAndInit(): Promise<void> {
    const { apiKey, baseUrl } = dshCreds();
    if (!apiKey) return Promise.reject(new Error('dsh-sdk: no DeepSeek API key (DEEPSEEK_API_KEY or ~/.blur-gateway/dsh.env)'));
    if (!fs.existsSync(path.join(DSH_DIR, DSH_BIN))) return Promise.reject(new Error(`dsh-sdk: runtime not found at ${path.join(DSH_DIR, DSH_BIN)}`));
    for (const d of [WORKSPACE, SESSION_ROOT, STORE_DIR]) fs.mkdirSync(d, { recursive: true });

    const child = spawn('node', ['--import', 'tsx', DSH_BIN, DSH_CONFIG], {
      cwd: DSH_DIR,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        DEEPSEEK_API_KEY: apiKey,
        DEEPSEEK_BASE_URL: baseUrl,
        DSH_CORDIS_CONFIG: DSH_CONFIG,
        DSH_SESSION_ROOT: SESSION_ROOT,
        DSH_SESSION_DB: path.join(SESSION_ROOT, 'sessions.db'),   // used by the sqlite composition
        DSH_CWD: WORKSPACE,
        DSH_PERMISSION_MODE: 'danger-full-access',
        DSH_SYSTEM_PROMPT: PERSONA,
      },
    });
    this.child = child;
    // Don't orphan the runtime if the gateway process goes down.
    const killChild = () => { try { child.kill('SIGTERM'); } catch { /* ignore */ } };
    process.once('exit', killChild);
    process.once('SIGTERM', killChild);
    process.once('SIGINT', killChild);
    child.stderr?.on('data', d => { this.stderrTail = (this.stderrTail + d.toString()).slice(-2000); });
    child.on('exit', (code, sig) => this.onExit(code, sig));
    const rl = createInterface({ input: child.stdout! });
    rl.on('line', l => this.onLine(l));

    // cwd/provider/model are fixed for the process here.
    return this.rpc('initialize', { cwd: WORKSPACE, provider: 'deepseek-official', model: 'deepseek-chat' }, INIT_TIMEOUT_MS).then(() => undefined);
  }

  private onExit(code: number | null, sig: string | null): void {
    const err = new Error(`dsh-sdk runtime exited (${code ?? sig})${this.stderrTail ? ` | ${this.stderrTail.trim().slice(-400)}` : ''}`);
    for (const [, p] of this.pending) p.rej(err);
    this.pending.clear();
    for (const [, t] of this.turns) t.reject(err);
    this.turns.clear();
    this.child = null;
    this.ready = null;   // next call respawns; persisted sessions resume from disk
  }

  private onLine(line: string): void {
    line = line.trim();
    if (!line || line[0] !== '{') return;   // stdout is protocol frames only
    let msg: any;
    try { msg = JSON.parse(line); } catch { return; }

    if (msg.id !== undefined && !msg.method) {          // response to one of our requests
      const p = this.pending.get(msg.id);
      if (p) { this.pending.delete(msg.id); msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result); }
      return;
    }
    if (msg.method === 'session.event') {               // per-session; stream is unfiltered
      const sid: string = msg.params?.sessionId;
      const ev = msg.params?.event;
      const t = this.turns.get(sid);
      if (!t || !ev) return;
      if (ev.type === 'assistant/message') {
        for (const b of (ev.data?.message?.content ?? [])) if (b?.type === 'text' && b.text) { t.textParts.push(b.text); t.sawAssistant = true; }
      } else if (ev.type === 'turn/end') {
        const kind = ev.data?.reason?.kind;
        if (kind && kind !== 'completed' && kind !== 'max-tokens') t.endError = String(kind);
      }
      return;
    }
    if (msg.method === 'session.status') {              // turn done: idle after the assistant message
      const sid: string = msg.params?.sessionId;
      const t = this.turns.get(sid);
      if (t && msg.params?.status === 'idle' && t.sawAssistant) {
        this.turns.delete(sid);
        if (t.endError && !t.textParts.length) t.reject(new Error(`dsh turn ended: ${t.endError}`));
        else t.resolve(t.textParts.join('').trim());
      }
      return;
    }
  }

  private rpc(method: string, params: unknown, timeoutMs = TURN_TIMEOUT_MS): Promise<any> {
    const id = this.nextId++;
    if (!this.child?.stdin?.writable) return Promise.reject(new Error('dsh-sdk: runtime not writable'));
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return new Promise((res, rej) => {
      const timer = setTimeout(() => { this.pending.delete(id); rej(new Error(`dsh-sdk ${method} timed out`)); }, timeoutMs);
      this.pending.set(id, { res: v => { clearTimeout(timer); res(v); }, rej: e => { clearTimeout(timer); rej(e); } });
    });
  }

  /** Run one turn on `sessionId` (reused id => dsh continues the same conversation). */
  async runTurn(sessionId: string, prompt: string): Promise<string> {
    await this.ensure();
    const turnPromise = new Promise<string>((resolve, reject) => {
      this.turns.set(sessionId, { textParts: [], sawAssistant: false, endError: null, resolve, reject });
    });
    const timer = setTimeout(() => {
      const t = this.turns.get(sessionId);
      if (t) { this.turns.delete(sessionId); t.reject(new Error(`dsh-sdk turn timed out after ${TURN_TIMEOUT_MS}ms`)); }
    }, TURN_TIMEOUT_MS);
    try {
      await this.rpc('session/prompt', { sessionId, contentBlocks: [{ type: 'text', text: prompt }] });
      return await turnPromise;
    } finally {
      clearTimeout(timer);
      this.turns.delete(sessionId);
    }
  }
}

const runtime = new DshRuntime();

type StoredTurn = { text: string; ts: number; title: string };
function storeTurn(sessionId: string, text: string, title: string): void {
  try { fs.mkdirSync(STORE_DIR, { recursive: true }); fs.writeFileSync(path.join(STORE_DIR, `${sessionId}.json`), JSON.stringify({ text, ts: Date.now(), title } as StoredTurn)); } catch { /* best-effort */ }
}
function readTurn(sessionId: string): StoredTurn | null {
  try { return JSON.parse(fs.readFileSync(path.join(STORE_DIR, `${sessionId}.json`), 'utf8')) as StoredTurn; } catch { return null; }
}
function newSessionId(): string {
  return `dsh_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export class DshSdkProvider implements DesktopProvider {
  name: ProviderName = 'dsh';

  async createPreparedSession(input: PreparedSessionInput): Promise<ProviderSession> {
    const sessionId = newSessionId();
    const text = await runtime.runTurn(sessionId, input.prompt);
    storeTurn(sessionId, text, input.title);
    return { providerSessionId: sessionId, providerSessionTitle: input.title };
  }

  async send(input: SendInput): Promise<void> {
    // Reuse the chain's sessionId so dsh CONTINUES the same conversation (full
    // context + prompt-cache reuse), restoring from persistence if the runtime restarted.
    const sessionId = input.providerSessionId || newSessionId();
    const text = await runtime.runTurn(sessionId, input.prompt);
    storeTurn(sessionId, text, input.providerSessionTitle);
  }

  async readLatest(sessionId: string, sinceIso?: string, _prompt?: string,
    _opts?: { mode?: ReadbackMode; responseId?: string; responseCreatedAtIso?: string; maxMessages?: number }): Promise<ReadLatestResult> {
    const rec = readTurn(sessionId);
    if (!rec || !rec.text) return { status: 'Processing...', outputText: null, highWaterIso: null };
    const sinceMs = sinceIso ? Date.parse(sinceIso) : 0;
    if (sinceMs && rec.ts && rec.ts <= sinceMs) return { status: 'Processing...', outputText: null, highWaterIso: null };
    return { status: 'completed', outputText: rec.text, highWaterIso: new Date(rec.ts).toISOString(), resolved: true };
  }

  async listSessions(): Promise<DesktopSession[]> {
    try {
      return fs.readdirSync(STORE_DIR).filter(f => f.endsWith('.json'))
        .map(f => ({ id: f.replace(/\.json$/, ''), rec: readTurn(f.replace(/\.json$/, '')) }))
        .filter(x => x.rec)
        .sort((a, b) => b.rec!.ts - a.rec!.ts)
        .map(x => ({ id: x.id, title: x.rec!.title || x.id, provider: this.name, status: 'idle' }));
    } catch { return []; }
  }
}
