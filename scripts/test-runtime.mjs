/**
 * Runtime smoke tests for the Chrome-facing layer.
 *
 *   node scripts/test-runtime.mjs
 *
 * scripts/test-grouping.mjs tests the decisions; this tests that the code which
 * carries them out actually runs. That distinction cost something: 258 logic
 * checks passed while organizeAllTabs threw "learned is not defined" on its
 * first line of real work, because a stale identifier is valid syntax and
 * nothing here had ever been executed.
 *
 * These are deliberately shallow — did it run, did tabs end up grouped, did
 * nothing throw — because depth belongs in the logic tests. What they add is
 * execution.
 */

import { makeFakeChrome } from './fake-chrome.mjs';

let pass = 0;
const failures = [];

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) pass++;
  else failures.push(`${name}\n      expected: ${e}\n      actual:   ${a}`);
}

function ok(name, condition, detail = '') {
  if (condition) pass++;
  else failures.push(`${name}${detail ? `\n      ${detail}` : ''}`);
}

/** Run a body with a fake Chrome installed, then restore. */
async function withChrome(opts, body) {
  const { chrome, state } = makeFakeChrome(opts);
  const saved = globalThis.chrome;
  globalThis.chrome = chrome;
  try {
    return await body(state, chrome);
  } catch (e) {
    // Recorded, not rethrown. An unguarded throw anywhere would otherwise kill
    // the runner and hide every check after it — which is exactly what happened
    // the first time this suite met a real bug.
    failures.push(`unexpected throw\n      ${e && e.stack ? e.stack.split('\n').slice(0, 2).join('\n      ') : e}`);
  } finally {
    globalThis.chrome = saved;
  }
  return undefined;
}

// The module reads `chrome` only inside functions, so it can be imported first.
const tabManager = await import('../lib/tabManager.js');
const storage = await import('../lib/storage.js');
const taskMemory = await import('../lib/taskMemory.js');

const WORK_TABS = [
  { id: 1, title: 'AUTH-482 auth migration rollout - Jira', url: 'https://acme.atlassian.net/browse/AUTH-482' },
  { id: 2, title: 'AUTH-482: fix token refresh · Pull Request #1203 · acme/gateway', url: 'https://github.com/acme/gateway/pull/1203' },
  { id: 3, title: 'Q3 budget planning - Google Sheets', url: 'https://docs.google.com/spreadsheets/d/q3budget2026/edit' },
  { id: 4, title: 'Q3 budget vendor invoice - Gmail', url: 'https://mail.google.com/mail/u/0/' },
];

// --- organizeAllTabs -------------------------------------------------------

await withChrome({ tabs: WORK_TABS }, async (state) => {
  storage.invalidateCache();
  taskMemory.invalidateMemoryCache();

  let result;
  try {
    result = await tabManager.organizeAllTabs();
  } catch (e) {
    failures.push(`organizeAllTabs threw\n      ${e && e.stack ? e.stack.split('\n')[0] : e}`);
    return;
  }
  pass++; // it ran

  ok('organizeAllTabs reports what it organized',
    result && typeof result.organized === 'number',
    `got ${JSON.stringify(result)}`);
  ok('it actually grouped tabs', state.grouping().size > 0,
    `grouping: ${JSON.stringify([...state.grouping()])}`);
  ok('every group it made has a title',
    [...state.grouping().keys()].every((t) => t && !t.startsWith('(untitled')),
    `grouping: ${JSON.stringify([...state.grouping()])}`);
  ok('it releases the busy lock', tabManager.isBusy() === false);
  ok('it records why each tab was placed',
    Object.keys(await tabManager.getReasons()).length > 0);
  ok('it reported progress to the popup',
    state.messages.some((m) => m.type === 'ORGANIZE_PROGRESS'));
});

// --- and does not teach itself ---------------------------------------------

