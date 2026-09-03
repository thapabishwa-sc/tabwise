/**
 * Tab affinity — deciding which tabs belong to the same piece of work before
 * any AI is involved.
 *
 * Two tabs are the same task when either is true:
 *   1. One was opened from the other (`openerTabId`). Following a link from a
 *      ticket to its PR, or from a PR to a failing test, is the single most
 *      reliable "same work" signal the browser gives us — and it is free.
 *   2. They share a strong task key (same Jira project, same repo, same doc,
 *      same ticket mentioned in the title). See lib/taskSignal.js.
 *
 * Deliberately NOT used: "opened around the same time". Two unrelated tabs
 * opened back-to-back would merge, which is the same class of error as grouping
 * by hostname — a coincidence of context mistaken for shared purpose.
 *
 * The result is a set of clusters handed to the grouper as atoms: the AI names
 * a cluster, it never splits one.
 */

import { readTask, titleTaskKey } from './taskSignal.js';

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
 * @returns {Array<{tabs:Array<object>, key:string|null}>}
 *   Clusters in input order. `key` is the shared strong task key when the
 *   cluster was formed by one (usable as a deterministic label), else null.
 */
export function clusterTabs(tabs, opts = {}) {
  const useOpeners = opts.useOpeners !== false;
  const list = tabs || [];
  if (list.length === 0) return [];

  const dsu = makeDsu(list.length);
  const indexById = new Map(list.map((t, i) => [t.id, i]));

  // --- 1. Opener lineage ---
  if (useOpeners) {
    for (let i = 0; i < list.length; i++) {
      const opener = list[i].openerTabId;
      if (opener == null) continue;
      const parent = indexById.get(opener);
      // Only link when the opener is itself in this grouping pass.
      if (parent !== undefined) dsu.union(parent, i);
    }
  }

  // --- 2. Shared strong task key (URL, then title) ---
  const keyOf = new Array(list.length).fill(null);
  const firstWithKey = new Map();
  for (let i = 0; i < list.length; i++) {
    const key = readTask(list[i].url).key || titleTaskKey(list[i].title);
    keyOf[i] = key;
    if (!key) continue;
    if (firstWithKey.has(key)) dsu.union(firstWithKey.get(key), i);
    else firstWithKey.set(key, i);
  }

  // --- Collect clusters, preserving input order ---
  const byRoot = new Map();
  for (let i = 0; i < list.length; i++) {
    const root = dsu.find(i);
    if (!byRoot.has(root)) byRoot.set(root, { tabs: [], keys: new Set() });
    const c = byRoot.get(root);
    c.tabs.push(list[i]);
    if (keyOf[i]) c.keys.add(keyOf[i]);
  }

  return [...byRoot.values()].map((c) => ({
    tabs: c.tabs,
    // A single shared key names the cluster; several means opener lineage
    // bridged different work items, so let the AI name it instead.
    key: c.keys.size === 1 ? [...c.keys][0] : null,
  }));
}

/**
 * A readable group label derived from a strong task key. Used when the AI is
 * unavailable, so the fallback still reads like work ("acme/gateway", "AUTH")
 * rather than like a hostname.
 *
 * @param {string|null} key
 * @returns {string|null}
 */
export function labelForKey(key) {
  if (!key) return null;
  const [kind, ...rest] = key.split(':');
  const val = rest.join(':');
  switch (kind) {
    case 'jira':
    case 'linear':
    case 'ticket':
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
