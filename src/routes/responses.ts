import crypto from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { config } from '../config';
import { db } from '../db/sqlite';
import { id } from '../utils/ids';
import { readJson, sendJson } from '../utils/http';
import { createWorkspace, attachFilesToWorkspace } from '../storage/files';
import { getProvider, providerFromModel } from '../providers';
import { eventId, normalizeReadbackMode } from '../providers/readback';
import type { BlurMessage, ReadbackMode } from '../types/provider';

const bridgeRequire = createRequire(path.join(config.bridgeRoot, 'package.json'));
const blurCommand = bridgeRequire('./lib/providers/claude/blur-command.js') as {
  BLUR_COMMANDS: unknown[];
  ENVELOPE_CONTRACT: unknown;
  buildBlurEnvelope(command: string, result?: { payload?: unknown; error?: { code: string; message: string } }, meta?: Record<string, unknown>): unknown;
  runBlurCommand(args: { text: string; cliSessionId: string | null; host: string | null }): Promise<unknown>;
};
const blurSpawn = bridgeRequire('./lib/providers/claude/spawn-flow.js') as {
  parseBlurSpawnArgs(text: string): { model?: string; title?: string; prompt?: string; error?: string };
};
const claudeSessions = bridgeRequire('./lib/core/sessions.js') as {
  listSessions(opts?: { limit?: number; provider?: string }): Array<{ sessionId: string; cliSessionId?: string | null; jsonlPath?: string | null }>;
};

export async function createResponse(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  let model = stringField(body.model) || 'codex-desktop';
  const previousResponseId = stringField(body.previous_response_id);
  const previousHighWater = highWaterFromBody(body);
  let provider = providerFromModel(model);
  const requestContext = (req as any).blurGateway as Record<string, unknown> | undefined;
  if (requestContext) requestContext.provider = provider.name;
  let responseId: string;
  const now = new Date().toISOString();
  const prompt = inputToText(body.input);
  const fileIds = extractFileIds(body);
  const normalizedInput = normalizeInput(prompt);

  if (!prompt.trim()) {
    sendJson(res, 400, { error: { message: 'Missing input text' } });
    return;
  }

  let chain: any;
  let isNewChain = false;
  if (previousResponseId) {
    const previous = db.getResponse(previousResponseId);
    if (!previous) {
      sendJson(res, 404, { error: { message: `Unknown previous_response_id: ${previousResponseId}` } });
      return;
    }
    responseId = previous.id;
    chain = db.getChain(previous.chain_id);
    if (!chain) {
      sendJson(res, 500, { error: { message: `Response chain missing for ${previousResponseId}` } });
      return;
    }
    provider = getProvider(chain.provider);
    model = stringField(body.model) || chain.model || model;
    if (isBlurSpawn(normalizedInput)) {
      const parsed = blurSpawn.parseBlurSpawnArgs(normalizedInput);
      if (parsed.error) {
        sendJson(res, 400, { error: { message: parsed.error } });
        return;
      }
      const parentChain = chain;
      responseId = id(provider.name);
      const workspaceDir = createWorkspace(responseId);
      const title = parsed.title || titleFromMetadata(body.metadata) || responseId;
      chain = {
        id: responseId,
        provider: parentChain.provider,
        model: parsed.model || parentChain.model || model,
        title,
        workspaceDir,
        providerSessionId: null,
        providerSessionTitle: title,
        archived: false,
        createdAt: now,
        updatedAt: now,
        spawnParent: parentChain,
      };
      db.insertChain(chain);
      isNewChain = true;
    }
  } else {
    responseId = id(provider.name);
    const workspaceDir = createWorkspace(responseId);
    const title = titleFromMetadata(body.metadata) || responseId;
    chain = {
      id: responseId,
      provider: provider.name,
      model,
      title,
      workspaceDir,
      providerSessionId: null,
      providerSessionTitle: title,
      archived: false,
      createdAt: now,
      updatedAt: now,
    };
    db.insertChain(chain);
    isNewChain = true;
  }

  const attached = attachFilesToWorkspace(responseId, fileIds, chain.workspace_dir || chain.workspaceDir);
  if (requestContext) {
    requestContext.responseId = responseId;
    requestContext.provider = chain.provider;
  }
  const delta = computeInjectionDelta(chain, normalizedInput, isNewChain);
  const effectivePromptBase = delta.injectedText || prompt;
  const effectivePrompt = attached.length
    ? `${effectivePromptBase}\n\nAttached files are available in:\n${attached.map(p => `- ${p}`).join('\n')}`
    : effectivePromptBase;
  const inputState = {
    text: normalizedInput,
    len: normalizedInput.length,
    hash: hashInput(normalizedInput),
  };

  db.upsertResponse({
    id: responseId,
    chainId: chain.id,
    previousResponseId,
    status: 'in_progress',
    input: body,
    outputText: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  });

  runResponse({
    responseId,
    chain,
    prompt: effectivePrompt,
    isNewChain,
    inputState,
    previousHighWaterIso: previousHighWater?.timestamp || null,
    metric: {
      id: id('metric'),
      provider: chain.provider,
      startedAt: now,
      isNewSession: isNewChain,
      hadPreviousResponseId: Boolean(previousResponseId),
      inputChars: normalizedInput.length,
      injectedChars: effectivePrompt.length,
      deltaStripped: delta.stripped,
      fileCount: fileIds.length,
    },
  }).catch(err => {
    db.updateResponse(responseId, { status: 'failed', error: err.message || String(err) });
  });

  sendJson(res, 200, responseObject({
    id: responseId,
    status: 'in_progress',
    model,
    outputText: null,
    chain,
    highWaterMark: previousHighWater?.mark || null,
  }));
}

