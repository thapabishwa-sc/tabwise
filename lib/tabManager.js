/**
 * Tab Manager — generic tab grouping powered by on-device AI.
 *
 * Tabs are grouped by the work they serve, resolved in this order:
 *   1. pinned rules      — explicit user config always wins;
 *   2. internal hosts    — infrastructure keeps deterministic per-host groups
 *                          (lib/url.js), so two clusters never merge;
 *   3. opener lineage    — a tab opened from another joins its group, no AI
 *                          needed; this is the strongest task signal there is;
 *   4. affinity + AI     — remaining tabs are clustered by shared task key
 *                          (lib/affinity.js) and the clusters are named by the
 *                          on-device model (lib/aiGrouper.js).
 *
 * Everything below step 2 is task-shaped rather than host-shaped: a ticket, its
 * pull request, its spec and its dashboard end up in one group even though they
 * live on four different domains.
 */

import { getSettings, saveSession, getSessions } from './storage.js';
import { groupClusters, groupByInstruction, categorizeTab, isAvailable as aiAvailable } from './aiGrouper.js';
import { subdomainGroupLabel, fallbackGroupLabel } from './url.js';
import { clusterTabs, labelForKey } from './affinity.js';
import { taskKey } from './taskSignal.js';

/**
 * Lock flag — suppresses event-driven processing during bulk operations
 * so we don't re-enter while organizeAllTabs is moving tabs around.
 */
let busy = false;
export function setBusy(val) { busy = val; }
export function isBusy() { return busy; }

