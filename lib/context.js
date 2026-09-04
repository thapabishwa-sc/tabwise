/**
 * Context engine — scoring how related any two tabs are, with no per-site rules.
 *
 * The platform registry in lib/taskSignal.js knows that `/browse/AUTH-482` is a
 * Jira issue and `github.com/acme/api/pull/7` is a pull request. That knowledge
 * works well and does not generalize at all: a team on Shortcut, Azure DevOps,
 * Redmine or an in-house tracker gets nothing from it, and every new tool means
 * another matcher.
 *
 * This module replaces the knowledge with a measurement. Every tab is reduced to
 * plain features — its host, its cumulative path prefixes, the identifiers in its
 * URL and title, its distinctive title words — and each feature is weighted by
 * how RARE it is across the tabs you actually have open:
 *
 *   a path prefix shared by 2 tabs out of 40   → names one piece of work
 *   the same prefix shared by 20 tabs          → names a container
 *
 * That is the strong/weak distinction the registry hardcoded, except it is now
 * read off your open tabs instead of being asserted per site. `atlassian.net/browse`
 * is a container when you have eight tickets open and an identity when you have
 * one — which is correct, and which no static rule can express.
 *
 * Pairs are then scored as a weighted sum of shared features, and every score
 * carries the list of features that produced it, so the UI can say "shares
 * AUTH-482" rather than just "related".
 *
 * One structural distinction does real work throughout: a path's INTERIOR
 * segments name containers, while its LAST segment names content. In
 * `github.com/acme/monorepo/pull/500` the word "monorepo" is interior, so two
 * pull requests sharing it are siblings; in
 * `/pages/2758606863/NG-SaaS-onboarding` the word "onboarding" is in the leaf,
 * so it is what the page is about. Titles repeat both — a pull request title
 * ends with its repository name — and without the distinction a repository name
 * reads as subject matter and merges every ticket in the repo.
 */

import { titleTokens } from './summarize.js';
import { isRealRef, refMatcher } from './refs.js';

/** How deep a path is worth following. Beyond this, prefixes stop discriminating. */
const MAX_PREFIX_DEPTH = 5;

/** Feature kinds and what a shared one is worth before rarity is applied. */
const KIND_WEIGHT = {
  ref: 3.0,     // an explicit work-item reference, in a URL or a title
  opaque: 3.0,  // a long generated id — a document, a file, a board
  item: 3.0,    // a numbered item within a container: `.../pull/1203`
  path: 1.0,    // a shared path prefix, scaled by how deep it goes
  word: 1.0,    // a distinctive title word
  tag: 0.3,     // a bracketed label: an environment, a region, a status
  host: 0.15,   // the same site, which on its own means very little
};

/** Feature kinds that identify a specific piece of work. */
const IDENTITY_KINDS = new Set(['ref', 'opaque', 'item']);

/**
 * A generated-looking id: long, alphanumeric, and not a word. Document ids,
 * board keys and hashes all look like this regardless of which product made them.
 */
function isOpaqueId(seg) {
  if (seg.length > 64) return false;
  // A long run of digits is a record id: a wiki page, an issue, a row.
  if (/^\d{6,}$/.test(seg)) return true;
  // Otherwise a single unbroken alphanumeric run. The no-dash requirement is
  // what separates a generated key from a readable slug: "getting-started-2"
  // has the same characters as an id and is plainly a title.
  if (seg.length < 8) return false;
  if (!/^[A-Za-z0-9_]+$/.test(seg)) return false;
  return /\d/.test(seg) && /[A-Za-z]/.test(seg);
}

/**
 * Reduce a tab to the features that could relate it to another tab.
 *
 * @param {{id:number,url:string,title?:string}} tab
 * @returns {{id:number, features:Map<string,number>}}
 *   feature key → its own weight multiplier (path depth, word specificity)
 */
