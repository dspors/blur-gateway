import type { DesktopProvider, ProviderName } from '../types/provider';
import { CodexProvider } from './codex';
import { ClaudeProvider } from './claude';

const providers: Record<ProviderName, DesktopProvider> = {
  codex: new CodexProvider(),
  claude: new ClaudeProvider(),
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
