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
import { clusterTabs, labelForKey } from '../lib/affinity.js';
import { isInternalHost, subdomainGroupLabel } from '../lib/url.js';
import { consolidateLabels } from '../lib/aiGrouper.js';

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
  taskKey('https://acme.atlassian.net/browse/AUTH-482'), 'ticket:AUTH');
check('jira issues in one project share a key',
  taskKey('https://acme.atlassian.net/browse/AUTH-495'), 'ticket:AUTH');
check('different jira project → different key',
  taskKey('https://acme.atlassian.net/browse/BILL-12'), 'ticket:BILL');
check('confluence beats the jira matcher on the same host',
  taskKey('https://acme.atlassian.net/wiki/spaces/ENG/pages/9/Design'), 'wiki:ENG');
check('github PR → repo key',
  taskKey('https://github.com/acme/gateway/pull/1203'), 'repo:acme/gateway');
check('github file in the same repo → same key',
  taskKey('https://github.com/acme/gateway/blob/main/src/auth/token.go'), 'repo:acme/gateway');
check('gitlab nested groups → full repo path',
  taskKey('https://gitlab.com/grp/sub/api/-/merge_requests/7'), 'repo:grp/sub/api');
check('two google docs are separate tasks',
  taskKey('https://docs.google.com/document/d/aaa/edit')
    !== taskKey('https://docs.google.com/spreadsheets/d/bbb/edit'), true);
check('ticket key on an unrecognized host still counts',
  taskKey('https://wiki.internal.example/AUTH-482-rollout'), 'ticket:AUTH');
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
  taskKey('https://wiki.internal.example/AUTH-482-rollout'), 'ticket:AUTH');
check('one-digit ticket is trusted on a recognized platform',
  taskKey('https://acme.atlassian.net/browse/PROJ-7'), 'ticket:PROJ');
check('one-digit ticket is not trusted on an unknown host',
  taskKey('https://random.example/PROJ-7'), null);

// GitHub/GitLab Pages paths are page routes, not owner/repo.
check('github pages is not a repo',
  taskKey('https://bishwa.github.io/myproject/page'), null);
check('gitlab pages is not a repo',
  taskKey('https://acme.gitlab.io/site/docs'), null);
check('self-hosted gitlab is still a repo',
  taskKey('https://gitlab.mycompany.com/grp/api/-/issues/3'), 'repo:grp/api');
check('ticket key read from a title',
  titleTaskKey('AUTH-482: rotate signing keys'), 'ticket:AUTH');
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
  clusters[0].tabs.map(t => t.id), [1, 2, 3, 4, 5]);
check('an unrelated tab on an already-used host stays separate',
  clusters[1].tabs.map(t => t.id), [6]);
check('cluster count', clusters.length, 2);

check('opener lineage can be disabled',
  clusterTabs(authTabs, { useOpeners: false }).length, 4);

check('a cluster spanning two work items is left for the AI to name',
  clusters[0].key, null);
check('a single-key cluster reports its key',
  clusterTabs([authTabs[0], authTabs[1]])[0].key, 'ticket:AUTH');
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
check('a PR titled with its ticket joins the repo to the ticket',
  bridged[0].tabs.map(t => t.id), [1, 2, 3, 4]);
check('unrelated work is still separate', bridged[1].tabs.map(t => t.id), [5]);
check('a cluster spanning two identities is named by the AI', bridged[0].key, null);
check('an unrelated repo is not dragged in',
  clusterTabs([
    { id: 1, title: 'Auth migration', url: 'https://acme.atlassian.net/browse/AUTH-482' },
    { id: 2, title: 'AUTH-482: fix token', url: 'https://github.com/acme/gateway/pull/1203' },
    { id: 3, title: 'Update README', url: 'https://github.com/acme/website/pull/9' },
  ]).map(c => c.tabs.map(t => t.id)), [[1, 2], [3]]);

check('repo key → readable label', labelForKey('repo:acme/gateway'), 'gateway');
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

// --- Report ---------------------------------------------------------------

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log('All grouping checks passed.\n');
