/**
 * Human-readable hints about what a URL points at, for the AI prompt.
 *
 * This is the one place with per-site knowledge — that `/browse/AUTH-482` is a
 * Jira issue, that `github.com/acme/api/pull/7` is a pull request — and its only
 * job now is to phrase that for the model: a prompt line reading
 * `[task: jira AUTH-482]` beats one reading `[task: browse AUTH-482]`.
 *
 * Grouping does NOT use any of it. Which tabs belong together is decided by
 * lib/context.js, which scores shared identifiers, containers and subject
 * matter by how rare each is across your open tabs, and therefore works the
 * same on an in-house tracker as on a product listed below. A missing matcher
 * here costs a slightly worse prompt hint, never a worse grouping.
 *
 * Keys are still returned for callers that want a platform-shaped label, and
 * they distinguish a work item (a ticket, a pull request, one document) from a
 * container that holds many (a repo, a project, a wiki space, a channel).
 */

import { REF_RE, findRef } from './refs.js';

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

/**
 * Reference detection lives in lib/refs.js, shared with the context engine so
 * the two can never disagree about what counts as a ticket.
 */
const TICKET_RE = REF_RE;

/** The full reference ('WEB-101') when it is confidently a ticket. */
function confidentTicketRef(text) {
  return findRef(text);
}

/** The project part of a confident reference, e.g. 'AUTH'. */
function confidentTicketProject(text) {
  const ref = findRef(text);
  return ref ? String(ref).split('-')[0] : null;
}

/** Strong key for one ticket, plus the weak key for its project. */
function ticketKeys(ref) {
  const project = String(ref).split('-')[0];
  return { key: `ticket:${ref}`, weak: [`proj:${project}`] };
}

/**
 * Platform matchers, most specific first. Each returns
 * `{ key, display }` — `key` clusters tabs, `display` goes in the prompt.
 *
 * Keys are deliberately scoped at the level a *task* lives at: a Jira project,
 * a repo, a single document, a channel. Too broad merges unrelated work; too
 * narrow (one key per URL) clusters nothing.
 *
 * A ticket project always yields `ticket:<PROJ>`, whatever it was read from —
 * a Jira URL, a Linear URL, an arbitrary URL, or a tab title. Namespacing these
 * per platform ('jira:AUTH' vs 'ticket:AUTH') would keep the same work item
 * from recognizing itself across sources, which is the whole point of the key.
 */
const MATCHERS = [
  // --- Confluence / Atlassian wiki: /wiki/spaces/ENG/pages/123/Title ---
  {
    test: (h, u) => u.pathname.startsWith('/wiki/'),
    read: (u, segs) => {
      const si = segs.indexOf('spaces');
      const space = si !== -1 ? segs[si + 1] : null;
      const pi = segs.indexOf('pages');
      const pageId = pi !== -1 ? segs[pi + 1] : null;
      const title = segs[segs.length - 1];
      return {
        // One page is a work item; the space around it is a container.
        key: pageId ? `wikipage:${pageId}` : null,
        weak: space ? [`wiki:${space.toUpperCase()}`] : [],
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
        return { ...ticketKeys(issue), display: `jira ${issue}` };
      }
      // A board or backlog is the project's container, not one work item.
      const pi = segs.indexOf('projects');
      if (pi !== -1 && segs[pi + 1]) {
        const proj = segs[pi + 1].toUpperCase();
        return { key: null, weak: [`proj:${proj}`], display: `jira ${proj} board` };
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
        ? { ...ticketKeys(m[0]), display: `linear ${m[0]}` }
        : { key: null, display: 'linear' };
    },
  },

  // --- GitHub / GitLab / Bitbucket / Gitea: owner/repo is the task anchor ---
  {
    // `*.github.io` / `*.gitlab.io` are published Pages sites, not repository
    // browsers — their paths are page routes, so `owner/repo` reads nothing.
    test: (h) => !/(^|\.)(github|gitlab)\.io$/.test(h)
      && (/(^|\.)(github\.com|gitlab\.com|bitbucket\.org)$/.test(h)
        || /(^|\.)(github|gitlab|gitea)\./.test(h)),
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
      let key = null;
      if (/^(pull|pull_requests|merge_requests)$/.test(kind)) {
        what = `PR#${num}`;
        if (num) key = `pr:${repo}#${num}`;
      } else if (kind === 'issues') {
        what = `issue#${num}`;
        if (num) key = `gh-issue:${repo}#${num}`;
      } else if (/^(blob|tree|blame)$/.test(kind)) {
        what = 'code';
      } else if (kind === 'actions') {
        what = 'CI';
      }
      // The change is the work item; the repository merely contains it.
      return { key, weak: [`repo:${repo}`], display: `repo ${repo}${what ? ' ' + what : ''}` };
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
        weak: [],
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
        ? { key: null, weak: [`slack:${ch}`], display: 'slack channel' }
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
  const none = { key: null, weak: [], display: '', host: '' };
  try { u = new URL(url); } catch { return none; }
  if (!/^https?:$/.test(u.protocol)) return none;

  const host = hostOf(u);
  const segs = segments(u);

  for (const m of MATCHERS) {
    let hit = false;
    try { hit = m.test(host, u); } catch { hit = false; }
    if (!hit) continue;
    const out = m.read(u, segs);
    return {
      key: out.key || null,
      weak: out.weak || [],
      display: (out.display || '').slice(0, 48),
      host,
    };
  }

  // --- Unrecognized host: no strong key, but still give the model a hint. ---
  const q = queryText(u);
  if (q) return { key: null, weak: [], display: `search "${q}"`, host };

  // A ticket key anywhere in the URL is a strong signal on any host, as long as
  // it really is a ticket key and not an encoding or standard.
  const path = u.pathname + u.search;
  const ref = confidentTicketRef(path);
  if (ref) {
    return { ...ticketKeys(ref), display: ref, host };
  }

  // Otherwise: the most descriptive path segment, as words.
  const slug = segs
    .filter((s) => !/^\d+$/.test(s) && s.length > 2)
    .map(deslug)
    .filter(Boolean)
    .pop() || '';
  return { key: null, weak: [], display: slug.slice(0, 40), host };
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
  const ref = confidentTicketRef(title);
  return ref ? `ticket:${ref}` : null;
}

/**
 * The weak (container) keys implied by a tab title — currently the project a
 * ticket belongs to. Corroborating evidence only; see lib/affinity.js.
 */
export function titleWeakKeys(title) {
  const ref = confidentTicketRef(title);
  return ref ? [`proj:${String(ref).split('-')[0]}`] : [];
}
