/**
 * The grouping pipeline, as a pure function.
 *
 * Every decision about which group a tab belongs to is made here, with no
 * Chrome APIs and no I/O. tabManager.js applies the result to real tab groups;
 * scripts/bench.mjs runs the very same code over recorded tab sets to score it.
 * Grouping quality is the whole product, so it needs to be measurable without a
 * browser in the loop.
 *
 * Resolution order, most authoritative first:
 *
 *   1. pin      — you dragged this exact page into a group. Nothing overrides
 *                 a direct instruction, so this outranks even a pinned rule:
 *                 the rule is a standing policy, the drag is you overriding it.
 *   2. rule     — a pinned rule you configured.
 *   3. internal — infrastructure keeps deterministic per-host groups.
 *   4. cluster  — everything else is clustered by link trail and shared task
 *                 key, then each cluster is named by, in order: a task you have
 *                 grouped before (learned), the model (ai), or its own titles
 *                 (summary).
 *
 * Each tab comes back with both the label and *why*, which is what lets the UI
 * explain itself and lets a correction be aimed at the right stage.
 */

import { subdomainGroupLabel, fallbackGroupLabel } from './url.js';
import { clusterTabs, nameCluster } from './affinity.js';
import { buildContext, RELATED_THRESHOLD } from './context.js';
import { recallPin, recallForTabs, resolveAlias, emptyMemory } from './taskMemory.js';
import { consolidateLabels } from './aiGrouper.js';

/** Why a tab ended up where it did, in the order we try them. */
export const REASONS = {
  pin: 'You filed this page here',
  rule: 'Matches a pinned rule',
  internal: 'Internal host, grouped by subdomain',
  learned: 'Matches a task you grouped before',
  related: 'Shares work with tabs already in this group',
  ai: 'Named by on-device AI',
  summary: 'Named from the tab titles',
  host: 'Fallback: grouped by site',
  misc: 'Too few tabs to form a group',
};

/**
 * Has this tab loaded enough to be judged?
 *
 * A title that is missing, or that is just the URL echoed back, means the page
 * has not said what it is yet. Grouping on that leaves only the hostname to go
 * on — exactly the inference to avoid — so the tab is left loose until it can
 * answer for itself.
 */
export function hasSettled(tab) {
  const title = (tab.title || '').trim();
  if (!title) return false;
  if (title === tab.url) return false;
  try {
    // Chrome shows the bare host or path as a placeholder title while loading.
    const u = new URL(tab.url);
    if (title === u.hostname || title === u.hostname.replace(/^www\./i, '')) return false;
    if (title === `${u.hostname}${u.pathname}`) return false;
  } catch { /* not a URL */ }
  return true;
}

/** Substitute $1, $2… in a label template with regex capture groups. */
function applyTemplate(template, m) {
  if (!template) return null;
  if (!m) return template;
  return template.replace(/\$(\d+)/g, (_, n) => m[Number(n)] ?? '');
}

/**
 * Apply a pinned rule to a URL, returning a forced label or null.
 *
 * Two rule kinds, both tested against "hostname + path":
 *   - { match, label }    — `match` is a case-insensitive substring; fixed label.
 *   - { pattern, label }  — `pattern` is a regex; the label may use $1, $2…
 *                           capture references (e.g. group Jira by project key).
 *
 * Rules are evaluated in order; the first match wins, so list specific rules
 * first (a capture rule before a broad substring rule for the same host).
 */
export function pinnedLabelFor(url, pinnedRules) {
  if (!pinnedRules || pinnedRules.length === 0) return null;
  let raw = '';
  try {
    const u = new URL(url);
    raw = u.hostname + u.pathname; // original case (capture groups need it)
  } catch { return null; }
  const lower = raw.toLowerCase();

  for (const rule of pinnedRules) {
    if (!rule) continue;
    if (rule.pattern) {
      try {
        const m = raw.match(new RegExp(rule.pattern));
        if (m) {
          const label = applyTemplate(rule.label, m);
          if (label) return label;
        }
      } catch { /* invalid regex — skip */ }
    } else if (rule.match && lower.includes(rule.match.toLowerCase())) {
      return rule.label || null;
    }
  }
  return null;
}

