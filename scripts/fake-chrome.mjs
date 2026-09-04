/**
 * A small in-memory Chrome, enough to actually RUN the extension's
 * Chrome-facing code outside a browser.
 *
 * scripts/test-grouping.mjs covers the pure logic, and covered it well enough
 * that 258 checks passed while organizeAllTabs was throwing
 * "ReferenceError: learned is not defined" on its first line of real work. A
 * stale identifier is valid syntax, `node --check` says nothing, and every
 * entry point that touches tabs had no coverage at all.
 *
 * This models just enough — tabs, groups, the two storage areas, windows — for
 * those entry points to be executed and their effects inspected.
 */

/** @returns {{chrome: object, state: object}} */
export function makeFakeChrome({ tabs = [], groups = [], permissions = false } = {}) {
  const state = {
    tabs: tabs.map((t, i) => ({
      id: t.id ?? i + 1,
      windowId: t.windowId ?? 1,
      index: i,
      url: t.url ?? 'https://example.com/',
      title: t.title ?? '',
      status: t.status ?? 'complete',
      pinned: !!t.pinned,
      active: !!t.active,
      discarded: !!t.discarded,
      groupId: t.groupId ?? -1,
      openerTabId: t.openerTabId,
      lastAccessed: t.lastAccessed ?? Date.now(),
    })),
    groups: groups.map((g, i) => ({
      id: g.id ?? 1000 + i,
      windowId: g.windowId ?? 1,
      title: g.title ?? '',
      color: g.color ?? 'grey',
      collapsed: !!g.collapsed,
    })),
    local: {},
    session: {},
    messages: [],
    nextGroupId: 2000,
    nextTabId: 9000,
    nextWindowId: 10,
  };

  const area = (bag) => ({
    get: async (keys) => {
      if (keys == null) return { ...bag };
      const list = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const k of list) if (k in bag) out[k] = bag[k];
      return out;
    },
    set: async (obj) => { Object.assign(bag, obj); },
    remove: async (keys) => {
      for (const k of (Array.isArray(keys) ? keys : [keys])) delete bag[k];
    },
    clear: async () => { for (const k of Object.keys(bag)) delete bag[k]; },
  });

  const tabById = (id) => state.tabs.find((t) => t.id === id);

  const chrome = {
    runtime: {
      sendMessage: async (msg) => { state.messages.push(msg); },
      onMessage: { addListener() {} },
      onInstalled: { addListener() {} },
      lastError: null,
    },
    storage: {
      local: area(state.local),
      session: area(state.session),
      onChanged: { addListener() {} },
    },
    permissions: {
      contains: async () => permissions,
      request: async () => permissions,
      remove: async () => true,
    },
    scripting: {
      executeScript: async ({ target }) => {
        const tab = tabById(target.tabId);
        return [{ result: { ogTitle: tab ? tab.title : '', description: '', headings: [], body: '' } }];
      },
    },
    windows: {
      getCurrent: async () => ({ id: state.tabs[0] ? state.tabs[0].windowId : 1 }),
      create: async () => {
        const windowId = state.nextWindowId++;
        const tab = {
          id: state.nextTabId++, windowId, index: 0, url: 'about:blank', title: '',
          status: 'complete', pinned: false, active: true, groupId: -1,
        };
        state.tabs.push(tab);
        return { id: windowId, tabs: [tab] };
      },
      update: async () => {},
      onFocusChanged: { addListener() {} },
    },
    tabs: {
      query: async (q = {}) => state.tabs.filter((t) => (
        (q.windowId === undefined || t.windowId === q.windowId)
        && (q.groupId === undefined || t.groupId === q.groupId)
        && (q.active === undefined || t.active === q.active)
      )).map((t) => ({ ...t })),
      get: async (id) => {
        const t = tabById(id);
        if (!t) throw new Error(`No tab with id ${id}`);
        return { ...t };
      },
      create: async ({ url, windowId }) => {
        const tab = {
          id: state.nextTabId++, windowId: windowId ?? 1, index: state.tabs.length,
          url, title: '', status: 'complete', pinned: false, active: false, groupId: -1,
        };
        state.tabs.push(tab);
        return { ...tab };
      },
      remove: async (id) => {
        const i = state.tabs.findIndex((t) => t.id === id);
        if (i !== -1) state.tabs.splice(i, 1);
      },
      update: async (id, props) => { Object.assign(tabById(id) || {}, props); },
      group: async ({ tabIds, groupId, createProperties }) => {
        const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
        let target = groupId;
        if (target == null) {
          target = state.nextGroupId++;
          const windowId = createProperties?.windowId
            ?? (tabById(ids[0]) ? tabById(ids[0]).windowId : 1);
          state.groups.push({ id: target, windowId, title: '', color: 'grey', collapsed: false });
        }
        const group = state.groups.find((g) => g.id === target);
        if (!group) throw new Error(`No group with id ${target}`);
        for (const id of ids) {
          const t = tabById(id);
          if (!t) throw new Error(`No tab with id ${id}`);
          t.groupId = target;
          t.windowId = group.windowId; // Chrome moves tabs across windows
        }
        return target;
      },
      ungroup: async (tabIds) => {
        for (const id of (Array.isArray(tabIds) ? tabIds : [tabIds])) {
          const t = tabById(id);
          if (t) t.groupId = -1;
        }
      },
      onCreated: { addListener() {} },
      onUpdated: { addListener() {} },
      onRemoved: { addListener() {} },
      onActivated: { addListener() {} },
    },
    tabGroups: {
      query: async (q = {}) => state.groups.filter((g) => (
        (q.windowId === undefined || g.windowId === q.windowId)
        && (q.title === undefined || g.title === q.title)
      )).map((g) => ({ ...g })),
      get: async (id) => {
        const g = state.groups.find((x) => x.id === id);
        if (!g) throw new Error(`No group with id ${id}`);
        return { ...g };
      },
      update: async (id, props) => {
        const g = state.groups.find((x) => x.id === id);
        if (!g) throw new Error(`No group with id ${id}`);
        Object.assign(g, props);
        return { ...g };
      },
      move: async (id, { windowId }) => {
        const g = state.groups.find((x) => x.id === id);
        if (g && windowId != null) {
          g.windowId = windowId;
          for (const t of state.tabs) if (t.groupId === id) t.windowId = windowId;
        }
      },
      onUpdated: { addListener() {} },
    },
  };

  /** Group titles mapped to the tab ids in them — what a test wants to assert. */
  state.grouping = () => {
    const out = new Map();
    for (const t of state.tabs) {
      if (t.groupId === -1) continue;
      const g = state.groups.find((x) => x.id === t.groupId);
      const title = g ? (g.title || `(untitled ${g.id})`) : `(missing ${t.groupId})`;
      if (!out.has(title)) out.set(title, []);
      out.get(title).push(t.id);
    }
    return out;
  };
  state.looseTabs = () => state.tabs.filter((t) => t.groupId === -1).map((t) => t.id);

  return { chrome, state };
}
