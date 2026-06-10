import os from 'node:os';
import path from 'node:path';

export type Config = {
  port: number;
  storageRoot: string;
  dbPath: string;
  filesDir: string;
  sessionsDir: string;
  bridgeRoot: string;
  sessionLifecycleKey: string | null;
};

const storageRoot = process.env.BLUR_GATEWAY_HOME || path.join(os.homedir(), '.blur-gateway');

export const config: Config = {
  port: Number(process.env.BLUR_GATEWAY_PORT || 3480),
  storageRoot,
  dbPath: process.env.BLUR_GATEWAY_DB || path.join(storageRoot, 'gateway.sqlite'),
  filesDir: path.join(storageRoot, 'files'),
  sessionsDir: path.join(storageRoot, 'sessions'),
  bridgeRoot: process.env.BRIDGE_ROOT || '/Users/danielspors/bridge',
  sessionLifecycleKey: process.env.BLUR_GATEWAY_SESSION_LIFECYCLE_KEY || null,
};
