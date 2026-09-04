/**
 * Grouping benchmark.
 *
 *   node scripts/bench.mjs                 # score every fixture
 *   node scripts/bench.mjs auth-migration  # one fixture, with a per-tab table
 *   node scripts/bench.mjs --verbose       # per-tab detail for all
 *   node scripts/bench.mjs --tune          # sweep the relatedness threshold
 *
 * Runs the real pipeline (lib/resolve.js) over recorded tab sets in
 * scripts/fixtures/ and scores it against hand-labelled correct groupings.
 *
 * Two numbers, because "better grouping" means two different things:
 *
 *   GROUPING F1 — did the right tabs end up together? Scored pairwise: for
 *     every pair of tabs, should they share a group, and do they? Precision
 *     falls when unrelated tabs are merged, recall when one task is split.
 *     Pairwise scoring is used because it degrades gracefully; a metric that
 *     only counts exact group matches tells you nothing about a near miss.
 *
 *   NAME QUALITY — are the group names descriptive? A name that is really an
 *     identifier ("AUTH-482", "acme/gateway"), a website ("GitHub"), or a piece
 *     of one of the group's own hostnames ("mail-1") makes you remember what it
 *     referred to, which is the thing group names exist to avoid. The hostname
 *     check is there because domain grouping keeps finding new routes back in,
 *     and it should be caught by a number rather than by noticing.
 *
 * Each fixture is scored twice:
 *
 * A fixture tab may carry `content`, standing in for a page summary read from a
 * live tab, so grouping that depends on page content is testable here too.
 *
 *   COLD — first sight, nothing learned. This is the deterministic floor: the
 *     on-device model is not available here, so any remaining error is a merge
 *     the model would have to make. Precision at 1.00 means the pipeline never
 *     invents a merge on its own.
 *   WARM — after you have corrected it once. The gold grouping is fed to
 *     lib/taskMemory.js the way naming and dragging a group would, then the same
 *     tabs are resolved again. This is the number that says whether corrections
 *     actually stick, which is the difference between a tool that learns and one
 *     that argues with you every morning.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { resolveGroups } from '../lib/resolve.js';
import { emptyMemory, observe } from '../lib/taskMemory.js';
import { looksLikeIdentifier } from '../lib/summarize.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(HERE, 'fixtures');

// Names that describe a website rather than the work done on it.
const SITE_NAMES = new Set([
  'github', 'gitlab', 'jira', 'confluence', 'slack', 'notion', 'figma',
  'gmail', 'mail', 'docs', 'google', 'grafana', 'jenkins', 'linear',
  'stackoverflow', 'youtube', 'reddit', 'atlassian', 'zendesk',
]);

/** Pairwise precision/recall/F1 of a predicted partition against gold. */
function scorePartition(tabs, predicted) {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (let i = 0; i < tabs.length; i++) {
    for (let j = i + 1; j < tabs.length; j++) {
      const a = tabs[i];
      const b = tabs[j];
      const goldSame = a.gold === b.gold;
      // An unassigned tab is its own singleton group.
      const pa = predicted.get(a.id);
      const pb = predicted.get(b.id);
      const predSame = pa != null && pb != null && pa === pb;
      if (goldSame && predSame) tp++;
      else if (!goldSame && predSame) fp++;
      else if (goldSame && !predSame) fn++;
    }
  }
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1, tp, fp, fn };
}

/**
 * Fraction of produced names that read as work rather than as an id or site.
 *
 * Only names that are *meant* to describe are judged. An internal-host group is
 * named after its host on purpose — that identity is what keeps two
 * infrastructure clusters from merging — and a pinned rule's label is whatever
 * you configured, so neither is the naming layer's to answer for.
 */
const DESCRIBING_REASONS = new Set(['ai', 'summary', 'learned', 'misc']);

