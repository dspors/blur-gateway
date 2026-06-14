import type { DesktopProvider, ProviderName } from '../types/provider';
import { CodexProvider } from './codex';
import { MimoProvider } from './mimo';
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
const claudeCli = createClaudeProvider('claude-cli', false);
const codexDesktop = serializeDesktop(new CodexProvider({ name: 'codex-desktop', transport: 'desktop' }));
const codexCli = new CodexProvider({ name: 'codex-cli', transport: 'cli' });
const mimoCli = new MimoProvider();

const providers: Record<ProviderName, DesktopProvider> = {
  claude: claudeCli,
  'claude-desktop': claudeDesktop,
  'claude-cli': claudeCli,
  codex: codexCli,
  'codex-desktop': codexDesktop,
  'codex-cli': codexCli,
  mimo: mimoCli,
  'mimo-cli': mimoCli,
};

export function providerFromModel(model: string | undefined): DesktopProvider {
  return getProvider(resolveProviderModel(model).provider);
}

export function resolveProviderModel(model: string | undefined): { provider: ProviderName; providerModel: string | null; model: string } {
  const raw = (model || 'codex-desktop').trim();
  const normalized = raw.toLowerCase().replace(/_/g, '-');
  if (normalized.startsWith('claude-cli-')) {
    return { provider: 'claude-cli', providerModel: normalized.slice('claude-cli-'.length), model: raw };
  }
  if (normalized.startsWith('claude-desktop-')) {
    return { provider: 'claude-desktop', providerModel: normalized.slice('claude-desktop-'.length), model: raw };
  }
  if (normalized.startsWith('codex-cli-')) {
    return { provider: 'codex-cli', providerModel: normalized.slice('codex-cli-'.length), model: raw };
  }
  if (normalized.startsWith('codex-desktop-')) {
    return { provider: 'codex-desktop', providerModel: normalized.slice('codex-desktop-'.length), model: raw };
  }
  if (normalized.startsWith('mimo-cli-')) {
    return { provider: 'mimo-cli', providerModel: normalized.slice('mimo-cli-'.length), model: raw };
  }
  if (normalized.startsWith('mimo/') || normalized.startsWith('xiaomi/')) {
    return { provider: 'mimo-cli', providerModel: raw, model: raw };
  }
  if (normalized === 'mimo' || normalized === 'mimo-cli' || normalized.includes('mimo-cli')) {
    return { provider: 'mimo-cli', providerModel: null, model: raw };
  }
  if (normalized.startsWith('gpt-5.')) {
    return { provider: 'codex-cli', providerModel: raw, model: raw };
  }
  if (normalized.startsWith('gpt-5')) {
    return { provider: 'codex-cli', providerModel: raw, model: raw };
  }
  if (normalized.includes('claude-cli')) return { provider: 'claude-cli', providerModel: null, model: raw };
  if (normalized.includes('claude-desktop')) return { provider: 'claude-desktop', providerModel: null, model: raw };
  if (normalized === 'claude') return { provider: 'claude-cli', providerModel: null, model: raw };
  if (normalized === 'opus' || normalized === 'sonnet' || normalized === 'haiku') {
    return { provider: 'claude-cli', providerModel: normalized, model: raw };
  }
  if (normalized.includes('codex-cli')) return { provider: 'codex-cli', providerModel: null, model: raw };
  if (normalized.includes('codex-desktop')) return { provider: 'codex-desktop', providerModel: null, model: raw };
  if (normalized === 'codex') return { provider: 'codex-cli', providerModel: null, model: raw };
  return { provider: 'codex-desktop', providerModel: null, model: raw };
}

export function getProvider(name: string): DesktopProvider {
  const provider = providers[name as ProviderName];
  if (!provider) throw new Error(`Unknown provider: ${name}`);
  return provider;
}

export function allProviders(): DesktopProvider[] {
  if (process.platform === 'linux') {
    return [providers['claude-cli'], providers['codex-cli'], providers['mimo-cli']];
  }
  return [providers['claude-desktop'], providers['claude-cli'], providers['codex-desktop'], providers['codex-cli'], providers['mimo-cli']];
}

export function availableModelOptions(): string[] {
  const cliModels = [
    'codex-cli',
    'codex-cli-gpt-5',
    'codex-cli-gpt-5-high',
    'claude-cli',
    'claude-cli-opus',
    'claude-cli-sonnet',
    'claude-cli-haiku',
    'claude-cli-deepseek',
    'mimo-cli',
    'mimo-cli-pro',
    'mimo-cli-v2.5-pro',
    'mimo-cli-deepseek-v4-pro',
    'mimo-cli-deepseek-v4-flash',
  ];
  if (process.platform === 'linux') return cliModels;
  return [
    ...cliModels,
    'codex-desktop',
    'claude-desktop',
  ];
}

function createClaudeProvider(name: ProviderName = 'claude-desktop', serialized = true): DesktopProvider {
  try {
    const { ClaudeProvider } = require('./claude') as typeof import('./claude');
    const transport = name === 'claude-cli' ? 'cli' : 'desktop';
    const provider = new ClaudeProvider({ name, transport });
    return serialized ? serializeDesktop(provider) : provider;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return unavailableProvider(name, message);
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