export async function getResponse(_req: IncomingMessage, res: ServerResponse, responseId: string): Promise<void> {
  const row = db.getResponse(responseId);
  if (!row) {
    sendJson(res, 404, { error: { message: `Unknown response: ${responseId}` } });
    return;
  }
  const requestContext = (_req as any).blurGateway as Record<string, unknown> | undefined;
  if (requestContext) {
    requestContext.responseId = row.id;
    requestContext.provider = row.provider;
  }
  let outputText = row.output_text;
  let status = row.status;
  const storedInput = safeJson(row.input_json);
  const requestUrl = requestUrlFromIncoming(_req);
  const readbackMode = readbackModeFromBody(storedInput as Record<string, unknown> | null, requestUrl);
  const includeSubagents = includeSubagentsFromBody(storedInput as Record<string, unknown> | null, requestUrl);
  const inputPrompt = storedInput && typeof storedInput === 'object' && !Array.isArray(storedInput)
    ? inputToText((storedInput as Record<string, unknown>).input)
    : '';
  const spawnEvent = readbackMode === 'events' && isBlurSpawn(normalizeInput(inputPrompt))
    ? subagentSpawnEvent(row, storedInput as Record<string, unknown> | null)
    : null;
  let blurMessages: BlurMessage[] | undefined;
  let highWaterMark = highWaterFromBody(safeJson(row.input_json) as Record<string, unknown> | null)?.mark || null;
  if (row.provider_session_id) {
    try {
      const input = storedInput;
      const priorHighWater = input && typeof input === 'object' && !Array.isArray(input)
        ? highWaterFromBody(input as Record<string, unknown>)
        : null;
      const prompt = input && typeof input === 'object' && !Array.isArray(input)
        ? inputToText((input as Record<string, unknown>).input)
        : undefined;
      const latest = await getProvider(row.provider).readLatest?.(row.provider_session_id, priorHighWater?.timestamp || row.created_at, prompt, {
        mode: readbackMode,
        responseId: row.id,
        responseCreatedAtIso: row.created_at,
      });
      if (latest?.outputText) outputText = latest.outputText;
      if (latest?.messages?.length) blurMessages = latest.messages;
      if (latest?.highWaterIso) highWaterMark = encodeHighWaterMark({
        provider: row.provider,
        sessionId: row.provider_session_id,
        timestamp: latest.highWaterIso,
      });
      if (/^Processing/i.test(latest?.status || '')) status = 'in_progress';
      else if (latest?.outputText && status === 'in_progress') status = 'completed';
    } catch {
      // Keep stored response state when provider readback is unavailable.
    }
  }
  if (readbackMode === 'events') {
    const events = blurMessages ? [...blurMessages] : [];
    if (spawnEvent) {
      blurMessages = includeSubagents ? [spawnEvent, ...events] : [spawnEvent];
    } else {
      blurMessages = events;
    }
    blurMessages.push(statusUpdateEvent(row, status));
  }
  sendJson(res, 200, responseObject({
    id: row.id,
    status,
    model: row.model,
    outputText,
    error: row.error,
    highWaterMark,
    blurMessages,
    chain: {
      id: row.chain_id,
      provider: row.provider,
      title: row.title,
      workspaceDir: row.workspace_dir,
      providerSessionId: row.provider_session_id,
      providerSessionTitle: row.provider_session_title,
    },
  }));
}

