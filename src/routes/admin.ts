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

/**
 * Per-stage timing breakdown across recent requests. Answers "which sub-step is
 * slow?" — e.g. provider.readLatest vs db read vs message normalize on the
 * session-history load. Query params:
 *   limit  — how many recent requests to sample (default 2000)
 *   path   — filter to a path prefix, e.g. /v1/responses
 */
export async function getStats(_req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const limit = Number(url.searchParams.get('limit') || 2000);
  const pathPrefix = url.searchParams.get('path') || undefined;
  sendJson(res, 200, {
    object: 'stage_stats',
    note: 'ms per stage over recent requests; stages sorted by p95 (slowest first)',
    ...db.stageStats({ limit, pathPrefix }),
  });
}
