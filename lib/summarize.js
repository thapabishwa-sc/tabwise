/**
 * Naming a group after the work, in about two words.
 *
 * A task key like `ticket:AUTH` is excellent for deciding *which* tabs belong
 * together and useless as a *name* for them: "AUTH" or "AUTH-482" forces you to
 * remember what that ticket was about every time you glance at the tab strip.
 * The identifier answers "same work?"; the title text answers "what work?".
 *
 * So identifiers are used for grouping only, and never as a label. This module
 * derives a short descriptive name from the tab titles instead, and detects
 * labels that are really just identifiers so they can be rejected.
 */

/** Words too common, or too much about the website, to name a task. */
const STOPWORDS = new Set([
  // grammar
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'your', 'you', 'are',
  'was', 'were', 'has', 'have', 'had', 'not', 'but', 'all', 'any', 'can',
  'how', 'why', 'what', 'when', 'who', 'new', 'get', 'use', 'using', 'about',
  'into', 'over', 'more', 'less', 'than', 'then', 'they', 'them', 'our', 'via',
  'per', 'its', 'his', 'her', 'their', 'been', 'being', 'will', 'would',
  'should', 'could', 'must', 'may', 'might', 'just', 'only', 'also', 'very',
  // page chrome
  'home', 'page', 'index', 'search', 'results', 'result', 'login', 'signin',
  'sign', 'dashboard', 'overview', 'untitled', 'welcome', 'loading', 'error',
  'view', 'edit', 'editing', 'open', 'close', 'menu', 'settings', 'preview',
  'detail', 'details', 'summary', 'list', 'item', 'items', 'main', 'default',
  // site and product names — never the name of your work
  'google', 'docs', 'doc', 'sheets', 'sheet', 'slides', 'drive', 'gmail',
  'mail', 'inbox', 'github', 'gitlab', 'bitbucket', 'jira', 'atlassian',
  'confluence', 'slack', 'notion', 'figma', 'linear', 'asana', 'trello',
  'grafana', 'kibana', 'datadog', 'jenkins', 'stackoverflow', 'stack',
  'overflow', 'youtube', 'twitter', 'reddit', 'medium', 'chrome',
  // generic dev vocabulary that describes the artifact, not the work
  'issue', 'issues', 'pull', 'request', 'requests', 'merge', 'commit',
  'commits', 'branch', 'repo', 'repository', 'file', 'files', 'folder',
  'ticket', 'task', 'tasks', 'board', 'backlog', 'sprint', 'epic', 'story',
  'comment', 'comments', 'review', 'draft', 'copy', 'untitled',
]);

/** Trailing site chrome: " - Jira", " · owner/repo", " — Notion". */
const SEPARATORS = /\s+[-–—|·:‹›»]+\s+/g;

/** Identifier shapes that must never become a group name. */
const IDENTIFIER_PATTERNS = [
  /^[A-Z][A-Z0-9]{1,9}-\d{1,6}$/,          // AUTH-482
  /^[A-Z][A-Z0-9]{1,9}$/,                  // AUTH
  /^#?\d+$/,                               // 1203, #1203
  /^[a-z0-9_-]+\/[a-z0-9._-]+$/i,          // acme/gateway
  /^(jira|linear|ticket|repo|wiki|issue|pr)\b[\s:_-]*[A-Z0-9-]*$/i, // "Jira: AUTH"
  /^[0-9a-f]{8,}$/i,                       // opaque ids
];

/**
 * Is this label an identifier rather than a description?
 *
 * Used to reject a model's answer: given a `[task: jira AUTH-482]` hint, a small
 * model will often echo the identifier straight back as the label, which is the
 * one thing the label must not be.
 */
export function looksLikeIdentifier(label) {
  const s = String(label || '').trim();
  if (!s) return true;
  if (IDENTIFIER_PATTERNS.some((re) => re.test(s))) return true;
  // A label whose words are ALL identifier-ish (e.g. "AUTH 482", "PR 1203").
  const words = s.split(/\s+/);
  const identifierish = words.filter((w) => /^#?\d+$/.test(w) || /^[A-Z][A-Z0-9]{1,9}(-\d+)?$/.test(w));
  return identifierish.length === words.length;
}

/**
 * Strip site chrome, identifiers and paths from a title, leaving prose.
 */
export function cleanTitle(title) {
  let s = String(title || '');

  // Drop a leading/trailing notification count: "(3) Inbox".
  s = s.replace(/^\(\d+\)\s*/, '');

  // Drop bracketed labels: "[single-org] [ap-tokyo-1] customerpoc - onboarding"
  // is about onboarding, and a group named "Single Org" says nothing at all.
  // lib/context.js keeps them separately as weak container evidence.
  s = s.replace(/\[[^\]]{1,40}\]/g, ' ');

  // A path-looking title is only useful as its basename: src/auth/token.go
  s = s.replace(/(^|\s)[\w.-]*(?:\/[\w.-]+){1,}(\s|$)/g, (m) => {
    const base = m.trim().split('/').pop() || '';
    return ` ${base.replace(/\.[a-z0-9]{1,5}$/i, '')} `;
  });

  // Remove ticket keys and issue numbers — grouping signal, not naming signal.
  s = s.replace(/\b[A-Z][A-Z0-9]{1,9}-\d{1,6}\b/g, ' ');
  s = s.replace(/#\d+/g, ' ');

  // Split on site-chrome separators and drop only the segments that are pure
  // chrome, keeping every segment that carries subject matter.
  //
  // Keeping just the longest segment loses the subject whenever a title is
  // shaped "metadata - subject": in
  // "[single-org] [ap-tokyo-1] customerpoc - onboarding" the bracketed
  // deployment tags win on length and "onboarding" — the only word saying what
  // the work is — gets discarded as though it were a product name.
  const parts = s.split(SEPARATORS).map((p) => p.trim()).filter(Boolean);
  if (parts.length > 1) {
    const kept = parts.filter((part) => {
      const words = part
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, ' ')
        .split(/[\s-]+/)
        .filter(Boolean);
      // " - Jira", " · Google Docs", " | Pull Request" are entirely chrome.
      return words.length > 0 && !words.every((w) => STOPWORDS.has(w));
    });
    s = (kept.length > 0 ? kept : parts).join(' ');
  }

  return s.replace(/\s+/g, ' ').trim();
}