/** Scope options for the deterministic host rule, drawn from settings. */
export function hostRuleOpts(settings) {
  return {
    scope: settings.subdomainScope === 'all' ? 'all' : 'internal',
    internalDomains: settings.internalDomains || [],
    clusterServiceTokens: settings.clusterServiceTokens || [],
  };
}

/**
 * Decide a group for every tab.
 *
 * @param {Array<{id:number,url:string,title?:string,openerTabId?:number}>} tabs
 * @param {object} [opts]
 * @param {object} [opts.settings]
 * @param {object} [opts.memory]        task memory (see lib/taskMemory.js)
 * @param {Function} [opts.proposeMerges]
 *   `async (groups) => [[labelA, labelB], ...]`. Omit to skip the merge pass.
 * @param {Function} [opts.nameClusters]
 *   `async (clusters, {projectMode}) => Map<tabId, label>`. Omit to name
 *   clusters from their titles instead, which is what happens when the
 *   on-device model is unavailable.
 * @returns {Promise<{
 *   assignments: Map<number,{label:string, reason:string, via:string}>,
 *   byLabel: Map<string, number[]>,
 *   exempt: Set<string>,
 *   clusters: Array<object>,
 * }>}
 */
export async function resolveGroups(tabs, opts = {}) {
  const settings = opts.settings || {};
  const memory = opts.memory || emptyMemory();
  const nameClusters = opts.nameClusters || null;
  const proposeMerges = opts.proposeMerges || null;

  const assignments = new Map();
  const exempt = new Set();
  const forClusters = [];

  const assign = (tabId, label, reason, via = 'alone') => {
    assignments.set(tabId, { label, reason, via });
  };

  // --- Stages 1-3: per-tab short circuits, most authoritative first ---------
  const hostOpts = hostRuleOpts(settings);
  for (const tab of tabs || []) {
    const pinned = recallPin(memory, tab);
    if (pinned) {
      exempt.add(pinned);
      assign(tab.id, pinned, 'pin');
      continue;
    }

    const ruled = pinnedLabelFor(tab.url, settings.pinnedRules);
    if (ruled) {
      exempt.add(ruled);
      assign(tab.id, ruled, 'rule');
      continue;
    }

    const internal = subdomainGroupLabel(tab.url, settings.subdomainStrategy, hostOpts);
    if (internal) {
      exempt.add(internal);
      assign(tab.id, internal, 'internal');
      continue;
    }

    forClusters.push(tab);
  }

  // --- Stage 4: cluster, then name each cluster ----------------------------
  const clusters = clusterTabs(forClusters, {
    useOpeners: settings.useOpenerAffinity !== false,
    threshold: settings.relatedThreshold,
  });

  // A task you have grouped before wins over a fresh guess: it is your own past
  // decision, and reusing it is what makes corrections stick.
  const unnamed = [];
  for (const cluster of clusters) {
    const recalled = recallForTabs(memory, cluster.tabs);
    if (recalled) {
      exempt.add(recalled.label);
      cluster.label = recalled.label;
      cluster.reason = 'learned';
      for (const t of cluster.tabs) {
        assign(t.id, recalled.label, 'learned', cluster.via.get(t.id) || 'alone');
      }
    } else {
      unnamed.push(cluster);
    }
  }

  if (unnamed.length > 0) {
    let named = null;
    if (nameClusters) {
      try {
        named = await nameClusters(unnamed, { projectMode: settings.aiProjectMode });
      } catch {
        named = null; // model failed — fall through to title-derived names
      }
    }

    for (const cluster of unnamed) {
      const fromModel = named ? named.get(cluster.tabs[0].id) : null;
      const label = fromModel
        || nameCluster(cluster)
        || cluster.tabs.map((t) => fallbackGroupLabel(t.url)).find(Boolean);
      if (!label) continue; // nothing nameable (e.g. an odd URL)

      const reason = fromModel ? 'ai' : (nameCluster(cluster) ? 'summary' : 'host');
      cluster.label = label;
      cluster.reason = reason;
      // A cluster naming real work is a real task however small, and a
      // deterministic name is intentional; neither should be swept into "Other".
      if (cluster.hasIdentity || reason !== 'ai') exempt.add(label);
      for (const t of cluster.tabs) {
        assign(t.id, label, reason, cluster.via.get(t.id) || 'alone');
      }
    }
  }

  // --- Your names replace proposed ones, then near-duplicates merge ---------
  for (const [id, a] of assignments) {
    const aliased = resolveAlias(memory, a.label);
    if (aliased !== a.label) {
      if (exempt.has(a.label)) exempt.add(aliased);
      assignments.set(id, { ...a, label: aliased });
    }
  }

  const flat = new Map([...assignments].map(([id, a]) => [id, a.label]));
  const consolidated = consolidateLabels(flat);
  for (const [id, label] of consolidated) {
    const a = assignments.get(id);
    if (a.label !== label) {
      if (exempt.has(a.label)) exempt.add(label);
      assignments.set(id, { ...a, label });
    }
  }

  // --- Ask the model which groups are the same work ------------------------
  if (proposeMerges) {
    await applyProposedMerges(assignments, tabs, proposeMerges);
  }

  // --- Minimum group size --------------------------------------------------
  const byLabel = new Map();
  for (const [id, a] of assignments) {
    if (!byLabel.has(a.label)) byLabel.set(a.label, []);
    byLabel.get(a.label).push(id);
  }

  const minSize = Math.max(1, settings.minGroupSize || 1);
  const miscLabel = settings.miscLabel || 'Other';
  if (minSize > 1) {
    const misc = [];
    for (const [label, ids] of [...byLabel]) {
      if (exempt.has(label) || label === miscLabel) continue;
      if (ids.length < minSize) {
        misc.push(...ids);
        byLabel.delete(label);
      }
    }
    // Only bucket leftovers when they are worth a group; otherwise leave loose.
    if (misc.length >= minSize) {
      byLabel.set(miscLabel, misc);
      for (const id of misc) {
        assignments.set(id, { ...assignments.get(id), label: miscLabel, reason: 'misc' });
      }
    } else {
      for (const id of misc) assignments.delete(id);
    }
  }

  return { assignments, byLabel, exempt, clusters };
}

