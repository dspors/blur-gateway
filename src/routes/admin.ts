import type { IncomingMessage, ServerResponse } from 'node:http';
import { db } from '../db/sqlite';
import { sendJson } from '../utils/http';

export async function getMetrics(_req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const hours = Number(url.searchParams.get('hours') || 24);
  const limit = Number(url.searchParams.get('limit') || 100);
  sendJson(res, 200, {
    object: 'metrics',
    hours,
    requests_by_hour: db.hourlyRequestRollup(hours),
    responses_by_hour: db.hourlyResponseRollup(hours),
    recent_response_metrics: db.listResponseMetrics(limit),
  });
}

export async function listRequests(_req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const limit = Number(url.searchParams.get('limit') || 100);
  sendJson(res, 200, {
    object: 'list',
    data: db.listRequestLog(limit),
  });
}
