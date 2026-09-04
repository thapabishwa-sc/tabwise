/**
 * AI Grouper — groups tabs by topic using Chrome's built-in, on-device AI
 * (Gemini Nano via the Prompt API / `LanguageModel`).
 *
 * Everything runs locally: tab titles and URLs never leave the machine.
 *
 * Entry points:
 *   - groupClusters(clusters)     → batch labeling for "organize all"
 *   - groupTabs(tabs)             → same, clustering the tabs first
 *   - categorizeTab(tab, labels)  → incremental labeling for a single new tab
 *
 * The model is asked to name the WORK a tab serves, not the site it sits on.
 * Two things make that possible, and neither is the hostname:
 *   - task signals distilled from the URL (ticket key, repo, document id) —
 *     see lib/taskSignal.js. Without these the hostname is the only shared
 *     feature left between tabs, so hostname grouping is all the model can do.
 *   - affinity clusters (lib/affinity.js), passed in as atoms the model names
 *     but never splits, so a task assembled from opener lineage survives.
 *
 * Callers handle genuinely internal hosts deterministically before reaching
 * here, so the model only sees tabs that need real task reasoning.
 *
 * Requires Chrome 138+ with the Prompt API available. Callers should check
 * isAvailable() and skip AI grouping when it returns false.
 */

import { readTask } from './taskSignal.js';
import { clusterTabs } from './affinity.js';
import { looksLikeIdentifier, summarizeTitles } from './summarize.js';

// Keep label strings short and tab-group friendly.
const MAX_LABEL_LEN = 24;

// Gemini Nano has a small context window; cap how many tabs we describe per call.
const BATCH_SIZE = 20;

// One shared session, lazily created and reused across calls.
let sessionPromise = null;

const SYSTEM_PROMPT = [
  'You sort browser tabs by the WORK each one serves, not by the website it is on.',
  'A task is one piece of work: a ticket and its code review, a document and the',
  'research behind it, a bug report and the dashboard showing it.',
  'Rules:',
  '(1) Tabs on DIFFERENT sites often belong together — a ticket, its pull request,',
  'its spec and its dashboard are one task.',
  '(2) Tabs on the SAME site often belong apart — two documents, or two',
  'spreadsheets, can serve unrelated work. The hostname is weak evidence; use it',
  'only to tell apart tabs you have no better signal for.',
  '(3) A [task ...] hint tells you WHICH tabs belong together. It is never the',
  'name. NEVER answer with a ticket id, issue number, repo name, or hash:',
  '"AUTH-482", "AUTH", "Jira: AUTH", "acme/gateway" and "#1203" are all WRONG,',
  'because they force the reader to remember what that id was about.',
  '(4) Say what the work IS, in TWO words, read from the tab titles:',
  '"Auth Migration", "Gift Card", "Q3 Budget", "Checkout Bug", "Memory Limits".',
  'Never name a group after a website ("GitHub", "Gmail", "Docs", "Slack") and',
  'never after a generic activity ("Research", "Reading", "Work", "Other").',
  'Prefer exactly two words, Title Case, max 24 chars; one word is acceptable,',
  'three at the very most. Reuse a label for tabs that belong together and',
  'prefer fewer, broader groups. Never invent tabs.',
].join(' ');

/**
 * Return the Prompt API constructor if this browser exposes it, else null.
 * Handles both the global `LanguageModel` and the older `self.ai.languageModel`.
 */
function getLanguageModel() {
  if (typeof LanguageModel !== 'undefined') return LanguageModel;
  if (typeof self !== 'undefined' && self.ai && self.ai.languageModel) {
    return self.ai.languageModel;
  }
  return null;
}

/**
 * Check whether on-device AI grouping can run right now.
 * @returns {Promise<{available: boolean, status: string}>}
 *   status: 'available' | 'downloadable' | 'downloading' | 'unavailable' | 'no-api'
 */
