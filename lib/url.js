/**
 * Hostname helpers for subdomain-aware grouping.
 *
 * The guiding rule: two tabs that live on different hostnames of the same
 * parent domain (e.g. app-east-1.corp.example.com vs app-west-1.corp.example.com)
 * must NOT be merged just because their pages look alike. Internal tools are
 * identified by their subdomain, so the subdomain — not the page topic — is the
 * grouping key for such hosts.
 */

const MAX_LABEL_LEN = 24;

/**
 * Break a URL's hostname into parts using a simple "registrable domain =
 * last two labels" approximation (good enough for grouping; no PSL needed).
 *
 * @param {string} url
 * @returns {{host:string, base:string, subdomain:string, leftmost:string, hasMeaningfulSub:boolean}}
 */
export function parseHost(url) {
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch { /* not a URL */ }
  if (!host) {
    return { host: '', base: '', subdomain: '', leftmost: '', hasMeaningfulSub: false };
  }

  const labels = host.split('.').filter(Boolean);
  const base = labels.slice(-2).join('.');
  const subLabels = labels.slice(0, -2); // everything left of the registrable domain
  const rawLeftmost = subLabels[0] || '';

  // 'www' (and a bare root domain) are not meaningful identities.
  const leftmost = rawLeftmost === 'www' ? '' : rawLeftmost;

  return {
    host,
    base,
    subdomain: subLabels.join('.'),
    leftmost,
    hasMeaningfulSub: leftmost.length > 0,
  };
}

function clip(s) {
  return s.length > MAX_LABEL_LEN ? s.slice(0, MAX_LABEL_LEN) : s;
}

/**
 * The deterministic group label for a host that has a meaningful subdomain,
 * or null when the host should be left to the AI to topic-group.
 *
 * Strategy controls how dashed subdomains map to a group:
 *   'subdomain' (default) — use the whole leftmost subdomain segment as the group.
 *   'ai'        — no deterministic grouping; the AI handles these hosts like
 *                 everything else (returns null).
 *   'prefix'    — drop the trailing dash-token, so `a-b-1-web` and
 *                 `a-b-1-api` both become `a-b-1`, while `a-b-2-*` stays apart.
 *   'host'      — use the full hostname (strictest; one group per host).
 *
 * @param {string} url
 * @param {'ai'|'subdomain'|'prefix'|'host'} [strategy]
 * @returns {string|null}
 */
export function subdomainGroupLabel(url, strategy = 'subdomain') {
  // 'ai' (and any unknown value) means: let the AI group these hosts.
  if (strategy !== 'subdomain' && strategy !== 'prefix' && strategy !== 'host') {
    return null;
  }

  const { hasMeaningfulSub, leftmost, host } = parseHost(url);
  if (!hasMeaningfulSub) return null;

  if (strategy === 'host') return clip(host);

  if (strategy === 'prefix') {
    // Strip the trailing dash-token when there are 2+ tokens.
    const tokens = leftmost.split('-');
    return clip(tokens.length >= 2 ? tokens.slice(0, -1).join('-') : leftmost);
  }

  // 'subdomain' (default): the leftmost subdomain segment as-is.
  return clip(leftmost);
}

/**
 * Deterministic, offline label for a tab — used as a fallback when the AI is
 * unavailable so the extension still groups something. Groups by the leftmost
 * subdomain when present, otherwise by the registrable (base) domain.
 *
 * @param {string} url
 * @returns {string|null}
 */
export function fallbackGroupLabel(url) {
  const { hasMeaningfulSub, leftmost, base } = parseHost(url);
  if (hasMeaningfulSub) return clip(leftmost);
  return base ? clip(base) : null;
}
