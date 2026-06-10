import crypto from 'node:crypto';
import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { config } from '../config';
import { allProviders } from '../providers';
import type { DesktopSession } from '../types/provider';
import { readJson, sendJson } from '../utils/http';

type LifecycleAction = 'dry-run' | 'archive' | 'hard-delete';

type LifecycleBody = {
  action?: unknown;
  provider?: unknown;
  expectedTitle?: unknown;
  capabilityKey?: unknown;
  reason?: unknown;
  dryRun?: unknown;
  allowHardDelete?: unknown;
};

type PlannedFile = {
  role: 'jsonl' | 'metadata';
  path: string;
  exists: boolean;
  bytes: number | null;
};

type LifecyclePlan = {
  sessionId: string;
  title: string;
  provider: string;
  status?: string;
  archived: boolean;
  files: PlannedFile[];
  warnings: string[];
};

type LocatedSession = {
  session: DesktopSession;
  provider: ReturnType<typeof allProviders>[number];
};

export async function lifecycleDesktopSession(req: IncomingMessage, res: ServerResponse, sessionId: string): Promise<void> {
  const body = await readJson(req) as LifecycleBody;
  const action = parseAction(body.action);
  const expectedTitle = requiredString(body.expectedTitle, 'expectedTitle');
  const reason = requiredString(body.reason, 'reason');
  const dryRun = action === 'dry-run' || body.dryRun === true;

  const authError = authorize(body.capabilityKey);
  if (authError) {
    sendJson(res, authError.status, { error: { code: authError.code, message: authError.message } });
    return;
  }

  const located = await findProviderSession(sessionId, optionalString(body.provider));
  if (!located) {
    sendJson(res, 404, { error: { code: 'SESSION_NOT_FOUND', message: `No desktop provider session found for ${sessionId}` } });
    return;
  }
  const { session, provider } = located;
  if (session.title !== expectedTitle) {
    sendJson(res, 409, {
      error: {
        code: 'SESSION_TITLE_MISMATCH',
        message: 'Session title did not match expectedTitle',
        expectedTitle,
        actualTitle: session.title,
      },
    });
    return;
  }

  const plan = buildLifecyclePlan(session);
  if (!plan.files.length) {
    sendJson(res, 422, { error: { code: 'SESSION_PATHS_UNAVAILABLE', message: 'Provider session did not expose any lifecycle file paths', plan } });
    return;
  }

  if (dryRun) {
    await appendAudit({ action, dryRun: true, reason, plan });
    sendJson(res, 200, { object: 'desktop.session.lifecycle_plan', action, dry_run: true, plan });
    return;
  }

  if (isCodexProvider(session.provider)) {
    sendJson(res, 409, {
      error: {
        code: 'CODEX_LIFECYCLE_DISCOVERY_REQUIRED',
        message: 'Codex lifecycle mutation is disabled: native sessions are indexed in state_5.sqlite/session_index.jsonl, so moving the JSONL alone is not a correct archive/delete.',
        plan,
      },
    });
    return;
  }

  if (action === 'archive') {
    const result = archiveSessionFiles(plan, reason);
    await appendAudit({ action, dryRun: false, reason, plan, result });
    sendJson(res, 200, { object: 'desktop.session.lifecycle_result', action, plan, result });
    return;
  }

  if (action === 'hard-delete') {
    if (body.allowHardDelete !== true) {
      sendJson(res, 409, { error: { code: 'HARD_DELETE_CONFIRMATION_REQUIRED', message: 'Set allowHardDelete=true after a dry-run and operator review.', plan } });
      return;
    }
    if (provider.deleteSession) {
      const result = await provider.deleteSession({
        providerSessionId: sessionId,
        providerSessionTitle: session.title,
        expectedTitle,
        reason,
        commit: true,
      });
      await appendAudit({ action, dryRun: false, reason, plan, result });
      sendJson(res, 200, { object: 'desktop.session.lifecycle_result', action, plan, result });
      return;
    }
    const result = deleteSessionFiles(plan, reason);
    await appendAudit({ action, dryRun: false, reason, plan, result });
    sendJson(res, 200, { object: 'desktop.session.lifecycle_result', action, plan, result });
    return;
  }

  sendJson(res, 400, { error: { code: 'UNSUPPORTED_ACTION', message: `Unsupported action: ${action}` } });
}

