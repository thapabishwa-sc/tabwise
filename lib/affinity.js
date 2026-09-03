/**
 * Tab affinity — deciding which tabs belong to the same piece of work before
 * any AI is involved.
 *
 * Two tabs are the same task when either is true:
 *   1. One was opened from the other (`openerTabId`). Following a link from a
 *      ticket to its PR, or from a PR to a failing test, is the single most
 *      reliable "same work" signal the browser gives us — and it is free.
 *   2. They share a STRONG task key — the same ticket, pull request or document.
 *      See lib/taskSignal.js.
 *
 * A WEAK key (a repository, a Jira project, a wiki space, a Slack channel) is a
 * container that holds many unrelated work items, so it cannot join tabs on its
 * own: three tickets touching one monorepo are three tasks, not one. A weak key
 * only adopts tabs that have no work item of their own — a source file next to
 * the one pull request that touches its repo joins that pull request, but if
 * three pull requests touch the repo, the file belongs to no one in particular
 * and stays with the other loose files.
 *
 * A tab can carry two identities at once, and that is what bridges platforms: a
 * pull request titled "AUTH-482: rotate keys" has both a repo key and a ticket
 * key, so it joins the repo's tabs to the ticket's tabs. Someone wrote that
 * ticket id into that title deliberately — it is a statement about which work
 * the change belongs to, not a coincidence.
 *
 * Deliberately NOT used: "opened around the same time". Two unrelated tabs
 * opened back-to-back would merge, which is the same class of error as grouping
 * by hostname — a coincidence of context mistaken for shared purpose.
 *
 * The result is a set of clusters handed to the grouper as atoms: the AI names
 * a cluster, it never splits one.
 */

import { readTask, titleTaskKey, titleWeakKeys } from './taskSignal.js';
import { summarizeTitles, looksLikeIdentifier } from './summarize.js';

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
 *   in this cluster), 'key' (shares a task key), or 'alone' — which is what the
 *   UI needs to answer "why is this tab in this group?".
 */
export function clusterTabs(tabs, opts = {}) {
  const useOpeners = opts.useOpeners !== false;
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

  // --- 2. Shared strong task keys (from the URL and from the title) ---
  // A tab is unioned on every strong key it carries, so a tab holding two
  // identities — a pull request titled with its ticket id — bridges clusters.
  const keysOf = new Array(list.length);
  const weakOf = new Array(list.length);
  const firstWithKey = new Map();
  for (let i = 0; i < list.length; i++) {
    const task = readTask(list[i].url);
    const titleKey = titleTaskKey(list[i].title);
    keysOf[i] = [...new Set([task.key, titleKey].filter(Boolean))];
    weakOf[i] = [...new Set([...(task.weak || []), ...titleWeakKeys(list[i].title)])];
    for (const key of keysOf[i]) {
      if (firstWithKey.has(key)) {
        dsu.union(firstWithKey.get(key), i);
        // A link trail is the more specific explanation, so it wins.
        if (via[i] === 'alone') via[i] = 'key';
      } else {
        firstWithKey.set(key, i);
      }
    }
  }

  // --- 3. Weak (container) keys, applied only where they settle nothing ---
  // Grouped after every strong union, so "which work items are in this
  // container" is already known.
  const byWeak = new Map();
  for (let i = 0; i < list.length; i++) {
    for (const w of weakOf[i]) {
      if (!byWeak.has(w)) byWeak.set(w, []);
      byWeak.get(w).push(i);
    }
  }

  for (const members of byWeak.values()) {
    if (members.length < 2) continue;
    const floaters = members.filter((i) => keysOf[i].length === 0);
    const anchored = members.filter((i) => keysOf[i].length > 0);
    const anchorRoots = new Set(anchored.map((i) => dsu.find(i)));

    if (anchorRoots.size <= 1) {
      // The container holds at most one work item, so everything in it is that
      // work: a repo with one open pull request, and the files it touches.
      for (let k = 1; k < members.length; k++) {
        dsu.union(members[0], members[k]);
        if (via[members[k]] === 'alone') via[members[k]] = 'key';
      }
    } else if (floaters.length > 1) {
      // Several work items share this container, so a tab with none of its own
      // cannot be attributed to any of them. Keep the loose ones together.
      for (let k = 1; k < floaters.length; k++) {
        dsu.union(floaters[0], floaters[k]);
        if (via[floaters[k]] === 'alone') via[floaters[k]] = 'key';
      }
    }
  }

  // --- Collect clusters, preserving input order ---
  const byRoot = new Map();
  for (let i = 0; i < list.length; i++) {
    const root = dsu.find(i);
    if (!byRoot.has(root)) byRoot.set(root, { tabs: [], keys: new Set(), via: new Map() });
    const c = byRoot.get(root);
    c.tabs.push(list[i]);
    c.via.set(list[i].id, via[i]);
    for (const key of keysOf[i]) c.keys.add(key);
  }

  return [...byRoot.values()].map((c) => ({
    tabs: c.tabs,
    // A single shared key names the cluster; several means opener lineage
    // bridged different work items, so let the AI name it instead.
    key: c.keys.size === 1 ? [...c.keys][0] : null,
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
  const summary = summarizeTitles(tabs.map((t) => t.title || ''), { maxWords: 2 });
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
