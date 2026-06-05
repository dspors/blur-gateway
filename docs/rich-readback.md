---
slug: blur-gateway-rich-readback
title: blur-gateway Rich Readback — Reference
aliases: [rich-readback, blur-messages, message-high-water-mark, response-events]
keywords: [blur-gateway, responses, readback, high-water, transcript, messages, events, tool-use, subagents, claude, codex]
summary: >
  Reference for blur-gateway readback modes. Defines the default text mode,
  opt-in message and event modes, high-water mark semantics, and the normalized
  reply/event conventions used to make Claude and Codex desktop transcripts
  comparable for clients.
type: reference
audience: [ai, human]
status: draft
tags: [blur-gateway, responses-api, readback, transcript, normalization]
related: [desktop-automation]
section: reference
---

# blur-gateway Rich Readback

`blur-gateway` defaults to a plain Responses-compatible shape. Rich transcript
data is opt-in so simple clients can treat the gateway like a text response
server, while workflow clients can ask for message or event data with timestamps,
turn ids, tool calls, status counters, and subagent lifecycle records.

## Request modes

Clients opt into richer readback through request metadata:

```json
{
  "model": "codex-desktop",
  "previous_response_id": "codex_abc123",
  "previous_response_high_water_mark": "<opaque mark from prior poll>",
  "input": "Continue from there.",
  "metadata": {
    "readback": "text",
    "include_subagents": false
  }
}
```

Supported `metadata.readback` values:

| Mode | Purpose | Response shape |
| --- | --- | --- |
| `text` | Default for ordinary API clients. | `output_text` plus assistant `output`; no transcript clutter. |
| `messages` | Conversation timeline for UI or state reconciliation. | Adds `blur_messages` with normalized user and assistant messages. |
| `events` | Diagnostic/full workflow timeline. | Adds `blur_messages` with user/assistant messages, tool calls/results, status updates, usage/counter snapshots, and subagent lifecycle events where available. |

`metadata.include_subagents` controls whether child sessions are expanded into
the rich readback stream.

| Value | Behavior |
| --- | --- |
| `false` | Default. Return subagent spawn/fork events only, with child response/session ids. |
| `true` | Include known child-session messages/events after the spawn event. |

## Default text mode

Text mode preserves the simplest Responses-style contract:

```json
{
  "id": "codex_abc123",
  "object": "response",
  "status": "completed",
  "output": [
    {
      "type": "message",
      "role": "assistant",
      "content": [{ "type": "output_text", "text": "Done." }]
    }
  ],
  "output_text": "Done.",
  "metadata": {
    "message_high_water_mark": "..."
  }
}
```

In text mode the high-water mark effectively means "last assistant message
returned to the client."

## Messages mode

Messages mode adds normalized user and assistant messages:

```json
{
  "output_text": "Done.",
  "metadata": {
    "message_high_water_mark": "..."
  },
  "blur_messages": [
    {
      "id": "msg_...",
      "type": "user_message",
      "role": "user",
      "text": "Continue from there.",
      "timestamp": "2026-06-05T13:34:09.613Z",
      "turn_id": "turn_...",
      "provider": "codex",
      "provider_session_id": "codex_..."
    },
    {
      "id": "msg_...",
      "type": "assistant_message",
      "role": "assistant",
      "text": "Done.",
      "timestamp": "2026-06-05T13:34:12.912Z",
      "turn_id": "turn_...",
      "provider": "codex",
      "provider_session_id": "codex_..."
    }
  ]
}
```

Messages mode is for clients that need a stable chat timeline but do not need
tool internals.

## Events mode

Events mode includes normalized workflow events. It may include all message-mode
events plus provider status, tool use, usage/counter snapshots, and subagent
events.

```json
{
  "blur_messages": [
    {
      "id": "evt_...",
      "type": "tool_call",
      "role": "tool",
      "tool_call_id": "call_...",
      "tool_name": "functions.exec_command",
      "arguments": { "cmd": "npm run check" },
      "timestamp": "2026-06-05T13:34:10.000Z",
      "turn_id": "turn_...",
      "provider": "codex"
    },
    {
      "id": "evt_...",
      "type": "tool_result",
      "role": "tool",
      "tool_call_id": "call_...",
      "tool_name": "functions.exec_command",
      "result_text": "tsc -p tsconfig.json --noEmit",
      "timestamp": "2026-06-05T13:34:11.000Z",
      "turn_id": "turn_...",
      "provider": "codex"
    },
    {
      "id": "evt_...",
      "type": "usage_snapshot",
      "role": "system",
      "timestamp": "2026-06-05T13:34:12.000Z",
      "turn_id": "turn_...",
      "provider": "codex",
      "usage": {
        "input_tokens": 37861,
        "output_tokens": 25,
        "total_tokens": 37886
      }
    }
  ]
}
```

Events mode is for debuggers, workflow engines, timeline UIs, and clients that
need to understand in-process state.

