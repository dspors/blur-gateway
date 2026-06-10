import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config';
import { db } from './db/sqlite';
import { ensureStorage } from './storage/files';
import { notFound, sendBuffer, sendJson } from './utils/http';
import { id } from './utils/ids';
import { createResponse, getResponse, adoptResponse } from './routes/responses';
import { createFile, getFileContent } from './routes/files';
import { deleteDesktopSession, listDesktopSessions, updateDesktopSession } from './routes/desktop';
import { lifecycleDesktopSession } from './routes/session-lifecycle';
import { getMetrics, listRequests } from './routes/admin';
import { availableModelOptions } from './providers';

function init(): void {
  fs.mkdirSync(config.storageRoot, { recursive: true });
  ensureStorage();
  db.init();
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const requestId = id('req');
  const requestContext: Record<string, unknown> = { requestId };
  (req as any).blurGateway = requestContext;
  res.setHeader('x-request-id', requestId);
  setCorsHeaders(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  res.once('finish', () => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      db.insertRequestLog({
        id: requestId,
        timestamp: new Date(started).toISOString(),
        method: req.method || '',
        path: url.pathname,
        statusCode: res.statusCode,
        durationMs: Date.now() - started,
        remoteAddr: req.socket.remoteAddress || null,
        userAgent: headerString(req.headers['user-agent']),
        host: headerString(req.headers.host),
        xForwardedFor: headerString(req.headers['x-forwarded-for']),
        xRequestId: headerString(req.headers['x-request-id']),
        authorizationPresent: Boolean(req.headers.authorization),
        contentLength: req.headers['content-length'] ? Number(req.headers['content-length']) : null,
        responseId: typeof requestContext.responseId === 'string' ? requestContext.responseId : null,
        provider: typeof requestContext.provider === 'string' ? requestContext.provider : null,
        error: typeof requestContext.error === 'string' ? requestContext.error : null,
      });
    } catch (err) {
      console.error('[blur-gateway] request log failed:', err instanceof Error ? err.message : String(err));
    }
  });
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/chat')) {
      sendChatPage(res);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/v1/models') {
      sendJson(res, 200, {
        object: 'list',
        data: availableModelOptions().map(model => ({
          id: model,
          object: 'model',
        })),
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, { ok: true, service: 'blur-gateway' });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/responses/adopt') {
      await adoptResponse(req, res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/responses') {
      await createResponse(req, res);
      return;
    }

    const responseMatch = url.pathname.match(/^\/v1\/responses\/([^/]+)$/);
    if (req.method === 'GET' && responseMatch) {
      await getResponse(req, res, responseMatch[1]);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/files') {
      await createFile(req, res);
      return;
    }

    const fileContentMatch = url.pathname.match(/^\/v1\/files\/([^/]+)\/content$/);
    if (req.method === 'GET' && fileContentMatch) {
      await getFileContent(req, res, fileContentMatch[1]);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/v1/desktop/sessions') {
      await listDesktopSessions(req, res);
      return;
    }

    const desktopSessionLifecycleMatch = url.pathname.match(/^\/v1\/desktop\/sessions\/([^/]+)\/lifecycle$/);
    if (req.method === 'POST' && desktopSessionLifecycleMatch) {
      await lifecycleDesktopSession(req, res, decodeURIComponent(desktopSessionLifecycleMatch[1]));
      return;
    }

    const desktopSessionMatch = url.pathname.match(/^\/v1\/desktop\/sessions\/([^/]+)$/);
    if (req.method === 'PATCH' && desktopSessionMatch) {
      await updateDesktopSession(req, res, decodeURIComponent(desktopSessionMatch[1]));
      return;
    }

    if (req.method === 'DELETE' && desktopSessionMatch) {
      await deleteDesktopSession(req, res, decodeURIComponent(desktopSessionMatch[1]));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/v1/admin/metrics') {
      await getMetrics(req, res, url);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/v1/admin/requests') {
      await listRequests(req, res, url);
      return;
    }

    notFound(res);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    requestContext.error = message;
    sendJson(res, 500, { error: { message } });
  }
});

init();
server.listen(config.port, () => {
  console.log(`[blur-gateway] listening on http://localhost:${config.port}`);
});

function headerString(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value.join(', ');
  return value || null;
}

function sendChatPage(res: http.ServerResponse): void {
  const pagePath = path.join(process.cwd(), 'public', 'chat.html');
  res.setHeader('cache-control', 'no-store, max-age=0');
  res.setHeader('pragma', 'no-cache');
  sendBuffer(res, 200, fs.readFileSync(pagePath), 'text/html; charset=utf-8');
}

function setCorsHeaders(res: http.ServerResponse): void {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type,authorization,x-request-id');
}