async function runResponse(opts: { responseId: string; chain: any; prompt: string; isNewChain: boolean; inputState: { text: string; len: number; hash: string }; previousHighWaterIso?: string | null; metric: any }): Promise<void> {
  const provider = getProvider(opts.chain.provider);
  const startMs = Date.now();
  db.insertResponseMetric({
    id: opts.metric.id,
    responseId: opts.responseId,
    provider: opts.metric.provider,
    startedAt: opts.metric.startedAt,
    isNewSession: opts.metric.isNewSession,
    hadPreviousResponseId: opts.metric.hadPreviousResponseId,
    inputChars: opts.metric.inputChars,
    injectedChars: opts.metric.injectedChars,
    deltaStripped: opts.metric.deltaStripped,
    fileCount: opts.metric.fileCount,
    automationStatus: 'started',
  });

  try {
    if (opts.prompt.startsWith('/blur.spawn')) {
      const parsed = blurSpawn.parseBlurSpawnArgs(opts.prompt);
      if (parsed.error) throw new Error(parsed.error);
      const parent = opts.chain.spawnParent;
      if (!parent) throw new Error('/blur.spawn requires previous_response_id so the parent session is known');
      if (!provider.spawn) throw new Error(`${provider.name} does not support /blur.spawn`);
      const session = await provider.spawn({
        parentSessionId: parent.provider_session_id || parent.providerSessionId,
        parentSessionTitle: parent.provider_session_title || parent.providerSessionTitle || parent.title,
        responseId: opts.responseId,
        title: parsed.title || opts.chain.title,
        model: parsed.model || opts.chain.model,
        prompt: parsed.prompt || null,
      });
      db.updateChainSession(opts.chain.id, session.providerSessionId, session.providerSessionTitle);
      db.updateChainInputState(opts.chain.id, opts.inputState);
      db.updateResponse(opts.responseId, {
        status: 'completed',
        outputText: parsed.prompt ? null : JSON.stringify(buildEnvelope('blur.spawn', {
          success: true,
          sessionId: session.providerSessionId,
          title: session.providerSessionTitle,
          model: parsed.model || null,
          forkedFrom: session.forkedFrom || null,
          steps: session.steps || [],
          elapsedMs: session.elapsedMs || null,
        })),
      });
      db.updateResponseMetric(opts.metric.id, {
        completedAt: new Date().toISOString(),
        automationStatus: 'completed',
        automationDurationMs: Date.now() - startMs,
        finalStatus: 'completed',
      });
      return;
    }

    if (opts.prompt.startsWith('/blur.help') || opts.prompt.startsWith('/blur.describe')) {
      db.updateResponse(opts.responseId, { status: 'completed', outputText: JSON.stringify(buildEnvelope('blur.help', { envelope: blurCommand.ENVELOPE_CONTRACT, commands: blurCommand.BLUR_COMMANDS }), null, 2) });
      db.updateResponseMetric(opts.metric.id, {
        completedAt: new Date().toISOString(),
        automationStatus: 'completed',
        automationDurationMs: Date.now() - startMs,
        finalStatus: 'completed',
      });
      return;
    }

    if (opts.prompt.startsWith('/blur.archive') || opts.prompt.startsWith('/blur.unarchive')) {
      const archive = opts.prompt.startsWith('/blur.archive');
      if (archive) {
        if (provider.archive) await provider.archive(sendInput(opts));
        db.archiveChain(opts.chain.id);
      } else {
        if (provider.unarchive) await provider.unarchive(sendInput(opts));
        db.unarchiveChain(opts.chain.id);
      }
      db.updateResponse(opts.responseId, { status: 'completed', outputText: archive ? 'Archived.' : 'Unarchived.' });
      db.updateResponseMetric(opts.metric.id, {
        completedAt: new Date().toISOString(),
        automationStatus: 'completed',
        automationDurationMs: Date.now() - startMs,
        finalStatus: 'completed',
      });
      return;
    }

    if (opts.prompt.startsWith('/blur.Task')) {
      const envelope = await runTaskCommand(opts);
      db.updateResponse(opts.responseId, { status: 'completed', outputText: JSON.stringify(envelope, null, 2) });
      db.updateResponseMetric(opts.metric.id, {
        completedAt: new Date().toISOString(),
        automationStatus: 'completed',
        automationDurationMs: Date.now() - startMs,
        finalStatus: 'completed',
      });
      return;
    }

    if (opts.prompt.startsWith('/blur.prompt')) {
      opts.prompt = opts.prompt.replace(/^\s*\/blur\.prompt\s?/, '');
    }

    if (opts.prompt.startsWith('/blur.archive')) {
      if (provider.archive) {
        await provider.archive(sendInput(opts));
      }
      db.archiveChain(opts.chain.id);
      db.updateResponse(opts.responseId, { status: 'completed', outputText: 'Archived.' });
      db.updateResponseMetric(opts.metric.id, {
        completedAt: new Date().toISOString(),
        automationStatus: 'completed',
        automationDurationMs: Date.now() - startMs,
        finalStatus: 'completed',
      });
      return;
    }

    if (opts.prompt.startsWith('/blur.rename ')) {
      const newTitle = opts.prompt.slice('/blur.rename '.length).trim();
      if (!newTitle) throw new Error('Missing title for /blur.rename');
      if (provider.rename) {
        await provider.rename(sendInput(opts), newTitle);
      } else {
        await provider.send({ ...sendInput(opts), prompt: opts.prompt });
      }
      db.updateResponse(opts.responseId, { status: 'completed', outputText: `Renamed to ${newTitle}.` });
      db.updateResponseMetric(opts.metric.id, {
        completedAt: new Date().toISOString(),
        automationStatus: 'completed',
        automationDurationMs: Date.now() - startMs,
        finalStatus: 'completed',
      });
      return;
    }

    if (opts.isNewChain) {
      const session = await provider.createPreparedSession({
        chainId: opts.chain.id,
        responseId: opts.responseId,
        title: opts.chain.title,
        workspaceDir: opts.chain.workspaceDir,
        prompt: opts.prompt,
      });
      db.updateChainSession(opts.chain.id, session.providerSessionId, session.providerSessionTitle);
    } else {
      await provider.send(sendInput(opts));
    }

    db.updateChainInputState(opts.chain.id, opts.inputState);
    db.updateResponse(opts.responseId, {
      status: 'completed',
      outputText: null,
    });
    db.updateResponseMetric(opts.metric.id, {
      completedAt: new Date().toISOString(),
      automationStatus: 'completed',
      automationDurationMs: Date.now() - startMs,
      finalStatus: 'completed',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    db.updateResponseMetric(opts.metric.id, {
      completedAt: new Date().toISOString(),
      automationStatus: 'failed',
      automationDurationMs: Date.now() - startMs,
      finalStatus: 'failed',
      error: message,
    });
    throw err;
  }
}

function sendInput(opts: { responseId: string; chain: any; prompt: string }) {
  return {
    chainId: opts.chain.id,
    responseId: opts.responseId,
    providerSessionId: opts.chain.provider_session_id || opts.chain.providerSessionId,
    providerSessionTitle: opts.chain.provider_session_title || opts.chain.providerSessionTitle || opts.chain.title,
    workspaceDir: opts.chain.workspace_dir || opts.chain.workspaceDir,
    prompt: opts.prompt,
  };
}

function responseObject(opts: { id: string; status: string; model: string; outputText?: string | null; error?: string | null; chain: any; highWaterMark?: string | null; blurMessages?: BlurMessage[] }) {
  const output = opts.outputText ? [{
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text: opts.outputText }],
  }] : [];
  const response: Record<string, unknown> = {
    id: opts.id,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: opts.status,
    model: opts.model,
    output,
    output_text: opts.outputText || '',
    error: opts.error ? { message: opts.error } : null,
    metadata: {
      chain_id: opts.chain.id,
      provider: opts.chain.provider,
      desktop_title: opts.chain.providerSessionTitle || opts.chain.provider_session_title || opts.chain.title,
      workspace_dir: opts.chain.workspaceDir || opts.chain.workspace_dir,
      message_high_water_mark: opts.highWaterMark || null,
    },
  };
  if (opts.blurMessages) response.blur_messages = opts.blurMessages;
  return response;
}