export async function checkAvailability() {
  const LM = getLanguageModel();
  if (!LM) return { available: false, status: 'no-api' };

  try {
    // Newer API: availability(); older: capabilities().available
    let status;
    if (typeof LM.availability === 'function') {
      status = await LM.availability();
    } else if (typeof LM.capabilities === 'function') {
      const caps = await LM.capabilities();
      status = caps.available === 'readily' ? 'available'
        : caps.available === 'after-download' ? 'downloadable'
        : 'unavailable';
    } else {
      status = 'unavailable';
    }
    return { available: status === 'available', status };
  } catch (e) {
    console.warn('AI Tab Grouper: availability check failed:', e);
    return { available: false, status: 'unavailable' };
  }
}

/** Convenience boolean wrapper. */
export async function isAvailable() {
  const { available } = await checkAvailability();
  return available;
}

/**
 * Create a LanguageModel session. Triggers the on-device model download if
 * needed, reporting progress (0..1) via the optional onProgress callback.
 */
async function createSession(onProgress) {
  const LM = getLanguageModel();
  if (!LM) throw new Error('Prompt API not available');

  const monitor = (m) => {
    m.addEventListener('downloadprogress', (e) => {
      console.log(`AI Tab Grouper: model download ${Math.round(e.loaded * 100)}%`);
      if (onProgress) {
        try { onProgress(e.loaded); } catch { /* noop */ }
      }
    });
  };

  try {
    return await LM.create({
      initialPrompts: [{ role: 'system', content: SYSTEM_PROMPT }],
      // Low temperature: we want stable, repeatable labels.
      temperature: 0.2,
      topK: 3,
      monitor,
    });
  } catch (e) {
    // Some Chrome builds reject unknown create options — retry minimally.
    console.warn('AI Tab Grouper: create with options failed, retrying minimal:', e);
    return await LM.create({
      initialPrompts: [{ role: 'system', content: SYSTEM_PROMPT }],
      monitor,
    });
  }
}

/**
 * Get (or lazily create) the shared LanguageModel session.
 * Triggers an on-device model download on first use if needed.
 */
async function getSession() {
  if (sessionPromise) return sessionPromise;
  sessionPromise = createSession();
  return sessionPromise;
}

/**
 * Eagerly download/prepare the on-device model without grouping anything.
 * Reports download progress (0..1) via onProgress, and caches the resulting
 * session for later use.
 *
 * @param {(loaded:number)=>void} [onProgress]
 * @returns {Promise<{ok:boolean, status:string}>}
 */
export async function prepareModel(onProgress) {
  const LM = getLanguageModel();
  if (!LM) return { ok: false, status: 'no-api' };

  try {
    const p = createSession(onProgress);
    sessionPromise = p; // reuse for subsequent grouping calls
    await p;
    return { ok: true, status: 'available' };
  } catch (e) {
    console.warn('AI Tab Grouper: prepareModel failed:', e);
    sessionPromise = null;
    return { ok: false, status: 'unavailable' };
  }
}

/** Tear down the cached session (e.g. on settings change). */
export function resetSession() {
  if (sessionPromise) {
    sessionPromise.then((s) => { try { s.destroy(); } catch { /* noop */ } });
    sessionPromise = null;
  }
}