function scoreNames(assignments, tabs) {
  const labels = [...assignments.values()]
    .filter((a) => DESCRIBING_REASONS.has(a.reason))
    .map((a) => a.label);
  const names = [...new Set(labels)];
  if (names.length === 0) return { quality: 1, bad: [] };

  // Every hostname component in the fixture. A group named after one of these
  // is grouping by domain whatever route it took to get there — which is how
  // "domain grouping is active" was reported, after an over-broad
  // internal-host guess quietly turned `mail-1.google.com` into `[mail-1]`.
  const hostWords = new Set();
  for (const t of tabs || []) {
    try {
      for (const part of new URL(t.url).hostname.toLowerCase().split('.')) {
        if (part.length >= 2) hostWords.add(part);
      }
    } catch { /* not a URL */ }
  }

  const bad = names.filter((n) => {
    if (looksLikeIdentifier(n)) return true;
    const words = n.toLowerCase().split(/\s+/);
    if (words.every((w) => SITE_NAMES.has(w))) return true;
    // A name that is nothing but hostname parts.
    return words.every((w) => hostWords.has(w));
  });
  return { quality: (names.length - bad.length) / names.length, bad };
}

function bar(v, width = 12) {
  const n = Math.round(v * width);
  return '█'.repeat(n) + '░'.repeat(width - n);
}

async function runFixture(file, { verbose, threshold }) {
  const fx = JSON.parse(readFileSync(join(FIXTURE_DIR, file), 'utf8'));
  const tabs = fx.tabs.map((t) => ({
    id: t.id,
    title: t.title,
    url: t.url,
    openerTabId: t.opener,
    // A fixture may carry a page summary, standing in for what
    // lib/pageContent.js reads from a live tab.
    ...(t.content ? { content: t.content } : {}),
  }));

  // Mirrors lib/storage.js DEFAULTS. Drifting from the real defaults would mean
  // benchmarking a configuration nobody runs.
  const settings = {
    subdomainScope: 'internal',
    subdomainStrategy: 'cluster',
    clusterServiceTokens: [],
    useOpenerAffinity: true,
    aiProjectMode: true,
    // Default to 1 so the score measures clustering rather than the leftover
    // bucket; a fixture can override to exercise min-size behavior.
    minGroupSize: 1,
    pinnedRules: [],
    internalDomains: [],
    ...(fx.settings || {}),
  };

  // No nameClusters: the model is unavailable here, so names come from titles.
  const run = async (memory) => {
    const { assignments } = await resolveGroups(tabs, {
      settings: threshold == null ? settings : { ...settings, relatedThreshold: threshold },
      memory,
    });
    return assignments;
  };

  // --- Cold: first sight, nothing learned. ---
  const cold = await run(fx.memory || emptyMemory());
  const predicted = new Map([...cold].map(([id, a]) => [id, a.label]));
  const grouping = scorePartition(fx.tabs, predicted);
  const naming = scoreNames(cold, fx.tabs);

  // --- Warm: after correcting it once. ---
  // Teaching from the gold grouping stands in for what a person does by hand:
  // renaming a group and dragging the stragglers into it.
  let taught = fx.memory || emptyMemory();
  const goldGroups = new Map();
  for (const t of fx.tabs) {
    if (!goldGroups.has(t.gold)) goldGroups.set(t.gold, []);
    goldGroups.get(t.gold).push(tabs.find((x) => x.id === t.id));
  }
  for (const [label, members] of goldGroups) {
    taught = observe(taught, label, members, { userNamed: true });
  }
  const warm = await run(taught);
  const warmPredicted = new Map([...warm].map(([id, a]) => [id, a.label]));
  const warmGrouping = scorePartition(fx.tabs, warmPredicted);
  const warmNaming = scoreNames(warm, fx.tabs);

  const groupCount = new Set(predicted.values()).size;
  const goldCount = new Set(fx.tabs.map((t) => t.gold)).size;

  if (verbose) {
    console.log(`\n  ${fx.name} — ${fx.description}`);
    console.log(`  ${'tab'.padEnd(4)}${'gold'.padEnd(18)}${'predicted'.padEnd(18)}why`);
    console.log(`  ${'-'.repeat(66)}`);
    for (const t of fx.tabs) {
      const a = cold.get(t.id);
      const w = warm.get(t.id);
      const drift = w && a && w.label !== a.label ? `  → warm: ${w.label} (${w.reason})` : '';
      console.log(`  ${String(t.id).padEnd(4)}${t.gold.padEnd(18)}${String(a ? a.label : '(loose)').padEnd(18)}${a ? `${a.reason}/${a.via}` : ''}${drift}`);
    }
  }

  return {
    name: fx.name, grouping, naming, groupCount, goldCount,
    warmGrouping, warmNaming,
  };
}