const GROUP_COLORS = ['blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];

/** Pick a stable color for a group title based on its name hash. */
function colorForLabel(label) {
  let hash = 0;
  for (const ch of label) hash = ((hash << 5) - hash + ch.charCodeAt(0)) | 0;
  return GROUP_COLORS[Math.abs(hash) % GROUP_COLORS.length];
}

/** A tab is eligible for grouping if it's a real web page and not pinned. */
function isEligible(tab) {
  return !!tab && !tab.pinned && !!tab.url && /^https?:\/\//i.test(tab.url);
}

// --- Tracking groups we created (so we can respect user-made groups) ---
// Stored in chrome.storage.session so it survives service-worker restarts but
// resets when the browser closes (a safe, conservative default).

const MANAGED_KEY = 'managedGroupIds';

async function getManagedSet() {
  try {
    const r = await chrome.storage.session.get(MANAGED_KEY);
    return new Set(r[MANAGED_KEY] || []);
  } catch {
    return new Set();
  }
}

async function addManaged(groupId) {
  try {
    const s = await getManagedSet();
    if (!s.has(groupId)) {
      s.add(groupId);
      await chrome.storage.session.set({ [MANAGED_KEY]: [...s] });
    }
  } catch { /* session storage unavailable */ }
}

async function removeManaged(groupId) {
  try {
    const s = await getManagedSet();
    if (s.delete(groupId)) {
      await chrome.storage.session.set({ [MANAGED_KEY]: [...s] });
    }
  } catch { /* noop */ }
}

/** True when a tab sits in a group the user made (i.e. not one of ours). */
function isManuallyGrouped(tab, managed) {
  return tab.groupId != null && tab.groupId !== -1 && !managed.has(tab.groupId);
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
function pinnedLabelFor(url, pinnedRules) {
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

/**
 * Find an existing tab group with the given title (preferring the same window),
 * or create a new one, and add the given tabs to it.
 *
 * @param {string} label
 * @param {number[]} tabIds
 * @param {number} [windowId]
 * @returns {Promise<number|null>} the group id, or null if no valid tabs
 */
export async function findOrCreateGroup(label, tabIds, windowId) {
  const validTabIds = [];
  for (const id of tabIds) {
    try {
      await chrome.tabs.get(id);
      validTabIds.push(id);
    } catch { /* tab closed */ }
  }
  if (validTabIds.length === 0) return null;

  // Reuse an existing group with this title when possible.
  let groupId = null;
  try {
    const existing = await chrome.tabGroups.query({ title: label });
    if (existing.length > 0) {
      const inSameWindow = windowId ? existing.find(g => g.windowId === windowId) : null;
      groupId = (inSameWindow || existing[0]).id;
    }
  } catch { /* tabGroups unavailable */ }

  if (groupId !== null) {
    try {
      await chrome.tabs.group({ tabIds: validTabIds, groupId });
      await addManaged(groupId);
      return groupId;
    } catch {
      groupId = null; // group vanished — recreate
    }
  }

  const createProps = windowId ? { createProperties: { windowId } } : {};
  groupId = await chrome.tabs.group({ tabIds: validTabIds, ...createProps });
  await chrome.tabGroups.update(groupId, {
    title: label,
    color: colorForLabel(label),
    collapsed: false,
  });
  await addManaged(groupId);
  return groupId;
}

/** Build the payload for the AI grouper / clusterer. */
function payload(tab) {
  return {
    id: tab.id,
    url: tab.url,
    title: tab.title || '',
    openerTabId: tab.openerTabId,
  };
}

/** Scope options for the deterministic host rule, drawn from settings. */
function hostRuleOpts(settings) {
  return {
    scope: settings.subdomainScope === 'all' ? 'all' : 'internal',
    internalDomains: settings.internalDomains || [],
  };
}

/**
 * Add a tab to an existing group without claiming ownership of it.
 *
 * findOrCreateGroup marks every group it touches as managed, which is right for
 * groups we made but wrong here: inheriting a tab into the user's own group must
 * not turn that group into ours to reorganize later.
 */
async function joinGroupUnclaimed(tabId, groupId) {
  await chrome.tabs.group({ tabIds: [tabId], groupId });
}

/**
 * Group ALL tabs in every window by topic using on-device AI.
 * @returns {Promise<{organized:number, error?:string}>}
 */
export async function organizeAllTabs() {
  const ai = await aiAvailable();

  busy = true;
  try {
    const settings = await getSettings();
    const managed = settings.respectManualGroups ? await getManagedSet() : new Set();
    const allTabs = await chrome.tabs.query({});

    // Bucket eligible tabs per window (skip pinned tabs and user-made groups).
    const byWindow = new Map();
    for (const tab of allTabs) {
      if (!isEligible(tab)) continue;
      if (isManuallyGrouped(tab, managed)) continue;
      if (!byWindow.has(tab.windowId)) byWindow.set(tab.windowId, []);
      byWindow.get(tab.windowId).push(tab);
    }

    const minSize = Math.max(1, settings.minGroupSize || 1);
    const miscLabel = settings.miscLabel || 'Other';

    let organized = 0;
    for (const [windowId, tabs] of byWindow) {
      if (tabs.length === 0) continue;

      // Resolve labels in priority order:
      //   1. pinned rule   2. internal host (deterministic)   3. task clusters
      // Pinned and internal labels are intentional and exempt from min-size.
      const byLabel = new Map();
      const exempt = new Set();
      const forTasks = [];
      const addTo = (label, id) => {
        if (!byLabel.has(label)) byLabel.set(label, []);
        byLabel.get(label).push(id);
      };
      const hostOpts = hostRuleOpts(settings);
      for (const tab of tabs) {
        const pinned = pinnedLabelFor(tab.url, settings.pinnedRules);
        if (pinned) { exempt.add(pinned); addTo(pinned, tab.id); continue; }

        const sub = subdomainGroupLabel(tab.url, settings.subdomainStrategy, hostOpts);
        if (sub) { exempt.add(sub); addTo(sub, tab.id); continue; }

        forTasks.push(tab);
      }

      if (forTasks.length > 0) {
        // Cluster first, so a task spread across several hosts is one unit
        // whether or not the AI is available.
        const clusters = clusterTabs(forTasks.map(payload), {
          useOpeners: settings.useOpenerAffinity !== false,
        });

        if (ai) {
          const labelMap = await groupClusters(clusters, { projectMode: settings.aiProjectMode });
          for (const [tabId, label] of labelMap) addTo(label, tabId);
          // A cluster built on a strong shared key is a real task, however few
          // tabs it has — don't let min-size dissolve it into "Other".
          for (const c of clusters) {
            if (!c.key) continue;
            const label = labelMap.get(c.tabs[0].id);
            if (label) exempt.add(label);
          }
        } else {
          // AI unavailable — name each cluster from its task key when it has
          // one, so the fallback still reads like work ("gateway", "AUTH")
          // rather than like a hostname. Only unkeyed tabs fall back to host.
          for (const c of clusters) {
            const keyLabel = labelForKey(c.key);
            if (keyLabel) {
              exempt.add(keyLabel);
              for (const t of c.tabs) addTo(keyLabel, t.id);
              continue;
            }
            for (const t of c.tabs) {
              const fb = fallbackGroupLabel(t.url);
              if (fb) { exempt.add(fb); addTo(fb, t.id); }
            }
          }
        }
      }

      // Min group size: AI-topic groups smaller than minSize fall into Misc.
      if (minSize > 1) {
        const misc = [];
        for (const [label, ids] of [...byLabel]) {
          if (exempt.has(label) || label === miscLabel) continue;
          if (ids.length < minSize) {
            misc.push(...ids);
            byLabel.delete(label);
          }
        }
        if (misc.length > 0) {
          // Only bucket Misc if it's worth a group; otherwise leave loose.
          if (misc.length >= minSize) {
            for (const id of misc) addTo(miscLabel, id);
          }
        }
      }

      for (const [label, tabIds] of byLabel) {
        try {
          await findOrCreateGroup(label, tabIds, windowId);
          organized += tabIds.length;
        } catch (e) {
          console.warn(`AI Tab Grouper: failed to group "${label}":`, e);
        }
      }

      if (settings.collapseInactive) await collapseInactiveGroups(windowId);
    }

    return { organized, mode: ai ? 'ai' : 'fallback' };
  } finally {
    busy = false;
  }
}

/**
 * Group a single tab (used when auto-grouping new/navigated tabs).
 * Prefers slotting into an existing group in the same window.
 */
export async function autoGroupTab(tabId) {
  if (busy) return;

  let tab;
  try { tab = await chrome.tabs.get(tabId); } catch { return; }
  if (!isEligible(tab)) return; // skips pinned tabs too

  const settings = await getSettings();

  // Don't disturb a tab the user manually placed in their own group.
  if (settings.respectManualGroups) {
    const managed = await getManagedSet();
    if (isManuallyGrouped(tab, managed)) return;
  }

  // Pinned rule short-circuits everything.
  const pinned = pinnedLabelFor(tab.url, settings.pinnedRules);
  if (pinned) {
    try { await findOrCreateGroup(pinned, [tabId], tab.windowId); } catch { /* noop */ }
    return;
  }

  // Internal hosts group deterministically by subdomain, so two infrastructure
  // clusters never get merged by topic. Public hosts fall through to task
  // grouping — see hostRuleOpts / lib/url.js.
  const sub = subdomainGroupLabel(tab.url, settings.subdomainStrategy, hostRuleOpts(settings));
  if (sub) {
    try {
      await findOrCreateGroup(sub, [tabId], tab.windowId);
      if (settings.collapseInactive) await collapseInactiveGroups(tab.windowId);
    } catch { /* noop */ }
    return;
  }

  // Opened from another tab? Then it is part of whatever that tab is doing.
  // Following a link from a ticket to its PR, or a PR to a failing test, is the
  // most reliable "same work" signal available — and it costs no AI call, so a
  // new tab lands in the right group instantly rather than after a model round
  // trip. The parent's group is joined without claiming ownership of it.
  //
  // Only for a tab that isn't in a group yet: this places a NEW tab, it does not
  // re-place an existing one. `openerTabId` outlives the navigation that set it,
  // so without this guard a tab opened from a link and later reused for
  // unrelated work would be pinned to its birth group forever; once grouped, a
  // navigation is re-judged on the page's own merits below.
  const ungrouped = tab.groupId == null || tab.groupId === -1;
  if (settings.useOpenerAffinity !== false && ungrouped && tab.openerTabId != null) {
    try {
      const opener = await chrome.tabs.get(tab.openerTabId);
      if (opener
        && opener.windowId === tab.windowId
        && opener.groupId != null
        && opener.groupId !== -1) {
        await joinGroupUnclaimed(tabId, opener.groupId);
        if (settings.collapseInactive) await collapseInactiveGroups(tab.windowId);
        return;
      }
    } catch { /* opener closed or ungrouped — fall through */ }
  }

  // AI unavailable — fall back to the tab's task key when it has one, and only
  // then to its host.
  if (!(await aiAvailable())) {
    const fb = labelForKey(taskKey(tab.url)) || fallbackGroupLabel(tab.url);
    if (fb) {
      try {
        await findOrCreateGroup(fb, [tabId], tab.windowId);
        if (settings.collapseInactive) await collapseInactiveGroups(tab.windowId);
      } catch { /* noop */ }
    }
    return;
  }

  let existingLabels = [];
  try {
    const groups = await chrome.tabGroups.query({ windowId: tab.windowId });
    existingLabels = groups.map(g => g.title).filter(Boolean);
  } catch { /* tabGroups unavailable */ }

  const label = await categorizeTab(payload(tab), existingLabels, { projectMode: settings.aiProjectMode });
  if (!label) return;

  // With a min group size, don't spawn a one-tab group out of a vague topic
  // guess: attach to an existing group instead, and let a batch "Group all"
  // bucket the leftovers. A tab that names a real work item (a ticket, a repo,
  // a document) is exempt — otherwise a brand-new task can never start its own
  // group and tabs only ever accrete into whatever groups already exist.
  const minSize = Math.max(1, settings.minGroupSize || 1);
  if (minSize > 1 && !existingLabels.includes(label) && !taskKey(tab.url)) return;

  try {
    await findOrCreateGroup(label, [tabId], tab.windowId);
    if (settings.collapseInactive) await collapseInactiveGroups(tab.windowId);
  } catch (e) {
    console.warn('AI Tab Grouper: failed to group tab:', e);
  }
}

/**
 * Collapse every group in the window except the one holding the active tab.
 * Exported so the background can run it on focus changes (accordion behavior).
 */
export async function collapseInactiveGroups(windowId) {
  try {
    const [active] = await chrome.tabs.query({ active: true, windowId });
    const activeGroup = active ? active.groupId : -1;
    const groups = await chrome.tabGroups.query({ windowId });
    for (const g of groups) {
      const shouldCollapse = g.id !== activeGroup;
      if (g.collapsed !== shouldCollapse) {
        await chrome.tabGroups.update(g.id, { collapsed: shouldCollapse });
      }
    }
  } catch { /* noop */ }
}

/**
 * Collapse every group in the window except the just-expanded one (and the
 * group holding the active tab, which Chrome won't let us collapse anyway).
 * Used to extend the accordion to manual header-expands.
 */
export async function foldOthers(windowId, keepGroupId) {
  try {
    const [active] = await chrome.tabs.query({ active: true, windowId });
    const activeGroup = active ? active.groupId : -1;
    const groups = await chrome.tabGroups.query({ windowId });
    for (const g of groups) {
      const keep = g.id === keepGroupId || g.id === activeGroup;
      if (g.collapsed !== !keep) {
        try { await chrome.tabGroups.update(g.id, { collapsed: !keep }); } catch { /* active tab group */ }
      }
    }
  } catch { /* noop */ }
}

/** Rename a tab group. Treats it as user-owned afterwards (won't auto-touch). */
export async function renameGroup(groupId, title) {
  try {
    await chrome.tabGroups.update(groupId, { title });
    await removeManaged(groupId);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/**
 * Move a single tab to another group (by label), or ungroup it.
 * @param {number} tabId
 * @param {string} label - target group title, or '__ungroup__' to remove it
 */
export async function moveTab(tabId, label) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (label === '__ungroup__') {
      await chrome.tabs.ungroup([tabId]);
    } else {
      await findOrCreateGroup(label, [tabId], tab.windowId);
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/** Remove all tab groups in a window (tabs stay open, just ungrouped). */
export async function ungroupAll(windowId) {
  const query = windowId ? { windowId } : {};
  const tabs = await chrome.tabs.query(query);
  const grouped = tabs.filter(t => t.groupId && t.groupId !== -1).map(t => t.id);
  if (grouped.length > 0) {
    try { await chrome.tabs.ungroup(grouped); } catch { /* noop */ }
  }
  return { ungrouped: grouped.length };
}

/**
 * Snapshot the current tab groups (+ loose tabs) for the popup UI.
 * @param {number} [windowId] - defaults to the current window
 */
export async function getGroupsSnapshot(windowId) {
  let winId = windowId;
  if (winId == null) {
    try { winId = (await chrome.windows.getCurrent()).id; } catch { /* noop */ }
  }

  const tabs = await chrome.tabs.query(winId != null ? { windowId: winId } : {});
  let groups = [];
  try {
    groups = await chrome.tabGroups.query(winId != null ? { windowId: winId } : {});
  } catch { /* tabGroups unavailable */ }

  const groupMeta = new Map(groups.map(g => [g.id, g]));
  const grouped = new Map(); // groupId → { ...meta, tabs: [] }
  const ungrouped = [];

  for (const tab of tabs) {
    const t = {
      id: tab.id,
      title: tab.title || tab.url || '',
      url: tab.url || '',
      favIconUrl: tab.favIconUrl || '',
      active: tab.active,
      pinned: tab.pinned,
    };
    if (tab.groupId && tab.groupId !== -1 && groupMeta.has(tab.groupId)) {
      if (!grouped.has(tab.groupId)) {
        const meta = groupMeta.get(tab.groupId);
        grouped.set(tab.groupId, {
          id: meta.id,
          title: meta.title || '(unnamed)',
          color: meta.color,
          collapsed: meta.collapsed,
          tabs: [],
        });
      }
      grouped.get(tab.groupId).tabs.push(t);
    } else {
      ungrouped.push(t);
    }
  }

  return {
    groups: [...grouped.values()].sort((a, b) => a.title.localeCompare(b.title)),
    ungrouped,
    totalTabs: tabs.length,
  };
}

// --- Move a whole group to its own new window ---

export async function moveGroupToWindow(groupId) {
  try {
    const win = await chrome.windows.create({ focused: true });
    const blankTabId = win.tabs && win.tabs[0] ? win.tabs[0].id : null;
    // Moves the group and ALL its tabs across to the new window.
    await chrome.tabGroups.move(groupId, { windowId: win.id, index: -1 });
    if (blankTabId != null) {
      try { await chrome.tabs.remove(blankTabId); } catch { /* noop */ }
    }
    await addManaged(groupId);
    return { ok: true, windowId: win.id };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// --- Natural-language grouping ---

/**
 * Re-group the eligible tabs in a window following a free-form instruction.
 * Bypasses pinned/subdomain rules since it's an explicit user command.
 */
export async function organizeByInstruction(instruction, windowId) {
  if (!(await aiAvailable())) return { organized: 0, error: 'ai-unavailable' };

  let winId = windowId;
  if (winId == null) {
    try { winId = (await chrome.windows.getCurrent()).id; } catch { /* noop */ }
  }

  busy = true;
  try {
    const settings = await getSettings();
    const managed = settings.respectManualGroups ? await getManagedSet() : new Set();
    const tabs = (await chrome.tabs.query(winId != null ? { windowId: winId } : {}))
      .filter(t => isEligible(t) && !isManuallyGrouped(t, managed));
    if (tabs.length === 0) return { organized: 0 };

    // Provide current group titles as context for "merge X and Y" style asks.
    const titleById = new Map();
    try {
      const groups = await chrome.tabGroups.query(winId != null ? { windowId: winId } : {});
      for (const g of groups) titleById.set(g.id, g.title);
    } catch { /* noop */ }

    const payloads = tabs.map(t => ({
      id: t.id,
      url: t.url,
      title: t.title || '',
      group: (t.groupId && t.groupId !== -1) ? (titleById.get(t.groupId) || '') : '',
    }));

    const labelMap = await groupByInstruction(payloads, instruction);
    const byLabel = new Map();
    for (const [tabId, label] of labelMap) {
      if (!byLabel.has(label)) byLabel.set(label, []);
      byLabel.get(label).push(tabId);
    }

    let organized = 0;
    for (const [label, ids] of byLabel) {
      try {
        await findOrCreateGroup(label, ids, winId);
        organized += ids.length;
      } catch (e) {
        console.warn(`AI Tab Grouper: NL group "${label}" failed:`, e);
      }
    }
    return { organized };
  } finally {
    busy = false;
  }
}

// --- Task capture ---

/**
 * Group the currently-ungrouped tabs in a window into a named "task" group.
 * The group is marked user-owned (removed from the managed set) so automatic
 * grouping won't disturb it later.
 *
 * @param {string} name
 * @param {number} [windowId]
 */
export async function captureTaskGroup(name, windowId) {
  const label = (name || '').trim();
  if (!label) return { grouped: 0, error: 'no-name' };

  let winId = windowId;
  if (winId == null) {
    try { winId = (await chrome.windows.getCurrent()).id; } catch { /* noop */ }
  }

  const tabs = await chrome.tabs.query(winId != null ? { windowId: winId } : {});
  const loose = tabs
    .filter(t => isEligible(t) && (!t.groupId || t.groupId === -1))
    .map(t => t.id);
  if (loose.length === 0) return { grouped: 0 };

  busy = true;
  try {
    const groupId = await findOrCreateGroup(label, loose, winId);
    if (groupId != null) await removeManaged(groupId); // protect from auto-grouping
    return { grouped: loose.length, label };
  } finally {
    busy = false;
  }
}

// --- Sessions (save / restore sets of tabs + their group) ---

export async function snapshotSession(name, windowId) {
  let winId = windowId;
  if (winId == null) {
    try { winId = (await chrome.windows.getCurrent()).id; } catch { /* noop */ }
  }
  const tabs = await chrome.tabs.query(winId != null ? { windowId: winId } : {});
  let groups = [];
  try {
    groups = await chrome.tabGroups.query(winId != null ? { windowId: winId } : {});
  } catch { /* noop */ }
  const titleById = new Map(groups.map(g => [g.id, g.title]));

  const saved = [];
  for (const t of tabs) {
    if (!/^https?:\/\//i.test(t.url || '')) continue;
    saved.push({
      url: t.url,
      group: (t.groupId && t.groupId !== -1) ? (titleById.get(t.groupId) || null) : null,
    });
  }
  await saveSession(name, saved);
  return { saved: saved.length };
}

export async function restoreSession(index) {
  const sessions = await getSessions();
  const session = sessions[index];
  if (!session) return { error: 'not-found' };

  busy = true;
  try {
    const win = await chrome.windows.create({ focused: true });
    const blankTabId = win.tabs && win.tabs[0] ? win.tabs[0].id : null;

    const byGroup = new Map(); // group title → [tabIds]
    for (const entry of session.tabs) {
      let tab;
      try {
        tab = await chrome.tabs.create({ windowId: win.id, url: entry.url, active: false });
      } catch { continue; }
      if (entry.group) {
        if (!byGroup.has(entry.group)) byGroup.set(entry.group, []);
        byGroup.get(entry.group).push(tab.id);
      }
    }

    for (const [title, ids] of byGroup) {
      try { await findOrCreateGroup(title, ids, win.id); } catch { /* noop */ }
    }
    if (blankTabId != null) {
      try { await chrome.tabs.remove(blankTabId); } catch { /* noop */ }
    }
    return { restored: session.tabs.length };
  } finally {
    busy = false;
  }
}