/**
 * Which existing group does this tab belong to, if any?
 *
 * A full pass sees every tab at once and clusters them together. A tab arriving
 * on its own gets no such view: without this it can only be placed by a rule,
 * by memory, or by asking the model — so a tab plainly belonging with what is
 * already on screen, sharing its ticket or its subject, would miss its group
 * and wait for the next batch.
 *
 * Scored by the same engine, over the whole window, so rarity is judged against
 * the tabs actually open rather than against the pair in isolation.
 *
 * @param {{id:number,url:string,title?:string}} tab
 * @param {Array<{id:number,url:string,title?:string,group:string}>} others
 *   the window's other tabs, each with the title of the group holding it ('' if
 *   it is loose)
 * @param {{threshold?:number}} [opts]
 * @returns {{label:string, score:number, via:string, why:Array<object>}|null}
 */
export function relatedGroupFor(tab, others, opts = {}) {
  const threshold = opts.threshold ?? RELATED_THRESHOLD;
  const grouped = (others || []).filter((t) => t.group && t.id !== tab.id);
  if (grouped.length === 0) return null;

  const ctx = buildContext([tab, ...(others || []).filter((t) => t.id !== tab.id)]);

  // A group's claim is its best-matching member, not its average: one tab
  // sharing this tab's ticket is decisive however many unrelated tabs sit
  // beside it, and averaging would let a large group dilute that away.
  const best = new Map();
  for (const other of grouped) {
    const r = ctx.relate(tab.id, other.id, threshold);
    if (!r.related) continue;
    const prev = best.get(other.group);
    if (!prev || r.score > prev.score) {
      best.set(other.group, { label: other.group, score: r.score, via: r.basis, why: r.why });
    }
  }
  if (best.size === 0) return null;

  const BASIS_VIA = { identity: 'key', subject: 'topic', container: 'key' };
  const winner = [...best.values()].sort((a, b) => b.score - a.score)[0];
  return { ...winner, via: BASIS_VIA[winner.via] || 'key' };
}

