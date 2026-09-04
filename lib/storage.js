/**
 * Settings persistence via chrome.storage.local.
 * Provides defaults and a cached getter to avoid repeated async reads.
 */

const DEFAULTS = {
  // When grouping happens:
  //   'auto' (default) — group each new/navigated tab as it settles.
  //   'manual'         — only when you click "Group all" / use a command /
  //                      capture a task. Tabs never move on their own.
  groupingMode: 'auto',

  // When the AI names groups, bias toward the PROJECT/TASK a tab supports over
  // its generic topic. On by default. Affects only AI-named groups — hosts that
  // look internal still group deterministically (subdomainScope below).
  aiProjectMode: true,

  // Read a summary of each page — headings, meta description, and a bounded
  // slice of the main text — so a tab with a generic title or an opaque URL
  // still has a description. Has no effect until page access is granted in
  // Settings; the extension installs with none. What is read never leaves the
  // machine and is cached only for the browser session.
  readPageContent: true,

  // After grouping, ask the model which groups are actually one piece of work.
  // The layer below it never invents a merge, so this is where a genuinely
  // semantic join gets made — whether two tickets are one effort cannot be read
  // off a URL. Guarded: only groups the model named are eligible, and at most a
  // third of them can be merged away in one pass. Turn off to keep grouping
  // entirely deterministic apart from naming.
  aiMergePass: true,

  // When grouping, also collapse groups other than the active one.
  collapseInactive: true,

  // Trust tabs opened from other tabs to belong to the same work, and put them
  // in the opener's group immediately. This is the strongest task signal the
  // browser exposes and needs no AI call. Turn off to have every new tab
  // classified from scratch.
  useOpenerAffinity: true,

  // How internal hosts are labeled (see lib/url.js).
  //   'cluster' (default) — every service on one cluster shares a group, so
  //       `prod-eu-1-grafana`, `prod-eu-1-kibana` and `prod-eu-1-jumper` are one
  //       group, and `gamma-dl`/`gamma-da` are one group. Different clusters
  //       still never merge.
  //   'subdomain' — one group per service on a cluster.
  //   'host' — one group per hostname (strictest).
  //   'prefix' — drop the trailing dash-token unconditionally (superseded).
  //   'ai' — hand these hosts to the model like any other.
  subdomainStrategy: 'cluster',

  // Trailing hostname tokens naming a SERVICE on a cluster rather than the
  // cluster itself, used by the 'cluster' strategy. Empty means use the
  // built-in list (see DEFAULT_SERVICE_TOKENS in lib/url.js); set it to
  // override, e.g. ['dl', 'da', 'jumper'] plus your own component names.
  clusterServiceTokens: [],

  // WHICH hosts the deterministic rule above applies to.
  //   'internal' (default) — only hosts that look like internal infrastructure:
  //       a configured internalDomain, a private marker (.corp., .internal), a
  //       bare/IP host, or the dashed cluster convention (prod-eu-1-grafana).
  //       Public SaaS hosts are task grouped instead, so `docs.google.com` no
  //       longer becomes a "docs" group holding unrelated documents.
  //   'all' — any host with a subdomain, the pre-task-grouping behavior.
  subdomainScope: 'internal',

  // Domain suffixes to treat as internal infrastructure, e.g.
  // ['corp.acme.com', 'acme.internal']. Use this when your internal hosts don't
  // follow a recognizable convention; matched hosts keep deterministic
  // per-subdomain groups and never go to the AI.
  internalDomains: [],

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

// Listen for external changes (e.g. options page updates settings).
// Guarded so this module can be imported outside a browser, which is what lets
// the grouping logic be tested and benchmarked without Chrome.
if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) {
      settingsCache = null;
    }
  });
}
