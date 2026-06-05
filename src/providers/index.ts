import type { DesktopProvider, ProviderName } from '../types/provider';
import { CodexProvider } from './codex';
import { ClaudeProvider } from './claude';
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

const providers: Record<ProviderName, DesktopProvider> = {
  codex: serializeDesktop(new CodexProvider()),
  claude: serializeDesktop(new ClaudeProvider()),
};

export function providerFromModel(model: string | undefined): DesktopProvider {
  const normalized = (model || 'codex-desktop').toLowerCase();
  if (normalized.includes('claude')) return providers.claude;
  return providers.codex;
}

export function getProvider(name: string): DesktopProvider {
  const provider = providers[name as ProviderName];
  if (!provider) throw new Error(`Unknown provider: ${name}`);
  return provider;
}

export function allProviders(): DesktopProvider[] {
  return Object.values(providers);
}
