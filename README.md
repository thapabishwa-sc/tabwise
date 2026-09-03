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
- **Task signals from the URL** — ticket keys, pull requests, document ids, wiki
  spaces and channel ids are read out of the path
  ([`lib/taskSignal.js`](lib/taskSignal.js)) and given to the model. Without
  them the hostname is the only shared feature between tabs, which is why
  hostname grouping used to be all you got.
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
- **Quick-switcher search** — filter tabs across all groups; Enter jumps to the
  first match.
- **Natural-language grouping** — "group by project", "put all AWS tabs
  together", "merge Docs and Research".
- **Move a group to its own window**, **rename groups**, and **move a tab**
  between groups from the popup.
- **Sessions** — save the current window's tabs + groups and restore them later.

Pinned tabs are never grouped (Chrome can't group them).

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
3. **Internal host** — infrastructure is labeled by `subdomainStrategy`, so two
   clusters never merge. Only hosts that look internal qualify; see
   `subdomainScope` below.
4. **Link trail** — a tab opened from another tab in the same window joins that
   tab's group. No AI call, so it lands correctly right away.
5. **A task you've grouped before** — matched on its work items and vocabulary,
   and named with the name you gave it.
6. **Task cluster, named** — everything left is clustered by shared work item,
   then named by the on-device model, or from the tabs' own titles when the
   model is unavailable.

Clustering happens *before* naming, so a cluster is an atom: the model names it
but can never split it, and a task assembled from a link trail survives. Names
are then consolidated, merging drift like "Auth Migration" vs "Auth Migrations"
that batching would otherwise turn into two groups.

Two tabs are the same task when one was opened from the other, or when they
share a **work item** — the same ticket, pull request or document. A tab can
carry two work items at once, and that is what bridges platforms: a pull request
titled `AUTH-482: fix token` joins the repo's tabs to that ticket's tabs,
because someone wrote that ticket id into that title deliberately.

A **container** — a repository, a Jira project, a wiki space, a Slack channel —
is not a work item, and cannot group tabs on its own. Three tickets touching one
monorepo are three tasks. A container only adopts tabs that have no work item of
their own: a source file next to the single pull request touching its repo joins
that pull request, but if three pull requests touch the repo, the file belongs to
no one in particular and stays with the other loose files.

Groups smaller than **Minimum group size** fall into the **Other** bucket.
Pinned groups, internal-host groups, learned tasks and clusters built on a real
work item are exempt — so a brand-new task can start its own group instead of
only ever accreting into groups that already exist.

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

A task is recognized by its work items first (decisive), then by hosts and
distinctive title words (corroborating — several must agree, since any two tabs
on `docs.google.com` share a host). See everything it has learned, and forget
any of it, under **Settings → What it has learned**.

## Is the grouping actually good?

```bash
node scripts/bench.mjs            # score every fixture
node scripts/bench.mjs --verbose  # per-tab detail: gold, predicted, and why
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
  auth-migration        ██████████░░ 0.80  1.00   0.67   1.00   4/2      1.00 +0.20
  infra-oncall          ████████████ 1.00  1.00   1.00   1.00   4/4   ✓  1.00   =
  mixed-saas-day        ███████████░ 0.88  1.00   0.78   1.00   4/3      1.00 +0.12
  monorepo-multitask    ████████████ 1.00  1.00   1.00   1.00   3/3   ✓  1.00   =
  research-sprawl       ████████████ 1.00  1.00   1.00   1.00   5/5   ✓  1.00   =
  ticket-lookalikes     ████████████ 1.00  1.00   1.00   1.00   5/5   ✓  1.00   =
  OVERALL               ███████████░ 0.946                 1.00           1.000
```

The on-device model is not available to the benchmark, so cold scores are a
**floor**: precision at 1.00 across every fixture means the deterministic layer
never invents a merge, and every remaining error is a merge the model (or one
correction from you) has to make. Both remaining gaps are genuinely semantic —
whether `AUTH-482` and `AUTH-495` are one effort cannot be read off a URL.

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
| Follow link trails | on | A tab opened from another joins that tab's group. |
| Accordion | on | Collapse inactive groups as you switch tabs. |
| Respect manual groups | on | Don't touch groups you created yourself. |
| Minimum group size | 2 | Smallest group before tabs go to "Other". Tabs naming a real work item are exempt. |
| Leftover group name | Other | Where sub-minimum tabs land. |
| Group by host instead of task | Internal hosts only | `internal` restricts host grouping to infrastructure; `all` restores the old "any subdomain is its own group" behavior. |
| Internal domains | (none) | Extra domain suffixes to treat as infrastructure. |
| Internal host labels | Full subdomain | `subdomain` / `host` / `ai` (`prefix` via Import). |
| Pinned rules | (above) | Force URLs into fixed groups. |
| What it has learned | — | Review and forget learned tasks (not a setting; a list). |

Keyboard shortcut: **Alt+Shift+G** — group all tabs now.

## Project structure

```
manifest.json        # MV3 manifest (permissions: tabs, tabGroups, storage)
background.js        # service worker: events, accordion, message routing
lib/resolve.js       # the grouping pipeline, pure and benchmarkable
lib/taskSignal.js    # reads work items + containers out of a URL
lib/affinity.js      # clusters tabs by link trail + shared work item
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
node scripts/test-grouping.mjs   # 109 checks
node scripts/bench.mjs           # grouping F1 + name quality, cold vs warm
```

## Privacy

All AI runs on-device via Chrome's built-in model. The extension requests only
`tabs`, `tabGroups`, and `storage` — no host permissions, no network calls of
its own, and it never reads page content: everything it knows comes from tab
titles and URLs.

Settings, saved sessions and everything it has learned live in
`chrome.storage.local` on your machine. Learned tasks store task keys, hostnames
and distinctive title words — enough to recognize a task, and nothing that
leaves the browser. **Settings → What it has learned** shows all of it and can
forget any or all of it.
