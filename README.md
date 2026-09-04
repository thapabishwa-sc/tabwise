# AI Tab Grouper

A Chrome extension that automatically groups your tabs by **the work they belong
to** using Chrome's **on-device AI** (Gemini Nano via the Prompt API). Everything
runs locally — tab titles and URLs never leave your machine.

A ticket, its pull request, its spec doc and its dashboard end up in one group
even though they live on four different domains — and two unrelated documents on
the same `docs.google.com` end up in different ones. Groups are named after the
work ("Auth Migration"), never after an id or a website. And it learns: rename a
group or drag a tab, and that correction sticks.

## Features

- **Task grouping, not domain grouping** — the group is the work-stream ("Auth
  Migration", "Q3 Budget"), never the website. Tabs across different sites merge
  when they serve one task; tabs on the same site split when they don't.
- **It learns from you** — renaming a group teaches your name for that work;
  dragging a tab into a group pins it there and teaches what belongs. Both
  survive restarts, and neither is ever undone by a later pass
  ([`lib/taskMemory.js`](lib/taskMemory.js)). Measured effect: benchmark score
  rises from **0.95 to 1.00** after a single correction.
- **Names describe, never identify** — a group is called "Auth Migration", not
  "AUTH-482", "acme/gateway" or "Jira". An id makes you remember what it
  referred to, which is the one job a group name has. Names are two words read
  from the tab titles, and an id-shaped answer from the model is rejected and
  replaced ([`lib/summarize.js`](lib/summarize.js)).
- **A context engine, not a list of websites** — relatedness is scored from
  shared identifiers, containers and subject matter, each weighted by how rare
  it is across your open tabs ([`lib/context.js`](lib/context.js)). The same
  feature is an identity in one window and a container in another, which is
  something no per-site rule can express — and it means an in-house tracker
  works as well as Jira. See [how two tabs are judged related](#how-two-tabs-are-judged-related).
- **Work items vs. containers** — a ticket or a pull request is one piece of
  work; a repository, a Jira project or a Slack channel is a place many
  unrelated pieces of work live. Only the former groups tabs on its own, so
  three tickets touching one monorepo stay three groups.
- **It shows its reasoning** — hover any tab in the popup to see which stage
  placed it (`you`, `rule`, `host`, `learned`, `AI`, `titles`) and how it joined
  its group (link trail, same work item). The AI's guesses are the ones marked,
  because they are the ones worth a second look.
- **Link trails** — a tab opened from another joins that tab's group instantly,
  with no AI call ([`lib/affinity.js`](lib/affinity.js)). Following a link from a
  ticket to its PR is the most reliable "same work" signal a browser offers.
- **Pinned rules** — force specific URLs into a fixed group, bypassing the AI.
  Matches against *hostname + path*, so rules can be path-specific, and regex
  capture rules can build the label from the URL.
- **Internal hosts stay deterministic** — infrastructure keeps per-host groups
  and never goes to the AI, so two clusters are never merged by topic. "Internal"
  means a configured domain, a private marker (`.corp.`, `.internal`), a bare or
  IP host, or a dashed cluster name like `prod-eu-1-grafana` — *not* merely
  having a subdomain, which would drag every SaaS host back into host grouping.
- **Tidy loose tabs** — group only the ungrouped ones, leaving settled groups
  alone. "Group all tabs" reorganizes everything, which is the wrong tool once
  most of your groups are right.
- **Task groups** — capture the loose tabs into a named task group that stays
  put, or use the natural-language box ("group my tabs for the billing work").
- **Accordion** — collapse every group except the one you're in, automatically
  as you switch tabs or expand a group.
- **Respect manual groups** — tabs you placed in your own group are left alone.
- **Minimum group size** — avoids one-tab groups; leftovers go to an "Other"
  bucket. Tabs naming a real work item are exempt, so a new task can start its
  own group.
- **Most recent work first** — groups are ordered by when you last touched them,
  with a relative timestamp in the header, so today's work is at the top.
- **One cluster, one group** — every service on an internal cluster lands
  together, while two clusters never merge. `prod-eu-1-grafana` and
  `prod-eu-1-kibana` are one group; `prod-ap-1-grafana` is another.
- **No guessing while a tab loads** — a new tab stays uncategorized until it has
  a real title. Nothing is placed on its hostname alone.
- **Reads the page, if you let it** — a summary of each page (headings, meta
  description, the start of the main text) so an untitled document or a
  dashboard called "Grafana" still has a description. Off until you grant it in
  Settings; see [Privacy](#privacy).
- **Quick-switcher search** — filter tabs across all groups; Enter jumps to the
  first match.
- **Natural-language grouping** — "group by project", "put all AWS tabs
  together", "merge Docs and Research".
- **Move a group to its own window**, **rename groups**, and **move a tab**
  between groups from the popup.
- **Sessions** — save the current window's tabs + groups and restore them later.

Pinned tabs are never grouped (Chrome can't group them).

## Which on-device model does it use?

Gemini Nano, via Chrome's Prompt API — and **the model is not selectable.**
`LanguageModel.create()` takes no model parameter; you get what the browser
ships. Sampling is tunable (temperature and topK), and this extension asks for a
low temperature so labels stay stable between passes, clamped to whatever range
`LanguageModel.params()` reports on your build.

What *is* worth knowing is that the Prompt API is not the only built-in model.
Chrome exposes task-specific ones — `Summarizer`, `LanguageDetector`,
`Translator` and others — which are separate models with their own tuning, and
they come and go between Chrome versions. Rather than guess, **Settings → On-device
AI in this browser** probes your browser and lists what is actually there, what
state each is in, and which ones this extension uses. A missing API explains a
missing capability far better than a changelog does.

**Settings → Refresh AI context** starts the model from a clean slate: it
destroys the current session, clears the cached page summaries so pages are
re-read, and drops the stored per-tab explanations. Learned tasks are
deliberately left alone — forgetting those is a separate, explicit button.

Of those, `Summarizer` is the one with a clear job here: naming a group from
page content is a summarization task, and a model tuned for it should beat
prompting a general one. Not wired up yet — worth doing only once the probe
shows it is available and the current naming is measurably the weak link.

Running a genuinely larger local model would mean bundling one (WebGPU plus
ONNX or similar) and shipping hundreds of megabytes of weights, with the load
time and complexity that implies. That is a different product, not a setting.

## Requirements

- **Chrome 138+** (the Prompt API for extensions is stable from 138).
- Hardware that supports the on-device model: ~22 GB free disk, a supported
  GPU, and an unmetered connection for the one-time model download (a few GB).
- AI features degrade gracefully. Without the model, everything except one step
  still works: pinned rules, learned tasks, internal hosts, link trails and
  shared work items all group as usual, so a ticket and its pull request still
  land together. Only *naming* changes — a group is named from its tab titles
  instead of by the model, which still reads like work ("Gift Card") rather than
  like a site.

## Install

### Load unpacked (development)

1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select this folder.
3. Open the popup. If the badge shows **AI ⬇**, click **Prepare AI** to download
   the model (watch progress in the service-worker console).

### Packaged

```bash
./scripts/package.sh        # produces dist/ai-tab-grouper.zip
```

Upload `dist/ai-tab-grouper.zip` to the
[Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole/),
or drag-and-drop the unzipped folder via **Load unpacked**.

## How grouping decides a tab's group

All of it lives in [`lib/resolve.js`](lib/resolve.js) as a pure function, which
is what makes it benchmarkable. For each eligible tab (http/https, not pinned),
the group is resolved in order of authority:

1. **You filed it** — you dragged this page into a group, so it stays there.
   This outranks even a pinned rule: the rule is a standing policy, and moving
   the tab was you overriding it.
2. **Pinned rule** — first rule whose `match` is a substring of
   `hostname + path` (or whose `pattern` matches).
3. **Internal host** — infrastructure is labeled by `subdomainStrategy`. Every
   service on one cluster shares a group (`prod-eu-1-grafana`,
   `prod-eu-1-kibana` and `prod-eu-1-jumper` are one group; `gamma-dl` and
   `gamma-da` are another), and two clusters still never merge. Only hosts that
   look internal qualify; see `subdomainScope` below.
   Steps 1-3 need only the URL, so they apply the moment a tab appears.
   Everything below infers, and **a tab stays out of every group until it has
   loaded enough to be judged** — a title that is missing, or that is just the
   URL echoed back, means the only signal available is the hostname. An
   uncategorized tab is honest; one dropped into a group on its hostname alone
   has to be corrected.

4. **Link trail** — a tab opened from another tab in the same window joins that
   tab's group. No AI call, so it lands correctly right away. Only for a tab
   that actually *began* by following a link: a tab opened blank still carries
   `openerTabId` pointing at whatever was focused, and inheriting that group
   makes a tab appear to jump into the group you were just in.
5. **A task you've grouped before** — matched on its work items and vocabulary,
   and named with the name you gave it.
6. **A group already on screen** — the context engine scores this tab against
   the tabs in every existing group; the best match above threshold takes it.
   This is what a batch pass gets for free by seeing every tab at once, and
   what a tab arriving on its own would otherwise miss until the next batch.
7. **Task cluster, named** — everything left is clustered by shared work item,
   then named by the on-device model, or from the tabs' own titles when the
   model is unavailable.
8. **The model merges what only semantics could** — finally it is asked which
   groups are actually one piece of work. Whether `AUTH-482` and `AUTH-495` are
   one effort cannot be read off a URL, and every step above correctly refuses
   to guess. Guarded: only groups the model itself named are ever offered (never
   your own filing, a pinned rule, an internal host, or a task you named), and
   at most a third of them can be merged away in one pass, so an answer of "all
   of these match" collapses nothing. Merges only — it can never split what the
   steps above established. Turn it off with **Let AI merge groups**.

Clustering happens *before* naming, so a cluster is an atom: the model names it
but can never split it, and a task assembled from a link trail survives. Names
are then consolidated, merging drift like "Auth Migration" vs "Auth Migrations"
that batching would otherwise turn into two groups.

## How two tabs are judged related

There is no list of websites. Deciding whether two tabs are the same work is a
measurement, made by the context engine in [`lib/context.js`](lib/context.js).

Each tab is reduced to plain features — its host, its cumulative path prefixes,
the identifiers in its URL and title, its distinctive title words — and each
shared feature is weighted by **how rare it is across the tabs you actually have
open**:

```
a path prefix shared by 2 tabs out of 40   →  names one piece of work
the same prefix shared by 20 tabs          →  names a container
```

That is the important part. `atlassian.net/browse` is a container when eight
tickets are open and an identity when one is — which is correct, and which no
static rule can express. It also means a team on Shortcut, Azure DevOps, Redmine
or an in-house tracker gets exactly the same treatment as a team on Jira.

Evidence is sorted into three kinds, because they mean different things:

| Evidence | Example | What it proves |
|---|---|---|
| **Identity** | the same ticket reference, generated document id, or numbered item | The two tabs are about the same thing. Decisive. |
| **Subject** | distinctive words shared between titles | They are about the same topic. Strong. |
| **Container** | a shared path prefix or host | They live in the same place. Weak, and misleading between two tabs that each name their own work. |

So: sharing an identity always joins. Sharing only a container joins **only** if
at least one side has no identity of its own — a source file beside the single
pull request touching its repo is adopted by it, but three pull requests in one
repository stay three tasks, and the loose files stay with each other rather
than being dragged into whichever was compared first. Sharing subject matter
joins regardless, which is what lets a ticket group with the wiki page
documenting it while staying apart from the next ticket in the same tracker.

Three structural details do a lot of work:

- **Interior path segments name containers; the leaf names content.** In
  `github.com/acme/monorepo/pull/500` the word "monorepo" is interior, so two
  pull requests repeating it in their titles are siblings. In
  `/pages/2758606863/NG-SaaS-onboarding` the word "onboarding" is in the leaf,
  so it is what the page is about. Pull request titles end with their repository
  name, and without this distinction a repository name reads as subject matter
  and merges every ticket in the repo.

  The leaf is also read as subject matter in its own right, which matters more
  than it sounds: when a title is just a product name ("Confluence", "Grafana")
  — the state a tab is in before an app sets its title, and permanently for some
  dashboards — the slug may be the only thing left. Without it those pages fell
  all the way back to hostname grouping.

**Page content**, when you have granted it, joins the title as subject matter:
headings, the meta description, and a bounded slice of the main text — with the
app's own furniture stripped out first (`nav`, `header`, `footer`, `aside`,
toolbars, dialogs). That last part is not a detail: every page of an app repeats
its navigation, so reading it made two unrelated Confluence pages score 5.53 on
"attachments", "templates" and "restrictions" and land in one group. Domain
grouping arriving by a new route.

Two further guards, because no selector list catches every app's furniture.
Body-text agreement is capped, so it can carry a merge but never shout. And
body-text agreement **between two pages of the same site does not count at
all** — furniture belongs to a site, so only same-site pages can share it, while
two pages on different hosts agreeing on their body text really are about the
same thing. With three or more pages of one site open, its furniture is also
detected by counting: a word in most of a host's page bodies is its navigation. It is
weighted below the title and capped in number, because a title is written to
describe a page while body text is whatever happened to be at the top of it, and
a long article would otherwise swamp every other signal. Group *names* use only
the first, most deliberate part — body text has the longest words and none of
the meaning, and will happily name a page about scheduler latency
"Regressions Replacement".
- **A path ending in a bare number is item N of its container.** The only thing
  telling `/pull/1` from `/pull/2` apart is the number, so it counts as an
  identity despite being far too short to look like one.
- **Bracketed labels in a title are metadata, not subject.** `[single-org]`,
  `[ap-tokyo-1]`, `[WIP]` are stamped on every ticket in a queue, so as subject
  matter they merge an onboarding ticket with an upgrade one and name the result
  "Single Org". They are kept as weak container evidence — two tabs about the
  same deployment do share something — and excluded from names entirely.

A tab opened from another tab (`openerTabId`) is joined outright, ahead of all
of this. Following a link from a ticket to its pull request is the most reliable
"same work" signal a browser offers, and it costs nothing.

The per-site knowledge that remains — that `/browse/AUTH-482` is a Jira issue —
lives in [`lib/taskSignal.js`](lib/taskSignal.js) and is used for **one thing**:
phrasing a hint for the model, so its prompt reads `[task: jira AUTH-482]`
rather than `[task: browse AUTH-482]`. A missing matcher there costs a slightly
worse hint, never a worse grouping.

Groups smaller than **Minimum group size** fall into the **Other** bucket.
Pinned groups, internal-host groups, learned tasks and clusters built on a real
work item are exempt — so a brand-new task can start its own group instead of
only ever accreting into groups that already exist.

### What the engine decides, and what it does not

The engine is the single answer to "are these the same work". Everything that
asks that question goes through it:

| | Uses the engine |
|---|---|
| Clustering a whole window ([`affinity.js`](lib/affinity.js)) | Yes — pairwise scores, plus opener lineage |
| Placing one arriving tab ([stage 6](#how-grouping-decides-a-tabs-group)) | Yes — scored against every group on screen |
| Recognizing a learned task ([`taskMemory.js`](lib/taskMemory.js)) | Yes — same feature vocabulary, same weight table |
| Min-size exemption | Yes — "does this name real work" |

Three things deliberately bypass it, and it is worth being clear why:

- **Pinned rules** are your explicit configuration. A rule you wrote should not
  be second-guessed by a score.
- **Internal hosts** ([`url.js`](lib/url.js)) are matched by a marker list
  (`.corp.`, `.internal`, a bare or IP host, dashed cluster names) and grouped
  deterministically *before* the engine sees them. This one is load-bearing, and
  measurably so: given two infrastructure clusters whose pages are titled
  identically ("Grafana - Node exporter" on both), the engine scores them as the
  same work at 1.06 and merges them — which is the original complaint that
  started this project. There is a test asserting both that the pipeline keeps
  them apart and that the engine alone would not.
- **Naming** ([`summarize.js`](lib/summarize.js)) answers a different question —
  "what is this called" rather than "does this belong together" — so it ranks
  words by how many tabs share them instead of scoring pairs.

## What it learns

Grouping without memory is grouping that argues with you every morning: a
correction you made yesterday is silently re-derived away today. So corrections
are recorded ([`lib/taskMemory.js`](lib/taskMemory.js)):

| You do this | It learns |
|---|---|
| Rename a group | Your name replaces the proposed one wherever that work is recognized again, and the group's profile carries over so it *is* recognized again. |
| Drag a tab into a group | That page is pinned there — no automatic pass may move it — and the group learns that pages like it belong. |
| Capture a task (**+ Task**) | Both the name and the membership are yours, so it becomes the strongest profile of all. |
| Nothing | Groups it made are still profiled weakly, so a task that recurs is recognized rather than re-derived. |

**Settings → What it has learned** shows every task as a list of the individual
signals it is recognized by — work items, words, places — each removable with
its own **×**. Removing one is usually better than forgetting the whole task: a
profile that picked up "org" from a queue's bracketed tags is worth keeping once
that word is gone. A removed signal is also **never learned again**, even if the
same tabs come back, or editing would be futile. Words can be added by hand for
a task that keeps missing something, and a task can be renamed in place.

A task is recognized by its **work items** (decisive) and its **words** (several
must agree). Deliberately not by where it lives: hosts and path prefixes are not
stored in a profile at all. They used to be, and they were most of what a
profile held — one Confluence page contributed five cumulative prefixes against
three real signals — which meant an unrelated page in the same wiki space
matched five of them and was recalled as that task. Memory was doing domain
grouping, and a learned mistake outlives the pass that made it. Removing them
cost the benchmark's warm score nothing, which is the clearest evidence they
were never carrying real information.
Profiles are stored in the engine's own feature vocabulary and scored with its
weight table, so there is one definition of what evidence is worth rather than
two that drift apart. See everything it has learned, and forget any of it, under
**Settings → What it has learned**.

## What "Group all tabs" does, in order

A full pass finishes each stage before starting the next, rather than grouping
tabs as it goes:

1. **Waits for loading tabs** (up to 8s, and never for a discarded tab). A tab
   judged mid-load is judged on a placeholder title and an unbuilt page.
2. **Reads every page**, across every window, before grouping any of them — so
   no window is decided on less information than another.
3. **Decides, then applies**, one window at a time.

Progress for each phase shows in the popup, since reading a large window takes
a moment.

## Reporting a grouping problem

**Settings → Report a grouping problem → Capture this window** turns your open
tabs into a benchmark fixture, with `gold` pre-filled from where each tab
actually landed and `_why` recording which stage put it there. Correct the ones
that are wrong, save it under `scripts/fixtures/`, and the problem becomes a
number that can be fixed and kept fixed rather than argued about.

Every grouping bug in this project so far was found by real tabs. URLs have
credential-shaped query parameters and fragments removed, but the capture still
contains your titles and paths — read it before sharing it.

## Is the grouping actually good?

```bash
node scripts/bench.mjs            # score every fixture
node scripts/bench.mjs --verbose  # per-tab detail: gold, predicted, and why
node scripts/bench.mjs --tune     # sweep the relatedness threshold
```

Grouping quality is the whole product, so it is a number rather than a vibe.
`scripts/bench.mjs` runs the real pipeline over hand-labelled tab sets in
[`scripts/fixtures/`](scripts/fixtures/) and reports:

- **Grouping F1**, scored pairwise — for every pair of tabs, should they share a
  group, and do they? Precision falls when unrelated tabs are merged, recall
  when one task is split.
- **Name quality** — the fraction of names that describe the work rather than
  identify it. Internal-host and pinned-rule labels are excluded, since those
  are identifiers on purpose.
- **Cold vs. warm** — the same tabs scored before and after one correction,
  which is what says whether learning works.

Current state:

```
  fixture               COLD F1         prec   rec    names  groups  WARM F1
  auth-migration        ██████████░░ 0.86  1.00   0.75   1.00   3/2      1.00 +0.14
  infra-oncall          ████████████ 1.00  1.00   1.00   1.00   4/4   ✓  1.00   =
  mixed-saas-day        ████████████ 1.00  1.00   1.00   1.00   3/3   ✓  1.00   =
  monorepo-multitask    ████████████ 1.00  1.00   1.00   1.00   3/3   ✓  1.00   =
  research-sprawl       ████████████ 1.00  1.00   1.00   1.00   5/5   ✓  1.00   =
  tagged-ticket-queue   ████████████ 1.00  1.00   1.00   1.00   4/4   ✓  1.00   =
  ticket-and-its-docs   ████████████ 1.00  1.00   1.00   1.00   3/3   ✓  1.00   =
  ticket-lookalikes     ████████████ 1.00  1.00   1.00   1.00   5/5   ✓  1.00   =
  OVERALL               ████████████ 0.982                 1.00           1.000
```

The on-device model is not available to the benchmark, so cold scores are a
**floor**: precision at 1.00 across every fixture means the deterministic layer
never invents a merge, and every remaining error is a merge the model (or one
correction from you) has to make. The remaining gap is genuinely semantic —
whether `AUTH-482` and `AUTH-495` are one effort cannot be read off a URL.

The engine's constants were chosen against these fixtures, so `--tune` sweeps
the relatedness threshold to check none of them is balanced on a knife edge.
Scores hold flat from 0.2 to 0.5, which says the *ranking* of the signals is
doing the work rather than a number fitted to a handful of examples. The setting
is the **top** of that plateau: over-merging is the worse failure, so the most
conservative value still scoring at peak is the one to take.

## Pinned rules

One rule per line in **Settings → Pinned Rules**:

```
match = Group Label
```

`match` is matched as a case-insensitive substring of the tab's `hostname + path`.
**First match wins**, so list more specific rules first.

**Regex capture rules** (via Import) extract a dynamic label from the URL using a
`pattern` and `$1`/`$2` references — e.g. group Jira by its project key:

```json
{ "pattern": "atlassian\\.net/browse/([A-Z][A-Z0-9]+)-", "label": "Jira: $1" }
```

So `…/browse/SASSC-6134` → group **Jira: SASSC**. Pattern rules are evaluated
before substring rules.

The core ships with **no pinned rules** — it's generic. Apply org/personal rules
as a runtime override (see below).

Prefer **task-shaped** rules that capture a project or ticket key over
**host-shaped** ones. A rule like `github.com = Code` recreates exactly the
hostname grouping that task grouping exists to avoid — it puts every repo you
touch into one undifferentiated bucket:

```json
{ "pattern": "atlassian\\.net/browse/([A-Z][A-Z0-9]+)-", "label": "Jira: $1" }
{ "pattern": "github\\.com/[^/]+/([^/]+)",               "label": "Repo: $1" }
```

## Runtime overrides (org/personal config)

Company-specific config isn't baked into the extension. Apply it at runtime via
**Settings → Import / Export**:

- **Import (merge)** — paste a settings JSON and it's merged over your current
  settings. A ready-made example lives at
  [`examples/example.json`](examples/example.json) (internal domains + task-shaped
  Jira/wiki/repo capture rules). Keys beginning with `_` are treated as comments
  and not saved.
- **Export current** — dumps your settings as JSON to back up or share.

## Settings

| Setting | Default | Description |
|---|---|---|
| When to group | Automatic | `auto` (as tabs load) or `manual` (only when you ask). |
| AI groups by project/task | on | Bias AI labels toward work-streams, not generic topics. |
| Page access | not granted | Optional permission to read page summaries. Off until granted; revocable. |
| Use page content when grouping | on | Keep the permission but stop using it, without revoking. |
| Let AI merge groups | on | After grouping, ask the model which groups are one piece of work. |
| Follow link trails | on | A tab opened from another joins that tab's group. |
| Accordion | on | Collapse inactive groups as you switch tabs. |
| Respect manual groups | on | Don't touch groups you created yourself. |
| Minimum group size | 2 | Smallest group before tabs go to "Other". Tabs naming a real work item are exempt. |
| Leftover group name | Other | Where sub-minimum tabs land. |
| Group by host instead of task | Internal hosts only | `internal` restricts host grouping to infrastructure; `all` restores the old "any subdomain is its own group" behavior. |
| Internal domains | (none) | Extra domain suffixes to treat as infrastructure. |
| Internal host labels | One group per cluster | `cluster` (services on a cluster share a group) / `subdomain` (one per service) / `host` / `ai`. |
| Service name tokens | (built-in list) | Trailing hostname parts naming a service rather than a cluster (`dl`, `da`, `jumper`, `grafana`, …). |
| Pinned rules | (above) | Force URLs into fixed groups. |
| What it has learned | — | Review, edit and forget learned tasks (not a setting; a list). |

Keyboard shortcut: **Alt+Shift+G** — group all tabs now.

## Project structure

```
manifest.json        # MV3 manifest (permissions: tabs, tabGroups, storage)
background.js        # service worker: events, accordion, message routing
lib/resolve.js       # the grouping pipeline, pure and benchmarkable
lib/context.js       # scores how related any two tabs are, with no site rules
lib/refs.js          # what counts as a work-item reference (vs. UTF-8, Q3-2026)
lib/pageContent.js   # the ONLY file that can read a page; optional permission
lib/aiProbe.js       # reports which built-in AI APIs this browser actually has
lib/affinity.js      # turns those pairwise scores into clusters
lib/taskSignal.js    # per-site knowledge, used only to phrase AI prompt hints
lib/taskMemory.js    # what it has learned: your names, your pins, task profiles
lib/summarize.js     # names a group after the work, in two words
lib/aiGrouper.js     # Prompt API wrapper (availability, cluster naming, NL, download)
lib/tabManager.js    # applies decisions to Chrome; feeds corrections back
lib/url.js           # internal-host detection + subdomain label logic
lib/storage.js       # settings + sessions persistence
popup/               # popup UI (groups view, search, NL, sessions)
options/             # settings page
icons/               # icon.svg source + build-icons.sh (regenerates the PNGs)
scripts/package.sh   # build a Web Store zip
scripts/test-grouping.mjs  # unit checks for the grouping logic (node, no browser)
scripts/bench.mjs          # scores grouping quality against labelled fixtures
scripts/fixtures/          # hand-labelled tab sets used by the benchmark
```

Neither script needs a browser or the model:

```bash
node scripts/test-grouping.mjs   # 243 checks
node scripts/bench.mjs           # grouping F1 + name quality, cold vs warm
```

## Does the AI learn?

The model does not. It is Gemini Nano running on your machine through Chrome's
Prompt API: frozen weights, no training, no fine-tuning, nothing written back.
Every call starts from the same blank slate, and uninstalling the extension
leaves the model exactly as it was.

What learns is the layer around it. Three separate mechanisms, worth keeping
apart:

| | Where it lives | Survives a restart? | Touches the model? |
|---|---|---|---|
| **Task memory** — your names, your pins, task profiles | `chrome.storage.local` | Yes | No. It runs *before* the model and usually means the model is never asked. |
| **In-prompt steering** — the group names already in use are restated in each prompt so the model reuses them | the prompt text, per call | No | Only as input, for that one call. |
| **The model** | Chrome's on-device model | — | Never modified. |

So the system gets better with use while the model stays fixed. That is a
deliberate trade, and a good one here: your corrections take effect on the very
next tab instead of after a training run, they are inspectable and reversible
under **Settings → What it has learned**, and grouping keeps working when the
model is unavailable.

Each prompt also runs in its own cloned context. Grouping calls are independent
classifications, not a conversation, and a shared session would otherwise
accumulate a transcript of every call — filling the context window until prompts
fail, and letting unrelated earlier decisions leak into later ones.

## Privacy

All AI runs on-device via Chrome's built-in model. **There are no network
requests anywhere in this extension** — nothing it reads can leave the machine,
because there is no code that could send it.

It installs with `tabs`, `tabGroups` and `storage`, and **no host permissions at
all**. On those permissions alone it never sees page content; everything it
knows comes from tab titles and URLs.

**Page access is optional and off by default.** `scripting` and `<all_urls>` are
declared as *optional* permissions, requested only when you press **Grant
access** in Settings, and revoking puts everything back exactly as it was. When
granted, what gets read is a summary, not the page:

- `og:title` and the meta description
- up to 8 `h1`/`h2` headings
- the first 600 characters of `<main>`, `<article>`, or the body

Never form fields, never inputs, never the full document. It is cached in
`chrome.storage.session`, which is cleared when the browser closes, and
invalidated the moment a tab navigates. Revoking access clears the cache too.

Worth being clear about the trade you are making: granting `<all_urls>` means
Chrome will tell you the extension can read data on every site you visit, and
that is true — it is what makes an untitled document groupable. Whether that is
worth it is a judgement about how much you trust this code, and the code is
right here: [`lib/pageContent.js`](lib/pageContent.js) is the only file that can
read a page, and it is 200 lines.

Settings, saved sessions and everything it has learned live in
`chrome.storage.local` on your machine. Learned tasks store task keys, hostnames
and distinctive title words — enough to recognize a task, and nothing that
leaves the browser. **Settings → What it has learned** shows all of it and can
forget any or all of it.