/** Normalize a raw model label into something safe for a tab group title. */
function cleanLabel(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let label = raw.trim().replace(/^["'\[]+|["'\]]+$/g, '').trim();
  if (!label) return null;
  if (label.length > MAX_LABEL_LEN) label = label.slice(0, MAX_LABEL_LEN).trim();
  return label;
}

/**
 * Keep a label descriptive.
 *
 * Handing the model a `[task: jira AUTH-482]` hint makes it far better at
 * deciding which tabs group together, and also tempts it to answer "AUTH-482" —
 * the one thing a label must never be, since an id tells you nothing about the
 * work when you glance at it later. When that happens, name the group from its
 * tab titles instead.
 *
 * @param {string|null} label   what the model answered
 * @param {string[]} titles     the group's tab titles, used as the fallback
 */
function describeOrRename(label, titles) {
  if (label && !looksLikeIdentifier(label)) return label;
  const summary = summarizeTitles(titles, { maxWords: 2 });
  if (summary && !looksLikeIdentifier(summary)) return summary;
  // Neither usable: keep the model's answer over inventing nothing.
  return label || null;
}

// Extra nudge when project/task grouping is on. The system prompt already
// establishes task-first grouping, so this reinforces rather than contradicts
// it: name the work-stream, and lean further toward merging across sites.
const PROJECT_HINT =
  'Name each group after the specific project or work-stream it serves — what ' +
  'the work is about, in two words — and merge across sites freely when tabs ' +
  'support the same work.\n';

/** Build a compact description line for one tab, task hint included. */
function describeTab(tab, index) {
  const { display, host } = readTask(tab.url);
  const title = (tab.title || '').slice(0, 80);
  const hint = display ? ` [task: ${display}]` : '';
  return `${index}. ${title} <${host}>${hint}`;
}

/**
 * Describe a whole affinity cluster as ONE line. The model names the cluster;
 * the caller fans that label back out to every member tab, so a cluster can
 * never be split apart by batching or by an inattentive model.
 */
function describeCluster(cluster, index) {
  const tabs = cluster.tabs || [];
  const titles = [];
  const hosts = new Set();
  const hints = new Set();

  for (const t of tabs) {
    const { display, host } = readTask(t.url);
    if (host) hosts.add(host);
    if (display) hints.add(display);
    const title = (t.title || '').trim();
    // Keep the first few distinct titles — enough to name the work.
    if (title && titles.length < 3 && !titles.includes(title)) {
      titles.push(title.slice(0, 60));
    }
  }

  const count = tabs.length > 1 ? `[${tabs.length} tabs] ` : '';
  const hostList = [...hosts].slice(0, 3).join(', ');
  const hintList = [...hints].slice(0, 2).join('; ');
  const hint = hintList ? ` [task: ${hintList}]` : '';
  return `${index}. ${count}${titles.join(' \u00b7 ')} <${hostList}>${hint}`;
}

/**
 * Parse the model's JSON response into a Map of index → label.
 * Tolerates code fences and stray prose around the JSON.
 */
function parseLabelResponse(text) {
  const map = new Map();
  if (!text) return map;
  let json = text.trim();
  const fence = json.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) json = fence[1].trim();

  let arr;
  try {
    arr = JSON.parse(json);
  } catch {
    // Try to extract the first [...] block
    const m = json.match(/\[[\s\S]*\]/);
    if (!m) return map;
    try { arr = JSON.parse(m[0]); } catch { return map; }
  }

  if (!Array.isArray(arr)) return map;
  for (const item of arr) {
    if (item == null) continue;
    const idx = Number(item.index ?? item.i);
    const label = cleanLabel(item.label ?? item.group ?? item.l);
    if (Number.isInteger(idx) && label) map.set(idx, label);
  }
  return map;
}

/**
 * JSON schema used to constrain model output (Chrome 137+ responseConstraint).
 */
const RESPONSE_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      index: { type: 'integer' },
      label: { type: 'string' },
    },
    required: ['index', 'label'],
  },
};

/** Prompt the session, using responseConstraint when supported. */
async function promptForLabels(session, userPrompt) {
  try {
    return await session.prompt(userPrompt, { responseConstraint: RESPONSE_SCHEMA });
  } catch (e) {
    // Older builds don't support responseConstraint — prompt plainly.
    return await session.prompt(userPrompt);
  }
}

/** Fraction of a session's input quota already consumed, or 0 if unknowable. */
function usageFraction(session) {
  const used = session.inputUsage ?? session.tokensSoFar;
  const quota = session.inputQuota ?? session.maxTokens;
  if (typeof used !== 'number' || typeof quota !== 'number' || quota <= 0) return 0;
  return used / quota;
}