export function extractFeatures(tab) {
  const features = new Map();
  // Words that name a container this tab lives in, rather than its subject.
  const interior = new Set();
  const add = (key, mult = 1) => {
    const prev = features.get(key) || 0;
    if (mult > prev) features.set(key, mult);
  };

  let u = null;
  try { u = new URL(tab.url); } catch { /* not a URL */ }

  if (u && /^https?:$/.test(u.protocol)) {
    const host = u.hostname.replace(/^www\./i, '').toLowerCase();
    add(`host:${host}`);

    const segs = u.pathname.split('/').filter(Boolean).map((s) => {
      try { return decodeURIComponent(s); } catch { return s; }
    });

    const leafSeg = segs[segs.length - 1];

    // Every segment but the last names a container. Recorded whole and split,
    // since a title writes "acme/monorepo" where a path writes two segments.
    for (const seg of segs.slice(0, -1)) {
      for (const word of seg.toLowerCase().split(/[^a-z0-9]+/)) {
        if (word.length >= 3) interior.add(word);
      }
    }

    // Cumulative prefixes. A deeper shared prefix is a narrower claim, so it
    // counts for much more. The first segment under a host is almost always a
    // namespace rather than a unit of work — `github.com/acme` is an
    // organization, `atlassian.net/browse` is every ticket there is — so on its
    // own it must not be enough to join two tabs; it can only corroborate.
    let prefix = host;
    for (let i = 0; i < Math.min(segs.length, MAX_PREFIX_DEPTH); i++) {
      prefix += `/${segs[i].toLowerCase()}`;
      add(`path:${prefix}`, 0.4 + i * 0.6);
    }

    for (const seg of segs) {
      if (isOpaqueId(seg)) add(`opaque:${seg}`);
    }

    // The last segment is the page's own name, and it is frequently the only
    // description available: page content is never read, so when a title is
    // generic ("Confluence", "Grafana") or has not loaded yet, a slug like
    // `NG-SaaS-onboarding-offboarding` or `auth-gateway-latency` is all there
    // is to say what the page is about. Interior segments are excluded above
    // because they name containers; the leaf is the content, so its words are
    // subject matter exactly as a title's are.
    if (leafSeg && !isOpaqueId(leafSeg) && !/^\d+$/.test(leafSeg)) {
      for (const w of titleTokens(leafSeg.replace(/[+_]/g, ' '))) {
        add(`word:${w}`, /\d/.test(w) ? 1 : Math.min(1.5, Math.max(0.25, w.length / 8)));
      }
    }

    // A path ending in a bare number is item N of whatever contains it:
    // `.../pull/1203`, `.../issues/7`, `.../comment/45`. Two such tabs under
    // one container are two items, not one — the only thing telling them apart
    // is the number, so it has to count as an identity even though it is far
    // too short to look like one on its own.
    if (segs.length >= 2 && leafSeg && /^\d+$/.test(leafSeg)) {
      add(`item:${host}${u.pathname.replace(/\/+$/, '').toLowerCase()}`);
    }

    // References anywhere in the URL, including the query string.
    for (const m of `${u.pathname}${u.search}`.matchAll(refMatcher())) {
      if (isRealRef(m[1])) add(`ref:${m[1]}-${m[2]}`);
    }
  }

  const title = tab.title || '';

  // A reference written into a title is a deliberate statement about which work
  // this page belongs to, and it is what bridges one tool to another.
  for (const m of title.matchAll(refMatcher())) {
    if (isRealRef(m[1])) add(`ref:${m[1]}-${m[2]}`);
  }

  // Bracketed labels — "[single-org]", "[ap-tokyo-1]", "[WIP]" — are metadata
  // stamped on a title: an environment, a region, a status. They are shared
  // boilerplate across every ticket in a queue, so as subject matter they merge
  // an onboarding ticket with an upgrade one and name the result after the tag.
  // They still say something (two tabs about the same deployment), so they are
  // kept as weak container evidence rather than discarded.
  for (const m of title.matchAll(/\[([^\]]{1,40})\]/g)) {
    for (const word of m[1].toLowerCase().split(/[^a-z0-9]+/)) {
      if (word.length >= 2) add(`tag:${word}`);
    }
  }

  // Distinctive words, weighted by specificity: length as a proxy, with a floor
  // for words carrying a digit, since "Q3" and "v2" name real things.
  for (const w of titleTokens(title)) {
    const spec = /\d/.test(w) ? 1 : Math.min(1.5, Math.max(0.25, w.length / 8));
    add(`word:${w}`, spec);
  }

  return { id: tab.id, features, interior };
}

