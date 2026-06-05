import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config';
import { id } from '../utils/ids';
import { db } from '../db/sqlite';

export type UploadedFile = {
  id: string;
  filename: string;
  path: string;
  bytes: number;
  contentType?: string;
  purpose?: string;
  createdAt: string;
};

export function ensureStorage(): void {
  fs.mkdirSync(config.filesDir, { recursive: true });
  fs.mkdirSync(config.sessionsDir, { recursive: true });
}

export function createWorkspace(chainId: string): string {
  const dir = path.join(config.sessionsDir, chainId, 'workspace');
  fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
  return dir;
}

export function storeFile(opts: { filename: string; data: Buffer; purpose?: string; contentType?: string }): UploadedFile {
  ensureStorage();
  const fileId = id('file');
  const dir = path.join(config.filesDir, fileId);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, sanitizeFilename(opts.filename || 'upload.bin'));
  fs.writeFileSync(filePath, opts.data);
  const createdAt = new Date().toISOString();
  const row: UploadedFile = {
    id: fileId,
    filename: opts.filename || 'upload.bin',
    path: filePath,
    bytes: opts.data.length,
    contentType: opts.contentType,
    purpose: opts.purpose,
    createdAt,
  };
  db.insertFile(row);
  return row;
}

export function attachFilesToWorkspace(responseId: string, fileIds: string[], workspaceDir: string): string[] {
  const attached: string[] = [];
  const destDir = path.join(workspaceDir, 'files');
  fs.mkdirSync(destDir, { recursive: true });
  for (const fileId of fileIds) {
    const row = db.getFile(fileId);
    if (!row) throw new Error(`Unknown file_id: ${fileId}`);
    const dest = uniquePath(destDir, sanitizeFilename(row.filename || `${fileId}.bin`));
    fs.copyFileSync(row.path, dest);
    db.linkResponseFile(responseId, fileId, dest);
    attached.push(dest);
  }
  return attached;
}

export function sanitizeFilename(name: string): string {
  return path.basename(name).replace(/[^\w.\- ]+/g, '_') || 'file';
}

function uniquePath(dir: string, filename: string): string {
  const parsed = path.parse(filename);
  let candidate = path.join(dir, filename);
  let i = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${parsed.name}-${i}${parsed.ext}`);
    i++;
  }
  return candidate;
}

export function parseMultipart(body: Buffer, contentType: string): { fields: Record<string, string>; files: Array<{ field: string; filename: string; contentType?: string; data: Buffer }> } {
  const boundaryMatch = contentType.match(/boundary=([^;]+)/i);
  if (!boundaryMatch) throw new Error('Missing multipart boundary');
  const boundary = `--${boundaryMatch[1].replace(/^"|"$/g, '')}`;
  const raw = body.toString('binary');
  const parts = raw.split(boundary).slice(1, -1);
  const fields: Record<string, string> = {};
  const files: Array<{ field: string; filename: string; contentType?: string; data: Buffer }> = [];

  for (const part of parts) {
    const trimmed = part.replace(/^\r\n/, '').replace(/\r\n$/, '');
    const sep = trimmed.indexOf('\r\n\r\n');
    if (sep === -1) continue;
    const headerText = trimmed.slice(0, sep);
    const content = trimmed.slice(sep + 4);
    const disposition = headerText.match(/content-disposition:\s*form-data;([^\r\n]+)/i)?.[1] || '';
    const name = disposition.match(/name="([^"]+)"/i)?.[1] || '';
    const filename = disposition.match(/filename="([^"]*)"/i)?.[1];
    const partType = headerText.match(/content-type:\s*([^\r\n]+)/i)?.[1]?.trim();
    const data = Buffer.from(content, 'binary');
    if (filename !== undefined) {
      files.push({ field: name, filename: filename || 'upload.bin', contentType: partType, data });
    } else if (name) {
      fields[name] = data.toString('utf8');
    }
  }

  return { fields, files };
}
