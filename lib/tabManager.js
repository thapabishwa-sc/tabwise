/**
 * Tab Manager — generic tab grouping powered by on-device AI.
 *
 * Which group a tab belongs to is decided by lib/resolve.js, which is pure and
 * benchmarked (scripts/bench.mjs). This module is the part that talks to Chrome:
 * it reads tabs, applies the decisions to real tab groups, and — importantly —
 * feeds your corrections back into lib/taskMemory.js so they stick.
 *
 * Every correction is a teaching moment. Renaming a group teaches your name for
 * that work; dragging a tab into a group teaches where that page belongs and
 * pins it there. Without that, the next pass would cheerfully undo both.
 */

import { getSettings, saveSession, getSessions } from './storage.js';
import { groupClusters, groupByInstruction, categorizeTab, isAvailable as aiAvailable } from './aiGrouper.js';
import { fallbackGroupLabel, subdomainGroupLabel } from './url.js';
import { nameCluster } from './affinity.js';
import { identitiesOf, namesWork } from './context.js';
import {
  resolveGroups, pinnedLabelFor, hostRuleOpts, relatedGroupFor, hasSettled, REASONS,
} from './resolve.js';
import {
  loadMemory, updateMemory, observe, learnRename, learnMove,
  recallPin, recallForTabs,
} from './taskMemory.js';

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

// --- Did this tab start by following a link? ---
// Kept in session storage so it survives a service-worker restart but not a
// browser restart, which is the right lifetime: it only matters while the tab
// is new.

const ORIGIN_KEY = 'linkOpenedTabIds';

export async function noteTabOrigin(tabId, followedALink) {
  if (!followedALink) return; // absence is the default; only record the positive
  try {
    const r = await chrome.storage.session.get(ORIGIN_KEY);
    const ids = new Set(r[ORIGIN_KEY] || []);
    ids.add(tabId);
    await chrome.storage.session.set({ [ORIGIN_KEY]: [...ids] });
  } catch { /* session storage unavailable */ }
}

export async function forgetTabOrigin(tabId) {
  try {
    const r = await chrome.storage.session.get(ORIGIN_KEY);
    const ids = new Set(r[ORIGIN_KEY] || []);
    if (ids.delete(tabId)) await chrome.storage.session.set({ [ORIGIN_KEY]: [...ids] });
  } catch { /* noop */ }
}

async function followedALink(tabId) {
  try {
    const r = await chrome.storage.session.get(ORIGIN_KEY);
    return (r[ORIGIN_KEY] || []).includes(tabId);
  } catch {
    return false;
  }
}

