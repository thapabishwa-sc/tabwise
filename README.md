# AI Tab Grouper

A Chrome extension that automatically groups your tabs by **the work they belong
to** using Chrome's **on-device AI** (Gemini Nano via the Prompt API). Everything
runs locally — tab titles and URLs never leave your machine.

A ticket, its pull request, its spec doc and its dashboard end up in one group
even though they live on four different domains — and two unrelated documents on
the same `docs.google.com` end up in different ones.

## Features

- **Task grouping, not domain grouping** — the group is the work-stream ("Auth
  Migration", "Q3 Budget"), never the website. Tabs across different sites merge
  when they serve one task; tabs on the same site split when they don't.
- **Task signals from the URL** — ticket keys, repo names, document ids, wiki
  spaces and channel ids are read out of the path
  ([`lib/taskSignal.js`](lib/taskSignal.js)) and given to the model. Without
  them the hostname is the only shared feature between tabs, which is why
  hostname grouping used to be all you got.
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
  bucket.
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
- AI features degrade gracefully: without the model, pinned rules, internal-host
  grouping, link trails and shared task keys all still work — a ticket and its PR
  still group together. Only the human-readable *naming* of a group falls back to
  the task key ("gateway", "AUTH") or, as a last resort, the host.

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

For each eligible tab (http/https, not pinned), the label is resolved in order:

1. **Pinned rule** — first rule whose `match` is a substring of `hostname + path`
   (or whose `pattern` matches). Explicit config always wins.
2. **Internal host** — infrastructure is labeled by `subdomainStrategy`, so two
   clusters never merge. Only hosts that look internal qualify; see
   `subdomainScope` below.
3. **Link trail** — if the tab was opened from another tab in the same window,
   it joins that tab's group. No AI call, so it lands correctly right away.
4. **Task cluster + AI name** — remaining tabs are clustered by shared task key
   (same ticket project, same repo, same document, same channel), and the
   on-device model names each cluster after the work it serves. A tab carrying
   two identities bridges them: a pull request titled `AUTH-482: fix token`
   joins the repo's tabs to that ticket's tabs, because someone wrote that
   ticket id into that title deliberately.

Clustering happens *before* the model runs, so a cluster is an atom: the AI names
it but can never split it, and a task assembled from a link trail survives.
Labels are then consolidated, merging drift like "Auth Migration" vs
"Auth Migrations" that batching would otherwise turn into two groups.

Groups smaller than **Minimum group size** fall into the **Other** bucket.
Pinned groups, internal-host groups, and clusters built on a real task key are
exempt — so a brand-new task can start its own group instead of only ever
accreting into groups that already exist.

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

Keyboard shortcut: **Alt+Shift+G** — group all tabs now.

## Project structure

```
manifest.json        # MV3 manifest (permissions: tabs, tabGroups, storage)
background.js        # service worker: events, accordion, message routing
lib/aiGrouper.js     # Prompt API wrapper (availability, cluster naming, NL, download)
lib/taskSignal.js    # reads task identity (ticket, repo, doc) out of a URL
lib/affinity.js      # clusters tabs by link trail + shared task key
lib/tabManager.js    # grouping orchestration, sessions, snapshot
lib/url.js           # internal-host detection + subdomain label logic
lib/storage.js       # settings + sessions persistence
popup/               # popup UI (groups view, search, NL, sessions)
options/             # settings page
icons/               # icon.svg source + build-icons.sh (regenerates the PNGs)
scripts/package.sh   # build a Web Store zip
scripts/test-grouping.mjs  # self-check for the grouping logic (node, no browser)
```

Run the logic self-check with:

```bash
node scripts/test-grouping.mjs
```

## Privacy

All AI runs on-device via Chrome's built-in model. The extension requests only
`tabs`, `tabGroups`, and `storage` — no host permissions, no network calls of
its own. Settings and saved sessions live in `chrome.storage.local`.
