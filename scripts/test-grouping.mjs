/**
 * Grouping logic self-check. No dependencies, no browser:
 *
 *   node scripts/test-grouping.mjs
 *
 * Covers the pure logic — task signals, affinity clustering, internal-host
 * detection, label consolidation. The Chrome APIs and the on-device model are
 * not exercised here; those need the extension loaded in a browser.
 */

import { readFileSync } from 'node:fs';
import { readTask, taskKey, titleTaskKey } from '../lib/taskSignal.js';
import { clusterTabs, labelForKey, nameCluster } from '../lib/affinity.js';
import { summarizeTitles, looksLikeIdentifier, titleTokens } from '../lib/summarize.js';
import { isInternalHost, subdomainGroupLabel } from '../lib/url.js';
import { consolidateLabels } from '../lib/aiGrouper.js';
import {
  emptyMemory, observe, learnRename, learnMove, forgetTask,
  recallForTabs, recallPin, resolveAlias, listTasks, pinKey,
} from '../lib/taskMemory.js';
import { resolveGroups, relatedGroupFor, hasSettled } from '../lib/resolve.js';
import { redactUrl } from '../lib/tabManager.js';
import { contentToText, gatherContent, __testing } from '../lib/pageContent.js';
import { buildContext, extractFeatures, identitiesOf, namesWork } from '../lib/context.js';

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

// A cluster's key is the one piece of work it is about, if there is exactly
// one. Pull requests and documents are identified by their full path rather
// than by an extracted reference, so they do not compete for the naming.
check('a cluster about one work item reports it',
  clusters[0].key, 'ticket:AUTH-482');
check('a ticket and its pull request are one work item',
  clusterTabs([authTabs[0], authTabs[2]])[0].key, 'ticket:AUTH-482');
check('a cluster spanning two work items is left for the AI to name',
  clusterTabs([
    { id: 1, title: 'WEB-101 login redirect', url: 'https://acme.atlassian.net/browse/WEB-101' },
    { id: 2, title: 'WEB-101 and SEARCH-9 rollup', url: 'https://acme.atlassian.net/browse/SEARCH-9' },
  ])[0].key, null);
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

