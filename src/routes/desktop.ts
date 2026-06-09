import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { allProviders } from '../providers';
import { db } from '../db/sqlite';
import { sendJson } from '../utils/http';
import { config } from '../config';

export async function listDesktopSessions(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const providerSessions = (await Promise.all(allProviders().map(async provider => {
    try {
      return await provider.listSessions();
    } catch {
      return [];
    }
  }))).flat();
  const providerSessionById = new Map(
    providerSessions
      .filter(session => session.id)
      .map(session => [session.id, session]),
  );

  sendJson(res, 200, {
    object: 'list',
    data: db.listChains().map(chain => {
      const providerSession = chain.provider_session_id
        ? providerSessionById.get(chain.provider_session_id)
        : null;
      return {
        id: chain.id,
        object: 'desktop.session',
        provider: chain.provider,
        model: chain.model,
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
