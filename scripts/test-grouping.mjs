/**
 * Grouping logic self-check. No dependencies, no browser:
 *
 *   node scripts/test-grouping.mjs
 *
 * Covers the pure logic — task signals, affinity clustering, internal-host
 * detection, label consolidation. The Chrome APIs and the on-device model are
 * not exercised here; those need the extension loaded in a browser.
 */

import { readTask, taskKey, titleTaskKey } from '../lib/taskSignal.js';
import { clusterTabs, labelForKey, nameCluster } from '../lib/affinity.js';
import { summarizeTitles, looksLikeIdentifier } from '../lib/summarize.js';
import { isInternalHost, subdomainGroupLabel } from '../lib/url.js';
import { consolidateLabels } from '../lib/aiGrouper.js';
import {
  emptyMemory, observe, learnRename, learnMove, forgetTask,
  recallForTabs, recallPin, resolveAlias, listTasks, pinKey,
} from '../lib/taskMemory.js';
import { resolveGroups } from '../lib/resolve.js';

let pass = 0;
const failures = [];

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) pass++;
  else failures.push(`${name}\n      expected: ${e}\n      actual:   ${a}`);
}

// --- Task signals: identity comes from the path, not the host ---------------

check('jira issue → project key',
  taskKey('https://acme.atlassian.net/browse/AUTH-482'), 'ticket:AUTH-482');
check('jira issues in one project share a key',
  taskKey('https://acme.atlassian.net/browse/AUTH-495'), 'ticket:AUTH-495');
check('different jira project → different key',
  taskKey('https://acme.atlassian.net/browse/BILL-12'), 'ticket:BILL-12');
check('confluence beats the jira matcher on the same host',
  taskKey('https://acme.atlassian.net/wiki/spaces/ENG/pages/9/Design'), 'wikipage:9');
check('github PR → repo key',
  taskKey('https://github.com/acme/gateway/pull/1203'), 'pr:acme/gateway#1203');
check('github file in the same repo → same key',
  taskKey('https://github.com/acme/gateway/blob/main/src/auth/token.go'), null);
check('gitlab nested groups → full repo path',
  taskKey('https://gitlab.com/grp/sub/api/-/merge_requests/7'), 'pr:grp/sub/api#7');
check('two google docs are separate tasks',
  taskKey('https://docs.google.com/document/d/aaa/edit')
    !== taskKey('https://docs.google.com/spreadsheets/d/bbb/edit'), true);
check('ticket key on an unrecognized host still counts',
  taskKey('https://wiki.internal.example/AUTH-482-rollout'), 'ticket:AUTH-482');
check('plain page has no task key',
  taskKey('https://www.rfc-editor.org/rfc/rfc6749'), null);

// Standards, encodings and formats look exactly like ticket keys. Treating them
// as tasks would cluster unrelated tabs — every page mentioning UTF-8 together.
for (const url of [
  'https://example.com/download?charset=UTF-8',
  'https://example.com/docs/UTF-8/intro',
  'https://example.com/std/ISO-8601',
  'https://example.com/a/SHA-256/b',
  'https://example.com/p/COVID-19',
  'https://example.com/rfc/RFC-6749',
  'https://example.com/x/CVE-2024/y',
]) {
  check(`not a ticket: ${url.slice(20)}`, taskKey(url), null);
}
for (const title of ['UTF-8 encoding explained', 'COVID-19 dashboard', 'ISO-8601 date format']) {
  check(`not a ticket title: ${title}`, titleTaskKey(title), null);
}
check('a real ticket on an unknown host still reads',
  taskKey('https://wiki.internal.example/AUTH-482-rollout'), 'ticket:AUTH-482');
check('one-digit ticket is trusted on a recognized platform',
  taskKey('https://acme.atlassian.net/browse/PROJ-7'), 'ticket:PROJ-7');
check('a one-digit ticket reads on an unknown host too (the prefix list, not a\n// digit count, is what rejects lookalikes)',
  taskKey('https://random.example/PROJ-7'), 'ticket:PROJ-7');

// GitHub/GitLab Pages paths are page routes, not owner/repo.
check('github pages is not a repo',
  taskKey('https://bishwa.github.io/myproject/page'), null);