// Internal-ness is claimed only by a private marker, a bare host, an IP, or
// your own configuration. Deliberately NOT by hostname shape: an internal
// cluster and a public shard are the same string pattern, and guessing from
// the pattern turned `mail-1.google.com` into its own per-host group.
for (const [url, expected] of [
  ['https://prod-eu-frankfurt-1-grafana.corp.example.com/', true],
  ['https://dev-qa3.corp.example.com/', true],
  ['https://prod-eu-1-kibana.acme.internal/', true],
  ['https://box.intranet.example.com/', true],
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

// A corpus of ordinary hostnames, none of which may be claimed as internal
// infrastructure. Thirteen of these were, which is what "domain grouping is
// active" looked like from the outside.
for (const host of [
  'mail-1.google.com', 's3-us-west-2.amazonaws.com', 'api-v2.stripe.com',
  'chat-2.slack.com', 'node-01.datadoghq.com', 'my-app-1.vercel.app',
  'ec2-52-1-2-3.compute-1.amazonaws.com', 'edge-3.cloudflare.com',
  'teams-1.microsoft.com', 'app-1.hubspot.com', 'static-1.squarespace.com',
  'cdn-1.example.com', 'web-2.medium.com', 'us02web.zoom.us', 'www2.example.com',
  'prod-db-01.example.com',
]) {
  check(`public host is not infrastructure: ${host}`,
    isInternalHost(`https://${host}/x`), false);
}
check('an internal host on a public-looking domain needs configuring',
  isInternalHost('https://prod-eu-1-grafana.acme.io/x', ['acme.io']), true);

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
// --- One cluster is one group -----------------------------------------------

// Reported from real use: every service on a cluster was getting its own group.
{
  const co = { scope: 'internal', internalDomains: ['corp.example.com'] };
  const label = (h) => subdomainGroupLabel(`https://${h}.corp.example.com/x`, 'cluster', co);

  check('every service on a cluster shares one group',
    [label('prod-eu-frankfurt-1-grafana'), label('prod-eu-frankfurt-1-kibana'), label('prod-eu-frankfurt-1-jumper')],
    ['prod-eu-frankfurt-1', 'prod-eu-frankfurt-1', 'prod-eu-frankfurt-1']);
  check('component suffixes collapse too',
    [label('gamma-dl'), label('gamma-da'), label('gamma-jumper')],
    ['gamma', 'gamma', 'gamma']);
  check('two clusters still never merge',
    label('prod-eu-frankfurt-1-grafana') === label('prod-ap-singapore-1-grafana'), false);
  check('nor do two deployments', label('gamma-dl') === label('delta-dl'), false);

  // The reason 'prefix' could not simply become the default: it takes the last
  // token unconditionally, turning dev-qa3 into dev and merging two clusters.
  check('a cluster whose name ends in its ordinal is left whole',
    [label('dev-qa3'), label('dev-qa4')], ['dev-qa3', 'dev-qa4']);
  check('and prefix would have merged those two',
    subdomainGroupLabel('https://dev-qa3.corp.example.com/x', 'prefix', co)
      === subdomainGroupLabel('https://dev-qa4.corp.example.com/x', 'prefix', co), true);

  check('a service token that is not trailing is kept', label('prod-db-01'), 'prod-db-01');
  check('a single-token host is left alone', label('grafana'), 'grafana');
  check('service tokens are configurable',
    subdomainGroupLabel('https://alpha-widget.corp.example.com/x', 'cluster',
      { ...co, clusterServiceTokens: ['widget'] }), 'alpha');
  check('one group per service is still available',
    subdomainGroupLabel('https://prod-eu-1-grafana.corp.example.com/x', 'subdomain', co),
    'prod-eu-1-grafana');
}

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

// --- The context engine works without knowing the site ---------------------

// The point of scoring rather than matching: a tracker and a wiki nobody wrote
// a rule for behave exactly like Jira and Confluence.
check('an unknown tracker still bridges a ticket to its review',
  clusterTabs([
    { id: 1, title: 'PLAT-88 nightly import times out', url: 'https://tracker.acme-internal.dev/task/PLAT-88' },
    { id: 2, title: 'PLAT-88: retry the import in batches', url: 'https://code.acme-internal.dev/r/proj/importer/change/9912' },
    { id: 3, title: 'Espresso machine descaling rota', url: 'https://wiki.acme-internal.dev/page/office/espresso-rota' },
  ]).map(c => c.tabs.map(t => t.id)), [[1, 2], [3]]);

check('an unknown wiki page joins the ticket it documents, by subject',
  clusterTabs([
    { id: 1, title: 'PLAT-88 nightly import times out', url: 'https://tracker.acme-internal.dev/task/PLAT-88' },
    { id: 2, title: 'Nightly import runbook', url: 'https://wiki.acme-internal.dev/page/ops/nightly-import-runbook' },
  ]).map(c => c.tabs.map(t => t.id)), [[1, 2]]);

check('two tickets on an unknown tracker stay apart',
  clusterTabs([
    { id: 1, title: 'PLAT-88 nightly import times out', url: 'https://tracker.acme-internal.dev/task/PLAT-88' },
    { id: 2, title: 'PLAT-91 dashboard legend overlaps', url: 'https://tracker.acme-internal.dev/task/PLAT-91' },
  ]).map(c => c.tabs.map(t => t.id)), [[1], [2]]);

// Identifiers a tab carries are absolute — no dependence on what else is open,
// which is what makes them safe for task memory to persist.
check('a reference is an identity',
  identitiesOf({ id: 1, title: 'x', url: 'https://any.host/thing/PLAT-88' }), ['ref:PLAT-88']);
check('a standard is not an identity',
  identitiesOf({ id: 1, title: 'UTF-8 notes', url: 'https://any.host/d?charset=UTF-8' }), []);
check('a generated id is an identity',
  identitiesOf({ id: 1, title: 'x', url: 'https://any.host/pages/2758606863/thing' }), ['opaque:2758606863']);
check('a readable slug is not an identity',
  identitiesOf({ id: 1, title: 'x', url: 'https://any.host/docs/getting-started-2' }), []);
check('namesWork reflects that', namesWork({ id: 1, title: 'PLAT-88 x', url: 'https://a.b/c' }), true);

{
  // Rarity is measured over the tabs actually open, which is how one feature
  // can be an identity in one window and a container in another.
  const alone = buildContext([
    { id: 1, title: 'Import times out', url: 'https://tracker.acme.dev/task/PLAT-88' },
    { id: 2, title: 'Retry in batches', url: 'https://tracker.acme.dev/task/PLAT-88/comments' },
  ]);
  check('a path shared by two tabs is an identity',
    alone.relate(1, 2).related, true);

  const crowded = buildContext([
    { id: 1, title: 'Import times out', url: 'https://tracker.acme.dev/task/PLAT-88' },
    { id: 2, title: 'Legend overlaps', url: 'https://tracker.acme.dev/task/PLAT-91' },
    { id: 3, title: 'Slow query', url: 'https://tracker.acme.dev/task/PLAT-95' },
    { id: 4, title: 'Broken link', url: 'https://tracker.acme.dev/task/PLAT-99' },
  ]);
  check('the same path shared by many tabs is only a container',
    crowded.relate(1, 2).related, false);
}

{
  // The scoring split, which is what stops "same place" reading as "same work".
  const ctx = buildContext([
    { id: 1, title: 'AUTH-482 rollout', url: 'https://acme.atlassian.net/browse/AUTH-482' },
    { id: 2, title: 'AUTH-482: fix token', url: 'https://github.com/acme/gateway/pull/1203' },
    { id: 3, title: 'BILL-9 invoice mismatch', url: 'https://acme.atlassian.net/browse/BILL-9' },
  ]);
  check('a shared reference is identity evidence', ctx.relate(1, 2).basis, 'identity');
  check('siblings in a tracker are not related', ctx.relate(1, 3).related, false);
}

check('an interior path segment names a container, a leaf names content',
  clusterTabs([
    { id: 1, title: 'Fix upload · Pull Request #1 · acme/monorepo', url: 'https://github.com/acme/monorepo/pull/1' },
    { id: 2, title: 'Fix login · Pull Request #2 · acme/monorepo', url: 'https://github.com/acme/monorepo/pull/2' },
  ]).map(c => c.tabs.map(t => t.id)), [[1], [2]]);

// --- Boilerplate in titles is not subject matter ---------------------------

// Reported from real use: every ticket in a queue carries the same bracketed
// deployment tags, so treating them as subject matter merged onboarding work
// with upgrade work and named the group "Single Org".
{
  const queue = [
    { id: 1, title: '[single-org] [ap-tokyo-1] customerpoc - onboarding', url: 'https://acme.atlassian.net/browse/SASOBD-603' },
    { id: 2, title: 'NG-SaaS onboarding offboarding - Confluence', url: 'https://acme.atlassian.net/wiki/spaces/EN/pages/2758606863/NG-SaaS+onboarding' },
    { id: 3, title: '[single-org] [ap-tokyo-1] acmecorp - upgrade failed at step 4', url: 'https://acme.atlassian.net/browse/SASUPG-211' },
    { id: 4, title: '[single-org] [us-ashburn-1] betacorp - upgrade stuck', url: 'https://acme.atlassian.net/browse/SASUPG-244' },
  ];
  const got = clusterTabs(queue);
  check('shared deployment tags do not merge unrelated tickets',
    got.map(c => c.tabs.map(t => t.id)), [[1, 2], [3, 4]]);
  check('and the group is not named after the tag', nameCluster(got[0]), 'Softbankpoc Onboarding'.replace('Softbankpoc', 'Customerpoc'));
  check('a bracketed tag is not a title word',
    titleTokens('[single-org] [ap-tokyo-1] customerpoc - onboarding'),
    ['customerpoc', 'onboarding']);
}

// A quarter looks exactly like a ticket. The denylist that rejects it lived in
// two copies — one for grouping, one for prompt hints — which had already
// drifted sixteen entries, leaving the copy doing the grouping the weaker one.
check('a quarter is not a work item',
  identitiesOf({ id: 1, title: 'Q3-2026 revenue plan', url: 'https://example.com/x' }), []);
check('two unrelated pages sharing a quarter stay apart',
  clusterTabs([
    { id: 1, title: 'Q3-2026 revenue plan', url: 'https://example.com/finance/revenue' },
    { id: 2, title: 'Q3-2026 hiring freeze memo', url: 'https://other.com/hr/freeze' },
  ]).map(c => c.tabs.map(t => t.id)), [[1], [2]]);
check('a real reference still reads',
  identitiesOf({ id: 1, title: 'AUTH-482 rollout', url: 'https://example.com/x' }), ['ref:AUTH-482']);

// --- Internal hosts must never be merged by topic --------------------------

// This is why internal hosts are resolved BEFORE the context engine. Scored,
// two infrastructure clusters serving identically-titled pages look like the
// same work — the titles are identical — and merging them is the original
// complaint that started all of this.
{
  const infra = [
    { id: 1, title: 'Grafana', url: 'https://prod-eu-frankfurt-1-grafana.corp.example.com/login' },
    { id: 2, title: 'Grafana - Node exporter', url: 'https://prod-eu-frankfurt-1-grafana.corp.example.com/d/node/nodes' },
    { id: 3, title: 'Grafana', url: 'https://prod-ap-singapore-1-grafana.corp.example.com/login' },
    { id: 4, title: 'Grafana - Node exporter', url: 'https://prod-ap-singapore-1-grafana.corp.example.com/d/node/nodes' },
  ];
  const settings = {
    minGroupSize: 1,
    internalDomains: ['corp.example.com'],
    subdomainScope: 'internal',
    subdomainStrategy: 'subdomain',
  };
  const { assignments } = await resolveGroups(infra, { settings, memory: emptyMemory() });
  const label = (id) => assignments.get(id).label;
  check('tabs on one internal host group together', label(1) === label(2), true);
  check('two internal clusters are never merged', label(1) === label(3), false);
  check('not even with identical page titles', label(2) === label(4), false);
  check('and it reports why', assignments.get(1).reason, 'internal');

  // The engine, given the same pair, would merge them — which is the point.
  const ctx = buildContext(infra);
  check('the engine alone would have merged them', ctx.relate(2, 4).related, true);
}

// --- A tab arriving alone can still find its group -------------------------

// A full pass clusters everything at once. A single new tab has no such view,
// so without this it could only be placed by a rule, by memory, or by the
// model — and a tab plainly belonging with what is on screen would wait for
// the next batch.
{
  const open = [
    { id: 1, title: 'AUTH-482 auth migration rollout', url: 'https://acme.atlassian.net/browse/AUTH-482', group: 'Auth Migration' },
    { id: 2, title: 'AUTH-482: fix token refresh', url: 'https://github.com/acme/gateway/pull/1203', group: 'Auth Migration' },
    { id: 3, title: 'Q3 budget planning', url: 'https://docs.google.com/spreadsheets/d/q3budget2026/edit', group: 'Q3 Budget' },
    { id: 4, title: 'Loose unrelated tab', url: 'https://example.com/nothing', group: '' },
  ];
  const arriving = (title, url) => relatedGroupFor({ id: 9, title, url }, open);

  const sameTicket = arriving('AUTH-482 rollback plan', 'https://acme.atlassian.net/browse/AUTH-482?tab=comments');
  check('a tab on the same ticket joins that group', sameTicket && sameTicket.label, 'Auth Migration');
  check('and says it was the work item', sameTicket && sameTicket.via, 'key');

  const sameSubject = arriving('OAuth token refresh notes', 'https://www.rfc-editor.org/rfc/rfc6749');
  check('a tab on the same subject joins that group', sameSubject && sameSubject.label, 'Auth Migration');
  check('and says it was the subject', sameSubject && sameSubject.via, 'topic');

  check('the right group wins when several are open',
    (arriving('Q3 budget vendor invoice', 'https://mail.google.com/mail/u/0/#x') || {}).label, 'Q3 Budget');
  check('an unrelated tab joins nothing',
    arriving('Best headphones 2026', 'https://www.nytimes.com/wirecutter/x/'), null);
  check('a loose tab is not a group to join',
    arriving('Nothing at all here', 'https://example.com/nothing-else'), null);
  check('with no groups open there is nothing to join',
    relatedGroupFor({ id: 9, title: 'x', url: 'https://acme.atlassian.net/browse/AUTH-482' },
      [{ id: 1, title: 'y', url: 'https://acme.atlassian.net/browse/AUTH-482', group: '' }]), null);
}

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
  check('the profile is stored in the engine feature vocabulary',
    listTasks(m)[0].features.some((f) => f === 'ref:AUTH-482'), true);
  check('container words are not remembered as subject matter',
    listTasks(m)[0].features.includes('word:gateway'), false);

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

// --- The URL's last segment is the backup description ----------------------

// Page content is never read, so a title is the main description. When it is
// just a product name — the state a tab is in before an app sets its title,
// and permanently for some dashboards — the slug is all that is left. Without
// this, such pages fell all the way back to hostname grouping, which is the
// exact failure this project exists to remove.
{
  const subjectOf = (title, url) => [...extractFeatures({ id: 1, title, url }).features.keys()]
    .filter((k) => k.startsWith('word:')).map((k) => k.slice(5));

  check('a descriptive slug supplies subject matter when the title cannot',
    subjectOf('Confluence', 'https://acme.atlassian.net/wiki/spaces/EN/pages/2758606863/NG-SaaS+onboarding+offboarding'),
    ['saas', 'onboarding', 'offboarding']);
  check('and it groups pages a generic title could not',
    clusterTabs([
      { id: 1, title: 'Confluence', url: 'https://acme.atlassian.net/wiki/spaces/EN/pages/2758606863/NG-SaaS+onboarding' },
      { id: 2, title: 'Grafana', url: 'https://grafana.acme.io/d/abc123/saas-onboarding-latency' },
      { id: 3, title: 'Confluence', url: 'https://acme.atlassian.net/wiki/spaces/FIN/pages/4419900012/Billing+export+reconciliation' },
    ]).map(c => c.tabs.map(t => t.id)), [[1, 2], [3]]);
  check('the group is named from the slug too',
    nameCluster({ key: null, tabs: [
      { title: 'Confluence', url: 'https://acme.atlassian.net/wiki/spaces/EN/pages/2758606863/NG-SaaS+onboarding+offboarding' },
      { title: 'Grafana', url: 'https://grafana.acme.io/d/abc123/saas-onboarding-latency' },
    ] }), 'Saas Onboarding');

  // Interior segments are still containers, not subject matter.
  check('only the leaf contributes, not the path above it',
    subjectOf('', 'https://github.com/acme/monorepo/pull/500'), []);
  check('an opaque leaf contributes nothing',
    subjectOf('Google Docs', 'https://docs.google.com/document/d/1kQm7yTvB2xNpLr9WsEc/edit'), []);
}

// --- A tab is only judged once it can say what it is -----------------------

// Reported from real use: a tab jumped into a group the moment it opened.
// Grouping fired before the page had a title, leaving the hostname as the only
// signal — the one inference this project exists to avoid.
{
  const settled = (title, url) => hasSettled({ title, url });
  check('no title yet is not settled', settled('', 'https://acme.atlassian.net/browse/A-1'), false);
  check('the URL echoed back as a title is not settled',
    settled('https://acme.atlassian.net/browse/A-1', 'https://acme.atlassian.net/browse/A-1'), false);
  check('a bare hostname placeholder is not settled',
    settled('acme.atlassian.net', 'https://acme.atlassian.net/browse/A-1'), false);
  check('a host+path placeholder is not settled',
    settled('acme.atlassian.net/browse/A-1', 'https://acme.atlassian.net/browse/A-1'), false);
  check('a real title is settled',
    settled('A-1 fix the thing - Jira', 'https://acme.atlassian.net/browse/A-1'), true);
}

// --- The benchmark must test the configuration people actually run ---------

{
  const bench = readFileSync(new URL('./bench.mjs', import.meta.url), 'utf8');
  const storage = readFileSync(new URL('../lib/storage.js', import.meta.url), 'utf8');
  const setting = (src, key) => {
    const m = src.match(new RegExp(`${key}:\\s*'([a-z]+)'`));
    return m ? m[1] : null;
  };
  check('bench uses the real default host strategy',
    setting(bench, 'subdomainStrategy'), setting(storage, 'subdomainStrategy'));
  check('bench uses the real default host scope',
    setting(bench, 'subdomainScope'), setting(storage, 'subdomainScope'));
}

// --- The model may merge groups, within limits -----------------------------

// The deterministic layer never invents a merge, so its errors are all merges
// it declined to make. This is where a genuinely semantic one gets made — and
// where a small model asked to compare things could spend the precision the
// layer below it holds at 1.00, so the guards matter more than the feature.
{
  const tabs = [
    { id: 1, title: 'AUTH-482 auth migration rollout plan', url: 'https://acme.atlassian.net/browse/AUTH-482' },
    { id: 2, title: 'AUTH-482: fix token refresh', url: 'https://github.com/acme/gateway/pull/1203' },
    { id: 3, title: 'AUTH-495 rotate signing keys', url: 'https://acme.atlassian.net/browse/AUTH-495' },
    { id: 4, title: 'Q3 budget planning', url: 'https://docs.google.com/spreadsheets/d/q3budget2026/edit' },
  ];
  const settings = { minGroupSize: 1 };
  const run = async (proposeMerges) => {
    const { byLabel } = await resolveGroups(tabs, { settings, memory: emptyMemory(), proposeMerges });
    return [...byLabel.values()].map((ids) => ids.sort((a, b) => a - b)).sort((a, b) => a[0] - b[0]);
  };

  check('without the pass, two tickets in one project stay apart',
    await run(null), [[1, 2], [3], [4]]);

  check('the model can join what only semantics could',
    await run(async (gs) => {
      const auth = gs.filter((g) => g.titles.some((t) => /AUTH-/.test(t)));
      return auth.length === 2 ? [[auth[0].label, auth[1].label]] : [];
    }), [[1, 2, 3], [4]]);

  check('it is shown titles, not ids',
    await (async () => {
      let seen = null;
      await run(async (gs) => { seen = gs; return []; });
      return seen.every((g) => g.titles.every((t) => /[a-z]{3}/i.test(t)));
    })(), true);

  check('"everything matches" cannot collapse everything',
    await run(async (gs) => gs.flatMap((g, i) => gs.slice(i + 1).map((h) => [g.label, h.label])))
      .then((r) => r.length > 1), true);
  check('a nonsense answer changes nothing',
    await run(async () => [['Nope', 'Nothing'], ['x']]), [[1, 2], [3], [4]]);
  check('a model that throws leaves the grouping alone',
    await run(async () => { throw new Error('boom'); }), [[1, 2], [3], [4]]);

  // Decisions already made are never put up for merging. Two loose pages are
  // included so the pass actually runs and can be observed refusing them.
  const guarded = [
    { id: 1, title: 'Grafana', url: 'https://prod-eu-1-graf.corp.example.com/d/x' },
    { id: 2, title: 'Grafana', url: 'https://prod-ap-1-graf.corp.example.com/d/x' },
    { id: 3, title: 'Sourdough starter troubleshooting', url: 'https://example.com/baking/sourdough-starter' },
    { id: 4, title: 'Bicycle drivetrain maintenance', url: 'https://other.example.com/cycling/drivetrain-care' },
  ];
  let offered = null;
  const { byLabel } = await resolveGroups(guarded, {
    settings: { minGroupSize: 1, internalDomains: ['corp.example.com'] },
    memory: emptyMemory(),
    proposeMerges: async (gs) => {
      offered = gs.map((g) => g.label);
      // A model that would merge anything it is handed.
      return gs.length >= 2 ? [[gs[0].label, gs[1].label]] : [];
    },
  });
  check('the pass runs when there are groups to compare', offered !== null, true);
  check('internal-host groups are never offered for merging',
    (offered || []).some((l) => l.startsWith('prod-')), false);
  check('so two clusters survive a model that would have merged them',
    [...byLabel.keys()].filter((l) => l.startsWith('prod-')).length, 2);
}

// --- Page content, where a title says nothing ------------------------------

// Some tabs genuinely cannot be grouped from title and URL: an untitled
// document with an opaque id, a dashboard called after its product. Reading a
// page summary is the only thing that reaches them.
{
  const bare = [
    { id: 1, title: 'Confluence', url: 'https://acme.atlassian.net/wiki/spaces/EN/pages/2758606863/x' },
    { id: 2, title: 'Google Docs', url: 'https://docs.google.com/document/d/1kQm7yTvB2xNpLr9WsEc/edit' },
    { id: 3, title: 'Google Docs', url: 'https://docs.google.com/document/d/9zXbQ2mWpLk4RtYv/edit' },
  ];
  check('without content these are unreachable',
    clusterTabs(bare).map((c) => c.tabs.map((t) => t.id)), [[1], [2], [3]]);

  const withContent = [
    { ...bare[0], content: 'Tenant onboarding runbook . Steps to onboard a new tenant' },
    { ...bare[1], content: 'Tenant onboarding checklist . Onboarding tasks per tenant' },
    { ...bare[2], content: 'Invoice dispute log . Disputed invoices awaiting credit notes' },
  ];
  const got = clusterTabs(withContent);
  check('content groups them by what the pages say',
    got.map((c) => c.tabs.map((t) => t.id)), [[1, 2], [3]]);
  check('and names them from it', nameCluster(got[0]), 'Tenant Onboarding');

  // Content is evidence, but weaker evidence: a title is written to describe a
  // page, body text is whatever happened to be at the top of it.
  const weight = (tab) => extractFeatures(tab).features.get('word:widget');
  check('a word in the title outweighs the same word in content',
    weight({ id: 1, title: 'widget', url: 'https://x.com/a' })
      > weight({ id: 1, title: '', url: 'https://x.com/a', content: 'widget' }), true);

  // A long page must not swamp every other signal.
  const many = Array.from({ length: 60 }, (_, i) => `distinctword${i}`).join(' ');
  const contentWords = [...extractFeatures({ id: 1, title: '', url: 'https://x.com/a', content: many })
    .features.keys()].filter((k) => k.startsWith('word:'));
  check('content words are capped', contentWords.length <= 16, true);

  // Naming reads only the deliberate first part, because body text has the
  // longest words and none of the meaning.
  check('naming ignores body text after the first part',
    nameCluster({ key: null, tabs: [{
      title: 'LWN.net',
      url: 'https://lwn.net/Articles/999123/',
      content: 'Scheduler latency in recent kernels . A look at wakeup latency regressions in the CFS replacement',
    }] }), 'Scheduler Latency');
}

{
  // The summary is assembled most-deliberate-first, which is what lets callers
  // truncate it and still keep the descriptive part.
  const text = contentToText({
    ogTitle: 'Tenant onboarding runbook',
    description: 'How to onboard a tenant',
    headings: ['Region selection', 'Quota setup'],
    body: 'Some body text that goes on for a while',
  });
  check('the og:title leads', text.startsWith('Tenant onboarding runbook'), true);
  check('the description follows', text.indexOf('How to onboard') < text.indexOf('Region selection'), true);
  check('headings precede body', text.indexOf('Quota setup') < text.indexOf('Some body text'), true);
  check('an empty extraction is empty', contentToText(null), '');
  check('missing parts are skipped',
    contentToText({ headings: ['Only this'] }), 'Only this');
}

// --- The site name is the last resort, and only for a real group -----------

// Naming a lone tab after its host is domain grouping with extra steps, and an
// uncategorized tab is honest where a wrong group has to be corrected.
{
  const S = { minGroupSize: 1 };
  const nothingKnown = { id: 1, title: 'Dashboard', url: 'https://widgets.example.com/' };

  const one = await resolveGroups([nothingKnown], { settings: S, memory: emptyMemory() });
  check('a lone tab nothing describes is left out of every group',
    one.assignments.has(1), false);

  // A group a link trail already assembled still needs a name, and the site is
  // a reasonable last thing to fall back to.
  const pair = await resolveGroups([
    { id: 1, title: 'Dashboard', url: 'https://widgets.example.com/a' },
    { id: 2, title: 'Dashboard', url: 'https://widgets.example.com/b', openerTabId: 1 },
  ], { settings: S, memory: emptyMemory() });
  check('a real group with no description falls back to the site',
    [...pair.byLabel.values()], [[1, 2]]);
  check('and is reported as such', pair.assignments.get(1).reason, 'host');
}

// --- An app's own furniture is not what its pages are about ----------------

// Reported from real use: an onboarding guide, an onboarding ticket, an upgrade
// guide and upgrade issues all ended up in one group. Every Confluence page
// repeats the app's navigation and sidebar, so reading the page body made two
// unrelated pages score 5.53 on "attachments", "templates" and "restrictions" —
// domain grouping arriving by a new route.
{
  const furniture = 'Confluence Spaces Recently viewed Starred Templates Apps Create '
    + 'Search People Calendars Analytics Space settings Page tree Comments Attachments '
    + 'Restrictions Watch Share Export Edit';
  const page = (subject) => `x . ${furniture} . ${subject}`;

  const tabs = [
    { id: 1, title: 'Onboarding guide - Confluence', url: 'https://acme.atlassian.net/wiki/spaces/EN/pages/2758606863/Onboarding+guide', content: page('Steps to onboard a tenant') },
    { id: 2, title: '[single-org] [ap-tokyo-1] customerpoc - onboarding', url: 'https://acme.atlassian.net/browse/SASOBD-603' },
    { id: 3, title: 'Upgrade guide - Confluence', url: 'https://acme.atlassian.net/wiki/spaces/EN/pages/3311882244/Upgrade+guide', content: page('How to run a cluster upgrade') },
    { id: 4, title: '[single-org] [ap-tokyo-1] acmecorp - upgrade failed', url: 'https://acme.atlassian.net/browse/SASUPG-211' },
  ];
  check('two pages of one app are not merged by the app\'s own chrome',
    clusterTabs(tabs).map((c) => c.tabs.map((t) => t.id)), [[1, 2], [3, 4]]);

  // The rule that makes this work: furniture belongs to a site, so only pages
  // of the SAME site can share it. Two pages on different hosts agreeing on
  // body text really are about the same thing.
  const ctx = buildContext(tabs);
  check('same-site body agreement alone does not relate two pages',
    ctx.relate(1, 3).related, false);

  const crossHost = [
    { id: 1, title: 'Confluence', url: 'https://acme.atlassian.net/wiki/spaces/EN/pages/2758606863/x', content: 'Tenant onboarding runbook . Steps to onboard a tenant' },
    { id: 2, title: 'Grafana', url: 'https://grafana.acme.io/d/abc123/z', content: 'Tenant onboarding duration . Time to onboard a tenant by region' },
  ];
  check('cross-site body agreement does relate them',
    buildContext(crossHost).relate(1, 2).related, true);

  // With enough pages of one app open, its furniture is detectable by counting.
  const manyPages = [1, 2, 3, 4].map((n) => ({
    id: n,
    title: `Page ${n} - Confluence`,
    url: `https://acme.atlassian.net/wiki/spaces/EN/pages/100000${n}/p${n}`,
    content: page(`Subject number ${n} alpha${n} beta${n}`),
  }));
  check('furniture is detected as such once several pages of a site are open',
    clusterTabs(manyPages).length, 4);
}

// --- Reading pages must never hang -----------------------------------------

// Reported from real use: "Reading pages... 7/10, stuck".
// chrome.scripting.executeScript returns a promise that neither resolves nor
// rejects when the target renderer cannot run script, so three such tabs left
// three pool workers awaiting forever, Promise.all never settled, and the busy
// flag stayed set — which disables grouping for every other tab until the
// service worker restarts.
{
  const { withTimeout } = __testing;
  const never = () => new Promise(() => {});

  check('a promise that never settles yields the fallback',
    await withTimeout(never(), 60, 'FALLBACK'), 'FALLBACK');
  check('a resolved promise passes through',
    await withTimeout(Promise.resolve('ok'), 60, 'FALLBACK'), 'ok');
  check('a rejection yields the fallback',
    await withTimeout(Promise.reject(new Error('x')), 60, 'FALLBACK'), 'FALLBACK');

  // Replay the report: ten readable tabs, three of which never answer.
  const hangs = new Set([3, 6, 9]);
  const saved = globalThis.chrome;
  globalThis.chrome = {
    permissions: { contains: async () => true },
    storage: { session: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
    scripting: {
      executeScript: async ({ target }) => {
        if (hangs.has(target.tabId)) return never();
        return [{ result: { ogTitle: `page ${target.tabId}`, headings: [], body: '' } }];
      },
    },
  };
  try {
    const tabs = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, url: `https://x.com/${i + 1}` }));
    const seen = [];
    const content = await gatherContent(tabs, {
      timeoutMs: 40,
      budgetMs: 2000,
      onProgress: (done, total) => seen.push(`${done}/${total}`),
    });
    check('the gather completes despite tabs that never answer', content.size, 10);
    check('progress reaches the total', seen[seen.length - 1], '10/10');
    check('the tabs that answered were read',
      content.get(1).startsWith('page 1'), true);
    check('the tabs that hung are simply empty', content.get(3), '');
  } finally {
    globalThis.chrome = saved;
  }
}

