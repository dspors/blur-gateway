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

export function timestampAfterSinceOrFallback(input: {
  timestamp?: string | null;
  sinceMs: number;
  fallbackBaseMs: number;
  offset: number;
}): string | null {
  const ts = input.timestamp ? Date.parse(input.timestamp) : NaN;
  if (Number.isFinite(ts) && (!input.sinceMs || ts > input.sinceMs)) {
    return new Date(ts).toISOString();
  }

  const baseMs = Number.isFinite(input.fallbackBaseMs) && input.fallbackBaseMs > 0
    ? input.fallbackBaseMs
    : input.sinceMs;
  if (!Number.isFinite(baseMs) || baseMs <= 0) return null;

  const fallbackMs = baseMs + Math.max(0, input.offset) + 1;
  if (input.sinceMs && fallbackMs <= input.sinceMs) return null;
  return new Date(fallbackMs).toISOString();
}

function fallbackTurnId(timestamp: string | null | undefined): string | undefined {
  if (!timestamp) return undefined;
  return `turn_${crypto.createHash('sha256').update(timestamp).digest('hex').slice(0, 16)}`;
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

/**
 * Whether a poll can skip the provider's transcript readback entirely.
 *
 * True ONLY for a completed Claude CLI text-mode turn that already has its
 * authoritative output recorded: the CLI is synchronous, so its own result was
 * stored at send-time and there is nothing more to learn from the JSONL.
 *
 * Deliberately narrow — this is the desktop-safety contract. The claude-desktop
 * automation transport (provider 'claude' / 'claude-desktop') has NO synchronous
 * result; it completes via readLatest, so it must NEVER be skipped. Non-text
 * readback modes still read the transcript for the tool-call event stream.
 */
export function shouldSkipCliReadback(input: {
  provider: string;
  status: string;
  hasOutput: boolean;
  mode: ReadbackMode;
}): boolean {
  return input.provider === 'claude-cli'
    && input.status === 'completed'
    && input.hasOutput
    && input.mode === 'text';
}

/**
 * Context-window size (tokens) from a Claude CLI `--output-format json` result:
 * usage.cache_read_input_tokens — the same signal the JSONL working-history scan
 * uses — so a CLI turn reports its context size without a transcript read. null
 * when usage is absent or the field is not a positive number.
 */
export function cliContextTokensFromResult(parsed: Record<string, unknown> | null | undefined): number | null {
  const usage = parsed && typeof parsed.usage === 'object' ? parsed.usage as Record<string, unknown> : null;
  const read = usage && typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : null;
  return typeof read === 'number' && read > 0 ? read : null;
}