## Partial information

Desktop providers expose partial data while work is still in progress. The
gateway should return that data in `messages` and `events` modes instead of
waiting for a perfect final snapshot.

Rules:

- Each returned event has a stable `id`.
- Events may be updated by a later poll if the provider supplies better data.
- Updated events reuse the same `id` and include `revision`.
- Clients should upsert by `id`, not append blindly.
- Finalized events include `final: true` when the gateway can determine finality.
- Unknown or provider-specific counters are optional and must not be required by
  clients.

Example in-progress status event:

```json
{
  "id": "evt_...",
  "type": "status_update",
  "role": "system",
  "status": "in_progress",
  "text": "Codex is processing",
  "timestamp": "2026-06-05T13:34:10.500Z",
  "turn_id": "turn_...",
  "provider": "codex",
  "final": false
}
```

## High-water marks

`previous_response_id` identifies the stable desktop session chain.
`message_high_water_mark` identifies how far the client has consumed readback
from that chain.

Clients receive the mark from:

```json
{
  "metadata": {
    "message_high_water_mark": "..."
  }
}
```

Clients send the mark back as either:

```json
{
  "previous_response_high_water_mark": "..."
}
```

or:

```json
{
  "metadata": {
    "message_high_water_mark": "..."
  }
}
```

High-water scope depends on readback mode:

| Mode | Mark advances to |
| --- | --- |
| `text` | Last assistant message returned. |
| `messages` | Last returned normalized user or assistant message. |
| `events` | Last returned normalized event of any supported type. |

If a client submits multiple prompts without polling, its high-water mark remains
behind. This is intentional. The next poll resumes from the last event the client
actually observed, not from the newest event in the desktop transcript.

## Normalized event schema

All rich readback items use a common base:

```json
{
  "id": "msg_or_evt_...",
  "type": "assistant_message",
  "role": "assistant",
  "text": "...",
  "timestamp": "2026-06-05T13:34:12.912Z",
  "turn_id": "turn_...",
  "provider": "codex",
  "provider_session_id": "codex_...",
  "response_id": "codex_...",
  "native_type": "response_item:message",
  "native_id": null,
  "revision": 1,
  "final": true
}
```

Required fields for rich events:

- `id`
- `type`
- `role`
- `timestamp` when available; otherwise gateway receive/read time
- `provider`
- `response_id`

Optional common fields:

- `text`
- `turn_id`
- `native_turn_id`
- `provider_session_id`
- `native_type`
- `native_id`
- `revision`
- `final`
- `provider_event` when raw provider events are explicitly requested

## Claude and Codex normalization guarantees

The gateway should make these fields consistent across Claude and Codex:

- `role`
- `type`
- `text`
- `timestamp`
- `provider`
- `provider_session_id`
- `response_id`
- `id`
- `turn_id` or gateway-generated fallback
- high-water behavior

Known provider differences:

- Codex JSONL includes explicit records such as `turn_context`, `event_msg`,
  `response_item`, `task_complete`, and token usage snapshots.
- Claude JSONL content blocks differ and may not always expose a provider-native
  turn id.
- Tool call and result payload shapes differ.
- Usage/counter data is richer in some Codex records than in Claude records.

The external schema stays stable. Provider-specific details may be exposed under
`provider_event` only when requested.

## Tool use

Tool calls normalize to:

```json
{
  "id": "evt_...",
  "type": "tool_call",
  "role": "tool",
  "tool_call_id": "call_...",
  "tool_name": "functions.exec_command",
  "arguments": {},
  "timestamp": "...",
  "turn_id": "...",
  "provider": "codex"
}
```

Tool results normalize to:

```json
{
  "id": "evt_...",
  "type": "tool_result",
  "role": "tool",
  "tool_call_id": "call_...",
  "tool_name": "functions.exec_command",
  "result_text": "...",
  "timestamp": "...",
  "turn_id": "...",
  "provider": "codex"
}
```

## Subagents

Subagents are represented as lifecycle events rather than ordinary tool calls.

Spawn/fork:

```json
{
  "id": "evt_...",
  "type": "subagent_spawn",
  "role": "system",
  "provider": "claude",
  "parent_response_id": "claude_parent",
  "subagent_response_id": "claude_child",
  "provider_session_id": "local_...",
  "title": "Research worker",
  "timestamp": "..."
}
```

Child message, only when `include_subagents` is `true`:

```json
{
  "id": "msg_...",
  "type": "subagent_message",
  "role": "assistant",
  "provider": "claude",
  "subagent_response_id": "claude_child",
  "text": "...",
  "timestamp": "..."
}
```

## Raw provider events

Raw provider payloads are omitted by default. Advanced clients may request them:

```json
{
  "metadata": {
    "readback": "events",
    "include_raw_provider_events": true
  }
}
```

When enabled, each normalized event may include `provider_event`. Clients must
treat this as provider-specific and unstable.