/** Groups the model may be asked about, and the sample it is shown. */
const MERGEABLE_REASONS = new Set(['ai', 'summary']);

/**
 * Let the model merge groups it recognizes as one piece of work.
 *
 * Guarded three ways, because a small model asked to compare things will
 * cheerfully say everything matches, and the layer below it holds precision at
 * 1.00 — the merge pass must not be the thing that spends that.
 *
 *   - Only groups the model or the summarizer named are eligible. A group from
 *     your own filing, a pinned rule, an internal host, or a task you named is
 *     a decision already made, and is never offered.
 *   - At most a third of the eligible groups may be merged away in one pass, so
 *     an answer of "all of these are the same" collapses nothing.
 *   - Merges only. There is no way for this to split a group the deterministic
 *     layer established.
 *
 * @param {Map<number,{label:string,reason:string,via:string}>} assignments
 * @param {Function} propose
 */
async function applyProposedMerges(assignments, tabs, propose) {
  const groups = new Map(); // label → { titles: [], mergeable: boolean }
  for (const [, a] of assignments) {
    if (!groups.has(a.label)) groups.set(a.label, { titles: [], mergeable: true });
    const g = groups.get(a.label);
    if (!MERGEABLE_REASONS.has(a.reason)) g.mergeable = false;
  }

  const eligible = [...groups.entries()]
    .filter(([, g]) => g.mergeable)
    .map(([label]) => label);
  if (eligible.length < 2) return;

  // Titles are what the model judges by, so give it the group's own tabs.
  const titleById = new Map((tabs || []).map((t) => [t.id, t.title || '']));
  const titlesByLabel = new Map(eligible.map((l) => [l, []]));
  for (const [id, a] of assignments) {
    const bucket = titlesByLabel.get(a.label);
    const title = titleById.get(id);
    if (bucket && title) bucket.push(title);
  }

  let pairs;
  try {
    pairs = await propose(eligible.map((label) => ({
      label,
      titles: titlesByLabel.get(label) || [],
    })));
  } catch {
    return; // the model failed; the deterministic grouping stands
  }
  if (!Array.isArray(pairs) || pairs.length === 0) return;

  const canonical = new Map(eligible.map((l) => [l, l]));
  // Follows a chain of merges to the surviving name. Must tolerate a label that
  // is not in the map at all — every protected group is one, and walking off
  // the end would rewrite their label to undefined.
  const resolve = (l) => {
    let cur = l;
    const seen = new Set();
    while (canonical.has(cur) && canonical.get(cur) !== cur && !seen.has(cur)) {
      seen.add(cur);
      cur = canonical.get(cur);
    }
    return cur;
  };

  const cap = Math.max(1, Math.floor(eligible.length / 3));
  let merged = 0;
  for (const pair of pairs) {
    if (merged >= cap) break;
    if (!Array.isArray(pair) || pair.length !== 2) continue;
    const a = resolve(pair[0]);
    const b = resolve(pair[1]);
    if (a === b || !canonical.has(a) || !canonical.has(b)) continue;
    // Keep the name of the larger group; it is the one already on screen.
    const sizeA = [...assignments.values()].filter((x) => x.label === a).length;
    const sizeB = [...assignments.values()].filter((x) => x.label === b).length;
    const [keep, drop] = sizeA >= sizeB ? [a, b] : [b, a];
    canonical.set(drop, keep);
    merged++;
  }
  if (merged === 0) return;

  for (const [id, a] of assignments) {
    const target = resolve(a.label);
    if (target !== a.label) assignments.set(id, { ...a, label: target });
  }
}
