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
- Providers: `codex-desktop` and `claude-desktop`
- Provider selection: `model`, e.g. `codex-desktop` or `claude-desktop`
- Response ids are stable session ids. A new chain returns a provider-prefixed
  id such as `codex_<id>` or `claude_<id>`; follow-up calls with
  `previous_response_id` return the same id.
- Bridge repo: `BRIDGE_ROOT`, defaulting to `/Users/danielspors/bridge`

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

Windows setup:

Prerequisites:

- Node.js/npm
- PM2 installed globally if the gateway should run under PM2
- .NET SDK 8 or newer for the Windows shield helpers
- A local Bridge checkout. The gateway imports Bridge provider and shield modules
  directly, so `BRIDGE_ROOT` must point at the Bridge repo on Windows.
- A local `blur-db` checkout as a sibling of this repo (`../blur-db`). The gateway
  depends on it via `file:../blur-db` for its SQLite layer (better-sqlite3,
  compiled natively) — no external `sqlite3` CLI is required on any platform.
- Claude Desktop and/or Codex Desktop running on the interactive desktop being
  automated. Do not run the smoke tests from a locked or disconnected desktop.

Example macOS setup:

```bash
cd /Users/danielspors
git clone https://github.com/dspors/blur-db.git blur-db

cd /Users/danielspors/blur-db
npm install
npm run build

cd /Users/danielspors/blur-gateway
npm install
npm run check
npm run build
BLUR_GATEWAY_PORT=3480 npm start
```

Example PowerShell setup:

```powershell
cd C:\Users\dspors
git clone https://github.com/dspors/blur-db.git blur-db

cd C:\Users\dspors\blur-db
npm install
npm run build

cd C:\Users\dspors\blur-gateway
npm install
npm run check
npm run build

$env:BRIDGE_ROOT = "C:\Users\dspors\bridge"
$env:BLUR_GATEWAY_PORT = "3480"
npm start
```

`blur-db` must be built before `blur-gateway` is checked or built because the
gateway resolves `blur-db` through `node_modules/blur-db -> ../blur-db`, and the
package publishes its runtime and type entrypoints from `blur-db/dist`.

PM2 example:

```powershell
cd C:\Users\dspors\blur-gateway
pm2 start npm --name blur-gateway -- start
pm2 save
```

If PM2 is used, make sure `BRIDGE_ROOT` and `BLUR_GATEWAY_PORT` are available in
the PM2 process environment. One option is to start it from a shell where those
variables are already set.

Windows smoke tests:

```powershell
curl http://localhost:3480/v1/desktop/sessions
curl http://localhost:3480/v1/admin/metrics
curl -X POST http://localhost:3480/v1/responses `
  -H "Content-Type: application/json" `
  -d "{\"model\":\"claude-desktop\",\"input\":\"Reply exactly: claude windows smoke ok\"}"
```

Codex Windows status:

- Existing-session Codex sends use the Windows Codex HID shield.
- New Codex session creation uses the gateway prepared-session path. The macOS
  shield supports that path, including `/project <dir>`, but the Windows Codex
  shield still needs parity work before Codex create-session should be treated as
  complete on Windows.

Claude Windows status:

- Claude send, create, rename, and spawn/fork paths route through the Windows
  Claude HID shield.
- Spawn/fork support requires an existing Claude parent session and uses the
  guarded shield path with `--spawn`, `--rename-title`, and `--prompt-after`.
