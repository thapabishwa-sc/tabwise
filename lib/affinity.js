/**
 * Tab affinity — deciding which tabs belong to the same piece of work before
 * any AI is involved.
 *
 * Two tabs are joined when either holds:
 *   1. One was opened from the other (`openerTabId`). Following a link from a
 *      ticket to its pull request is the single most reliable "same work"
 *      signal the browser gives us — and it is free.
 *   2. The context engine (lib/context.js) scores them as the same work, from
 *      shared identifiers, shared containers and shared subject matter, each
 *      weighted by how rare it is across the tabs you actually have open.
 *
 * The scoring lives in lib/context.js and carries no per-site rules, so a team
 * on an in-house tracker gets the same treatment as one on Jira. This module
 * turns those pairwise judgements into clusters, and records why each tab
 * landed in its own, which is what the UI shows and what a correction targets.
 *
 * Deliberately NOT used: "opened around the same time". Two unrelated tabs
 * opened back-to-back would merge, which is the same class of error as grouping
 * by hostname — a coincidence of context mistaken for shared purpose.
 *
 * The result is a set of clusters handed to the grouper as atoms: the AI names
 * a cluster, it never splits one.
 */

import { summarizeTitles, looksLikeIdentifier } from './summarize.js';
import { buildContext, leafText, RELATED_THRESHOLD } from './context.js';

/** Minimal union-find over array indices. */
function makeDsu(n) {
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i) => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };
  return { find, union };
}

/**
 * Cluster tabs by opener lineage and shared task keys.
 *
 * @param {Array<{id:number, url:string, title?:string, openerTabId?:number}>} tabs
 * @param {{useOpeners?: boolean}} [opts]
 * @returns {Array<{tabs:Array<object>, key:string|null, via:Map<number,string>}>}
 *   Clusters in input order. `key` is the shared strong task key when the
 *   cluster was formed by one (usable as a deterministic label), else null.
 *   `via` maps each tab id to why it is here — 'trail' (opened from another tab
 *   in this cluster), 'key' (shares a task key), 'topic' (shares distinctive
 *   vocabulary), or 'alone' — which is what the UI needs to answer "why is this
 *   tab in this group?".
 */
export function clusterTabs(tabs, opts = {}) {
  const useOpeners = opts.useOpeners !== false;
  const threshold = opts.threshold ?? RELATED_THRESHOLD;
  const list = tabs || [];
  if (list.length === 0) return [];

  const dsu = makeDsu(list.length);
  const indexById = new Map(list.map((t, i) => [t.id, i]));
  const via = new Array(list.length).fill('alone');

  // --- 1. Opener lineage ---
  if (useOpeners) {
    for (let i = 0; i < list.length; i++) {
      const opener = list[i].openerTabId;
      if (opener == null) continue;
      const parent = indexById.get(opener);
      // Only link when the opener is itself in this grouping pass.
      if (parent !== undefined) {
        dsu.union(parent, i);
        via[i] = 'trail';
      }
    }
  }

  // --- 2. Context scoring over every pair ---
  const ctx = buildContext(list);
  const verdicts = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const r = ctx.relate(list[i].id, list[j].id, threshold);
      if (r.related) verdicts.push({ i, j, ...r });
    }
  }
  verdicts.sort((a, b) => b.score - a.score);

  const BASIS_VIA = { identity: 'key', subject: 'topic', container: 'key' };
  const join = (a, b, basis) => {
    if (dsu.find(a) !== dsu.find(b)) dsu.union(a, b);
    for (const k of [a, b]) {
      if (via[k] === 'alone') via[k] = BASIS_VIA[basis] || 'key';
    }
  };

  // Identity and subject-matter evidence is about the tabs themselves, so it
  // applies directly, strongest first.
  for (const v of verdicts) {
    if (v.basis !== 'container') join(v.i, v.j, v.basis);
  }

  // Container evidence is applied last and collectively, because it is a claim
  // about a PLACE and only makes sense once we know what work is in that place.
  //
  // A tab with no identity of its own belongs to the container's work when the
  // container holds one piece of work — a source file beside the single pull
  // request touching its repo. When the container holds several, that tab
  // belongs to no one in particular, and attaching it to whichever it was
  // compared against first would chain every work item in the container into
  // one group. Judged pair by pair this is invisible; it needs the whole
  // container in view at once.
  const identitiesOfRoot = (i) => {
    const root = dsu.find(i);
    const out = new Set();
    for (let k = 0; k < list.length; k++) {
      if (dsu.find(k) !== root) continue;
      for (const id of ctx.refsOf(list[k].id)) out.add(id);
    }
    return out;
  };

  const byContainer = new Map();
  for (const v of verdicts) {
    if (v.basis !== 'container') continue;
    // The narrowest place the pair has in common is the one being claimed.
    const place = v.why.find((w) => w.kind === 'path') || v.why[0];
    const key = place ? place.key : 'host';
    if (!byContainer.has(key)) byContainer.set(key, new Set());
    byContainer.get(key).add(v.i);
    byContainer.get(key).add(v.j);
  }

  for (const members of byContainer.values()) {
    const list_ = [...members];
    const anchored = list_.filter((i) => identitiesOfRoot(i).size > 0);
    const anchorRoots = new Set(anchored.map((i) => dsu.find(i)));

    if (anchorRoots.size <= 1) {
      for (let k = 1; k < list_.length; k++) join(list_[0], list_[k], 'container');
    } else {
      const floaters = list_.filter((i) => identitiesOfRoot(i).size === 0);
      for (let k = 1; k < floaters.length; k++) join(floaters[0], floaters[k], 'container');
    }
  }

  // --- Collect clusters, preserving input order ---
  const byRoot = new Map();
  for (let i = 0; i < list.length; i++) {
    const root = dsu.find(i);
    if (!byRoot.has(root)) {
      byRoot.set(root, { tabs: [], ids: new Set(), refs: new Set(), via: new Map() });
    }
    const c = byRoot.get(root);
    c.tabs.push(list[i]);
    c.via.set(list[i].id, via[i]);
    for (const id of ctx.refsOf(list[i].id)) {
      c.ids.add(id);
      if (id.startsWith('ref:')) c.refs.add(id.slice(4));
    }
  }

  return [...byRoot.values()].map((c) => ({
    tabs: c.tabs,
    // Two separate questions, previously conflated in `key`:
    //
    //   hasIdentity — does this cluster name real work at all? A ticket with its
    //     pull request holds two identifiers and is emphatically real, so this
    //     is what min-size exemption should consult.
    //   key — is there a single identifier worth showing as a NAME? Only a
    //     reference reads as anything ("AUTH-482"); a pull request number or a
    //     generated document id identifies perfectly and describes nothing.
    hasIdentity: c.ids.size > 0,
    key: c.refs.size === 1 ? `ticket:${[...c.refs][0]}` : null,
    via: c.via,
  }));
}

