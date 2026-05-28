// Thin wrapper around browser.storage.local for connections, log, settings.

import {
  type Connection,
  type RelayLogEntry,
  type ExtensionSettings,
  DEFAULT_SETTINGS,
} from './types';

const K_CONNECTIONS = 'cb.connections';
const K_LOG = 'cb.relayLog';
const K_SETTINGS = 'cb.settings';
const MAX_LOG_ENTRIES = 100;

export async function getConnections(): Promise<Connection[]> {
  const r = await browser.storage.local.get(K_CONNECTIONS);
  return (r[K_CONNECTIONS] as Connection[]) || [];
}

export async function setConnections(connections: Connection[]): Promise<void> {
  await browser.storage.local.set({ [K_CONNECTIONS]: connections });
}

export async function addConnection(conn: Connection): Promise<void> {
  const list = await getConnections();
  list.push(conn);
  await setConnections(list);
}

export async function updateConnection(
  id: string,
  patch: Partial<Connection>,
): Promise<void> {
  const list = await getConnections();
  const idx = list.findIndex(c => c.id === id);
  if (idx === -1) return;
  list[idx] = { ...list[idx], ...patch };
  await setConnections(list);
}

export async function removeConnection(id: string): Promise<void> {
  const list = await getConnections();
  await setConnections(list.filter(c => c.id !== id));
}

export async function getRelayLog(): Promise<RelayLogEntry[]> {
  const r = await browser.storage.local.get(K_LOG);
  return (r[K_LOG] as RelayLogEntry[]) || [];
}

export async function appendLog(entry: RelayLogEntry): Promise<void> {
  const log = await getRelayLog();
  log.unshift(entry);
  if (log.length > MAX_LOG_ENTRIES) log.length = MAX_LOG_ENTRIES;
  await browser.storage.local.set({ [K_LOG]: log });
}

export async function clearLog(): Promise<void> {
  await browser.storage.local.set({ [K_LOG]: [] });
}

export async function getSettings(): Promise<ExtensionSettings> {
  const r = await browser.storage.local.get(K_SETTINGS);
  if (r[K_SETTINGS] && typeof r[K_SETTINGS] === 'object') {
    return { ...DEFAULT_SETTINGS, ...(r[K_SETTINGS] as Partial<ExtensionSettings>) };
  }
  return DEFAULT_SETTINGS;
}

export async function setSettings(patch: Partial<ExtensionSettings>): Promise<void> {
  const current = await getSettings();
  await browser.storage.local.set({ [K_SETTINGS]: { ...current, ...patch } });
}