await withChrome({ tabs: WORK_TABS }, async (state) => {
  storage.invalidateCache();
  taskMemory.invalidateMemoryCache();
  await tabManager.organizeAllTabs();
  const memory = await taskMemory.loadMemory();
  check('an automatic pass learns nothing', taskMemory.listTasks(memory).length, 0);
  ok('and wrote no memory at all', state.local.taskMemory === undefined
    || taskMemory.listTasks(state.local.taskMemory).length === 0);
});

// --- organizeLooseTabs leaves settled groups alone -------------------------

await withChrome({
  tabs: [
    { id: 1, title: 'Kept where it is', url: 'https://acme.atlassian.net/browse/KEEP-1', groupId: 1000 },
    { id: 2, title: 'AUTH-482 auth migration - Jira', url: 'https://acme.atlassian.net/browse/AUTH-482' },
    { id: 3, title: 'AUTH-482: fix token refresh', url: 'https://github.com/acme/gateway/pull/1203' },
  ],
  groups: [{ id: 1000, title: 'My Own Group' }],
}, async (state) => {
  storage.invalidateCache();
  taskMemory.invalidateMemoryCache();

  let result;
  try {
    result = await tabManager.organizeLooseTabs(1);
  } catch (e) {
    failures.push(`organizeLooseTabs threw\n      ${e && e.stack ? e.stack.split('\n')[0] : e}`);
    return;
  }
  pass++;

  ok('organizeLooseTabs reports a count', result && typeof result.organized === 'number');
  check('the existing group is untouched',
    state.tabs.find((t) => t.id === 1).groupId, 1000);
  ok('the loose tabs were grouped', !state.looseTabs().includes(2) && !state.looseTabs().includes(3),
    `loose: ${JSON.stringify(state.looseTabs())}`);
});

// --- autoGroupTab, and the settle gate -------------------------------------

await withChrome({
  tabs: [
    { id: 1, title: 'AUTH-482 auth migration - Jira', url: 'https://acme.atlassian.net/browse/AUTH-482', groupId: 1000 },
    { id: 2, title: '', url: 'https://acme.atlassian.net/browse/AUTH-495', status: 'loading' },
    { id: 3, title: 'AUTH-482 rollback plan - Jira', url: 'https://acme.atlassian.net/browse/AUTH-482?tab=comments' },
  ],
  groups: [{ id: 1000, title: 'Auth Migration' }],
}, async (state) => {
  storage.invalidateCache();
  taskMemory.invalidateMemoryCache();

  try {
    await tabManager.autoGroupTab(2);
    await tabManager.autoGroupTab(3);
    pass++;
  } catch (e) {
    failures.push(`autoGroupTab threw\n      ${e && e.stack ? e.stack.split('\n')[0] : e}`);
    return;
  }

  check('a tab with no title yet is left ungrouped',
    state.tabs.find((t) => t.id === 2).groupId, -1);
  ok('a tab sharing a work item joins the group on screen',
    state.tabs.find((t) => t.id === 3).groupId === 1000,
    `tab 3 groupId: ${state.tabs.find((t) => t.id === 3).groupId}`);
});

// --- corrections are the only thing that teaches ---------------------------

await withChrome({
  tabs: [{ id: 1, title: 'AUTH-482 auth migration - Jira', url: 'https://acme.atlassian.net/browse/AUTH-482', groupId: 1000 }],
  groups: [{ id: 1000, title: 'Auth Migration' }],
}, async () => {
  storage.invalidateCache();
  taskMemory.invalidateMemoryCache();

  try {
    await tabManager.renameGroup(1000, 'SSO Work');
    pass++;
  } catch (e) {
    failures.push(`renameGroup threw\n      ${e && e.stack ? e.stack.split('\n')[0] : e}`);
    return;
  }

  const memory = await taskMemory.loadMemory();
  const tasks = taskMemory.listTasks(memory);
  check('a rename is learned under your name', tasks.map((t) => t.label), ['SSO Work']);
  check('and marked as yours', tasks[0] && tasks[0].userNamed, true);
});

