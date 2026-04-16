/**
 * AI Grouper — groups tabs by topic using Chrome's built-in, on-device AI
 * (Gemini Nano via the Prompt API / `LanguageModel`).
 *
 * Everything runs locally: tab titles and URLs never leave the machine.
 *
 * Two entry points:
 *   - groupTabs(tabs)             → batch labeling for "organize all"
 *   - categorizeTab(tab, labels)  → incremental labeling for a single new tab
 *
 * Callers handle subdomain-based hosts deterministically before reaching here,
 * so the model only sees tabs that genuinely need topic grouping.
 *
 * Requires Chrome 138+ with the Prompt API available. Callers should check
 * isAvailable() and skip AI grouping when it returns false.
 */

// Keep label strings short and tab-group friendly.
const MAX_LABEL_LEN = 24;

// Gemini Nano has a small context window; cap how many tabs we describe per call.
const BATCH_SIZE = 20;

// One shared session, lazily created and reused across calls.
let sessionPromise = null;

const SYSTEM_PROMPT = [
  'You organize browser tabs into groups by topic or project.',
  'Given tabs (title + URL + hostname), assign each a short group label',
  '(1-3 words, Title Case, max 24 chars). Reuse the same label for tabs that',
  'belong together. Prefer fewer, broader groups over many tiny ones.',
  'The hostname is an important signal: tabs on different websites usually',
  'belong to different groups unless they clearly share a topic.',
  'Group by the real topic — e.g. "GitHub", "Docs", "Email", "Shopping",',
  '"Research". Never invent tabs that were not given.',
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

/** Build a compact description line for one tab. */
function describeTab(tab, index) {
  let host = '';
  try { host = new URL(tab.url).host; } catch { /* about:blank etc. */ }
  const title = (tab.title || '').slice(0, 80);
  return `${index}. ${title} <${host}>`;
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

/**
 * Batch-group a list of tabs.
 *
 * @param {Array<{id:number, url:string, title:string}>} tabs
 * @returns {Promise<Map<number, string>>} tabId → group label
 */
export async function groupTabs(tabs) {
  const result = new Map();
  if (!tabs || tabs.length === 0) return result;

  const session = await getSession();
  const knownLabels = new Set();

  for (let start = 0; start < tabs.length; start += BATCH_SIZE) {
    const chunk = tabs.slice(start, start + BATCH_SIZE);

    const lines = chunk.map((t, i) => describeTab(t, i));
    const existing = knownLabels.size
      ? `\nExisting group labels you should reuse when appropriate: ${[...knownLabels].join(', ')}.\n`
      : '\n';

    const userPrompt =
      `Group these ${chunk.length} tabs.${existing}` +
      `Tabs:\n${lines.join('\n')}\n\n` +
      `Respond with a JSON array of {"index": <number>, "label": "<group>"} for every tab.`;

    let labelMap;
    try {
      const raw = await promptForLabels(session, userPrompt);
      labelMap = parseLabelResponse(raw);
    } catch (e) {
      console.warn('AI Tab Grouper: groupTabs chunk failed:', e);
      labelMap = new Map();
    }

    for (let i = 0; i < chunk.length; i++) {
      const label = labelMap.get(i) || 'Other';
      result.set(chunk[i].id, label);
      knownLabels.add(label);
    }
  }

  return result;
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

  const session = await getSession();

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
      const raw = await promptForLabels(session, userPrompt);
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

  return result;
}

/**
 * Categorize a single tab, preferring to slot it into an existing group.
 *
 * @param {{id:number, url:string, title:string}} tab
 * @param {string[]} existingLabels - current group titles in the window
 * @returns {Promise<string|null>} chosen label, or null on failure
 */
export async function categorizeTab(tab, existingLabels = []) {
  const session = await getSession();

  const existing = existingLabels.length
    ? `Existing groups (reuse one if it fits): ${existingLabels.join(', ')}.\n`
    : 'There are no groups yet.\n';

  const userPrompt =
    `Assign a single group label to this tab.\n${existing}` +
    `Tab:\n${describeTab(tab, 0)}\n\n` +
    `Respond with a JSON array containing exactly one object: ` +
    `[{"index": 0, "label": "<group>"}].`;

  try {
    const raw = await promptForLabels(session, userPrompt);
    const map = parseLabelResponse(raw);
    return map.get(0) || null;
  } catch (e) {
    console.warn('AI Tab Grouper: categorizeTab failed:', e);
    return null;
  }
}
