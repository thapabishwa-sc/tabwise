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

import {
  extractFeatures, profileFeaturesOf, scoreAgainstProfile,
} from './context.js';
import { titleTokens } from './summarize.js';

const STORAGE_KEY = 'taskMemory';
// 4: profiles stored host and path prefixes, which caused false recalls.
// 5: generated document ids are namespaced by host, so their old un-namespaced
//    keys can never match again.
// 6: automatic groupings are no longer learned, so profiles that were never
//    named by the user are dropped — those are exactly the ones a guess made.
export const MEMORY_VERSION = 6;

/** Caps, so memory stays small and a stale profile can't grow forever. */
const MAX_FEATURES_PER_TASK = 48;
const MAX_TASKS = 200;
const MAX_PINS = 500;

/**
 * Subject-matter evidence needed to recognize a task that nothing identifies
 * outright. Roughly two distinctive words.
 *
 * Higher than the pairwise threshold in lib/context.js because no rarity
 * discount applies here: a profile knows nothing about what else is open, so
 * its scores are not divided down.
 */
const RECALL_THRESHOLD = 1.0;

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
 * Find the learned task that best matches a set of tabs.
 *
 * Scored by lib/context.js against each stored profile, using the same feature
 * vocabulary and the same weight table as pairwise relatedness — so what counts
 * as evidence is defined in exactly one place. A shared identifier is decisive.
 * Subject words and paths have to add up, because any two tabs on
 * `docs.google.com` share a host and that is precisely the inference this
 * project exists to stop making.
 *
 * @returns {{label:string, score:number, via:string}|null}
 */
export function recallForTabs(memory, tabs) {
  const list = tabs || [];
  if (list.length === 0 || !memory.tasks) return null;

  const extracted = list.map(extractFeatures);

  let best = null;
  for (const [label, task] of Object.entries(memory.tasks)) {
    const profile = new Set(task.features || []);
    if (profile.size === 0) continue;

    // Best-matching tab, not the average: one tab carrying the task's ticket
    // settles it however many unrelated tabs are alongside.
    let top = null;
    for (const e of extracted) {
      const s = scoreAgainstProfile(e, profile);
      const total = s.identity + s.subject + s.container;
      if (!top || total > top.total) top = { ...s, total };
    }
    if (!top) continue;

    // Container evidence cannot carry a recall, only corroborate one. Sharing a
    // host or a wiki space with a remembered task says the tab is in the same
    // place, which is the inference this project exists to refuse — and a
    // profile has no rarity discount to keep it honest.
    const confident = top.identity > 0 || top.subject >= RECALL_THRESHOLD;
    if (!confident) continue;

    // A name you chose yourself breaks ties in its own favor.
    const score = top.total + (task.userNamed ? 1 : 0);
    if (!best || score > best.score) {
      best = {
        label: resolveAlias(memory, label),
        score,
        via: top.identity > 0 ? 'key' : 'topic',
      };
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
  // A signal you deleted stays deleted. Without this, editing a profile would
  // be futile: the next pass that saw the same tabs would put the signal
  // straight back, and the edit would look like it never happened.
  const blocked = new Set(task.blocked || []);
  const features = new Set((task.features || []).filter((f) => !blocked.has(f)));
  for (const t of tabs || []) {
    for (const key of profileFeaturesOf(t)) {
      if (!blocked.has(key)) features.add(key);
    }
  }
  return {
    ...task,
    features: trim([...features], MAX_FEATURES_PER_TASK),
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
  const prev = memory.tasks[target] || { features: [], hits: 0 };
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
  const carried = memory.tasks[from] || { features: [], hits: 0 };
  const existing = memory.tasks[newLabel] || { features: [], hits: 0 };

  const merged = mergeInto({
    features: [...new Set([...(existing.features || []), ...(carried.features || [])])],
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

/**
 * Remove one signal from a task, and remember not to learn it again.
 *
 * The useful unit of correction is often a single bad signal rather than the
 * whole task: a profile that picked up "org" from a queue's bracketed tags is
 * worth keeping once that one word is gone.
 */
export function forgetFeature(memory, label, feature) {
  const target = resolveAlias(memory, label);
  const task = memory.tasks[target];
  if (!task) return memory;

  const next = {
    ...task,
    features: (task.features || []).filter((f) => f !== feature),
    blocked: [...new Set([...(task.blocked || []), feature])],
  };
  return { ...memory, tasks: { ...memory.tasks, [target]: next } };
}

/**
 * Add a signal to a task by hand — "this work is also about billing".
 *
 * Adding un-blocks it too, so a signal removed and then re-added behaves the
 * way you would expect rather than being silently suppressed forever.
 */
export function addFeature(memory, label, feature) {
  const target = resolveAlias(memory, label);
  const task = memory.tasks[target];
  if (!task || !feature) return memory;

  const next = {
    ...task,
    features: trim([...new Set([...(task.features || []), feature])], MAX_FEATURES_PER_TASK),
    blocked: (task.blocked || []).filter((f) => f !== feature),
  };
  return { ...memory, tasks: { ...memory.tasks, [target]: next } };
}

/**
 * Rename a learned task directly, without a group to read tabs from.
 * learnRename does the same thing when a real group is being renamed; this is
 * for editing the list itself.
 */
export function renameTask(memory, oldLabel, newLabel) {
  const name = String(newLabel || '').trim();
  if (!name || name === oldLabel) return memory;
  return learnRename(memory, oldLabel, name, []);
}

/** Turn a typed word into the feature key the engine would have produced. */
export function wordFeature(text) {
  const words = titleTokens(String(text || ''));
  return words.length > 0 ? `word:${words[0]}` : null;
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
    cache = migrate(r[STORAGE_KEY]);
  } catch {
    cache = emptyMemory();
  }
  return cache;
}

/**
 * Bring a stored memory up to the current shape.
 *
 * Signals that can no longer match are dropped and the rest is kept, rather
 * than wiping everything: what you taught it is mostly work items and words,
 * and those are still good. Only the keys whose format changed are lost, and
 * they were dead weight either way.
 */
function migrate(stored) {
  if (!stored || typeof stored !== 'object') return emptyMemory();
  if (stored.version === MEMORY_VERSION) return { ...emptyMemory(), ...stored };
  if (!stored.tasks) return emptyMemory();

  const dead = (key) => (
    // v4 removed these from profiles entirely.
    key.startsWith('path:') || key.startsWith('host:')
    // v5 namespaced these by host; the old form has no '/' after the kind.
    || ((key.startsWith('opaque:') || key.startsWith('item:'))
      && !key.slice(key.indexOf(':') + 1).includes('/'))
  );

  const tasks = {};
  for (const [label, task] of Object.entries(stored.tasks)) {
    // v6: a profile that was never named by the user came from an automatic
    // grouping, and those are no longer learned at all. Dropping them clears
    // out whatever earlier guesses had accumulated, while keeping every task
    // that was actually renamed, dragged into place, or captured by hand.
    if (!task.userNamed) continue;

    const features = (task.features || []).filter((f) => !dead(f));
    // A profile with nothing matchable left is not worth keeping.
    if (features.length === 0) continue;
    tasks[label] = { ...task, features, blocked: (task.blocked || []).filter((f) => !dead(f)) };
  }

  return { ...emptyMemory(), ...stored, version: MEMORY_VERSION, tasks };
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