/** Crude stem, for deduplicating "migration"/"migrations"/"migrating". */
function stem(w) {
  return w
    .replace(/(ings|ing|ies|ed|es|s)$/, '')
    .replace(/(ion|ions)$/, '');
}

/** Distinctive lowercase words from a title, in order of appearance. */
export function titleTokens(title) {
  const cleaned = cleanTitle(title).toLowerCase();
  const words = cleaned
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter((w) => w.length <= 20
      && !STOPWORDS.has(w)
      && !/^\d+$/.test(w)
      // Three letters, or two when one is a digit: "Q3" and "v2" name work,
      // while "of" and "to" do not.
      && (w.length >= 3 || (w.length === 2 && /\d/.test(w))));
  return [...new Set(words)];
}

/** Title Case a single word, preserving known all-caps forms. */
function titleCaseWord(w) {
  if (/^(api|ui|ux|sql|css|html|dns|ssl|tls|jwt|sso|cli|sdk|aws|gcp|ci|cd|qa|ml|ai|io)$/i.test(w)) {
    return w.toUpperCase();
  }
  if (/^oauth\d*$/i.test(w)) return w.replace(/^oauth/i, 'OAuth');
  return w.charAt(0).toUpperCase() + w.slice(1);
}

/**
 * Name a group from its tabs' titles, in `maxWords` words.
 *
 * Words are ranked by how many *different* titles use them: a word appearing in
 * several tabs describes the shared work, while one appearing in a single tab
 * describes only that tab. Ties break toward earlier, longer words. The chosen
 * words are emitted in the order they naturally read.
 *
 * @param {string[]} titles
 * @param {{maxWords?:number}} [opts]
 * @returns {string|null} e.g. "Auth Migration", or null if nothing usable
 */
export function summarizeTitles(titles, opts = {}) {
  const maxWords = opts.maxWords || 2;
  const list = (titles || []).map(cleanTitle).filter(Boolean);
  if (list.length === 0) return null;

  // docFreq: how many titles contain the word.
  // posSum/posN: normalized position within each title, averaged. Position must
  // be normalized and averaged, not taken from whichever title happened to
  // mention the word first — those indices aren't comparable across titles, and
  // comparing them yields orderings like "Card Gift".
  const docFreq = new Map();
  const posSum = new Map();
  const posN = new Map();
  const byStem = new Map();

  list.forEach((title) => {
    const tokens = titleTokens(title);
    tokens.forEach((w, i) => {
      docFreq.set(w, (docFreq.get(w) || 0) + 1);
      const rel = tokens.length > 1 ? i / (tokens.length - 1) : 0;
      posSum.set(w, (posSum.get(w) || 0) + rel);
      posN.set(w, (posN.get(w) || 0) + 1);
      const st = stem(w);
      // Keep the shortest surface form for a stem, so "migrations" → "migration".
      const cur = byStem.get(st);
      if (!cur || w.length < cur.length) byStem.set(st, w);
    });
  });

  /** Mean normalized position of a word across the titles that use it. */
  const meanPos = (w) => (posN.get(w) ? posSum.get(w) / posN.get(w) : 1);

  if (docFreq.size === 0) return null;

  // Collapse inflections onto one representative word.
  const merged = new Map();
  for (const [w, n] of docFreq) {
    const rep = byStem.get(stem(w)) || w;
    merged.set(rep, (merged.get(rep) || 0) + n);
  }

  const ranked = [...merged.entries()]
    .sort((a, b) => {
      // A word used by several tabs describes the shared work; one used by a
      // single tab describes only that tab.
      if (b[1] !== a[1]) return b[1] - a[1];
      // With frequency tied (common in small clusters, where every word appears
      // once) prefer the more specific word: "onboarding" over "team".
      if (b[0].length !== a[0].length) return b[0].length - a[0].length;
      return meanPos(a[0]) - meanPos(b[0]);
    })
    .slice(0, maxWords)
    .map(([w]) => w);

  if (ranked.length === 0) return null;

  // Emit in reading order rather than rank order: "Gift Card", not "Card Gift".
  ranked.sort((a, b) => meanPos(a) - meanPos(b));

  const label = ranked.map(titleCaseWord).join(' ');
  return label.length > 24 ? label.slice(0, 24).trim() : label;
}
