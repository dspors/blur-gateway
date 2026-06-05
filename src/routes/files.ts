import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { db } from '../db/sqlite';
import { parseMultipart, storeFile } from '../storage/files';
import { readBody, sendBuffer, sendJson } from '../utils/http';

export async function createFile(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const contentType = req.headers['content-type'] || '';
  const raw = await readBody(req);
  let filename = 'upload.bin';
  let purpose = 'assistants';
  let data: Buffer;
  let partType: string | undefined;

  if (String(contentType).includes('multipart/form-data')) {
    const parsed = parseMultipart(raw, String(contentType));
    const file = parsed.files[0];
    if (!file) {
      sendJson(res, 400, { error: { message: 'Multipart upload missing file part' } });
      return;
    }
    filename = file.filename;
    purpose = parsed.fields.purpose || purpose;
    data = file.data;
    partType = file.contentType;
  } else {
    const parsed = JSON.parse(raw.toString('utf8') || '{}');
    filename = parsed.filename || filename;
    purpose = parsed.purpose || purpose;
    if (typeof parsed.content_base64 === 'string') data = Buffer.from(parsed.content_base64, 'base64');
    else if (typeof parsed.content === 'string') data = Buffer.from(parsed.content, 'utf8');
    else {
      sendJson(res, 400, { error: { message: 'JSON upload requires content or content_base64' } });
      return;
    }
    partType = parsed.content_type;
  }

  const file = storeFile({ filename, purpose, data, contentType: partType });
  sendJson(res, 200, {
    id: file.id,
    object: 'file',
    bytes: file.bytes,
    created_at: Math.floor(new Date(file.createdAt).getTime() / 1000),
    filename: file.filename,
    purpose: file.purpose,
  });
}

export async function getFileContent(_req: IncomingMessage, res: ServerResponse, fileId: string): Promise<void> {
  const row = db.getFile(fileId);
  if (!row) {
    sendJson(res, 404, { error: { message: `Unknown file: ${fileId}` } });
    return;
  }
  sendBuffer(res, 200, fs.readFileSync(row.path), row.content_type || 'application/octet-stream');
}