await withChrome({
  tabs: [{ id: 1, title: 'Some page', url: 'https://example.com/reading/thing' }],
}, async (state) => {
  storage.invalidateCache();
  taskMemory.invalidateMemoryCache();

  try {
    await tabManager.moveTab(1, 'Reading');
    pass++;
  } catch (e) {
    failures.push(`moveTab threw\n      ${e && e.stack ? e.stack.split('\n')[0] : e}`);
    return;
  }

  ok('a moved tab lands in the named group',
    state.tabs[0].groupId !== -1, `groupId ${state.tabs[0].groupId}`);
  const memory = await taskMemory.loadMemory();
  ok('and the page is pinned there',
    taskMemory.recallPin(memory, { url: 'https://example.com/reading/thing' }) === 'Reading');
});

// --- snapshot, capture, ungroup: the remaining entry points ----------------

await withChrome({ tabs: WORK_TABS }, async () => {
  storage.invalidateCache();
  taskMemory.invalidateMemoryCache();
  for (const [name, fn] of [
    ['getGroupsSnapshot', () => tabManager.getGroupsSnapshot(1)],
    ['captureTaskGroup', () => tabManager.captureTaskGroup('A Task', 1)],
    ['captureFixture', () => tabManager.captureFixture(1)],
    ['collapseInactiveGroups', () => tabManager.collapseInactiveGroups(1)],
    ['ungroupAll', () => tabManager.ungroupAll(1)],
    ['clearReasons', () => tabManager.clearReasons()],
  ]) {
    try {
      const r = await fn();
      ok(`${name} runs`, r === undefined || r !== null);
    } catch (e) {
      failures.push(`${name} threw\n      ${e && e.stack ? e.stack.split('\n')[0] : e}`);
    }
  }
});

// --- a stale profile from an older version must not survive ----------------

// The reported bug, end to end: a memory written before profiles were cleaned
// up, holding one profile that had absorbed two unrelated Confluence pages and
// then been renamed. Loading it must not group those pages together.
await withChrome({
  tabs: [
    { id: 1, title: 'NG-SaaS onboarding offboarding - Confluence', url: 'https://acme.atlassian.net/wiki/spaces/EN/pages/2758606863/NG-SaaS+onboarding+offboarding' },
    { id: 2, title: 'NGSaaS 7.0.0 Upgrade - Confluence', url: 'https://acme.atlassian.net/wiki/spaces/EN/pages/5042962780/NGSaaS+7.0.0+Upgrade' },
  ],
}, async (state) => {
  storage.invalidateCache();
  taskMemory.invalidateMemoryCache();
  state.local.taskMemory = {
    version: 6,
    aliases: { 'Saas Work': 'NGSaaS' },
    pins: { 'example.com/reading/thing': 'Reading' },
    tasks: {
      NGSaaS: {
        userNamed: true,
        hits: 4,
        features: [
          'opaque:acme.atlassian.net/2758606863',
          'opaque:acme.atlassian.net/5042962780',
          'word:onboarding', 'word:upgrade', 'word:saas',
        ],
      },
    },
  };

  await tabManager.organizeAllTabs();
  const grouping = state.grouping();
  check('the two pages are no longer in one group', grouping.size, 2);
  ok('and each is on its own',
    [...grouping.values()].every((ids) => ids.length === 1),
    `grouping: ${JSON.stringify([...grouping])}`);

  const memory = await taskMemory.loadMemory();
  check('the stale profile is gone', taskMemory.listTasks(memory).length, 0);
  check('the rename survives as an alias',
    taskMemory.resolveAlias(memory, 'Saas Work'), 'NGSaaS');
  check('and so does a filed page',
    taskMemory.recallPin(memory, { url: 'https://example.com/reading/thing' }), 'Reading');
});

// --- Report ----------------------------------------------------------------

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log('All runtime checks passed.\n');
