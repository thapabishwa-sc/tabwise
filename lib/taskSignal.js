/**
 * Task signals — what work a tab belongs to, read out of its URL.
 *
 * Grouping by hostname fails because one host serves many tasks (two unrelated
 * `docs.google.com` tabs) and one task spans many hosts (a ticket, its PR, its
 * dashboard, its spec). The identity of the *work* lives in the path: ticket
 * keys, repo names, document ids, channel ids.
 *
 * Two outputs per tab:
 *   - taskKey(url) → a strong, deterministic key ('jira:AUTH', 'repo:acme/api')
 *     when the URL names a work item. Tabs sharing a key are the same task with
 *     no AI involved.
 *   - signalText(url) → a compact hint string for the AI prompt, so the model
 *     sees "AUTH-482" rather than guessing from a hostname.
 *
 * Unrecognized URLs get a null key and a distilled path slug as weak signal;
 * those are exactly the tabs the AI should reason about.
 */

/** Strip a leading 'www.' and lowercase. */
function hostOf(u) {
  return u.hostname.replace(/^www\./i, '').toLowerCase();
}

/** Non-empty, decoded path segments. */
function segments(u) {
  return u.pathname.split('/').filter(Boolean).map((s) => {
    try { return decodeURIComponent(s); } catch { return s; }
  });
}

/** An uppercase ticket key like AUTH-482 → its project part ('AUTH'). */
const TICKET_RE = /\b([A-Z][A-Z0-9]{1,9})-(\d{1,6})\b/;

/**
 * Platform matchers, most specific first. Each returns
 * `{ key, display }` — `key` clusters tabs, `display` goes in the prompt.
 *
 * Keys are deliberately scoped at the level a *task* lives at: a Jira project,
 * a repo, a single document, a channel. Too broad merges unrelated work; too
 * narrow (one key per URL) clusters nothing.
 */
const MATCHERS = [
  // --- Confluence / Atlassian wiki: /wiki/spaces/ENG/pages/123/Title ---
  {
    test: (h, u) => u.pathname.startsWith('/wiki/'),
    read: (u, segs) => {
      const si = segs.indexOf('spaces');
      const space = si !== -1 ? segs[si + 1] : null;
      const title = segs[segs.length - 1];
      return {
        key: space ? `wiki:${space.toUpperCase()}` : null,
        display: `wiki ${space || ''} ${deslug(title)}`.trim(),
      };
    },
  },

  // --- Jira (cloud + server) ---
  {
    test: (h) => h.endsWith('atlassian.net') || h.includes('jira'),
    read: (u, segs) => {
      const fromPath = (u.pathname.match(TICKET_RE) || [])[0];
      const fromQuery = (u.search.match(TICKET_RE) || [])[0];
      const issue = fromPath || fromQuery;
      if (issue) {
        return { key: `jira:${issue.split('-')[0]}`, display: `jira ${issue}` };
      }
      // Board/backlog/project pages: /jira/software/projects/AUTH/boards/12
      const pi = segs.indexOf('projects');
      if (pi !== -1 && segs[pi + 1]) {
        const proj = segs[pi + 1].toUpperCase();
        return { key: `jira:${proj}`, display: `jira ${proj} board` };
      }
      return { key: null, display: 'jira' };
    },
  },

  // --- Linear: /team/ENG/issue/ENG-123/title or /issue/ENG-123 ---
  {
    test: (h) => h === 'linear.app',
    read: (u) => {
      const m = u.pathname.match(TICKET_RE);
      return m
        ? { key: `linear:${m[1]}`, display: `linear ${m[0]}` }
        : { key: null, display: 'linear' };
    },
  },

  // --- GitHub / GitLab / Bitbucket / Gitea: owner/repo is the task anchor ---
  {
    test: (h) => /(^|\.)(github\.com|gitlab\.com|bitbucket\.org)$/.test(h)
      || /(^|\.)(github|gitlab|gitea)\./.test(h),
    read: (u, segs) => {
      // GitLab nests groups: /group/sub/repo/-/merge_requests/7
      const dash = segs.indexOf('-');
      const repoSegs = dash !== -1 ? segs.slice(0, dash) : segs.slice(0, 2);
      if (repoSegs.length < 2) {
        return { key: null, display: 'git' };
      }
      const repo = repoSegs.join('/').toLowerCase();
      const rest = dash !== -1 ? segs.slice(dash + 1) : segs.slice(2);
      const kind = rest[0] || '';
      const num = rest[1] && /^\d+$/.test(rest[1]) ? rest[1] : '';
      let what = '';
      if (/^(pull|pull_requests|merge_requests)$/.test(kind)) what = `PR#${num}`;
      else if (kind === 'issues') what = `issue#${num}`;
      else if (/^(blob|tree|blame)$/.test(kind)) what = 'code';
      else if (kind === 'actions') what = 'CI';
      return { key: `repo:${repo}`, display: `repo ${repo}${what ? ' ' + what : ''}` };
    },
  },

  // --- Google Docs/Sheets/Slides: a document is its own task anchor ---
  {
    test: (h) => h === 'docs.google.com',
    read: (u, segs) => {
      const di = segs.indexOf('d');
      const id = di !== -1 ? segs[di + 1] : null;
      const kind = segs[0] || 'doc';
      return {
        key: id ? `gdoc:${id.slice(0, 16)}` : null,
        display: `google ${kind}`,
      };
    },
  },

  // --- Notion: /Some-Page-Title-<32 hex> ---
  {
    test: (h) => h.endsWith('notion.so') || h.endsWith('notion.site'),
    read: (u, segs) => {
      const last = segs[segs.length - 1] || '';
      const m = last.match(/^(.*?)-?([0-9a-f]{32})$/i);
      return m
        ? { key: `notion:${m[2].slice(0, 12)}`, display: `notion ${deslug(m[1])}` }
        : { key: null, display: `notion ${deslug(last)}` };
    },
  },

  // --- Slack: a channel is the closest thing to a task ---
  {
    test: (h) => h.endsWith('slack.com'),
    read: (u, segs) => {
      const ch = segs.find((s) => /^[CGD][A-Z0-9]{6,}$/.test(s));
      return ch
        ? { key: `slack:${ch}`, display: 'slack channel' }
        : { key: null, display: 'slack' };
    },
  },

  // --- Figma: /file/<key>/<Name> ---
  {
    test: (h) => h.endsWith('figma.com'),
    read: (u, segs) => {
      const i = segs.findIndex((s) => s === 'file' || s === 'design' || s === 'board');
      const id = i !== -1 ? segs[i + 1] : null;
      const name = i !== -1 ? segs[i + 2] : null;
      return {
        key: id ? `figma:${id.slice(0, 12)}` : null,
        display: `figma ${deslug(name || '')}`.trim(),
      };
    },
  },
];