/** Is this tab grouped with exactly the tabs it should be? */
function sameCluster(goldTabs, predicted, tab) {
  const mine = predicted.get(tab.id);
  for (const other of goldTabs) {
    if (other.id === tab.id) continue;
    const together = mine != null && predicted.get(other.id) === mine;
    if (together !== (other.gold === tab.gold)) return false;
  }
  return true;
}

const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const tune = args.includes('--tune');
const only = args.filter((a) => !a.startsWith('--'));

const files = readdirSync(FIXTURE_DIR)
  .filter((f) => f.endsWith('.json'))
  .filter((f) => only.length === 0 || only.some((o) => f.startsWith(o)));

if (files.length === 0) {
  console.error(`No fixtures matched. Available: ${readdirSync(FIXTURE_DIR).join(', ')}`);
  process.exit(1);
}

if (tune) {
  // The constants in lib/context.js were chosen against these fixtures, so the
  // question that matters is not "what is the best score" but "is the setting
  // sitting on a knife edge". A plateau means the ranking of signals is doing
  // the work; a single spike means the number was fitted to the fixtures.
  console.log(`\n  threshold   F1      per-fixture`);
  console.log(`  ${'-'.repeat(64)}`);
  for (const th of [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 1.0, 1.3]) {
    const rs = [];
    for (const f of files) rs.push(await runFixture(f, { verbose: false, threshold: th }));
    const m = rs.reduce((a, r) => a + r.grouping.f1, 0) / rs.length;
    const marks = rs.map((r) => (r.grouping.f1 >= 0.99 ? '✓' : r.grouping.f1 >= 0.8 ? '·' : '✗')).join(' ');
    console.log(`  ${String(th).padEnd(11)} ${m.toFixed(3)}   ${marks}`);
  }
  console.log(`\n  ${' '.repeat(21)}${files.map((f) => f[0]).join(' ')}   (fixture initials)\n`);
  process.exit(0);
}

const results = [];
for (const f of files) {
  results.push(await runFixture(f, { verbose: verbose || only.length === 1 }));
}

console.log(`\n  ${'fixture'.padEnd(22)}${'COLD F1'.padEnd(16)}${'prec'.padEnd(7)}${'rec'.padEnd(7)}${'names'.padEnd(7)}${'groups'.padEnd(8)}WARM F1`);
console.log(`  ${'-'.repeat(84)}`);
for (const r of results) {
  const flag = r.grouping.f1 >= 0.99 ? '✓' : r.grouping.f1 >= 0.8 ? ' ' : '!';
  const gain = r.warmGrouping.f1 - r.grouping.f1;
  const arrow = gain > 0.005 ? `+${gain.toFixed(2)}` : gain < -0.005 ? gain.toFixed(2) : '  =  ';
  console.log(
    `  ${r.name.padEnd(22)}${bar(r.grouping.f1)} ${r.grouping.f1.toFixed(2)}  `
    + `${r.grouping.precision.toFixed(2)}   ${r.grouping.recall.toFixed(2)}   `
    + `${r.naming.quality.toFixed(2)}   ${`${r.groupCount}/${r.goldCount}`.padEnd(6)}${flag}  `
    + `${r.warmGrouping.f1.toFixed(2)} ${arrow}`,
  );
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const overall = mean(results.map((r) => r.grouping.f1));
const names = mean(results.map((r) => r.naming.quality));
const warmOverall = mean(results.map((r) => r.warmGrouping.f1));
const warmNames = mean(results.map((r) => r.warmNaming.quality));
console.log(`  ${'-'.repeat(84)}`);
console.log(
  `  ${'OVERALL'.padEnd(22)}${bar(overall)} ${overall.toFixed(3)}`
  + `                 ${names.toFixed(2)}           ${warmOverall.toFixed(3)}`,
);
console.log(
  `  ${'names'.padEnd(22)}${' '.repeat(13)}cold ${names.toFixed(2)}   warm ${warmNames.toFixed(2)}`,
);

const badNames = results.flatMap((r) => r.naming.bad);
if (badNames.length > 0) {
  console.log(`\n  Cold names that identify rather than describe: ${[...new Set(badNames)].join(', ')}`);
}
const badWarm = results.flatMap((r) => r.warmNaming.bad);
if (badWarm.length > 0) {
  console.log(`  Warm names still identifying: ${[...new Set(badWarm)].join(', ')}`);
}
console.log();