/**
 * The page's own name from its URL — the last path segment, as words.
 *
 * The counterpart to titles for naming: page content is never read, so when a
 * title is generic ("Confluence", "Grafana") the slug is the only thing left
 * that says what the page is.
 *
 * @returns {string} '' when the leaf is an id, a number, or absent
 */
export function leafText(url) {
  let u;
  try { u = new URL(url); } catch { return ''; }
  if (!/^https?:$/.test(u.protocol)) return '';
  const segs = u.pathname.split('/').filter(Boolean).map((seg) => {
    try { return decodeURIComponent(seg); } catch { return seg; }
  });
  const leaf = segs[segs.length - 1];
  if (!leaf || isOpaqueId(leaf) || /^\d+$/.test(leaf)) return '';
  return leaf.replace(/[+_]/g, ' ');
}

/**
 * Score a tab's features against a bag of remembered feature keys.
 *
 * Task memory needs the same question answered — "is this tab this task?" —
 * against a stored profile rather than another tab. Sharing the vocabulary and
 * the weight table means there is one definition of what evidence is worth,
 * instead of two that drift apart.
 *
 * Rarity plays no part: a profile is absolute, carrying no notion of what else
 * is open, which is exactly what lets it still mean something tomorrow.
 *
 * @param {{features:Map<string,number>}} extracted  from extractFeatures
 * @param {Set<string>|string[]} profile  remembered feature keys
 * @returns {{identity:number, subject:number, container:number, hits:string[]}}
 */
export function scoreAgainstProfile(extracted, profile) {
  const bag = profile instanceof Set ? profile : new Set(profile || []);
  const out = { identity: 0, subject: 0, container: 0, hits: [] };
  for (const [key, mult] of extracted.features) {
    if (!bag.has(key)) continue;
    const kind = kindOf(key);
    const points = (KIND_WEIGHT[kind] || 0) * mult;
    if (points <= 0) continue;
    if (IDENTITY_KINDS.has(kind)) out.identity += points;
    else if (kind === 'word') out.subject += points;
    else out.container += points;
    out.hits.push(key);
  }
  return out;
}

/**
 * The feature keys worth remembering about a tab.
 *
 * Interior path words are dropped: they name the container a tab sits in, and a
 * profile carrying "monorepo" as subject matter would match every tab in the
 * repository. Everything else — identifiers, subject words, hosts, path
 * prefixes — is stable enough to recognize the task again later.
 */
export function profileFeaturesOf(tab) {
  const { features, interior } = extractFeatures(tab);
  const out = [];
  for (const key of features.keys()) {
    if (key.startsWith('word:') && interior.has(key.slice(5))) continue;
    out.push(key);
  }
  return out;
}

/**
 * The identifiers a tab carries, on their own terms.
 *
 * Unlike a relatedness score, these do not depend on which other tabs are open,
 * so they are safe to persist: task memory needs a key that still means the same
 * thing tomorrow.
 *
 * @returns {string[]} e.g. ['ref:AUTH-482', 'opaque:1a2b3c4d5e']
 */
export function identitiesOf(tab) {
  const { features } = extractFeatures(tab);
  return [...features.keys()].filter((k) => IDENTITY_KINDS.has(k.slice(0, k.indexOf(':'))));
}

/** Does this tab name a specific piece of work? */
export function namesWork(tab) {
  return identitiesOf(tab).length > 0;
}

/** The kind prefix of a feature key. */
function kindOf(key) {
  return key.slice(0, key.indexOf(':'));
}

/**
 * Build a scorer over one set of tabs.
 *
 * Rarity is measured across exactly these tabs, which is the whole point: the
 * same feature is an identity in one window and a container in another.
 *
 * @param {Array<{id:number,url:string,title?:string}>} tabs
 */