/**
 * Name a cluster without the AI.
 *
 * Titles come first, because they say what the work is: "Auth Token" beats
 * "AUTH", which beats nothing. The task key is only a fallback for a cluster
 * whose titles are all site chrome, and even then it is an identifier — a poor
 * name that at least distinguishes one group from another.
 *
 * @param {{tabs:Array<{title?:string,url:string}>, key?:string|null}} cluster
 * @returns {string|null}
 */
export function nameCluster(cluster) {
  const tabs = (cluster && cluster.tabs) || [];
  // The URL's last segment joins the title, because a page whose title is just
  // its product name ("Confluence", "Grafana") still usually carries what it is
  // about in its slug — and page content is never read, so that slug is the
  // only description left. Words appearing in both simply reinforce each other.
  // Only the FIRST part of the content is used for naming. contentToText joins
  // its pieces with " . " in order of how deliberate each is — og:title, then
  // the meta description, then headings, then body text — so the first piece is
  // the one an author wrote to describe the page. Taking a character slice
  // instead let body text in, and body text names a page badly: it has the
  // longest words and none of the meaning, turning "Scheduler latency in recent
  // kernels" into "Regressions Replacement".
  const contentHead = (t) => String(t.content || '').split(' . ')[0] || '';
  const summary = summarizeTitles(
    tabs.map((t) => `${t.title || ''} ${leafText(t.url)} ${contentHead(t)}`.trim()),
    { maxWords: 2 },
  );
  if (summary && !looksLikeIdentifier(summary)) return summary;
  return labelForKey(cluster && cluster.key);
}

/**
 * A last-resort label derived from a strong task key. An identifier makes a poor
 * group name — "AUTH" tells you nothing about the work — so prefer
 * nameCluster, which reads the titles.
 *
 * @param {string|null} key
 * @returns {string|null}
 */
export function labelForKey(key) {
  if (!key) return null;
  const [kind, ...rest] = key.split(':');
  const val = rest.join(':');
  switch (kind) {
    // Ticket projects all canonicalize to 'ticket:' (see lib/taskSignal.js);
    // the platform arms remain as a safety net for any future matcher.
    case 'ticket':
    case 'jira':
    case 'linear':
      return val.toUpperCase();
    case 'wiki':
      return `${val.toUpperCase()} Docs`;
    case 'repo': {
      const name = val.split('/').pop() || val;
      return name.slice(0, 24);
    }
    // Opaque ids make poor labels — let the caller fall back to the AI or host.
    case 'gdoc':
    case 'notion':
    case 'figma':
    case 'slack':
      return null;
    default:
      return null;
  }
}
