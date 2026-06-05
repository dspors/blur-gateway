# blur-gateway

Responses-style local gateway backed by desktop AI sessions.

MVP endpoints:

- `POST /v1/responses`
- `GET /v1/responses/:id`
- `POST /v1/files`
- `GET /v1/files/:id/content`
- `GET /v1/desktop/sessions`
- `GET /v1/admin/metrics`
- `GET /v1/admin/requests`

Defaults:

- Port: `3480`
- Storage root: `~/.blur-gateway`
- First provider: `codex`
- Provider selection: `model`, e.g. `codex-desktop` or later `claude-desktop`
- Response ids are stable session ids. A new Codex chain returns `codex_<id>`;
  follow-up calls with `previous_response_id` return the same id.

Metrics:

- `GET /v1/admin/metrics?hours=24&limit=100` returns hourly request rollups,
  hourly response automation rollups, and recent response metric rows.
- `GET /v1/admin/requests?limit=100` returns recent request log rows.
- Request logging stores method, path, status, duration, remote address, selected
  client headers, provider, and response id. It records whether authorization was
  present, but does not store authorization values, cookies, or request bodies.

Run:

```bash
npm install
npm run build
BLUR_GATEWAY_PORT=3480 npm start
```
