/**
 * Reading what a page is actually about.
 *
 * Titles and URLs carry a lot, but not always enough: an untitled document, a
 * dashboard called "Grafana", a single-page app that has not set its title yet.
 * Those tabs have no description at all, and no amount of cleverness about
 * hostnames invents one.
 *
 * So this reads the page — under three constraints that shape the whole module:
 *
 *   1. It is OFF until you turn it on. The extension installs with no host
 *      access whatsoever; `scripting` and `<all_urls>` are optional permissions
 *      requested from the options page, and revoking them puts things back
 *      exactly as they were.
 *   2. It takes a summary, not the page. Headings, the meta description, and a
 *      bounded slice of the main text — enough to say what the page is about,
 *      and far less than the page itself.
 *   3. What it takes never leaves the machine, and never outlives the browser
 *      session. There are no network calls anywhere in this extension, and the
 *      cache lives in chrome.storage.session.
 */

/** Characters of body text worth keeping. Enough to describe, not to copy. */
const MAX_BODY = 600;
const MAX_HEADINGS = 8;

/** Where the cache lives. Session-scoped: cleared when the browser closes. */
const CACHE_KEY = 'pageContentCache';

/** How many tabs to read at once. Each is a script injection into a live page. */
const CONCURRENCY = 6;

/** The permissions content reading needs, requested together. */
export const CONTENT_PERMISSIONS = {
  permissions: ['scripting'],
  origins: ['<all_urls>'],
};

/** Has the user granted page reading? */
export async function hasContentAccess() {
  try {
    return await chrome.permissions.contains(CONTENT_PERMISSIONS);
  } catch {
    return false;
  }
}

/*
 * There is deliberately no requestContentAccess() here.
 * chrome.permissions.request() only works inside a user gesture, so it must be
 * called from the options page's own click handler; routing it through the
 * service worker fails silently, which is a bad way to learn about a
 * permission model.
 */

/** Give the permissions back. */
export async function revokeContentAccess() {
  try {
    await chrome.permissions.remove(CONTENT_PERMISSIONS);
    await clearContentCache();
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs inside the page. Must be entirely self-contained — it is serialized and
 * injected, so it closes over nothing.
 *
 * Reads the parts of a document that say what it is: the headings an author
 * wrote, the description they wrote for search engines, and the start of the
 * main content. Deliberately not form values, not inputs, not the whole body.
 */
function extractInPage() {
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

  const meta = (sel) => {
    const el = document.querySelector(sel);
    return el ? clean(el.getAttribute('content')) : '';
  };

  const description = meta('meta[name="description"]')
    || meta('meta[property="og:description"]')
    || '';
  const ogTitle = meta('meta[property="og:title"]') || '';

  const headings = [...document.querySelectorAll('h1, h2')]
    .map((el) => clean(el.textContent))
    .filter((t) => t.length > 2 && t.length < 120)
    .slice(0, 8);

  // Prefer the semantic main region; fall back to the body.
  const main = document.querySelector('main, article, [role="main"]') || document.body;
  const body = clean(main && main.innerText ? main.innerText : '').slice(0, 600);

  return { ogTitle, description, headings, body };
}

/** Cache read: keyed by tab AND url, so a navigation invalidates it. */
async function readCache() {
  try {
    return (await chrome.storage.session.get(CACHE_KEY))[CACHE_KEY] || {};
  } catch {
    return {};
  }
}

async function writeCache(cache) {
  try {
    await chrome.storage.session.set({ [CACHE_KEY]: cache });
  } catch { /* session storage unavailable or full */ }
}

export async function clearContentCache() {
  try {
    await chrome.storage.session.remove(CACHE_KEY);
  } catch { /* noop */ }
}

/** Only http(s) pages can be read; Chrome blocks its own pages and the store. */
function isReadable(tab) {
  if (!tab || !tab.url) return false;
  if (!/^https?:\/\//i.test(tab.url)) return false;
  // A discarded tab has no live document to inject into.
  if (tab.discarded) return false;
  return true;
}

/**
 * Turn an extraction into the text the grouper reasons over.
 *
 * Ordered by how deliberate each part is: an author writes headings and a
 * description on purpose, while body text is whatever happened to be first on
 * the page. The order matters because callers truncate.
 */
export function contentToText(extracted) {
  if (!extracted) return '';
  const parts = [
    extracted.ogTitle,
    extracted.description,
    (extracted.headings || []).slice(0, MAX_HEADINGS).join(' . '),
    (extracted.body || '').slice(0, MAX_BODY),
  ];
  return parts.filter(Boolean).join(' . ').slice(0, 1200);
}

/**
 * Read one tab. Returns '' for anything unreadable rather than throwing, since
 * a page that cannot be read is normal (a PDF, a Chrome page, a crashed tab)
 * and must not stop a grouping pass.
 */
export async function readTabContent(tab) {
  if (!isReadable(tab)) return '';
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractInPage,
    });
    return contentToText(result && result.result);
  } catch {
    return ''; // no access to this origin, or the page blocks injection
  }
}

/**
 * Read many tabs, in bounded parallel, using the cache where possible.
 *
 * @param {Array<{id:number,url:string,discarded?:boolean}>} tabs
 * @param {{onProgress?:(done:number,total:number)=>void}} [opts]
 * @returns {Promise<Map<number,string>>} tabId → content text ('' if unread)
 */
export async function gatherContent(tabs, opts = {}) {
  const out = new Map();
  const list = (tabs || []).filter(isReadable);
  if (list.length === 0) return out;
  if (!(await hasContentAccess())) return out;

  const cache = await readCache();
  const pending = [];
  for (const tab of list) {
    const hit = cache[tab.id];
    if (hit && hit.url === tab.url) out.set(tab.id, hit.text);
    else pending.push(tab);
  }

  let done = out.size;
  const total = list.length;
  if (opts.onProgress) opts.onProgress(done, total);

  // A simple worker pool: injections are independent, but firing one per tab at
  // once on a large window is a lot of simultaneous script evaluation.
  const queue = [...pending];
  const worker = async () => {
    for (;;) {
      const tab = queue.shift();
      if (!tab) return;
      const text = await readTabContent(tab);
      out.set(tab.id, text);
      cache[tab.id] = { url: tab.url, text };
      done++;
      if (opts.onProgress) opts.onProgress(done, total);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));

  await writeCache(cache);
  return out;
}

/** Forget one tab's cached content (on close, or when it navigates). */
export async function forgetContent(tabId) {
  const cache = await readCache();
  if (cache[tabId]) {
    delete cache[tabId];
    await writeCache(cache);
  }
}
