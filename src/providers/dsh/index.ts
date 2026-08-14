import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  DesktopProvider, DesktopSession, PreparedSessionInput,
  ProviderName, ProviderSession, ReadbackMode, ReadLatestResult, SendInput,
} from '../../types/provider';

// deepseek-harness (dsh) provider — drives the harness's ACP (Agent Client
// Protocol) stdio server directly, no bridge. Each turn spawns the runtime,
// speaks newline-delimited JSON-RPC (initialize -> session/new -> session/prompt),
// collects the streamed `agent_message_chunk` text, and ends on `stopReason`.
// Mirrors the mimo-cli provider's synchronous create/send + poll-readback shape:
// createPreparedSession/send run the whole turn to completion (ACP emits only
// COMMITTED assistant text, so there is no first-message/preamble trap), stash
// the answer on disk keyed by a synthetic session id, and readLatest reads it
// back — surviving a gateway restart between the turn and the first poll.
//
// ACP deliberately exposes only committed text — no token streaming, no tool or
// reasoning events on the wire (they live in the runtime's own session log). If
// the gateway ever needs live progress/tool visibility, the heavier
// packages/sdk/server (sdk-jsonrpc) path is the alternative; this provider is the
// request/response seam.

const RUN_TIMEOUT_MS = Number(process.env.DSH_RUN_TIMEOUT_MS || 300000);

/** The dsh checkout (built host face) this provider drives. */
const DSH_DIR = process.env.DSH_DIR || path.join(os.homedir(), 'dsh');
/** ACP runnable composition (relative to DSH_DIR): pins a real model + a fetch tool. */
const DSH_CONFIG = process.env.DSH_CONFIG || 'examples/acp-agent/gateway-deepseek.cordis.yml';
/** The ACP stdio entrypoint, run through tsx. */
const DSH_BIN = process.env.DSH_BIN || 'packages/examples/acp-demo/src/bin.ts';

/** Where readback answers are stashed (survives a gateway restart mid-poll). */
function sessionStoreDir(): string {
  const root = process.env.BLUR_GATEWAY_HOME || path.join(os.homedir(), '.blur-gateway');
  const dir = path.join(root, 'dsh-sessions');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  return dir;
}

/**
 * Resolve the DeepSeek credentials the dsh runtime needs. The gateway process
 * has no dotenv, so read them from the environment first, then fall back to a
 * plain KEY=VALUE file at ~/.blur-gateway/dsh.env (kept out of the repo). Maps
 * Sheddy's FAST_* names too, so the same key that drives the router works here.
 */
let _credsCache: Record<string, string> | null = null;
function dshCreds(): { apiKey: string; baseUrl: string } {
  if (!_credsCache) {
    _credsCache = { ...process.env } as Record<string, string>;
    const envFile = path.join(process.env.BLUR_GATEWAY_HOME || path.join(os.homedir(), '.blur-gateway'), 'dsh.env');
    try {
      for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m && !(m[1] in _credsCache!)) _credsCache![m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    } catch { /* no file → env only */ }
  }
  const c = _credsCache;
  const apiKey = c.DEEPSEEK_API_KEY || c.FAST_KEY || '';
  // dsh's dsh-llm-deepseek appends /chat/completions, so pass the ORIGIN (no /v1).
  let baseUrl = c.DEEPSEEK_BASE_URL || c.FAST_BASE || 'https://api.deepseek.com';
  baseUrl = baseUrl.replace(/\/v1\/?$/, '').replace(/\/$/, '');
  return { apiKey, baseUrl };
}

/**
 * Run one ACP turn: spawn the runtime, do the handshake, return the committed
 * assistant text. Rejects on protocol error, non-zero boot exit, or timeout.
 */
