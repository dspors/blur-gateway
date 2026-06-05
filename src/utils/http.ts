import type { IncomingMessage, ServerResponse } from 'node:http';

export type JsonValue = Record<string, unknown> | unknown[] | string | number | boolean | null;

export function sendJson(res: ServerResponse, status: number, body: JsonValue): void {
  const data = Buffer.from(JSON.stringify(body, null, 2));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(data.length),
  });
  res.end(data);
}

export function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType = 'application/octet-stream'): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': String(body.length),
  });
  res.end(body);
}

export function notFound(res: ServerResponse): void {
  sendJson(res, 404, { error: { message: 'Not found' } });
}

export function readBody(req: IncomingMessage, maxBytes = 50 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', chunk => {
      const buf = Buffer.from(chunk);
      total += buf.length;
      if (total > maxBytes) {
        reject(new Error(`Request body exceeds ${maxBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req);
  if (!raw.length) return {};
  const parsed = JSON.parse(raw.toString('utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Expected JSON object');
  }
  return parsed as Record<string, unknown>;
}
