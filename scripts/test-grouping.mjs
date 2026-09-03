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
  taskKey('https://acme.atlassian.net/browse/AUTH-482'), 'jira:AUTH');
check('jira issues in one project share a key',
  taskKey('https://acme.atlassian.net/browse/AUTH-495'), 'jira:AUTH');
check('different jira project → different key',
  taskKey('https://acme.atlassian.net/browse/BILL-12'), 'jira:BILL');
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
  clusterTabs([authTabs[0], authTabs[1]])[0].key, 'jira:AUTH');
check('an opener pointing outside the pass is ignored',
  clusterTabs([{ id: 9, title: 'x', url: 'https://example.com/a', openerTabId: 999 }]).length, 1);

check('repo key → readable label', labelForKey('repo:acme/gateway'), 'gateway');
check('jira key → readable label', labelForKey('jira:AUTH'), 'AUTH');
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
