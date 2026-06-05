import http from 'node:http';
import fs from 'node:fs';
import { config } from './config';
import { db } from './db/sqlite';
import { ensureStorage } from './storage/files';
import { notFound, sendJson } from './utils/http';
import { createResponse, getResponse } from './routes/responses';
import { createFile, getFileContent } from './routes/files';
import { listDesktopSessions } from './routes/desktop';

function init(): void {
  fs.mkdirSync(config.storageRoot, { recursive: true });
  ensureStorage();
  db.init();
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, { ok: true, service: 'blur-gateway' });
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

    notFound(res);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendJson(res, 500, { error: { message } });
  }
});

init();
server.listen(config.port, () => {
  console.log(`[blur-gateway] listening on http://localhost:${config.port}`);
});