type HighWaterMark = {
  provider?: string;
  sessionId?: string;
  timestamp: string;
  mark: string;
};

function highWaterFromBody(body: Record<string, unknown> | null | undefined): HighWaterMark | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const direct = stringField(body.previous_response_high_water_mark)
    || stringField(body.message_high_water_mark)
    || stringField(body.high_water_mark);
  const metadata = body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
    ? body.metadata as Record<string, unknown>
    : null;
  const nested = metadata
    ? stringField(metadata.previous_response_high_water_mark)
      || stringField(metadata.message_high_water_mark)
      || stringField(metadata.high_water_mark)
    : undefined;
  return decodeHighWaterMark(direct || nested);
}

function readbackModeFromBody(body: Record<string, unknown> | null | undefined, url?: URL | null): ReadbackMode {
  const queryReadback = url?.searchParams.get('readback');
  if (queryReadback) return normalizeReadbackMode(queryReadback);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'text';
  const metadata = body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
    ? body.metadata as Record<string, unknown>
    : null;
  return normalizeReadbackMode(metadata?.readback || body.readback);
}

function includeSubagentsFromBody(body: Record<string, unknown> | null | undefined, url?: URL | null): boolean {
  const queryValue = url?.searchParams.get('include_subagents');
  if (typeof queryValue === 'string') return queryValue === 'true' || queryValue === '1';
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const metadata = body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
    ? body.metadata as Record<string, unknown>
    : null;
  return Boolean(metadata?.include_subagents ?? body.include_subagents);
}