function runDshTurn(prompt: string, workspaceDir: string | undefined): Promise<string> {
  const { apiKey, baseUrl } = dshCreds();
  if (!apiKey) return Promise.reject(new Error('dsh: no DeepSeek API key (set DEEPSEEK_API_KEY or ~/.blur-gateway/dsh.env)'));
  if (!fs.existsSync(path.join(DSH_DIR, DSH_BIN))) {
    return Promise.reject(new Error(`dsh: runtime not found at ${path.join(DSH_DIR, DSH_BIN)} (set DSH_DIR)`));
  }
  // ACP session/new requires an absolute, existing cwd.
  const cwd = workspaceDir && fs.existsSync(workspaceDir) ? path.resolve(workspaceDir) : os.tmpdir();

  return new Promise((resolve, reject) => {
    const child = spawn('node', ['--import', 'tsx', DSH_BIN, '--config', DSH_CONFIG], {
      cwd: DSH_DIR,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        DEEPSEEK_API_KEY: apiKey,
        DEEPSEEK_BASE_URL: baseUrl,
        DSH_PERMISSION_MODE: 'danger-full-access', // headless: no permission round-trips to hang on
      },
    });

    let nextId = 1;
    const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
    const chunks: string[] = [];
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => finish(new Error(`dsh timed out after ${RUN_TIMEOUT_MS}ms`)), RUN_TIMEOUT_MS);

    function finish(err: Error | null, text?: string) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      if (err) reject(new Error(`${err.message}${stderr ? ` | stderr: ${stderr.trim().slice(-400)}` : ''}`));
      else resolve((text || '').trim());
    }

    function rpc(method: string, params: unknown): Promise<any> {
      const id = nextId++;
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      return new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej }));
    }
    function respond(id: number, result: unknown) {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
    }

    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', e => finish(e));
    child.on('exit', (code, sig) => { if (!settled) finish(new Error(`dsh runtime exited ${code ?? sig} before end_turn`)); });

    const rl = createInterface({ input: child.stdout });
    rl.on('line', (raw: string) => {
      const line = raw.trim();
      if (!line || line[0] !== '{') return; // stdout is protocol frames only; ignore stray lines
      let msg: any;
      try { msg = JSON.parse(line); } catch { return; }
      // Response to one of our requests.
      if (msg.id !== undefined && !msg.method && (msg.result !== undefined || msg.error !== undefined)) {
        const p = pending.get(msg.id);
        if (p) { pending.delete(msg.id); msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result); }
        return;
      }
      // Server -> client request (e.g. session/request_permission): auto-answer.
      if (msg.method && msg.id !== undefined) {
        if (msg.method === 'session/request_permission') {
          const opts = msg.params?.options || [];
          const allow = opts.find((o: any) => /allow/i.test(o.optionId || '') || /allow/i.test(o.name || '')) || opts[0];
          respond(msg.id, { outcome: { outcome: 'selected', optionId: allow?.optionId } });
        } else {
          respond(msg.id, {});
        }
        return;
      }
      // Notification: accumulate committed assistant text.
      if (msg.method === 'session/update') {
        const u = msg.params?.update;
        if (u?.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') chunks.push(u.content.text);
      }
    });

    (async () => {
      try {
        await rpc('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } });
        const ns = await rpc('session/new', { cwd, mcpServers: [] });
        const sessionId = ns?.sessionId;
        if (!sessionId) throw new Error('dsh: session/new returned no sessionId');
        await rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text: prompt }] });
        finish(null, chunks.join(''));
      } catch (e) {
        finish(e as Error);
      }
    })();
  });
}

function newSessionId(): string {
  return `dsh_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

type StoredTurn = { text: string; ts: number; title: string };

function storeTurn(sessionId: string, text: string, title: string): void {
  const rec: StoredTurn = { text, ts: Date.now(), title };
  try { fs.writeFileSync(path.join(sessionStoreDir(), `${sessionId}.json`), JSON.stringify(rec)); } catch { /* best-effort */ }
}

function readTurn(sessionId: string): StoredTurn | null {
  try { return JSON.parse(fs.readFileSync(path.join(sessionStoreDir(), `${sessionId}.json`), 'utf8')) as StoredTurn; } catch { return null; }
}

export class DshProvider implements DesktopProvider {
  name: ProviderName = 'dsh';

  async createPreparedSession(input: PreparedSessionInput): Promise<ProviderSession> {
    const text = await runDshTurn(input.prompt, input.workspaceDir);
    const sessionId = newSessionId();
    storeTurn(sessionId, text, input.title);
    return { providerSessionId: sessionId, providerSessionTitle: input.title };
  }

  async send(input: SendInput): Promise<void> {
    // v1: no cross-turn ACP session resumption (each turn is a fresh runtime +
    // session), so a follow-up runs standalone. Overwrite the stored answer under
    // the same session id so the poll path reads THIS turn's reply.
    const text = await runDshTurn(input.prompt, input.workspaceDir);
    const sessionId = input.providerSessionId || newSessionId();
    storeTurn(sessionId, text, input.providerSessionTitle);
  }

  async readLatest(
    sessionId: string,
    sinceIso?: string,
    _prompt?: string,
    _opts?: { mode?: ReadbackMode; responseId?: string; responseCreatedAtIso?: string; maxMessages?: number },
  ): Promise<ReadLatestResult> {
    const rec = readTurn(sessionId);
    if (!rec || !rec.text) return { status: 'Processing...', outputText: null, highWaterIso: null };
    const sinceMs = sinceIso ? Date.parse(sinceIso) : 0;
    if (sinceMs && rec.ts && rec.ts <= sinceMs) {
      // Stored turn predates the mark — this turn's reply hasn't landed yet.
      return { status: 'Processing...', outputText: null, highWaterIso: null };
    }
    // ACP committed text == the final answer, so the turn is resolved on read.
    return { status: 'completed', outputText: rec.text, highWaterIso: new Date(rec.ts).toISOString(), resolved: true };
  }

  async listSessions(): Promise<DesktopSession[]> {
    try {
      const dir = sessionStoreDir();
      return fs.readdirSync(dir)
        .filter(f => f.endsWith('.json'))
        .map(f => ({ file: f, rec: readTurn(f.replace(/\.json$/, '')) }))
        .filter(x => x.rec)
        .sort((a, b) => (b.rec!.ts) - (a.rec!.ts))
        .map(x => ({ id: x.file.replace(/\.json$/, ''), title: x.rec!.title || x.file, provider: this.name, status: 'idle' }));
    } catch {
      return [];
    }
  }
}
