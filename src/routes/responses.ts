import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { db } from '../db/sqlite';
import { id } from '../utils/ids';
import { readJson, sendJson } from '../utils/http';
import { createWorkspace, attachFilesToWorkspace } from '../storage/files';
import { getProvider, providerFromModel } from '../providers';

export async function createResponse(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  const model = stringField(body.model) || 'codex-desktop';
  const previousResponseId = stringField(body.previous_response_id);
  const provider = providerFromModel(model);
  let responseId: string;
  const now = new Date().toISOString();
  const prompt = inputToText(body.input);
  const fileIds = extractFileIds(body);

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
  const effectivePrompt = attached.length ? `${prompt}\n\nAttached files are available in:\n${attached.map(p => `- ${p}`).join('\n')}` : prompt;

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
  }).catch(err => {
    db.updateResponse(responseId, { status: 'failed', error: err.message || String(err) });
  });

  sendJson(res, 200, responseObject({
    id: responseId,
    status: 'in_progress',
    model,
    outputText: null,
    chain,
  }));
}

export async function getResponse(_req: IncomingMessage, res: ServerResponse, responseId: string): Promise<void> {
  const row = db.getResponse(responseId);
  if (!row) {
    sendJson(res, 404, { error: { message: `Unknown response: ${responseId}` } });
    return;
  }
  let outputText = row.output_text;
  let status = row.status;
  if (row.provider_session_id) {
    try {
      const input = safeJson(row.input_json);
      const prompt = input && typeof input === 'object' && !Array.isArray(input)
        ? inputToText((input as Record<string, unknown>).input)
        : undefined;
      const latest = await getProvider(row.provider).readLatest?.(row.provider_session_id, row.created_at, prompt);
      if (latest?.outputText) outputText = latest.outputText;
      if (/^Processing/i.test(latest?.status || '')) status = 'in_progress';
      else if (latest?.outputText && status === 'in_progress') status = 'completed';
    } catch {
      // Keep stored response state when provider readback is unavailable.
    }
  }
  sendJson(res, 200, responseObject({
    id: row.id,
    status,
    model: row.model,
    outputText,
    error: row.error,
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

async function runResponse(opts: { responseId: string; chain: any; prompt: string; isNewChain: boolean }): Promise<void> {
  const provider = getProvider(opts.chain.provider);

  if (opts.prompt.startsWith('/blur.archive')) {
    if (provider.archive) {
      await provider.archive(sendInput(opts));
    }
    db.archiveChain(opts.chain.id);
    db.updateResponse(opts.responseId, { status: 'completed', outputText: 'Archived.' });
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

  db.updateResponse(opts.responseId, {
    status: 'completed',
    outputText: null,
  });
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

function responseObject(opts: { id: string; status: string; model: string; outputText?: string | null; error?: string | null; chain: any }) {
  const output = opts.outputText ? [{
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text: opts.outputText }],
  }] : [];
  return {
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
    },
  };
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