/**
 * Run one prompt in a throwaway context.
 *
 * Every grouping call is an independent classification, not a turn in a
 * conversation — but `session.prompt()` appends to the session's history, and
 * the session here is shared and long-lived. Left alone it accumulates a
 * transcript of every grouping call ever made, which costs twice: the context
 * window fills until prompts start failing (and a failed prompt means those
 * tabs fall back to "Other"), and unrelated earlier decisions leak into later
 * ones, making labels depend on browsing history nobody can see.
 *
 * `clone()` exists for exactly this: a fresh context that keeps the system
 * prompt and drops the history. Where it is unavailable, the shared session is
 * recycled once it has eaten most of its quota, so the failure mode is a
 * rebuilt session rather than a dead one.
 *
 * Cross-batch continuity does not depend on session history — the labels
 * already in use are restated in each prompt — so nothing is lost.
 */
async function promptOnce(userPrompt) {
  let base = await getSession();

  if (typeof base.clone === 'function') {
    let copy = null;
    try {
      copy = await base.clone();
    } catch { /* clone unsupported at runtime — fall through to reuse */ }
    if (copy) {
      try {
        return await promptForLabels(copy, userPrompt);
      } finally {
        try { copy.destroy(); } catch { /* already gone */ }
      }
    }
  }

  // No clone: keep the shared session usable by replacing it before it fills.
  if (usageFraction(base) > 0.6) {
    resetSession();
    base = await getSession();
  }
  return promptForLabels(base, userPrompt);
}

/**
 * Normalize a label for equality testing: case-, punctuation-, plural- and
 * word-order-insensitive. "Auth Migration", "auth migrations" and
 * "Migration - Auth" all collapse to the same form.
 */
function labelFingerprint(label) {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (w.length > 3 ? w.replace(/s$/, '') : w))
    .sort()
    .join(' ');
}

/**
 * Merge labels that mean the same thing.
 *
 * Batching makes drift inevitable: batch 1 says "Auth Migration", batch 2 says
 * "Auth Migrations", and one task becomes two groups. Only exact-fingerprint
 * matches are merged — deliberately not prefix or substring matches, which
 * would fold "Budget" into "Budget Review" and lose a real distinction.
 * The most frequent spelling wins, since it is the one already on screen.
 *
 * @param {Map<number,string>} labelsById
 * @returns {Map<number,string>}
 */
export function consolidateLabels(labelsById) {
  const counts = new Map(); // fingerprint → Map<label, n>
  for (const label of labelsById.values()) {
    const fp = labelFingerprint(label);
    if (!fp) continue;
    if (!counts.has(fp)) counts.set(fp, new Map());
    const m = counts.get(fp);
    m.set(label, (m.get(label) || 0) + 1);
  }

  const canonical = new Map(); // fingerprint → winning label
  for (const [fp, m] of counts) {
    let best = null;
    let bestN = -1;
    for (const [label, n] of m) {
      // Ties break toward the shorter label, which reads better on a tab strip.
      if (n > bestN || (n === bestN && best && label.length < best.length)) {
        best = label;
        bestN = n;
      }
    }
    canonical.set(fp, best);
  }

  const out = new Map();
  for (const [id, label] of labelsById) {
    const fp = labelFingerprint(label);
    out.set(id, canonical.get(fp) || label);
  }
  return out;
}

/**
 * Label a set of affinity clusters, one line per cluster.
 *
 * Clustering first is what makes cross-site tasks survive: the model sees
 * "[4 tabs] ticket · PR · spec · dashboard" as a single thing to name, instead
 * of four tabs on four hosts it might split four ways. It also cuts the item
 * count, which matters a lot on a small on-device context window.
 *
 * @param {Array<{tabs:Array<{id:number,url:string,title:string}>, key?:string|null}>} clusters
 * @param {{projectMode?: boolean}} [opts]
 * @returns {Promise<Map<number, string>>} tabId → group label
 */
