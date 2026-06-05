# blur-gateway

Responses-style local gateway backed by desktop AI sessions.

MVP endpoints:

- `POST /v1/responses`
- `GET /v1/responses/:id`
- `POST /v1/files`
- `GET /v1/files/:id/content`
- `GET /v1/desktop/sessions`

Defaults:

- Port: `3480`
- Storage root: `~/.blur-gateway`
- First provider: `codex`
- Provider selection: `model`, e.g. `codex-desktop` or later `claude-desktop`
- Response ids are stable session ids. A new Codex chain returns `codex_<id>`;
  follow-up calls with `previous_response_id` return the same id.

Run:

```bash
npm install
npm run build
BLUR_GATEWAY_PORT=3480 npm start
```