// --- A captured bug report must not carry secrets --------------------------

// Capturing a window produces a fixture meant to be pasted into a bug report,
// so it leaves the browser. Grouping reads host and path and almost never the
// query, which makes dropping credential-shaped parameters free.
{
  const q = (url) => new URL(redactUrl(url)).searchParams;
  check('an access token is redacted',
    q('https://x.com/a?token=SECRET&page=2').get('token'), 'REDACTED');
  check('but ordinary parameters survive',
    q('https://x.com/a?token=SECRET&page=2').get('page'), '2');
  for (const name of ['api_key', 'session', 'password', 'sig', 'bearer', 'access_token']) {
    check(`${name} is redacted`, q(`https://x.com/a?${name}=v`).get(name), 'REDACTED');
  }
  check('a search query is kept, since it says what the work is',
    q('https://x.com/s?q=oauth+refresh').get('q'), 'oauth refresh');
  check('the fragment is dropped',
    redactUrl('https://x.com/a#inbox/secret-thread'), 'https://x.com/a');
  check('the path is untouched',
    redactUrl('https://x.com/wiki/spaces/EN/pages/1/Onboarding'),
    'https://x.com/wiki/spaces/EN/pages/1/Onboarding');
  check('a malformed URL is returned unchanged', redactUrl('not a url'), 'not a url');
}

// --- Report ---------------------------------------------------------------

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log('All grouping checks passed.\n');
