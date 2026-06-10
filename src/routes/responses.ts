import crypto from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { config } from '../config';
import { db } from '../db/sqlite';
import { id } from '../utils/ids';
import { readJson, sendJson } from '../utils/http';
import { createWorkspace, attachFilesToWorkspace } from '../storage/files';
import { getProvider, resolveProviderModel } from '../providers';
import { eventId, normalizeReadbackMode } from '../providers/readback';
import type { BlurMessage, ReadbackMode } from '../types/provider';

type BlurCommandModule = {
  BLUR_COMMANDS: unknown[];
  ENVELOPE_CONTRACT: unknown;
  buildBlurEnvelope(command: string, result?: { payload?: unknown; error?: { code: string; message: string } }, meta?: Record<string, unknown>): unknown;
  runBlurCommand(args: { text: string; cliSessionId: string | null; host: string | null }): Promise<unknown>;
};
type BlurSpawnModule = {
  parseBlurSpawnArgs(text: string): { model?: string; title?: string; prompt?: string; error?: string };
};
type ClaudeSessionsModule = {
  listSessions(opts?: { limit?: number; provider?: string }): Array<{ sessionId: string; cliSessionId?: string | null; jsonlPath?: string | null }>;
};

const bridgeRequire = createRequire(path.join(config.bridgeRoot, 'package.json'));
let cachedBlurCommand: BlurCommandModule | null = null;
let cachedBlurSpawn: BlurSpawnModule | null = null;
let cachedClaudeSessions: ClaudeSessionsModule | null = null;

function getBlurCommand(): BlurCommandModule {
  return cachedBlurCommand ||= bridgeRequire('./lib/providers/claude/blur-command.js') as BlurCommandModule;
}

function getBlurSpawn(): BlurSpawnModule {
  return cachedBlurSpawn ||= bridgeRequire('./lib/providers/claude/spawn-flow.js') as BlurSpawnModule;
}

function getClaudeSessions(): ClaudeSessionsModule {
  return cachedClaudeSessions ||= bridgeRequire('./lib/core/sessions.js') as ClaudeSessionsModule;
}

