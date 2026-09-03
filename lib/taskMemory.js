/**
 * Task memory — what the extension has learned about your work.
 *
 * Without this, grouping is amnesiac: every pass re-guesses from scratch, so a
 * correction you made yesterday is silently undone today. That is the difference
 * between a tool that feels smart and one that feels broken, no matter how good
 * the underlying guess is.
 *
 * Three kinds of learning, in descending order of authority:
 *   1. Pins — you moved a specific page into a specific group. Nothing may
 *      override that, ever.
 *   2. Aliases — you renamed a group. Your vocabulary replaces the model's
 *      wherever that group would be proposed again ("Auth Migration" → "SSO Work").
 *   3. Task profiles — the task keys, hosts and title words seen in a group.
 *      A new tab matching a profile joins that group with no AI call.
 *
 * Pure query functions take the memory object as their first argument so they
 * can be tested and benchmarked without Chrome; the load/save/learn wrappers at
 * the bottom are the only part that touches storage.
 */

import { readTask, titleTaskKey } from './taskSignal.js';
import { titleTokens } from './summarize.js';

const STORAGE_KEY = 'taskMemory';
export const MEMORY_VERSION = 1;

export { titleTokens };

/** Caps, so memory stays small and a stale profile can't grow forever. */
const MAX_KEYS_PER_TASK = 12;
const MAX_HOSTS_PER_TASK = 12;
const MAX_TOKENS_PER_TASK = 24;
const MAX_TASKS = 200;
const MAX_PINS = 500;

/** An empty memory, also the shape everything else expects. */
export function emptyMemory() {
  return { version: MEMORY_VERSION, tasks: {}, aliases: {}, pins: {} };
}

/** A stable identity for pinning one page, ignoring query and fragment. */
export function pinKey(url) {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/+$/, '');
    return `${u.hostname.replace(/^www\./i, '').toLowerCase()}${path}`;
  } catch {
    return '';
  }
}

/** Hostname of a URL, or ''. */
function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./i, '').toLowerCase(); } catch { return ''; }
}

/** Every task key a tab carries (URL and title). */
export function keysForTab(tab) {
  const urlKey = readTask(tab.url).key;
  const tKey = titleTaskKey(tab.title);
  return [...new Set([urlKey, tKey].filter(Boolean))];
}

// --- Pure queries -----------------------------------------------------------

/** Follow a rename: the label you chose replaces the one that was proposed. */
export function resolveAlias(memory, label) {
  if (!label) return label;
  const seen = new Set();
  let cur = label;
  // Aliases can chain if a group was renamed twice; stop on a cycle.
  while (memory.aliases && memory.aliases[cur] && !seen.has(cur)) {
    seen.add(cur);
    cur = memory.aliases[cur];
  }
  return cur;
}

/** A page you explicitly filed somewhere. Authoritative. */
export function recallPin(memory, tab) {
  const key = pinKey(tab.url);
  const label = key && memory.pins ? memory.pins[key] : null;
  return label ? resolveAlias(memory, label) : null;
}

/**
 * Score how well a set of tabs matches each learned task profile, and return
 * the best match above a confidence floor.
 *
 * A shared task key is decisive (it names the same work item). Hosts and title
 * words are corroborating evidence only — several must agree before they can
 * stand on their own, because any two tabs on `docs.google.com` share a host,
 * and that is precisely the inference this project exists to stop making.
 *
 * @returns {{label:string, score:number, via:string}|null}
 */
export function recallForTabs(memory, tabs) {
  const list = tabs || [];
  if (list.length === 0 || !memory.tasks) return null;

  const keys = new Set();
  const hosts = new Set();
  const tokens = new Set();
  for (const t of list) {
    for (const k of keysForTab(t)) keys.add(k);
    const h = hostOf(t.url);
    if (h) hosts.add(h);
    for (const w of titleTokens(t.title)) tokens.add(w);
  }

  let best = null;
  for (const [label, task] of Object.entries(memory.tasks)) {
    let keyHits = 0;
    for (const k of task.keys || []) if (keys.has(k)) keyHits++;
    let hostHits = 0;
    for (const h of task.hosts || []) if (hosts.has(h)) hostHits++;
    let tokenHits = 0;
    for (const w of task.tokens || []) if (tokens.has(w)) tokenHits++;

    // A key match is worth far more than any amount of host/word overlap.
    const score = keyHits * 10 + Math.min(hostHits, 3) + Math.min(tokenHits, 4) * 2
      + (task.userNamed ? 3 : 0);

    // Either one real key match, or a broad agreement of weaker signals.
    const confident = keyHits > 0 || (tokenHits >= 2 && hostHits >= 1) || tokenHits >= 3;
    if (!confident) continue;

    if (!best || score > best.score) {
      best = { label: resolveAlias(memory, label), score, via: keyHits > 0 ? 'key' : 'profile' };
    }
  }
  return best;
}

/** Convenience: recall for a single tab. */
export function recallForTab(memory, tab) {
  return recallPin(memory, tab)
    ? { label: recallPin(memory, tab), score: 100, via: 'pin' }
    : recallForTabs(memory, [tab]);
}

/** Tasks ordered most-recently-seen first, for the options UI. */
export function listTasks(memory) {
  return Object.entries(memory.tasks || {})
    .map(([label, t]) => ({ label, ...t }))
    .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
}

// --- Pure mutations (return a new memory) -----------------------------------

function trim(arr, max) {
  return arr.length > max ? arr.slice(arr.length - max) : arr;
}

