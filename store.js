import { normalizeConfig } from "./lib/config.js";
import { buildPacScript } from "./lib/pac.js";

export const STORAGE_KEY = "config";

let cache = null;

export function invalidateConfigCache() {
  cache = null;
}

export async function loadConfig() {
  if (cache) return cache;
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  cache = normalizeConfig(stored ? stored[STORAGE_KEY] : null);
  return cache;
}

export async function saveConfig(config) {
  const next = normalizeConfig(config);
  await chrome.storage.local.set({ [STORAGE_KEY]: next });
  cache = next;
  return next;
}

export async function getProxyControl() {
  try {
    const details = await chrome.proxy.settings.get({ incognito: false });
    return details && details.levelOfControl ? details.levelOfControl : "unknown";
  } catch {
    return "unknown";
  }
}

export async function applyConfig(config) {
  try {
    if (!config.proxy || config.domains.length === 0) {
      await chrome.proxy.settings.clear({ scope: "regular" });
      return { applied: false, error: null };
    }
    const data = buildPacScript(config.domains, config.proxy);
    await chrome.proxy.settings.set({
      value: { mode: "pac_script", pacScript: { data, mandatory: true } },
      scope: "regular"
    });
    return { applied: true, error: null };
  } catch (error) {
    return { applied: false, error: error && error.message ? error.message : String(error) };
  }
}

export async function commitConfig(nextConfig) {
  const previous = await loadConfig();
  const saved = await saveConfig(nextConfig);
  const result = await applyConfig(saved);

  if (result.error) {
    const rolledBack = await saveConfig({ ...previous, lastError: result.error });
    await applyConfig(rolledBack);
    return { ok: false, config: rolledBack, error: result.error };
  }
  if (saved.lastError) {
    const cleaned = await saveConfig({ ...saved, lastError: null });
    return { ok: true, config: cleaned, error: null };
  }
  return { ok: true, config: saved, error: null };
}

export async function recordError(message) {
  const config = await loadConfig();
  return saveConfig({ ...config, lastError: message || null });
}