export function buildContext(tabs) {
  const list = tabs || [];
  const extracted = list.map(extractFeatures);

  // How many tabs carry each feature.
  const docFreq = new Map();
  for (const { features } of extracted) {
    for (const key of features.keys()) {
      docFreq.set(key, (docFreq.get(key) || 0) + 1);
    }
  }

  const byId = new Map(extracted.map((e) => [e.id, e]));

  /**
   * Rarity of a feature.
   *
   * Softened with a square root rather than a plain reciprocal. A word shared
   * by three tabs is not a third as meaningful as one shared by two — often all
   * three are the same task — and 1/df punishes exactly the case we want to
   * find. The root keeps rare features dominant without erasing the rest.
   */
  const rarity = (key) => 1 / Math.sqrt(Math.max(1, docFreq.get(key) || 1));

  /**
   * Score one pair, split by what kind of evidence produced it.
   *
   * The split matters more than the total. Sharing an IDENTITY (the same
   * reference or generated id) means the two tabs are about the same thing.
   * Sharing a CONTAINER (a path prefix, a host) means only that they live in
   * the same place, which is worth little and is actively misleading between
   * two tabs that each name their own piece of work. Sharing SUBJECT words is
   * evidence either way.
   *
   * @returns {{identity:number, subject:number, container:number,
   *            why:Array<{key:string, points:number}>}}
   */
  const scorePair = (idA, idB) => {
    const A = byId.get(idA);
    const B = byId.get(idB);
    const out = { identity: 0, subject: 0, container: 0, why: [] };
    if (!A || !B) return out;

    for (const [key, multA] of A.features) {
      const multB = B.features.get(key);
      if (multB === undefined) continue;
      const kind = kindOf(key);
      const base = KIND_WEIGHT[kind] || 0;
      const points = base * Math.min(multA, multB) * rarity(key);
      if (points <= 0) continue;

      if (IDENTITY_KINDS.has(kind)) {
        out.identity += points;
      } else if (kind === 'word') {
        // A word both tabs carry as an interior path segment is the name of
        // something containing them, not something they are about.
        const word = key.slice(5);
        const containerName = A.interior.has(word) && B.interior.has(word);
        if (containerName) out.container += points;
        else out.subject += points;
      } else {
        out.container += points;
      }
      out.why.push({ key, points, kind });
    }
    out.why.sort((a, b) => b.points - a.points);
    return out;
  };

  /**
   * The most specific references a tab carries — those shared by few tabs.
   * Used to veto container merges: if two tabs each name a different piece of
   * work, the container they have in common must not join them.
   */
  const refsOf = (id) => {
    const e = byId.get(id);
    if (!e) return new Set();
    const out = new Set();
    for (const key of e.features.keys()) {
      const kind = kindOf(key);
      if (!IDENTITY_KINDS.has(kind)) continue;
      // A reference on nearly every tab is boilerplate, not an identity.
      if ((docFreq.get(key) || 1) <= Math.max(2, list.length / 3)) out.add(key);
    }
    return out;
  };

  /**
   * Decide whether two tabs are the same work, and say why.
   *
   * 1. They name the same thing → yes. Nothing outranks a shared identity.
   * 2. They each name a DIFFERENT thing → the container they share stops
   *    counting. Two tickets in one tracker, two pages in one wiki space, two
   *    pull requests in one repository: siblings, not collaborators. Only
   *    shared subject matter can still connect them, which is what lets a
   *    ticket join the page documenting it while staying apart from the next
   *    ticket in the same tracker.
   * 3. Otherwise → the full weight of the evidence, container included. A tab
   *    with no identity of its own is free to be adopted by the one piece of
   *    work its container holds.
   *
   * @returns {{related:boolean, score:number, basis:string,
   *            why:Array<object>}}
   */
  const relate = (idA, idB, threshold = RELATED_THRESHOLD) => {
    const s = scorePair(idA, idB);

    if (s.identity > 0) {
      return { related: true, score: s.identity + s.subject, basis: 'identity', why: s.why };
    }

    const refsA = refsOf(idA);
    const refsB = refsOf(idB);
    const bothNamed = refsA.size > 0 && refsB.size > 0;

    if (bothNamed) {
      return {
        related: s.subject >= threshold,
        score: s.subject,
        basis: 'subject',
        why: s.why.filter((w) => w.kind === 'word'),
      };
    }

    const score = s.subject + s.container;
    return {
      related: score >= threshold,
      score,
      basis: s.container > s.subject ? 'container' : 'subject',
      why: s.why,
    };
  };

  return { scorePair, relate, refsOf, docFreq, features: byId };
}

/** Evidence needed to call two tabs the same work, absent a shared identity. */
export const RELATED_THRESHOLD = 0.5;
