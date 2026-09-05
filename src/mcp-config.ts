/**
 * Per-session MCP config.
 *
 * When a session's metadata declares `mcp_servers`, write the CLI-appropriate
 * config into that session's workspace so the spawned CLI mounts them. This is
 * how Residency gives a Resident its SCOPED surface — a single
 * `http://<host>/resident/<holon>/<role>` URL served by the resident-MCP
 * (blur-script Streamable-HTTP) — with no per-session process to deploy.
 *
 * Adapter per CLI; claude (`.mcp.json`, http transport) is the reference. See
 * doc/standard/holon-components (CLIs as managed components of this Holon).
 */
import fs from 'node:fs';
import path from 'node:path';

export interface McpServerDecl {
  name: string;
  url: string;
  transport?: string; // 'http' (default) | 'sse'
}

/** Pull a validated mcp_servers list off session metadata (tolerant of shape). */
export function serversFromMetadata(metadata: unknown): McpServerDecl[] {
  // Precedence: `mcp_servers` (canonical) over `mcpServers` (camelCase alias).
  const raw = (metadata as any)?.mcp_servers ?? (metadata as any)?.mcpServers;
  if (!Array.isArray(raw)) return [];
  // `name` must be a safe identifier — it is written verbatim into TOML section
  // headers (`[mcp_servers.<name>]`), so reject anything that could break/inject.
  const safeName = /^[A-Za-z0-9_-]+$/;
  return raw
    .filter((s: any) => s && typeof s.url === 'string' && typeof s.name === 'string' && safeName.test(s.name))
    .map((s: any) => ({ name: s.name, url: s.url, transport: typeof s.transport === 'string' ? s.transport : 'http' }));
}

/** Claude Code reads `.mcp.json` at the project root; http transport supported. */
function writeClaude(workspaceDir: string, servers: McpServerDecl[]): void {
  const mcpServers: Record<string, unknown> = {};
  for (const s of servers) mcpServers[s.name] = { type: s.transport, url: s.url };
  fs.writeFileSync(path.join(workspaceDir, '.mcp.json'), JSON.stringify({ mcpServers }, null, 2));
}

/**
 * Codex reads MCP servers from config.toml. Written workspace-local under
 * `.codex/config.toml`.
 * REVIEW POINT: codex's per-workspace config discovery is not yet confirmed — it
 * may require `CODEX_HOME` pointing at this dir, or a `--config` flag threaded
 * through the codex bridge. Verify before relying on codex-scoped Residents.
 */
function writeCodex(workspaceDir: string, servers: McpServerDecl[]): void {
  const lines: string[] = [];
  for (const s of servers) {
    lines.push(`[mcp_servers.${s.name}]`);
    lines.push(`url = ${JSON.stringify(s.url)}`);
    lines.push('');
  }
  const dir = path.join(workspaceDir, '.codex');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.toml'), lines.join('\n'));
}

/**
 * Write per-session MCP config for the given provider. Best-effort: never blocks
 * a spawn on MCP-config failure. Returns what was declared (for logging/audit).
 */
export function writeSessionMcp(workspaceDir: string, providerName: string, metadata: unknown): McpServerDecl[] {
  const servers = serversFromMetadata(metadata);
  if (servers.length === 0) return [];
  try {
    if (providerName.startsWith('claude')) writeClaude(workspaceDir, servers);
    else if (providerName.startsWith('codex')) writeCodex(workspaceDir, servers);
    else writeClaude(workspaceDir, servers); // mimo/qwen/dsh: adapter TBD — .mcp.json as a reasonable default
    // audit: record what was mounted (not silent).
    console.log(`[mcp-config] ${providerName} session: mounted ${servers.length} MCP server(s): ${servers.map((s) => s.name).join(', ')}`);
  } catch (e) {
    // MCP config is an enhancement, not a precondition — a failure must not fail the
    // session, but it must NOT be silent (was invisible before).
    console.warn(`[mcp-config] failed to write session MCP config for ${providerName}: ${(e as Error).message}`);
  }
  return servers;
}
