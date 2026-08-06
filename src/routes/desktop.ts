import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { allProviders } from '../providers';
import { db } from '../db/sqlite';
import { readJson, sendJson } from '../utils/http';
import { timerFrom } from '../utils/timing';
import { config } from '../config';

// Short-TTL cache of each provider's session list, keyed by provider name. The
// list changes rarely between rapid session-switches / transcript re-renders, so
// serving a few-seconds-stale list avoids re-spawning CLIs (claude/codex) or
// re-querying on every request. Providers that read a store directly (mimo, now)
// are already fast, but the cache still spares them redundant work. A caller can
// force-refresh with ?refresh=1.
const SESSION_LIST_TTL_MS = 8000;
const _sessionListCache = new Map<string, { at: number; data: DesktopSessionRow[] }>();
type DesktopSessionRow = Awaited<ReturnType<ReturnType<typeof allProviders>[number]['listSessions']>>[number];

export async function listDesktopSessions(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const timer = timerFrom(_req);
  const url = new URL((_req.url || '/'), `http://${_req.headers.host || 'localhost'}`);
  const forceRefresh = url.searchParams.get('refresh') === '1';
  const nowMs = Date.now();
  // Each provider's listSessions() reads its own store (mimo/codex sqlite) or
  // shells out (claude/codex CLI, on first boot). Cache per provider with a
  // short TTL; time each separately (cache-hit vs live) so /v1/admin/stats shows
  // which one is the slow one and whether the cache is helping.
  const providerSessions = (await Promise.all(allProviders().map(async provider => {
    const cached = _sessionListCache.get(provider.name);
    if (!forceRefresh && cached && (nowMs - cached.at) < SESSION_LIST_TTL_MS) {
      timer?.add(`listSessions.${provider.name}.cached`, 0);
      return cached.data;
    }
    const run = async () => {
      try { return await provider.listSessions(); }
      catch { return []; }
    };
    const data = timer ? await timer.time(`listSessions.${provider.name}`, run) : await run();
    _sessionListCache.set(provider.name, { at: Date.now(), data });
    return data;
  }))).flat();
  const providerSessionById = new Map(
    providerSessions
      .filter(session => session.id)
      .map(session => [session.id, session]),
  );

  const chains = timer ? timer.timeSync('db.listChains', () => db.listChains()) : db.listChains();
  sendJson(res, 200, {
    object: 'list',
    data: chains.map(chain => {
      const providerSession = chain.provider_session_id
        ? providerSessionById.get(chain.provider_session_id)
        : null;
      return {
        id: chain.id,
        object: 'desktop.session',
        provider: chain.provider,
        model: chain.model,
        provider_model: providerModelFromStoredModel(chain.model),
        title: chain.title,
        provider_session_id: chain.provider_session_id,
        provider_session_title: chain.provider_session_title,
        workspace_dir: chain.workspace_dir,
        archived: Boolean(chain.archived),
        created_at: chain.created_at,
        updated_at: chain.updated_at,
        provider_status: providerSession?.status || null,
        jsonl_updated_at: providerSession?.jsonlUpdatedAt || null,
      };
    }),
    provider_sessions: providerSessions,
  });
}

export async function updateDesktopSession(req: IncomingMessage, res: ServerResponse, chainId: string): Promise<void> {
  const chain = db.getChain(chainId);
  if (!chain) {
    sendJson(res, 404, { error: { message: `Session ${chainId} not found` } });
    return;
  }
  const body = await readJson(req);
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (!title) {
    sendJson(res, 400, { error: { message: 'Missing title' } });
    return;
  }
  db.updateChainTitle(chainId, title);
  sendJson(res, 200, {
    id: chainId,
    object: 'desktop.session',
    provider: chain.provider,
    model: chain.model,
    provider_model: providerModelFromStoredModel(chain.model),
    title,
    provider_session_id: chain.provider_session_id,
    provider_session_title: title,
    workspace_dir: chain.workspace_dir,
    archived: Boolean(chain.archived),
    created_at: chain.created_at,
    updated_at: new Date().toISOString(),
  });
}

export async function deleteDesktopSession(_req: IncomingMessage, res: ServerResponse, chainId: string): Promise<void> {
  const chain = db.getChain(chainId);
  if (!chain) {
    sendJson(res, 404, { error: { message: `Session ${chainId} not found` } });
    return;
  }

  db.deleteChain(chainId);
  removeWorkspace(chain.workspace_dir);
  sendJson(res, 200, {
    id: chainId,
    object: 'desktop.session.deleted',
    deleted: true,
  });
}

function providerModelFromStoredModel(model: unknown): string | null {
  if (typeof model !== 'string') return null;
  const normalized = model.toLowerCase().replace(/_/g, '-');
  for (const prefix of ['claude-cli-', 'claude-desktop-', 'codex-cli-', 'codex-desktop-']) {
    if (normalized.startsWith(prefix)) return normalized.slice(prefix.length);
  }
  if (normalized === 'opus' || normalized === 'sonnet' || normalized === 'haiku') return normalized;
  if (normalized.startsWith('gpt-5')) return model;
  return null;
}

function removeWorkspace(workspaceDir: unknown): void {
  if (typeof workspaceDir !== 'string' || !workspaceDir) return;
  const root = path.resolve(config.sessionsDir);
  const target = path.resolve(workspaceDir);
  if (target !== root && target.startsWith(`${root}${path.sep}`)) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
    } catch {
      // The database delete is authoritative for the chat list; workspace
      // cleanup is best-effort because files may be held by a provider process.
    }
  }
}