check('gitlab pages is not a repo',
  taskKey('https://acme.gitlab.io/site/docs'), null);
check('self-hosted gitlab is still a repo',
  taskKey('https://gitlab.mycompany.com/grp/api/-/issues/3'), 'gh-issue:grp/api#3');
check('ticket key read from a title',
  titleTaskKey('AUTH-482: rotate signing keys'), 'ticket:AUTH-482');
check('search query becomes a prompt hint',
  readTask('https://www.google.com/search?q=oauth+refresh').display, 'search "oauth refresh"');

// --- Affinity: opener lineage bridges hosts, coincidence does not -----------

const authTabs = [
  { id: 1, title: 'AUTH-482', url: 'https://acme.atlassian.net/browse/AUTH-482' },
  { id: 2, title: 'AUTH-495', url: 'https://acme.atlassian.net/browse/AUTH-495' },
  { id: 3, title: 'PR 1203', url: 'https://github.com/acme/gateway/pull/1203', openerTabId: 1 },
  { id: 4, title: 'token.go', url: 'https://github.com/acme/gateway/blob/main/a.go' },
  { id: 5, title: 'Spec', url: 'https://docs.google.com/document/d/abc/edit', openerTabId: 3 },
  { id: 6, title: 'Budget', url: 'https://docs.google.com/spreadsheets/d/xyz/edit' },
];
const clusters = clusterTabs(authTabs);
check('one task spanning 3 hosts is a single cluster',
  clusters[0].tabs.map(t => t.id), [1, 3, 4, 5]);
check('a different ticket is its own task, even in the same project',
  clusters[1].tabs.map(t => t.id), [2]);
check('an unrelated tab on an already-used host stays separate',
  clusters[2].tabs.map(t => t.id), [6]);
check('cluster count', clusters.length, 3);

check('opener lineage can be disabled',
  clusterTabs(authTabs, { useOpeners: false }).length, 5);

check('a cluster spanning several work items is left for the AI to name',
  clusters[0].key, null);
check('a single-work-item cluster reports its key',
  clusterTabs([authTabs[0], authTabs[2]])[0].key, null);
check('two tabs of the same ticket share one key',
  clusterTabs([
    { id: 1, title: 'AUTH-482 rollout', url: 'https://acme.atlassian.net/browse/AUTH-482' },
    { id: 2, title: 'AUTH-482 comments', url: 'https://acme.atlassian.net/browse/AUTH-482?focus=c1' },
  ])[0].key, 'ticket:AUTH-482');
check('an opener pointing outside the pass is ignored',
  clusterTabs([{ id: 9, title: 'x', url: 'https://example.com/a', openerTabId: 999 }]).length, 1);

// A tab carrying two identities bridges their clusters. A PR titled with its
// ticket id is a deliberate statement about which work the change belongs to.
const bridged = clusterTabs([
  { id: 1, title: 'Auth migration rollout', url: 'https://acme.atlassian.net/browse/AUTH-482' },
  { id: 2, title: 'Rotate signing keys', url: 'https://acme.atlassian.net/browse/AUTH-495' },
  { id: 3, title: 'AUTH-482: fix token refresh', url: 'https://github.com/acme/gateway/pull/1203' },
  { id: 4, title: 'gateway/src/auth/token.go', url: 'https://github.com/acme/gateway/blob/main/a.go' },
  { id: 5, title: 'Q3 budget', url: 'https://docs.google.com/spreadsheets/d/x/edit' },
]);
check('a PR titled with its ticket joins that ticket, and pulls in the repo file',
  bridged[0].tabs.map(t => t.id), [1, 3, 4]);
check('a DIFFERENT ticket in the same project is not merged in',
  bridged[1].tabs.map(t => t.id), [2]);
check('unrelated work is still separate', bridged[2].tabs.map(t => t.id), [5]);
check('an unrelated repo is not dragged in',
  clusterTabs([
    { id: 1, title: 'Auth migration', url: 'https://acme.atlassian.net/browse/AUTH-482' },
    { id: 2, title: 'AUTH-482: fix token', url: 'https://github.com/acme/gateway/pull/1203' },
    { id: 3, title: 'Update README', url: 'https://github.com/acme/website/pull/9' },
  ]).map(c => c.tabs.map(t => t.id)), [[1, 2], [3]]);

