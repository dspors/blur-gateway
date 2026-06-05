import crypto from 'node:crypto';
import type { BlurMessage, ProviderName, ReadbackMode } from '../types/provider';

export function normalizeReadbackMode(value: unknown): ReadbackMode {
  return value === 'messages' || value === 'events' ? value : 'text';
}

export function messageId(parts: Array<string | null | undefined>): string {
  const hash = crypto.createHash('sha256')
    .update(parts.filter(Boolean).join('|'))
    .digest('hex')
    .slice(0, 24);
  return `msg_${hash}`;
}

export function eventId(parts: Array<string | null | undefined>): string {
  const hash = crypto.createHash('sha256')
    .update(parts.filter(Boolean).join('|'))
    .digest('hex')
    .slice(0, 24);
  return `evt_${hash}`;
}

export function normalizeMessage(input: {
  provider: ProviderName;
  providerSessionId?: string | null;
  responseId?: string;
  role: string;
  text?: string | null;
  timestamp?: string | null;
  nativeType?: string | null;
  nativeId?: string | null;
  turnId?: string | null;
}): BlurMessage | null {
  const role = input.role === 'assistant' ? 'assistant' : input.role === 'user' ? 'user' : input.role;
  if (role !== 'user' && role !== 'assistant') return null;
  const text = input.text || '';
  if (!text.trim()) return null;
  const type = role === 'user' ? 'user_message' : 'assistant_message';
  return {
    id: messageId([input.provider, input.providerSessionId, input.nativeId, input.timestamp, type, text]),
    type,
    role,
    text,
    timestamp: input.timestamp || undefined,
    turn_id: input.turnId || fallbackTurnId(input.timestamp),
    provider: input.provider,
    provider_session_id: input.providerSessionId || null,
    response_id: input.responseId,
    native_type: input.nativeType || undefined,
    native_id: input.nativeId || null,
    revision: 1,
    final: true,
  };
}

export function normalizeToolCall(input: {
  provider: ProviderName;
  providerSessionId?: string | null;
  responseId?: string;
  timestamp?: string | null;
  nativeType?: string | null;
  nativeId?: string | null;
  turnId?: string | null;
  toolCallId?: string | null;
  toolName?: string | null;
  args?: unknown;
  text?: string | null;
}): BlurMessage {
  return {
    id: eventId([input.provider, input.providerSessionId, input.nativeId, input.toolCallId, input.timestamp, 'tool_call']),
    type: 'tool_call',
    role: 'tool',
    text: input.text || undefined,
    timestamp: input.timestamp || undefined,
    turn_id: input.turnId || fallbackTurnId(input.timestamp),
    provider: input.provider,
    provider_session_id: input.providerSessionId || null,
    response_id: input.responseId,
    native_type: input.nativeType || undefined,
    native_id: input.nativeId || null,
    tool_call_id: input.toolCallId || null,
    tool_name: input.toolName || null,
    arguments: parseMaybeJson(input.args),
    revision: 1,
    final: true,
  };
}

export function normalizeToolResult(input: {
  provider: ProviderName;
  providerSessionId?: string | null;
  responseId?: string;
  timestamp?: string | null;
  nativeType?: string | null;
  nativeId?: string | null;
  turnId?: string | null;
  toolCallId?: string | null;
  toolName?: string | null;
  resultText?: string | null;
}): BlurMessage {
  return {
    id: eventId([input.provider, input.providerSessionId, input.nativeId, input.toolCallId, input.timestamp, 'tool_result']),
    type: 'tool_result',
    role: 'tool',
    text: input.resultText || undefined,
    timestamp: input.timestamp || undefined,
    turn_id: input.turnId || fallbackTurnId(input.timestamp),
    provider: input.provider,
    provider_session_id: input.providerSessionId || null,
    response_id: input.responseId,
    native_type: input.nativeType || undefined,
    native_id: input.nativeId || null,
    tool_call_id: input.toolCallId || null,
    tool_name: input.toolName || null,
    result_text: input.resultText || null,
    revision: 1,
    final: true,
  };
}

export function latestTimestamp(messages: BlurMessage[]): string | null {
  const timestamps = messages
    .map(message => message.timestamp)
    .filter((timestamp): timestamp is string => typeof timestamp === 'string' && Number.isFinite(Date.parse(timestamp)));
  if (!timestamps.length) return null;
  return timestamps.sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1) || null;
}

export function afterSince(timestamp: string | null | undefined, sinceMs: number): boolean {
  if (!sinceMs) return true;
  if (!timestamp) return false;
  const ts = Date.parse(timestamp);
  return Number.isFinite(ts) && ts > sinceMs;
}

function fallbackTurnId(timestamp: string | null | undefined): string | undefined {
  if (!timestamp) return undefined;
  return `turn_${crypto.createHash('sha256').update(timestamp).digest('hex').slice(0, 16)}`;
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}