/** True when a tab sits in a group the user made (i.e. not one of ours). */
function isManuallyGrouped(tab, managed) {
  return tab.groupId != null && tab.groupId !== -1 && !managed.has(tab.groupId);
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

  // Reuse an existing group with this title, but only within the same window.
  // chrome.tabs.group() MOVES tabs to the group's window, so reusing a
  // same-named group from another window would silently teleport tabs out of
  // the window the user is looking at. One group per window per task instead.
  let groupId = null;
  try {
    const existing = await chrome.tabGroups.query({ title: label });
    const target = windowId
      ? existing.find(g => g.windowId === windowId)
      : existing[0];
    if (target) groupId = target.id;
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
 * Remember why each tab was placed where it was, so the popup can explain
 * itself. Session-scoped: an explanation is only interesting while the grouping
 * that produced it is still on screen.
 */
const REASON_KEY = 'groupReasons';

async function saveReasons(assignments) {
  try {
    const prev = (await chrome.storage.session.get(REASON_KEY))[REASON_KEY] || {};
    const next = { ...prev };
    for (const [tabId, a] of assignments) {
      next[tabId] = { label: a.label, reason: a.reason, via: a.via };
    }
    await chrome.storage.session.set({ [REASON_KEY]: next });
  } catch { /* session storage unavailable */ }
}

async function saveOneReason(tabId, label, reason, via = 'alone') {
  await saveReasons(new Map([[tabId, { label, reason, via }]]));
}

export async function getReasons() {
  try {
    return (await chrome.storage.session.get(REASON_KEY))[REASON_KEY] || {};
  } catch {
    return {};
  }
}

/** Human-readable text for a reason code, for the UI. */
export function reasonText(reason) {
  return REASONS[reason] || '';
}

/**
 * Group ALL tabs in every window by the work they serve.
 * @returns {Promise<{organized:number, mode:string}>}
 */
export async function organizeAllTabs() {
  const ai = await aiAvailable();

  busy = true;
  try {
    const settings = await getSettings();
    const memory = await loadMemory();
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

    // The model names clusters when it is available; otherwise resolve.js names
    // them from their titles, which still reads like work.
    const nameClusters = ai
      ? (clusters, opts) => groupClusters(clusters, opts)
      : null;

    let organized = 0;
    let learned = memory;
    for (const [windowId, tabs] of byWindow) {
      if (tabs.length === 0) continue;

      const { assignments, byLabel } = await resolveGroups(tabs.map(payload), {
        settings,
        memory: learned,
        nameClusters,
      });

      const tabsById = new Map(tabs.map((t) => [t.id, t]));
      for (const [label, tabIds] of byLabel) {
        try {
          await findOrCreateGroup(label, tabIds, windowId);
          organized += tabIds.length;
          // Learn the shape of every group we just made, so a task seen again
          // is recognized rather than re-derived.
          learned = observe(learned, label, tabIds.map((id) => payload(tabsById.get(id))).filter(Boolean));
        } catch (e) {
          console.warn(`AI Tab Grouper: failed to group "${label}":`, e);
        }
      }

      await saveReasons(assignments);
      if (settings.collapseInactive) await collapseInactiveGroups(windowId);
    }

    if (learned !== memory) await updateMemory(() => learned);
    return { organized, mode: ai ? 'ai' : 'fallback' };
  } finally {
    busy = false;
  }
}

/**
 * Group a single tab as it loads, in the same order of authority as a full pass
 * (see lib/resolve.js), stopping at the first stage that answers.
 *
 * The early stages cost nothing, so most tabs land instantly and the model is
 * only consulted for a page nothing else recognizes.
 */
export async function autoGroupTab(tabId) {
  if (busy) return;

  let tab;
  try { tab = await chrome.tabs.get(tabId); } catch { return; }
  if (!isEligible(tab)) return; // skips pinned tabs too

  const settings = await getSettings();
  const memory = await loadMemory();

  // Don't disturb a tab the user manually placed in their own group.
  if (settings.respectManualGroups) {
    const managed = await getManagedSet();
    if (isManuallyGrouped(tab, managed)) return;
  }

  const place = async (label, reason, via = 'alone') => {
    try {
      await findOrCreateGroup(label, [tabId], tab.windowId);
      await saveOneReason(tabId, label, reason, via);
      if (settings.collapseInactive) await collapseInactiveGroups(tab.windowId);
    } catch { /* tab or group vanished */ }
  };

  // 1. A page you filed yourself. Outranks even a configured rule: the rule is
  //    a standing policy, and moving the tab was you overriding it.
  const pinned = recallPin(memory, tab);
  if (pinned) return place(pinned, 'pin');

  // 2. A pinned rule you configured.
  const ruled = pinnedLabelFor(tab.url, settings.pinnedRules);
  if (ruled) return place(ruled, 'rule');

  // 3. Internal hosts group deterministically by subdomain, so two
  //    infrastructure clusters never get merged by topic.
  const internal = subdomainGroupLabel(tab.url, settings.subdomainStrategy, hostRuleOpts(settings));
  if (internal) return place(internal, 'internal');

  // Everything below infers, and inference needs the page to have loaded. Until
  // then the tab stays out of every group: an uncategorized tab is honest,
  // while one dropped into a group on its hostname alone has to be corrected.
  if (!hasSettled(tab)) return;

  // 4. Opened from another tab? Then it is part of whatever that tab is doing.
  //    The most reliable "same work" signal available, and it costs no AI call,
  //    so the tab lands correctly right away rather than after a model round
  //    trip. The parent's group is joined without claiming ownership of it.
  //
  //    Only for a tab that isn't in a group yet: this places a NEW tab, it does
  //    not re-place an existing one. `openerTabId` outlives the navigation that
  //    set it, so without this guard a tab opened from a link and later reused
  //    for unrelated work would be pinned to its birth group forever.
  //
  //    And only when the tab actually began by following a link. A tab opened
  //    blank still carries openerTabId pointing at whatever was focused at the
  //    time, so without this it inherits that group despite nothing having been
  //    followed — the tab appearing to jump into the group you were just in.
  const ungrouped = tab.groupId == null || tab.groupId === -1;
  if (settings.useOpenerAffinity !== false
    && ungrouped
    && tab.openerTabId != null
    && await followedALink(tabId)) {
    try {
      const opener = await chrome.tabs.get(tab.openerTabId);
      if (opener
        && opener.windowId === tab.windowId
        && opener.groupId != null
        && opener.groupId !== -1) {
        await joinGroupUnclaimed(tabId, opener.groupId);
        const g = await chrome.tabGroups.get(opener.groupId);
        await saveOneReason(tabId, g.title || '', 'learned', 'trail');
        if (settings.collapseInactive) await collapseInactiveGroups(tab.windowId);
        return;
      }
    } catch { /* opener closed or ungrouped — fall through */ }
  }

  // 5. A task you have grouped before, matched by its keys and vocabulary.
  const recalled = recallForTabs(memory, [payload(tab)]);
  if (recalled) return place(recalled.label, 'learned', recalled.via);

  // 6. Does it belong with tabs already grouped in this window? A full pass
  //    would cluster them together on sight; arriving alone, the tab has to ask.
  //    Free, instant, and it keeps a task together as it grows rather than only
  //    when "Group all" next runs.
  let windowTabs = [];
  let groupTitleById = new Map();
  try {
    windowTabs = await chrome.tabs.query({ windowId: tab.windowId });
    const groups = await chrome.tabGroups.query({ windowId: tab.windowId });
    groupTitleById = new Map(groups.map((g) => [g.id, g.title || '']));
  } catch { /* tabGroups unavailable */ }

  const others = windowTabs
    .filter((t) => t.id !== tabId && isEligible(t))
    .map((t) => ({ ...payload(t), group: groupTitleById.get(t.groupId) || '' }));

  const near = relatedGroupFor(payload(tab), others, {
    threshold: settings.relatedThreshold,
  });
  if (near) {
    // Join by group id rather than by title, and without claiming ownership:
    // the best match may be a group the user built by hand.
    const targetId = [...groupTitleById.entries()]
      .find(([, title]) => title === near.label);
    if (targetId) {
      try {
        await joinGroupUnclaimed(tabId, targetId[0]);
        await saveOneReason(tabId, near.label, 'related', near.via);
        if (settings.collapseInactive) await collapseInactiveGroups(tab.windowId);
        return;
      } catch { /* group vanished — fall through to the model */ }
    }
  }

  // 7. Nothing recognized it. Ask the model, or name it from its own title.
  if (!(await aiAvailable())) {
    const fb = nameCluster({ tabs: [payload(tab)], key: identitiesOf(payload(tab))[0] || null })
      || fallbackGroupLabel(tab.url);
    if (fb) await place(fb, 'summary');
    return;
  }

  const existingLabels = [...groupTitleById.values()].filter(Boolean);

  const label = await categorizeTab(payload(tab), existingLabels, { projectMode: settings.aiProjectMode });
  if (!label) return;

  // With a min group size, don't spawn a one-tab group out of a vague topic
  // guess: attach to an existing group instead, and let a batch "Group all"
  // bucket the leftovers. A tab that names a real work item (a ticket, a repo,
  // a document) is exempt — otherwise a brand-new task can never start its own
  // group and tabs only ever accrete into whatever groups already exist.
  const minSize = Math.max(1, settings.minGroupSize || 1);
  if (minSize > 1 && !existingLabels.includes(label) && !namesWork(payload(tab))) return;

  await place(label, 'ai');
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

/**
 * Rename a tab group, and learn the name.
 *
 * A rename is the clearest signal there is about what a piece of work is called:
 * you looked at the group and told it the right answer. From here on your name
 * replaces the proposed one wherever that work is recognized again, and the
 * group's profile carries over so it IS recognized again.
 */
export async function renameGroup(groupId, title) {
  try {
    const before = await chrome.tabGroups.get(groupId).catch(() => null);
    const oldTitle = before ? before.title : null;

    let tabs = [];
    try {
      tabs = (await chrome.tabs.query({ groupId })).map(payload);
    } catch { /* group may be empty */ }

    await chrome.tabGroups.update(groupId, { title });
    await removeManaged(groupId);

    if (title && oldTitle !== title) {
      await updateMemory((m) => learnRename(m, oldTitle, title, tabs));
    }
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
      await saveOneReason(tabId, '', 'pin');
      return { ok: true };
    }

    await findOrCreateGroup(label, [tabId], tab.windowId);
    // Filing a page by hand pins it: automatic grouping must never move it back,
    // and the group learns that pages like this one belong to it.
    await updateMemory((m) => learnMove(m, payload(tab), label));
    await saveOneReason(tabId, label, 'pin');
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
      lastAccessed: tab.lastAccessed || 0,
    };
    if (tab.groupId && tab.groupId !== -1 && groupMeta.has(tab.groupId)) {
      if (!grouped.has(tab.groupId)) {
        const meta = groupMeta.get(tab.groupId);
        grouped.set(tab.groupId, {
          id: meta.id,
          title: meta.title || '(unnamed)',
          color: meta.color,
          collapsed: meta.collapsed,
          lastActive: 0,
          tabs: [],
        });
      }
      const g = grouped.get(tab.groupId);
      g.tabs.push(t);
      // A group is as recent as its most recently visited tab.
      if (t.lastAccessed > g.lastActive) g.lastActive = t.lastAccessed;
    } else {
      ungrouped.push(t);
    }
  }

  return {
    // Most recently worked-on first: what you are doing now belongs at the top,
    // and last month's task should not sit above it because of its name.
    groups: [...grouped.values()].sort(
      (a, b) => (b.lastActive - a.lastActive) || a.title.localeCompare(b.title),
    ),
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

    // A task you named and populated yourself is the strongest profile we can
    // learn: both the name and the membership are your own.
    const captured = tabs.filter((t) => loose.includes(t.id)).map(payload);
    await updateMemory((m) => observe(m, label, captured, { userNamed: true }));
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