// A container (a repo, a project, a wiki space) holds many unrelated work
// items, so it must not join them. Three tickets touching one monorepo are
// three tasks — merging them was a precision collapse the benchmark caught.
check('one container, three work items → three clusters',
  clusterTabs([
    { id: 1, title: 'WEB-101 login redirect loop', url: 'https://acme.atlassian.net/browse/WEB-101' },
    { id: 2, title: 'WEB-101: fix login redirect', url: 'https://github.com/acme/monorepo/pull/500' },
    { id: 3, title: 'WEB-115 image upload fails', url: 'https://acme.atlassian.net/browse/WEB-115' },
    { id: 4, title: 'WEB-115: chunk uploads', url: 'https://github.com/acme/monorepo/pull/504' },
    { id: 5, title: 'SEARCH-9 latency regression', url: 'https://acme.atlassian.net/browse/SEARCH-9' },
    { id: 6, title: 'SEARCH-9: add cache', url: 'https://github.com/acme/monorepo/pull/511' },
  ]).map(c => c.tabs.map(t => t.id)), [[1, 2], [3, 4], [5, 6]]);
check('a container with ONE work item adopts its loose files',
  clusterTabs([
    { id: 1, title: 'DOC-12: rewrite guide', url: 'https://github.com/acme/website/pull/77' },
    { id: 2, title: 'website/docs/getting-started.md', url: 'https://github.com/acme/website/blob/main/docs/g.md' },
  ]).map(c => c.tabs.map(t => t.id)), [[1, 2]]);
check('loose files in a busy container stay together, not with any one item',
  clusterTabs([
    { id: 1, title: 'WEB-101: a', url: 'https://github.com/acme/mono/pull/1' },
    { id: 2, title: 'WEB-115: b', url: 'https://github.com/acme/mono/pull/2' },
    { id: 3, title: 'mono/src/a.go', url: 'https://github.com/acme/mono/blob/main/src/a.go' },
    { id: 4, title: 'mono/src/b.go', url: 'https://github.com/acme/mono/blob/main/src/b.go' },
  ]).map(c => c.tabs.map(t => t.id)), [[1], [2], [3, 4]]);

// Strong vs weak tiers, read straight off the URL.
check('a pull request is a work item', taskKey('https://github.com/acme/api/pull/7'), 'pr:acme/api#7');
check('a source file is not', taskKey('https://github.com/acme/api/blob/main/a.go'), null);
check('a jira board is a container, not a work item',
  taskKey('https://acme.atlassian.net/jira/software/projects/AUTH/boards/2'), null);
check('a slack channel is a container', taskKey('https://app.slack.com/client/T01ABCDEF/C02GHIJKL'), null);

check('repo key → readable label', labelForKey('repo:acme/gateway'), 'gateway');

// --- Group names describe the work, they never identify it ------------------

for (const label of ['AUTH-482', 'AUTH', 'Jira: AUTH', 'acme/gateway', '#1203', 'PR 1203']) {
  check(`identifier rejected as a name: ${label}`, looksLikeIdentifier(label), true);
}
for (const label of ['Auth Migration', 'Gift Card', 'Q3 Budget', 'Memory Limits']) {
  check(`description accepted as a name: ${label}`, looksLikeIdentifier(label), false);
}

check('two words read from the titles, in reading order',
  summarizeTitles([
    'CART-88 checkout total wrong for gift cards',
    'Fix gift card rounding #442 · acme/storefront',
    'Gift card rounding - Notion',
  ]), 'Gift Card');
check('site chrome and ids are stripped before naming',
  summarizeTitles([
    'SRE-77 memory limits for analytics worker',
    'OOMKilled analytics-worker',
    'prod cluster pod evictions',
  ]), 'Analytics Worker');
check('a cluster is named from its titles, not its task key',
  nameCluster({
    key: 'ticket:AUTH',
    tabs: [
      { title: 'AUTH-482 auth migration rollout', url: 'https://acme.atlassian.net/browse/AUTH-482' },
      { title: 'AUTH-495 auth migration keys', url: 'https://acme.atlassian.net/browse/AUTH-495' },
    ],
  }), 'Auth Migration');