export async function groupClusters(clusters, opts = {}) {
  const result = new Map();
  const list = (clusters || []).filter((c) => c && c.tabs && c.tabs.length > 0);
  if (list.length === 0) return result;

  // Surfaces an unavailable model early, before any prompt is built.
  await getSession();
  const knownLabels = new Set();
  const modeLine = opts.projectMode ? PROJECT_HINT : '';

  for (let start = 0; start < list.length; start += BATCH_SIZE) {
    const chunk = list.slice(start, start + BATCH_SIZE);
    const lines = chunk.map((c, i) => describeCluster(c, i));
    const existing = knownLabels.size
      ? `\nGroup labels already in use — reuse one when the work matches: ${[...knownLabels].join(', ')}.\n`
      : '\n';

    const userPrompt =
      `Name the work each of these ${chunk.length} items belongs to.${existing}${modeLine}` +
      `An item marked [N tabs] is one task already — give it a single label.\n` +
      `Items:\n${lines.join('\n')}\n\n` +
      `Respond with a JSON array of {"index": <number>, "label": "<group>"} for every item.`;

    let labelMap;
    try {
      const raw = await promptOnce(userPrompt);
      labelMap = parseLabelResponse(raw);
    } catch (e) {
      console.warn('AI Tab Grouper: groupClusters chunk failed:', e);
      labelMap = new Map();
    }

    for (let i = 0; i < chunk.length; i++) {
      const titles = chunk[i].tabs.map((t) => t.title || '');
      const chosen = describeOrRename(labelMap.get(i), titles);
      const label = chosen || summarizeTitles(titles, { maxWords: 2 }) || 'Other';
      // Fan the cluster's one label out to all of its tabs.
      for (const tab of chunk[i].tabs) result.set(tab.id, label);
      // Only offer labels the model actually chose to later batches. 'Other' is
      // a marker for a failed line, and advertising it invites the model to keep
      // dumping tabs there.
      if (chosen) knownLabels.add(chosen);
    }
  }

  return consolidateLabels(result);
}

/**
 * Batch-group a list of tabs: cluster by affinity, then label the clusters.
 *
 * @param {Array<{id:number, url:string, title:string, openerTabId?:number}>} tabs
 * @param {{projectMode?: boolean, useOpeners?: boolean}} [opts]
 * @returns {Promise<Map<number, string>>} tabId → group label
 */
export async function groupTabs(tabs, opts = {}) {
  if (!tabs || tabs.length === 0) return new Map();
  const clusters = clusterTabs(tabs, { useOpeners: opts.useOpeners });
  return groupClusters(clusters, opts);
}

/**
 * Group tabs according to a free-form user instruction, e.g.
 * "group by project", "put all AWS tabs together", "merge Docs and Research".
 *
 * @param {Array<{id:number, url:string, title:string, group?:string}>} tabs
 * @param {string} instruction
 * @returns {Promise<Map<number, string>>} tabId → group label
 */
export async function groupByInstruction(tabs, instruction) {
  const result = new Map();
  if (!tabs || tabs.length === 0) return result;

  await getSession();

  for (let start = 0; start < tabs.length; start += BATCH_SIZE) {
    const chunk = tabs.slice(start, start + BATCH_SIZE);
    const lines = chunk.map((t, i) => {
      const base = describeTab(t, i);
      return t.group ? `${base} [now in: ${t.group}]` : base;
    });

    const userPrompt =
      `Reorganize these tabs into groups following this instruction:\n` +
      `"${instruction}"\n\n` +
      `Assign each tab a short group label (1-3 words, Title Case, max 24 chars). ` +
      `Reuse labels for tabs that belong together.\n` +
      `Tabs:\n${lines.join('\n')}\n\n` +
      `Respond with a JSON array of {"index": <number>, "label": "<group>"} for every tab.`;

    let labelMap;
    try {
      const raw = await promptOnce(userPrompt);
      labelMap = parseLabelResponse(raw);
    } catch (e) {
      console.warn('AI Tab Grouper: groupByInstruction chunk failed:', e);
      labelMap = new Map();
    }

    for (let i = 0; i < chunk.length; i++) {
      const label = labelMap.get(i) || chunk[i].group || 'Other';
      result.set(chunk[i].id, label);
    }
  }

  return consolidateLabels(result);
}

/**
 * Categorize a single tab, preferring to slot it into an existing group.
 *
 * @param {{id:number, url:string, title:string}} tab
 * @param {string[]} existingLabels - current group titles in the window
 * @param {{projectMode?: boolean}} [opts]
 * @returns {Promise<string|null>} chosen label, or null on failure
 */
