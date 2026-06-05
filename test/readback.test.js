const test = require('node:test');
const assert = require('node:assert/strict');

const {
  afterSince,
  latestTimestamp,
  normalizeMessage,
  normalizeReadbackMode,
  normalizeToolCall,
  normalizeToolResult,
} = require('../dist/providers/readback.js');

test('normalizes readback modes with text as the default', () => {
  assert.equal(normalizeReadbackMode('text'), 'text');
  assert.equal(normalizeReadbackMode('messages'), 'messages');
  assert.equal(normalizeReadbackMode('events'), 'events');
  assert.equal(normalizeReadbackMode('full'), 'text');
  assert.equal(normalizeReadbackMode(undefined), 'text');
});

test('normalizes user and assistant messages with stable metadata', () => {
  const message = normalizeMessage({
    provider: 'codex',
    providerSessionId: 'codex_session',
    responseId: 'codex_response',
    role: 'assistant',
    text: 'Done.',
    timestamp: '2026-06-05T12:00:00.000Z',
    nativeType: 'response_item',
    nativeId: 'native_1',
  });

  assert.equal(message.type, 'assistant_message');
  assert.equal(message.role, 'assistant');
  assert.equal(message.text, 'Done.');
  assert.equal(message.provider, 'codex');
  assert.equal(message.provider_session_id, 'codex_session');
  assert.equal(message.response_id, 'codex_response');
  assert.match(message.id, /^msg_/);
  assert.match(message.turn_id, /^turn_/);
});

test('drops empty ordinary messages', () => {
  assert.equal(normalizeMessage({
    provider: 'claude',
    role: 'assistant',
    text: '   ',
  }), null);
});

test('normalizes tool calls and JSON argument payloads', () => {
  const event = normalizeToolCall({
    provider: 'claude',
    providerSessionId: 'local_1',
    responseId: 'claude_response',
    timestamp: '2026-06-05T12:01:00.000Z',
    toolCallId: 'call_1',
    toolName: 'Bash',
    args: '{"command":"npm run check"}',
  });

  assert.equal(event.type, 'tool_call');
  assert.equal(event.role, 'tool');
  assert.equal(event.tool_call_id, 'call_1');
  assert.equal(event.tool_name, 'Bash');
  assert.deepEqual(event.arguments, { command: 'npm run check' });
  assert.match(event.id, /^evt_/);
});

test('normalizes tool results where providers expose them', () => {
  const event = normalizeToolResult({
    provider: 'claude',
    providerSessionId: 'local_1',
    responseId: 'claude_response',
    timestamp: '2026-06-05T12:02:00.000Z',
    toolCallId: 'call_1',
    toolName: 'Bash',
    resultText: 'ok',
  });

  assert.equal(event.type, 'tool_result');
  assert.equal(event.result_text, 'ok');
  assert.equal(event.text, 'ok');
  assert.equal(event.final, true);
});

test('high-water helpers use strict timestamp ordering', () => {
  const messages = [
    { timestamp: '2026-06-05T12:00:00.000Z' },
    { timestamp: '2026-06-05T12:02:00.000Z' },
    { timestamp: '2026-06-05T12:01:00.000Z' },
  ];
  assert.equal(latestTimestamp(messages), '2026-06-05T12:02:00.000Z');
  const since = Date.parse('2026-06-05T12:01:00.000Z');
  assert.equal(afterSince('2026-06-05T12:01:00.000Z', since), false);
  assert.equal(afterSince('2026-06-05T12:01:00.001Z', since), true);
});