check('the task key is the fallback when titles say nothing',
  nameCluster({
    key: 'ticket:AUTH',
    tabs: [{ title: 'Jira', url: 'https://acme.atlassian.net/browse/AUTH-482' }],
  }), 'AUTH');
check('ticket key → readable label', labelForKey('ticket:AUTH'), 'AUTH');
check('opaque ids make poor labels', labelForKey('gdoc:abc123'), null);

// --- Internal hosts stay deterministic; SaaS hosts do not ------------------

for (const [url, expected] of [
  ['https://prod-eu-frankfurt-1-grafana.corp.example.com/', true],
  ['https://dev-qa3.corp.example.com/', true],
  ['https://prod-db-01.example.com/', true],
  ['https://jenkins/job/x', true],
  ['https://10.0.4.12:9200/x', true],
  ['https://docs.google.com/document/d/a/edit', false],
  ['https://mail.google.com/mail/u/0/', false],
  ['https://app.slack.com/client/T/C', false],
  ['https://console.aws.amazon.com/ec2/', false],
  ['https://acme.atlassian.net/browse/A-1', false],
  ['https://my-cool-app.vercel.app/', false],
  ['https://grafana.acme.io/d/x/y', false],
]) {
  check(`isInternalHost ${new URL(url).hostname}`, isInternalHost(url), expected);
}

check('configured internal domain is honored',
  isInternalHost('https://wiki.acme.io/x', ['acme.io']), true);

const opts = { scope: 'internal', internalDomains: [] };
check('two internal clusters never merge',
  subdomainGroupLabel('https://prod-eu-1-graf.corp.example.com/', 'subdomain', opts)
    !== subdomainGroupLabel('https://prod-ap-1-graf.corp.example.com/', 'subdomain', opts), true);
check('SaaS host is left to task grouping',
  subdomainGroupLabel('https://docs.google.com/x', 'subdomain', opts), null);
check('IP host groups by the whole address, not its first octet',
  subdomainGroupLabel('https://10.0.4.12/x', 'subdomain', opts), '10.0.4.12');
check('legacy scope:all still groups any subdomain',
  subdomainGroupLabel('https://docs.google.com/x', 'subdomain', { scope: 'all' }), 'docs');
check('prefix strategy drops the trailing dash-token',
  subdomainGroupLabel('https://a-b-1-web.corp.example.com/', 'prefix', opts), 'a-b-1');

// --- Label consolidation ---------------------------------------------------

check('label variants merge to the most common spelling',
  [...consolidateLabels(new Map([
    [1, 'Auth Migration'], [2, 'Auth Migrations'], [3, 'auth migration'], [4, 'Migration - Auth'],
  ])).values()],
  ['Auth Migration', 'Auth Migration', 'Auth Migration', 'Auth Migration']);
check('genuinely different labels are not merged',
  [...consolidateLabels(new Map([
    [1, 'Budget'], [2, 'Budget Review'], [3, 'Q3 Budget'],
  ])).values()],
  ['Budget', 'Budget Review', 'Q3 Budget']);

// --- Learning: corrections have to stick ------------------------------------

const authGroup = [
  { id: 1, title: 'AUTH-482 auth migration rollout', url: 'https://acme.atlassian.net/browse/AUTH-482' },
  { id: 2, title: 'AUTH-482: fix token refresh', url: 'https://github.com/acme/gateway/pull/1203' },
];

