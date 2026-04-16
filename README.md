# AI Tab Grouper

A Chrome extension that automatically groups your tabs by topic using Chrome's
**on-device AI** (Gemini Nano via the Prompt API). Everything runs locally —
tab titles and URLs never leave your machine.

## Features

- **AI topic grouping** — groups plain websites by topic (Code, Docs, Email…)
  using the on-device model.
- **Subdomained hosts** — grouped deterministically so internal tools aren't
  mislabeled by the AI (no AI, instant, offline). Default `subdomain` (leftmost
  subdomain); `host` (whole hostname); `prefix` (drop the trailing dash-token,
  via Import); or `ai` to let the model group them too.
- **Pinned rules** — force specific URLs into a fixed group, bypassing the AI.
  Matches against *hostname + path*, so rules can be path-specific.
- **Auto-grouping** — new/navigated tabs are grouped as they settle.
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
- AI features degrade gracefully: if the model is unavailable, subdomain and
  pinned-rule grouping still work; only topic grouping of plain sites is skipped.

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

1. **Pinned rule** — first rule whose `match` is a substring of `hostname + path`.
2. **Subdomained host** — grouped by `subdomainStrategy` (default `subdomain`;
   set to `ai` to skip this and let the model decide).
3. **AI topic** — the on-device model picks a short label (plain domains, and
   everything when the model is available).

AI-topic groups smaller than **Minimum group size** fall into the **Other**
bucket. Pinned and subdomain groups are exempt.

## Pinned rules

One rule per line in **Settings → Pinned Rules**:

```
match = Group Label
```

`match` is matched as a case-insensitive substring of the tab's `hostname + path`.
**First match wins**, so list more specific rules first.

The core ships with **no pinned rules** — it's generic. Apply org/personal
rules as a runtime override (see below), e.g.:

```
atlassian.net/wiki = Confluence
atlassian.net      = Jira
github.com         = Code
bitbucket.org      = Code
```

## Runtime overrides (org/personal config)

Company-specific config isn't baked into the extension. Apply it at runtime via
**Settings → Import / Export**:

- **Import (merge)** — paste a settings JSON and it's merged over your current
  settings. A ready-made example lives at
  [`examples/example.json`](examples/example.json) (Jira/Confluence/Code pinned
  rules + the `prefix` subdomain strategy).
- **Export current** — dumps your settings as JSON to back up or share.

## Settings

| Setting | Default | Description |
|---|---|---|
| Auto-group new tabs | on | Group tabs automatically as they load. |
| Accordion | on | Collapse inactive groups as you switch tabs. |
| Respect manual groups | on | Don't touch groups you created yourself. |
| Minimum group size | 2 | Smallest AI-topic group before tabs go to "Other". |
| Leftover group name | Other | Where sub-minimum tabs land. |
| Subdomained hosts | Full subdomain | `subdomain` / `host` / `ai` (`prefix` via Import). |
| Pinned rules | (above) | Force URLs into fixed groups. |

Keyboard shortcut: **Alt+Shift+G** — group all tabs now.

## Project structure

```
manifest.json        # MV3 manifest (permissions: tabs, tabGroups, storage)
background.js        # service worker: events, accordion, message routing
lib/aiGrouper.js     # Prompt API wrapper (availability, grouping, NL, download)
lib/tabManager.js    # grouping orchestration, sessions, snapshot
lib/url.js           # subdomain label logic
lib/storage.js       # settings + sessions persistence
popup/               # popup UI (groups view, search, NL, sessions)
options/             # settings page
icons/               # icon.svg source + build-icons.sh (regenerates the PNGs)
scripts/package.sh   # build a Web Store zip
```

## Privacy

All AI runs on-device via Chrome's built-in model. The extension requests only
`tabs`, `tabGroups`, and `storage` — no host permissions, no network calls of
its own. Settings and saved sessions live in `chrome.storage.local`.