export async function categorizeTab(tab, existingLabels = [], opts = {}) {
  await getSession();

  const existing = existingLabels.length
    ? `Existing groups (reuse one if it fits): ${existingLabels.join(', ')}.\n`
    : 'There are no groups yet.\n';
  const modeLine = opts.projectMode ? PROJECT_HINT : '';

  const userPrompt =
    `Assign a single group label to this tab.\n${existing}${modeLine}` +
    `Tab:\n${describeTab(tab, 0)}\n\n` +
    `Respond with a JSON array containing exactly one object: ` +
    `[{"index": 0, "label": "<group>"}].`;

  try {
    const raw = await promptOnce(userPrompt);
    const map = parseLabelResponse(raw);
    return describeOrRename(map.get(0) || null, [tab.title || '']);
  } catch (e) {
    console.warn('AI Tab Grouper: categorizeTab failed:', e);
    return null;
  }
}

/**
 * Ask the model which of these groups are the same work.
 *
 * Merging already happens by accident: two clusters handed the same name are
 * folded together, and the model is told which names are in use. But it is
 * never asked to *compare* groups, so a merge depends on it independently
 * choosing identical wording for both — which is a coincidence to rely on.
 *
 * This asks directly. It is the one job the model is better at than the
 * deterministic layer: whether AUTH-482 and AUTH-495 are one effort cannot be
 * read off a URL, and the layer below correctly refuses to guess (its precision
 * is 1.00, and every remaining error is a merge it declined to invent).
 *
 * Only merges are accepted, never splits, and the caller decides which groups
 * are eligible to be offered at all.
 *
 * @param {Array<{label:string, titles:string[]}>} groups
 * @returns {Promise<Array<[string,string]>>} pairs of labels to merge
 */
export async function proposeMerges(groups) {
  const list = (groups || []).filter((g) => g && g.label);
  // Below two there is nothing to compare; above a dozen the prompt stops
  // fitting a small context window and the answers get worse, not better.
  if (list.length < 2 || list.length > 12) return [];

  await getSession();

  const lines = list.map((g, i) => {
    const sample = (g.titles || []).slice(0, 3).map((t) => t.slice(0, 60)).join(' \u00b7 ');
    return `${i}. "${g.label}" — ${sample}`;
  });

  const userPrompt =
    'Here are groups of browser tabs, each a separate piece of work.\n'
    + 'Say which pairs are actually the SAME piece of work and should be one group.\n'
    + 'Two groups are the same work only if they serve one goal — a ticket and '
    + 'the change implementing it, two tickets in one effort. Two groups about '
    + 'similar subjects, or in the same tool, or for the same team, are NOT the '
    + 'same work. Most pairs are not. Answer with an empty array if none are.\n'
    + `Groups:\n${lines.join('\n')}\n\n`
    + 'Respond with a JSON array of {"a": <number>, "b": <number>} for pairs to merge.';

  let raw;
  try {
    raw = await promptOnce(userPrompt);
  } catch (e) {
    console.warn('AI Tab Grouper: proposeMerges failed:', e);
    return [];
  }

  let parsed;
  try {
    let json = String(raw || '').trim();
    const fence = json.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) json = fence[1].trim();
    const m = json.match(/\[[\s\S]*\]/);
    parsed = JSON.parse(m ? m[0] : json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out = [];
  const seen = new Set();
  for (const item of parsed) {
    if (!item) continue;
    const a = Number(item.a ?? item.A ?? item[0]);
    const b = Number(item.b ?? item.B ?? item[1]);
    if (!Number.isInteger(a) || !Number.isInteger(b) || a === b) continue;
    if (!list[a] || !list[b]) continue;
    const key = [Math.min(a, b), Math.max(a, b)].join(':');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push([list[a].label, list[b].label]);
  }
  return out;
}

/** JSON schema for the merge answer, when the build supports constraints. */
export const MERGE_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: { a: { type: 'integer' }, b: { type: 'integer' } },
    required: ['a', 'b'],
  },
};