async function findProviderSession(sessionId: string, providerName?: string): Promise<LocatedSession | null> {
  const providers = allProviders().filter(provider => !providerName || provider.name === providerName || provider.name.replace(/-(desktop|cli)$/, '') === providerName);
  for (const provider of providers) {
    const sessions = await provider.listSessions();
    const found = sessions.find(session => session.id === sessionId);
    if (found) return { session: found, provider };
  }
  return null;
}

export function buildLifecyclePlan(session: DesktopSession): LifecyclePlan {
  const files: PlannedFile[] = [];
  if (session.jsonlPath) files.push(plannedFile('jsonl', session.jsonlPath));
  if (session.metadataPath) files.push(plannedFile('metadata', session.metadataPath));
  const warnings: string[] = [];
  if (isCodexProvider(session.provider) && session.jsonlPath) {
    warnings.push('Codex native sessions are indexed in state_5.sqlite/session_index.jsonl; lifecycle mutation is discovery-gated.');
  }
  if (!session.metadataPath && (session.provider === 'claude' || session.provider === 'claude-desktop')) {
    warnings.push('Claude metadataPath is unavailable; UI may retain a stale row until provider cache refresh.');
  }
  return {
    sessionId: session.id || '',
    title: session.title,
    provider: session.provider,
    status: session.status,
    archived: Boolean(session.archived),
    files,
    warnings,
  };
}

function isCodexProvider(provider: string): boolean {
  return provider === 'codex' || provider === 'codex-cli' || provider === 'codex-desktop';
}

function plannedFile(role: PlannedFile['role'], filePath: string): PlannedFile {
  try {
    const stat = fs.statSync(filePath);
    return { role, path: filePath, exists: stat.isFile(), bytes: stat.isFile() ? stat.size : null };
  } catch {
    return { role, path: filePath, exists: false, bytes: null };
  }
}

function archiveSessionFiles(plan: LifecyclePlan, reason: string): Record<string, unknown> {
  const archiveDir = path.join(config.sessionsDir, 'lifecycle-archive', sanitizePathPart(plan.sessionId), timestampPathPart());
  fs.mkdirSync(archiveDir, { recursive: true });
  const moved: Array<Record<string, unknown>> = [];
  for (const file of plan.files) {
    if (!file.exists) {
      moved.push({ role: file.role, source: file.path, skipped: 'missing' });
      continue;
    }
    const target = path.join(archiveDir, `${file.role}-${path.basename(file.path)}`);
    fs.renameSync(file.path, target);
    moved.push({ role: file.role, source: file.path, archivedTo: target });
  }
  const manifest = { archivedAt: new Date().toISOString(), reason, plan, moved };
  const manifestPath = path.join(archiveDir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return { archiveDir, manifestPath, moved };
}

function deleteSessionFiles(plan: LifecyclePlan, reason: string): Record<string, unknown> {
  const deleted: Array<Record<string, unknown>> = [];
  for (const file of plan.files) {
    if (!file.exists) {
      deleted.push({ role: file.role, path: file.path, skipped: 'missing' });
      continue;
    }
    fs.rmSync(file.path, { force: true });
    deleted.push({ role: file.role, path: file.path, deleted: true });
  }
  return { deletedAt: new Date().toISOString(), reason, deleted };
}

async function appendAudit(row: Record<string, unknown>): Promise<void> {
  const auditPath = path.join(config.storageRoot, 'session-lifecycle-audit.jsonl');
  await fs.promises.mkdir(path.dirname(auditPath), { recursive: true });
  await fs.promises.appendFile(auditPath, JSON.stringify({ at: new Date().toISOString(), ...row }) + '\n');
}

function authorize(key: unknown): { status: number; code: string; message: string } | null {
  if (!config.sessionLifecycleKey) {
    return { status: 403, code: 'SESSION_LIFECYCLE_DISABLED', message: 'Set BLUR_GATEWAY_SESSION_LIFECYCLE_KEY to enable session lifecycle operations.' };
  }
  if (typeof key !== 'string' || !safeEqual(key, config.sessionLifecycleKey)) {
    return { status: 403, code: 'SESSION_LIFECYCLE_FORBIDDEN', message: 'Invalid session lifecycle capability key.' };
  }
  return null;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function parseAction(action: unknown): LifecycleAction {
  if (action === undefined || action === null) return 'dry-run';
  if (action === 'dry-run' || action === 'archive' || action === 'hard-delete') return action;
  throw new Error('action must be one of dry-run, archive, hard-delete');
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function sanitizePathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, '_').slice(0, 120) || 'session';
}

function timestampPathPart(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}