function requestUrlFromIncoming(req: IncomingMessage): URL | null {
  try {
    return new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  } catch {
    return null;
  }
}

function subagentSpawnEvent(row: any, input: Record<string, unknown> | null): BlurMessage {
  const prompt = input && typeof input === 'object' ? inputToText(input.input) : '';
  const parsed = blurSpawn.parseBlurSpawnArgs(normalizeInput(prompt));
  const timestamp = row.updated_at || row.created_at || new Date().toISOString();
  return {
    id: eventId([row.provider, row.id, row.provider_session_id, timestamp, 'subagent_spawn']),
    type: 'subagent_spawn',
    role: 'system',
    text: parsed.title ? `Spawned ${parsed.title}` : 'Spawned subagent session',
    timestamp,
    turn_id: `turn_${row.id}`,
    provider: row.provider,
    provider_session_id: row.provider_session_id || null,
    response_id: row.id,
    native_type: 'blur.spawn',
    native_id: row.id,
    parent_response_id: row.previous_response_id || null,
    subagent_response_id: row.id,
    title: parsed.title || row.provider_session_title || row.title || null,
    revision: 1,
    final: row.status !== 'in_progress',
  };
}

function statusUpdateEvent(row: any, status: string): BlurMessage {
  const timestamp = row.updated_at || row.created_at || new Date().toISOString();
  return {
    id: eventId([row.provider, row.id, row.provider_session_id, timestamp, status, 'status_update']),
    type: 'status_update',
    role: 'system',
    text: `${row.provider} response ${status}`,
    timestamp,
    turn_id: `turn_${row.id}`,
    provider: row.provider,
    provider_session_id: row.provider_session_id || null,
    response_id: row.id,
    native_type: 'blur-gateway:response_status',
    native_id: row.id,
    status,
    revision: 1,
    final: status !== 'in_progress',
  };
}

function encodeHighWaterMark(input: { provider?: string; sessionId?: string; timestamp: string }): string {
  return Buffer.from(JSON.stringify({
    v: 1,
    provider: input.provider || null,
    session_id: input.sessionId || null,
    ts: input.timestamp,
  }), 'utf8').toString('base64url');
}

