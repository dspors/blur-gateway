import type { DesktopProvider, ProviderName } from '../types/provider';
import { CodexProvider } from './codex';
import { runExclusive } from './desktop-lock';

// HID methods drive the single shared desktop and MUST be serialized end-to-end:
// each is multi-step, and the shield's per-call lock alone lets sequences
// interleave and cross-contaminate. Read-only methods (listSessions/readLatest)
// are NOT serialized — they read metadata and must stay responsive during polling.
const HID_METHODS = new Set(['createPreparedSession', 'send', 'spawn', 'archive', 'unarchive', 'rename']);

function serializeDesktop(provider: DesktopProvider): DesktopProvider {
  return new Proxy(provider, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === 'function' && typeof prop === 'string' && HID_METHODS.has(prop)) {
        return (...args: unknown[]) => runExclusive(() => (value as (...a: unknown[]) => Promise<unknown>).apply(target, args));
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as DesktopProvider;
}

const claudeDesktop = createClaudeProvider();
const codexDesktop = serializeDesktop(new CodexProvider({ name: 'codex-desktop', transport: 'desktop' }));
const codexCli = new CodexProvider({ name: 'codex-cli', transport: 'cli' });

const providers: Record<ProviderName, DesktopProvider> = {
  claude: claudeDesktop,
  'claude-desktop': claudeDesktop,
  codex: codexCli,
  'codex-desktop': codexDesktop,
  'codex-cli': codexCli,
};

export function providerFromModel(model: string | undefined): DesktopProvider {
  const normalized = (model || 'codex-desktop').toLowerCase();
  if (normalized.includes('claude')) return providers['claude-desktop'];
  if (normalized.includes('codex-cli') || normalized.includes('codex_cli')) return providers['codex-cli'];
  if (normalized.includes('codex-desktop') || normalized.includes('codex_desktop')) return providers['codex-desktop'];
  if (normalized === 'codex') return providers.codex;
  if (normalized.startsWith('gpt-5.')) return providers['codex-cli'];
  return providers['codex-desktop'];
}

export function getProvider(name: string): DesktopProvider {
  const provider = providers[name as ProviderName];
  if (!provider) throw new Error(`Unknown provider: ${name}`);
  return provider;
}

export function allProviders(): DesktopProvider[] {
  return [providers['claude-desktop'], providers['codex-desktop'], providers['codex-cli']];
}

function createClaudeProvider(): DesktopProvider {
  try {
    const { ClaudeProvider } = require('./claude') as typeof import('./claude');
    return serializeDesktop(new ClaudeProvider({ name: 'claude-desktop' }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return unavailableProvider('claude-desktop', message);
  }
}

function unavailableProvider(name: ProviderName, reason: string): DesktopProvider {
  const fail = async () => {
    throw new Error(`${name} is unavailable on this host: ${reason}`);
  };
  return {
    name,
    createPreparedSession: fail,
    send: fail,
    listSessions: async () => [],
  };
}
