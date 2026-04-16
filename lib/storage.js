/**
 * Settings persistence via chrome.storage.local.
 * Provides defaults and a cached getter to avoid repeated async reads.
 */

const DEFAULTS = {
  // Automatically group newly opened / navigated tabs as they settle.
  autoGroup: true,

  // When grouping, also collapse groups other than the active one.
  collapseInactive: true,

  // How hosts with a meaningful subdomain are grouped (see lib/url.js).
  // Default 'subdomain' groups such hosts deterministically (by their leftmost
  // subdomain) so internal tools aren't mislabeled by the AI. 'host' is stricter;
  // 'prefix' (drop the trailing dash-token) is available via Import; 'ai' hands
  // these hosts to the model too. See examples/example.json.
  subdomainStrategy: 'subdomain',

  // Leave tabs the user has manually placed in a group (that we didn't create)
  // untouched.
  respectManualGroups: true,

  // Minimum tabs sharing an AI topic before they get their own group; smaller
  // groups fall into the "miscLabel" bucket. Set to 1 to allow single-tab groups.
  minGroupSize: 2,

  // Group label for leftover tabs that don't meet minGroupSize.
  miscLabel: 'Other',

  // Pin certain URLs to a fixed group label, bypassing the AI.
  // `match` is a substring of "hostname + path"; first match wins, so list the
  // most specific rules first. Empty by default — apply org/personal rules at
  // runtime via Settings → Import (see examples/example.json).
  pinnedRules: [],
};

let settingsCache = null;

/**
 * Get current settings, merged with defaults.
 */
export async function getSettings() {
  if (settingsCache) return settingsCache;

  const stored = await chrome.storage.local.get('settings');
  settingsCache = { ...DEFAULTS, ...(stored.settings || {}) };
  return settingsCache;
}

/**
 * Save settings (partial update).
 */
export async function saveSettings(partial) {
  const current = await getSettings();
  const updated = { ...current, ...partial };
  await chrome.storage.local.set({ settings: updated });
  settingsCache = updated;
  return updated;
}

/**
 * Reset settings to defaults.
 */
export async function resetSettings() {
  await chrome.storage.local.set({ settings: DEFAULTS });
  settingsCache = { ...DEFAULTS };
  return settingsCache;
}

/**
 * Invalidate cache (call when storage changes externally, e.g. options page).
 */
export function invalidateCache() {
  settingsCache = null;
}

// --- Sessions (saved sets of tabs + their group) ---

/** @returns {Promise<Array<{name:string, createdAt:string, tabs:Array<{url:string, group:string|null}>}>>} */
export async function getSessions() {
  const stored = await chrome.storage.local.get('sessions');
  return stored.sessions || [];
}

export async function saveSession(name, tabs) {
  const sessions = await getSessions();
  sessions.push({ name, createdAt: new Date().toISOString(), tabs });
  await chrome.storage.local.set({ sessions });
  return sessions;
}

export async function deleteSession(index) {
  const sessions = await getSessions();
  sessions.splice(index, 1);
  await chrome.storage.local.set({ sessions });
  return sessions;
}

// Listen for external changes (e.g. options page updates settings)
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) {
    settingsCache = null;
  }
});