function decodeHighWaterMark(mark: string | undefined): HighWaterMark | null {
  if (!mark) return null;
  try {
    const parsed = JSON.parse(Buffer.from(mark, 'base64url').toString('utf8')) as Record<string, unknown>;
    const timestamp = stringField(parsed.ts) || stringField(parsed.timestamp);
    if (!timestamp || Number.isNaN(Date.parse(timestamp))) return null;
    return {
      provider: stringField(parsed.provider),
      sessionId: stringField(parsed.session_id) || stringField(parsed.sessionId),
      timestamp,
      mark,
    };
  } catch {
    return null;
  }
}

function inputToText(input: unknown): string {
  if (typeof input === 'string') return input;
  if (Array.isArray(input)) {
    return input.map(item => {
      if (typeof item === 'string') return item;
      if (!item || typeof item !== 'object') return '';
      const record = item as Record<string, unknown>;
      if (typeof record.content === 'string') return record.content;
      if (Array.isArray(record.content)) {
        return record.content.map(part => {
          if (!part || typeof part !== 'object') return '';
          const p = part as Record<string, unknown>;
          return typeof p.text === 'string' ? p.text : '';
        }).filter(Boolean).join('\n');
      }
      return '';
    }).filter(Boolean).join('\n');
  }
  return '';
}

function extractFileIds(body: Record<string, unknown>): string[] {
  const ids = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === 'string' && value.startsWith('file_')) ids.add(value);
  };
  const explicit = body.file_ids;
  if (Array.isArray(explicit)) explicit.forEach(add);
  const input = body.input;
  const walk = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    const record = value as Record<string, unknown>;
    add(record.file_id);
    Object.values(record).forEach(walk);
  };
  walk(input);
  return [...ids];
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function titleFromMetadata(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const record = metadata as Record<string, unknown>;
  return typeof record.title === 'string' && record.title.trim() ? record.title.trim() : null;
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isBlurSpawn(text: string): boolean {
  return /^\s*\/blur\.spawn\b/.test(text);
}

function buildEnvelope(command: string, payload: unknown): unknown {
  return blurCommand.buildBlurEnvelope(command, { payload }, {
    startedAtMs: Date.now(),
    host: 'blur-gateway',
  });
}

async function runTaskCommand(opts: { chain: any; prompt: string }): Promise<unknown> {
  if (opts.chain.provider !== 'claude') {
    return blurCommand.buildBlurEnvelope('blur.Task', {
      error: { code: 'unsupported_provider', message: 'Task commands are currently supported for Claude sessions only' },
    }, { host: 'blur-gateway' });
  }
  const providerSessionId = opts.chain.provider_session_id || opts.chain.providerSessionId;
  const session = claudeSessions.listSessions({ limit: 1000, provider: 'claude' }).find(s => s.sessionId === providerSessionId);
  const cliSessionId = session?.cliSessionId || (session?.jsonlPath ? path.basename(session.jsonlPath, '.jsonl') : null);
  return blurCommand.runBlurCommand({
    text: opts.prompt,
    cliSessionId,
    host: 'blur-gateway',
  });
}

function normalizeInput(text: string): string {
  return text.replace(/\r\n/g, '\n').trimEnd();
}

function hashInput(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function computeInjectionDelta(chain: any, normalizedInput: string, isNewChain: boolean): { injectedText: string; stripped: boolean } {
  if (isNewChain) return { injectedText: normalizedInput, stripped: false };
  const priorLen = Number(chain.last_input_len || 0);
  const priorHash = typeof chain.last_input_hash === 'string' ? chain.last_input_hash : '';
  if (!priorLen || !priorHash || normalizedInput.length < priorLen) {
    return { injectedText: normalizedInput, stripped: false };
  }
  const prefix = normalizedInput.slice(0, priorLen);
  if (hashInput(prefix) !== priorHash) {
    return { injectedText: normalizedInput, stripped: false };
  }
  const suffix = normalizedInput.slice(priorLen).trimStart();
  return { injectedText: suffix || normalizedInput, stripped: Boolean(suffix) };
}