/** 'auth-token-refresh' / 'Auth_Token+Refresh' → 'auth token refresh' */
function deslug(s) {
  if (!s) return '';
  return s
    .replace(/\.[a-z0-9]{1,5}$/i, '')      // trailing file extension
    .replace(/[-_+.]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')   // camelCase
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
}

/** Pull a user search query out of the URL, if any. */
function queryText(u) {
  for (const p of ['q', 'query', 'search', 'search_query', 'k']) {
    const v = u.searchParams.get(p);
    if (v && v.length > 1) return deslug(v);
  }
  return '';
}

/**
 * Read the task identity of a URL.
 *
 * @param {string} url
 * @returns {{key: string|null, display: string, host: string}}
 *   key     — strong task key, or null when the URL names no work item
 *   display — compact hint for the AI prompt ('' when nothing useful)
 */
export function readTask(url) {
  let u;
  try { u = new URL(url); } catch { return { key: null, display: '', host: '' }; }
  if (!/^https?:$/.test(u.protocol)) return { key: null, display: '', host: '' };

  const host = hostOf(u);
  const segs = segments(u);

  for (const m of MATCHERS) {
    let hit = false;
    try { hit = m.test(host, u); } catch { hit = false; }
    if (!hit) continue;
    const { key, display } = m.read(u, segs);
    return { key, display: (display || '').slice(0, 48), host };
  }

  // --- Unrecognized host: no strong key, but still give the model a hint. ---
  const q = queryText(u);
  if (q) return { key: null, display: `search "${q}"`, host };

  // A bare ticket key anywhere in the URL is a strong signal on any host.
  const ticket = (u.pathname + u.search).match(TICKET_RE);
  if (ticket) {
    return { key: `ticket:${ticket[1]}`, display: ticket[0], host };
  }

  // Otherwise: the most descriptive path segment, as words.
  const slug = segs
    .filter((s) => !/^\d+$/.test(s) && s.length > 2)
    .map(deslug)
    .filter(Boolean)
    .pop() || '';
  return { key: null, display: slug.slice(0, 40), host };
}

/** Strong task key for a URL, or null. */
export function taskKey(url) {
  return readTask(url).key;
}

/**
 * A ticket key mentioned in a tab *title* (e.g. "AUTH-482: rotate keys").
 * Titles often carry the ticket even when the URL doesn't — a dashboard or doc
 * named after the work item belongs with that work item.
 *
 * @returns {string|null} project-scoped key, e.g. 'ticket:AUTH'
 */
export function titleTaskKey(title) {
  if (!title) return null;
  const m = String(title).match(TICKET_RE);
  return m ? `ticket:${m[1]}` : null;
}