{
  // Renaming a group teaches your name for that work.
  let m = observe(emptyMemory(), 'Auth Token', authGroup);
  m = learnRename(m, 'Auth Token', 'SSO Work', authGroup);

  check('a rename makes your name canonical', resolveAlias(m, 'Auth Token'), 'SSO Work');
  check('the old name is gone from the task list',
    listTasks(m).map((t) => t.label), ['SSO Work']);
  check('your name is marked as yours', listTasks(m)[0].userNamed, true);
  check('the profile carries over, so the task is still recognized',
    recallForTabs(m, [authGroup[0]]).label, 'SSO Work');

  // A new tab of the same work is recognized without the AI.
  check('a later tab of the same ticket recalls your name',
    recallForTabs(m, [{ id: 9, title: 'AUTH-482 rollout notes', url: 'https://acme.atlassian.net/browse/AUTH-482' }]).label,
    'SSO Work');
  check('recall is by task key, not by host',
    recallForTabs(m, [{ id: 9, title: 'AUTH-482 rollout', url: 'https://wiki.example.com/AUTH-482' }]).via,
    'key');

  // Unrelated work must not match.
  check('an unrelated tab is not recalled',
    recallForTabs(m, [{ id: 10, title: 'Weather for San Jose', url: 'https://weather.com/today' }]),
    null);
  check('a mere shared host is not enough to recall',
    recallForTabs(m, [{ id: 11, title: 'Update README', url: 'https://github.com/other/site/pull/1' }]),
    null);

  // Renaming twice must not leave a dangling chain.
  const m2 = learnRename(m, 'SSO Work', 'Identity Work', authGroup);
  check('a second rename re-points the first alias',
    resolveAlias(m2, 'Auth Token'), 'Identity Work');
  check('renaming twice leaves one task', listTasks(m2).length, 1);
}

{
  // Filing a tab by hand pins that page, and nothing may move it back.
  const stray = { id: 5, title: 'Best headphones 2026', url: 'https://www.nytimes.com/wirecutter/x/' };
  const m = learnMove(emptyMemory(), stray, 'Shopping');
  check('a page you filed is pinned there', recallPin(m, stray), 'Shopping');
  check('the pin ignores query and fragment',
    recallPin(m, { ...stray, url: 'https://www.nytimes.com/wirecutter/x/?utm=1#top' }), 'Shopping');
  check('a different page is not pinned',
    recallPin(m, { id: 6, title: 'x', url: 'https://www.nytimes.com/other/' }), null);
  check('pins follow a later rename',
    recallPin(learnRename(m, 'Shopping', 'Gear', []), stray), 'Gear');
  check('forgetting a task drops its pins',
    recallPin(forgetTask(m, 'Shopping'), stray), null);
}

{
  // The pipeline must honor a pin above every automatic decision, including a
  // pinned rule that says otherwise.
  const tab = { id: 1, title: 'AUTH-482 rollout', url: 'https://acme.atlassian.net/browse/AUTH-482' };
  const settings = { pinnedRules: [{ match: 'atlassian.net', label: 'Jira' }], minGroupSize: 1 };

  const ruled = await resolveGroups([tab], { settings, memory: emptyMemory() });
  check('a pinned rule applies when nothing else has', ruled.assignments.get(1).label, 'Jira');
  check('and is reported as a rule', ruled.assignments.get(1).reason, 'rule');

  const pinnedMem = learnMove(emptyMemory(), tab, 'SSO Work');
  const overridden = await resolveGroups([tab], { settings, memory: pinnedMem });
  check('your own filing outranks a pinned rule',
    overridden.assignments.get(1).label, 'SSO Work');
  check('and is reported as yours', overridden.assignments.get(1).reason, 'pin');
}

{
  // A learned task should close the gap that needs semantics.
  const tabs = [
    { id: 1, title: 'AUTH-482 auth migration rollout', url: 'https://acme.atlassian.net/browse/AUTH-482' },
    { id: 2, title: 'AUTH-495 rotate signing keys', url: 'https://acme.atlassian.net/browse/AUTH-495' },
  ];
  const settings = { minGroupSize: 1 };

  const cold = await resolveGroups(tabs, { settings, memory: emptyMemory() });
  check('two tickets in one project are not merged on a guess',
    cold.assignments.get(1).label === cold.assignments.get(2).label, false);

  const taught = observe(emptyMemory(), 'SSO Work', tabs, { userNamed: true });
  const warm = await resolveGroups(tabs, { settings, memory: taught });
  check('once taught, they group together',
    warm.assignments.get(1).label === warm.assignments.get(2).label, true);
  check('under the name you gave', warm.assignments.get(1).label, 'SSO Work');
  check('and it says it learned that', warm.assignments.get(1).reason, 'learned');
}

check('pin keys normalize host and trailing slash',
  pinKey('https://WWW.Example.com/a/b/'), 'example.com/a/b');

// --- Report ---------------------------------------------------------------

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log('All grouping checks passed.\n');
