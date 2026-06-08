import type { IncomingMessage, ServerResponse } from 'node:http';
import { allProviders } from '../providers';
import { db } from '../db/sqlite';
import { sendJson } from '../utils/http';

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