export async function createResponse(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  const requestedModel = stringField(body.model);
  let model = requestedModel || 'codex-desktop';
  const explicitProvider = stringField(body.provider);
  const resolved = resolveProviderModel(model);
  const previousResponseId = stringField(body.previous_response_id);
  const previousHighWater = highWaterFromBody(body);
  let provider = explicitProvider ? getProvider(explicitProvider) : getProvider(resolved.provider);
  const explicitProviderModel = explicitProvider && model.toLowerCase().replace(/_/g, '-') !== explicitProvider.toLowerCase().replace(/_/g, '-')
    ? model
    : resolved.providerModel;
  let providerModel = providerModelFromBody(body, explicitProviderModel);
  // Capture whether the caller explicitly asked for a particular provider
  // (either via `model` or via `provider`), for the continuation-mismatch
  // guard below. When neither is set the caller accepts whatever the chain's
  // provider is, so no mismatch is possible.
  const requestedProvider = (requestedModel || explicitProvider) ? provider : null;
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
    const chainProvider = getProvider(chain.provider);
    // Continuation-mismatch guard: when the caller explicitly asked for a
    // provider that disagrees with the chain's provider (and this isn't a
    // /blur spawn, which legitimately re-providers), refuse with 409 rather
    // than silently routing to chainProvider — the caller's intent and the
    // request would be inconsistent.
    if (requestedProvider && requestedProvider.name !== chainProvider.name && !isBlurSpawn(normalizedInput)) {
      sendJson(res, 409, {
        error: {
          message: 'model provider conflicts with previous_response_id provider',
          code: 'MODEL_CONTINUATION_PROVIDER_MISMATCH',
          requested_model: requestedModel,
          requested_provider: requestedProvider.name,
          previous_response_id: previousResponseId,
          continuation_provider: chainProvider.name,
        },
      });
      return;
    }
    provider = chainProvider;
    model = requestedModel || chain.model || model;
    providerModel = providerModelFromBody(body, providerModelFromStoredModel(model));
    chain.model = model;
    if (isBlurSpawn(normalizedInput)) {
      const parsed = getBlurSpawn().parseBlurSpawnArgs(normalizedInput);
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
        providerModel: providerModelFromStoredModel(parsed.model || parentChain.model || model),
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
      providerModel,
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

/**
 * Adopt an EXISTING provider session (created outside the gateway — e.g. a
 * bridge-forked Claude desktop session `local_<uuid>`) as a gateway response
 * chain, so it can be driven via /v1/responses going forward WITHOUT creating a
 * new session. Powers the bridge→gateway Proceedings migration (tkt_6adf9de6 /
 * tkt_91eba62a): registers a chain bound to the existing `provider_session_id`
 * and mints a high-water mark at a caller-supplied timestamp — typically the
 * last turn already recorded in Blur, so subsequent readback delivers only newer
 * turns (catch-up). Does NOT dispatch a prompt.
 *
 * Body: { session_id, provider?='claude', model?, since_timestamp?, metadata? }
 * Returns: { id (responseId, use as previous_response_id), message_high_water_mark, … }
 */
export async function adoptResponse(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  const sessionId = stringField(body.session_id) || stringField(body.provider_session_id);
  if (!sessionId) {
    sendJson(res, 400, { error: { message: 'adopt requires session_id (the existing provider session id to bind)' } });
    return;
  }
  const providerName = stringField(body.provider) || 'claude';
  const provider = getProvider(providerName);
  const model = stringField(body.model) || providerName;
  const sinceTimestamp = stringField(body.since_timestamp) || stringField(body.timestamp) || new Date().toISOString();
  const now = new Date().toISOString();
  const responseId = id(provider.name);
  const workspaceDir = createWorkspace(responseId);
  const title = titleFromMetadata(body.metadata) || sessionId;
  // Bind the chain to the EXISTING session (provider_session_id set up-front).
  db.insertChain({
    id: responseId,
    provider: provider.name,
    model,
    title,
    workspaceDir,
    providerSessionId: sessionId,
    providerSessionTitle: title,
    archived: false,
    createdAt: now,
    updatedAt: now,
  });
  // Register a completed response so responseId is a valid previous_response_id.
  db.upsertResponse({
    id: responseId,
    chainId: responseId,
    previousResponseId: null,
    status: 'completed',
    input: { adopt: true, session_id: sessionId, since_timestamp: sinceTimestamp },
    outputText: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  });
  const mark = encodeHighWaterMark({ provider: provider.name, sessionId, timestamp: sinceTimestamp });
  const ctx = (req as any).blurGateway as Record<string, unknown> | undefined;
  if (ctx) { ctx.responseId = responseId; ctx.provider = provider.name; }
  sendJson(res, 200, {
    id: responseId,
    object: 'response',
    status: 'completed',
    model,
    adopted_session_id: sessionId,
    message_high_water_mark: mark,
    metadata: { message_high_water_mark: mark },
  });
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
  // The client advances the high-water mark on each poll (sent as the
  // `high_water_mark` query param) so the readback PAGES FORWARD through a
  // backlog; fall back to the create-time stored mark on the first poll. Reading
  // only the stored mark (the old behavior) re-read the same window every poll →
  // the loop could never drain a >window backlog.
  const storedMark = storedInput && typeof storedInput === 'object' && !Array.isArray(storedInput)
    ? highWaterFromBody(storedInput as Record<string, unknown>)
    : null;
  const urlHighWater = highWaterFromUrl(requestUrl);
  const fullHistory = fullHistoryFromUrl(requestUrl);
  const priorHighWater = urlHighWater ?? (fullHistory ? null : storedMark);
  let highWaterMark = priorHighWater?.mark || null;
  let contextBytes: number | null = null;
  if (row.provider_session_id) {
    try {
      const input = storedInput;
      const prompt = input && typeof input === 'object' && !Array.isArray(input)
        ? inputToText((input as Record<string, unknown>).input)
        : undefined;
      const sinceIso = fullHistory && !priorHighWater ? undefined : priorHighWater?.timestamp || row.created_at;
      let latest = await getProvider(row.provider).readLatest?.(row.provider_session_id, sinceIso, prompt, {
        mode: readbackMode,
        responseId: row.id,
        responseCreatedAtIso: row.created_at,
        maxMessages: fullHistory ? 1000 : 200,
      });
      if (urlHighWater && row.status === 'in_progress' && !latest?.outputText && !latest?.messages?.length) {
        latest = await getProvider(row.provider).readLatest?.(row.provider_session_id, storedMark?.timestamp || row.created_at, prompt, {
          mode: readbackMode,
          responseId: row.id,
          responseCreatedAtIso: row.created_at,
          maxMessages: 200,
        });
      }
      if (latest?.outputText) outputText = latest.outputText;
      if (latest?.messages?.length) blurMessages = latest.messages;
      if (latest?.contextBytes != null) contextBytes = latest.contextBytes;
      if (latest?.highWaterIso) highWaterMark = encodeHighWaterMark({
        provider: row.provider,
        sessionId: row.provider_session_id,
        timestamp: latest.highWaterIso,
      });
      // Complete only when the reply to THIS turn has landed — i.e. the readback
      // has reached a turn at/after this response's created_at. A catch-up
      // assistant turn (older than created_at) no longer trips completion, so the
      // loop keeps paging until the real reply arrives.
      const repliedToThisTurn = latest?.highWaterIso
        ? Date.parse(latest.highWaterIso) >= Date.parse(row.created_at)
        : false;
      // Authoritative turn-end gate (tkt_57ef4311). Providers that surface a
      // `resolved` signal (Claude: bridge readSessionHealth.resolved derived
      // from JSONL stop_reason; codex: future task_complete plumbing) MUST be
      // resolved !== false before we mark this response completed. This is
      // belt-and-suspenders with the Claude provider's own outputText
      // suppression while unresolved — that masks the symptom; this exposes
      // the signal for any consumer (including codex when it gets equivalent
      // plumbing). Providers that don't surface `resolved` (undefined/null)
      // fall through unchanged. See bridge/docs/claude-turn-end-signal.md.
      const turnResolved = latest?.resolved !== false;
      if (status !== 'completed' && /^Processing/i.test(latest?.status || '')) status = 'in_progress';
      else if (latest?.outputText && status === 'in_progress' && repliedToThisTurn && turnResolved) status = 'completed';
      if (status === 'completed' && latest?.outputText && row.status !== 'completed') {
        db.updateResponse(row.id, { status: 'completed', outputText: latest.outputText });
      }
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
    contextBytes,
    chain: {
      id: row.chain_id,
      provider: row.provider,
      model: row.model,
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
      const parsed = getBlurSpawn().parseBlurSpawnArgs(opts.prompt);
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
      const blurCommand = getBlurCommand();
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
      db.updateChainSession(
        opts.chain.id,
        opts.chain.provider_session_id || opts.chain.providerSessionId,
        newTitle,
      );
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
        providerModel: opts.chain.providerModel || providerModelFromStoredModel(opts.chain.model),
      });
      db.updateChainSession(opts.chain.id, session.providerSessionId, session.providerSessionTitle);
    } else {
      await provider.send(sendInput(opts));
    }

    db.updateChainInputState(opts.chain.id, opts.inputState);
    // The injection (send) is done, but the assistant has NOT replied yet. Leave
    // the RESPONSE in_progress so the poll path (getResponse) completes it only
    // when the reply to THIS turn lands (readback reaches a turn at/after
    // created_at) — not on send. The automation METRIC still records success.
    db.updateResponse(opts.responseId, {
      status: 'in_progress',
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
    providerModel: opts.chain.providerModel || providerModelFromStoredModel(opts.chain.model),
  };
}

function responseObject(opts: { id: string; status: string; model: string; outputText?: string | null; error?: string | null; chain: any; highWaterMark?: string | null; blurMessages?: BlurMessage[]; contextBytes?: number | null }) {
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
      model: opts.model,
      provider_session_id: opts.chain.providerSessionId || opts.chain.provider_session_id || null,
      provider_session_title: opts.chain.providerSessionTitle || opts.chain.provider_session_title || opts.chain.title,
      provider_model: opts.chain.providerModel || providerModelFromStoredModel(opts.chain.model),
      desktop_title: opts.chain.providerSessionTitle || opts.chain.provider_session_title || opts.chain.title,
      workspace_dir: opts.chain.workspaceDir || opts.chain.workspace_dir,
      message_high_water_mark: opts.highWaterMark || null,
      context_bytes: opts.contextBytes ?? null,
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

/**
 * Read the high-water mark from the request URL query (the client sends its
 * advancing cursor on each poll so the readback pages forward). Checks the
 * common param spellings.
 */
function highWaterFromUrl(url: URL | null): HighWaterMark | null {
  if (!url) return null;
  const mark = url.searchParams.get('high_water_mark')
    || url.searchParams.get('previous_response_high_water_mark')
    || url.searchParams.get('message_high_water_mark')
    || undefined;
  return decodeHighWaterMark(mark || undefined);
}

function fullHistoryFromUrl(url: URL | null): boolean {
  if (!url) return false;
  const value = url.searchParams.get('full_history') || url.searchParams.get('history');
  return value === 'true' || value === '1' || value === 'full';
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
  const parsed = getBlurSpawn().parseBlurSpawnArgs(normalizeInput(prompt));
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

function providerModelFromBody(body: Record<string, unknown> | null | undefined, fallback?: string | null): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fallback || null;
  const providerOptions = body.provider_options && typeof body.provider_options === 'object' && !Array.isArray(body.provider_options)
    ? body.provider_options as Record<string, unknown>
    : null;
  const metadata = body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
    ? body.metadata as Record<string, unknown>
    : null;
  return stringField(providerOptions?.model)
    || stringField(providerOptions?.provider_model)
    || stringField(metadata?.provider_model)
    || fallback
    || null;
}

function providerModelFromStoredModel(model: unknown): string | null {
  return resolveProviderModel(typeof model === 'string' ? model : undefined).providerModel;
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
  return getBlurCommand().buildBlurEnvelope(command, { payload }, {
    startedAtMs: Date.now(),
    host: 'blur-gateway',
  });
}

async function runTaskCommand(opts: { chain: any; prompt: string }): Promise<unknown> {
  if (opts.chain.provider !== 'claude' && opts.chain.provider !== 'claude-desktop' && opts.chain.provider !== 'claude-cli') {
    return getBlurCommand().buildBlurEnvelope('blur.Task', {
      error: { code: 'unsupported_provider', message: 'Task commands are currently supported for Claude sessions only' },
    }, { host: 'blur-gateway' });
  }
  const providerSessionId = opts.chain.provider_session_id || opts.chain.providerSessionId;
  const session = getClaudeSessions().listSessions({ limit: 1000, provider: 'claude' }).find(s => s.sessionId === providerSessionId);
  const cliSessionId = session?.cliSessionId || (session?.jsonlPath ? path.basename(session.jsonlPath, '.jsonl') : null);
  return getBlurCommand().runBlurCommand({
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