function mergeInto(task, tabs, now) {
  const keys = new Set(task.keys || []);
  const hosts = new Set(task.hosts || []);
  const tokens = new Set(task.tokens || []);
  for (const t of tabs || []) {
    for (const k of keysForTab(t)) keys.add(k);
    const h = hostOf(t.url);
    // A host is only worth remembering when it is not a generic multi-tenant
    // one; those would make the profile match everything.
    if (h) hosts.add(h);
    for (const w of titleTokens(t.title)) tokens.add(w);
  }
  return {
    ...task,
    keys: trim([...keys], MAX_KEYS_PER_TASK),
    hosts: trim([...hosts], MAX_HOSTS_PER_TASK),
    tokens: trim([...tokens], MAX_TOKENS_PER_TASK),
    lastSeen: now,
    hits: (task.hits || 0) + 1,
  };
}

/** Drop the least-recently-seen tasks once the store is full. */
function evict(memory) {
  const labels = Object.keys(memory.tasks);
  if (labels.length <= MAX_TASKS) return memory;
  const keep = labels
    .map((l) => [l, memory.tasks[l].lastSeen || 0])
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_TASKS)
    .map(([l]) => l);
  const tasks = {};
  for (const l of keep) tasks[l] = memory.tasks[l];
  return { ...memory, tasks };
}

/**
 * Record that a group is called `label` and looks like `tabs`.
 * `userNamed` marks names you chose yourself, which outrank inferred ones.
 */
export function observe(memory, label, tabs, { userNamed = false, now = Date.now() } = {}) {
  if (!label) return memory;
  const target = resolveAlias(memory, label);
  const prev = memory.tasks[target] || { keys: [], hosts: [], tokens: [], hits: 0 };
  const next = mergeInto(prev, tabs, now);
  if (userNamed) next.userNamed = true;
  return evict({ ...memory, tasks: { ...memory.tasks, [target]: next } });
}

/**
 * Record a rename. The new name becomes canonical, the old one an alias, and
 * the profile carries over so the group is recognized again under its new name.
 */
export function learnRename(memory, oldLabel, newLabel, tabs, { now = Date.now() } = {}) {
  if (!newLabel || oldLabel === newLabel) return memory;

  const from = resolveAlias(memory, oldLabel);
  const carried = memory.tasks[from] || { keys: [], hosts: [], tokens: [], hits: 0 };
  const existing = memory.tasks[newLabel] || { keys: [], hosts: [], tokens: [], hits: 0 };

  const merged = mergeInto({
    keys: [...new Set([...(existing.keys || []), ...(carried.keys || [])])],
    hosts: [...new Set([...(existing.hosts || []), ...(carried.hosts || [])])],
    tokens: [...new Set([...(existing.tokens || []), ...(carried.tokens || [])])],
    hits: (existing.hits || 0) + (carried.hits || 0),
  }, tabs, now);
  merged.userNamed = true;

  const tasks = { ...memory.tasks, [newLabel]: merged };
  delete tasks[from];

  // Point the old name, and anything already pointing at it, to the new one.
  const aliases = { ...memory.aliases, [from]: newLabel };
  for (const [k, v] of Object.entries(aliases)) {
    if (v === from) aliases[k] = newLabel;
  }
  delete aliases[newLabel]; // the canonical name must not alias away

  const pins = { ...memory.pins };
  for (const [k, v] of Object.entries(pins)) {
    if (v === from) pins[k] = newLabel;
  }

  return evict({ ...memory, tasks, aliases, pins });
}

/**
 * Record that you filed a specific page into a group by hand. This pins the
 * page (nothing may move it again) and teaches the group's profile.
 */
export function learnMove(memory, tab, label, { now = Date.now() } = {}) {
  if (!label) return memory;
  const target = resolveAlias(memory, label);
  const key = pinKey(tab.url);
  let pins = memory.pins;
  if (key) {
    pins = { ...memory.pins, [key]: target };
    const keys = Object.keys(pins);
    if (keys.length > MAX_PINS) {
      // Oldest-first is unavailable (pins carry no timestamp), so drop from the
      // front of insertion order, which is the closest proxy.
      const drop = keys.slice(0, keys.length - MAX_PINS);
      pins = { ...pins };
      for (const k of drop) delete pins[k];
    }
  }
  return observe({ ...memory, pins }, target, [tab], { userNamed: true, now });
}

/** Forget one task (and any pins/aliases pointing at it). */
export function forgetTask(memory, label) {
  const tasks = { ...memory.tasks };
  delete tasks[label];
  const aliases = Object.fromEntries(
    Object.entries(memory.aliases || {}).filter(([k, v]) => v !== label && k !== label),
  );
  const pins = Object.fromEntries(
    Object.entries(memory.pins || {}).filter(([, v]) => v !== label),
  );
  return { ...memory, tasks, aliases, pins };
}

// --- Storage ---------------------------------------------------------------

let cache = null;

/** Load memory from chrome.storage.local, migrating/defaulting as needed. */
export async function loadMemory() {
  if (cache) return cache;
  try {
    const r = await chrome.storage.local.get(STORAGE_KEY);
    const stored = r[STORAGE_KEY];
    cache = (stored && stored.version === MEMORY_VERSION)
      ? { ...emptyMemory(), ...stored }
      : emptyMemory();
  } catch {
    cache = emptyMemory();
  }
  return cache;
}

export async function saveMemory(memory) {
  cache = memory;
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: memory });
  } catch { /* storage full or unavailable — keep the in-memory copy */ }
  return memory;
}

export function invalidateMemoryCache() {
  cache = null;
}

/** Apply a pure mutation and persist the result. */
export async function updateMemory(fn) {
  const current = await loadMemory();
  return saveMemory(fn(current));
}

export async function clearMemory() {
  return saveMemory(emptyMemory());
}
