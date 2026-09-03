/**
 * Hostname helpers for subdomain-aware grouping.
 *
 * The guiding rule: two tabs that live on different hostnames of the same
 * parent domain (e.g. app-east-1.corp.example.com vs app-west-1.corp.example.com)
 * must NOT be merged just because their pages look alike. Internal tools are
 * identified by their subdomain, so the subdomain — not the page topic — is the
 * grouping key for such hosts.
 *
 * That rule is right for internal infrastructure and wrong for everything else.
 * "Has a subdomain" is far too broad a test for it: `docs.google.com`,
 * `mail.google.com`, `app.slack.com` and `console.aws.amazon.com` all have one,
 * and forcing them into per-host groups ("docs", "app", "console") is exactly
 * the hostname grouping we want to avoid — it even merges unrelated work, since
 * a design doc and a budget sheet share `docs.google.com`.
 *
 * So deterministic subdomain grouping now requires positive evidence that a
 * host really is internal infrastructure (isInternalHost): a private-network
 * marker, an explicitly configured domain, a bare/IP host, or the dashed
 * cluster-naming convention (`prod-eu-frankfurt-1-grafana`). Every other host
 * goes to task grouping, where it belongs.
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

// Hostname markers for private/internal networks.
const PRIVATE_MARKERS = ['corp', 'internal', 'intranet', 'intra', 'priv', 'lan', 'local', 'inet'];

/**
 * True for a bare hostname (`jenkins`) or an IP literal — always internal, and
 * always grouped by the whole host: the "registrable domain = last two labels"
 * approximation is meaningless for both (it would read `10.0.4.12` as the
 * subdomain `10` under the domain `4.12`, merging every 10.x host).
 */
function isBareOrIp(host) {
  if (!host.includes('.')) return true;
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

/**
 * Does this host look like internal infrastructure, as opposed to a public
 * SaaS product that merely has a subdomain?
 *
 * Evidence, any one of which is enough:
 *   - the host ends with a user-configured internal domain;
 *   - a private-network label appears in the host (`.corp.`, `.internal`, …);
 *   - the host is bare or an IP literal;
 *   - the leftmost label follows the dashed cluster convention — two or more
 *     dash-separated tokens including a digit (`prod-eu-frankfurt-1-grafana`,
 *     `dev-qa3`). The digit requirement keeps ordinary dashed product
 *     subdomains (`my-cool-app.vercel.app`) out.
 *
 * @param {string} url
 * @param {string[]} [internalDomains] - configured suffixes, e.g. ['corp.acme.com']
 * @returns {boolean}
 */
export function isInternalHost(url, internalDomains = []) {
  const { host, leftmost } = parseHost(url);
  if (!host) return false;

  if (isBareOrIp(host)) return true;

  for (const d of internalDomains || []) {
    const suffix = String(d || '').trim().toLowerCase().replace(/^\.+/, '');
    if (suffix && (host === suffix || host.endsWith('.' + suffix))) return true;
  }

  const labels = host.split('.');
  // Skip the leftmost label when checking markers: a product legitimately named
  // `local.example.com` shouldn't count, but `app.corp.example.com` should.
  if (labels.slice(1).some((l) => PRIVATE_MARKERS.includes(l))) return true;

  if (leftmost.includes('-')) {
    const tokens = leftmost.split('-').filter(Boolean);
    if (tokens.length >= 2 && /\d/.test(leftmost)) return true;
  }

  return false;
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
 * Scope controls WHICH hosts this applies to:
 *   'internal' (default) — only hosts that look like internal infrastructure
 *                 (isInternalHost). Public SaaS hosts return null and are task
 *                 grouped, so `docs.google.com` no longer becomes a "docs" group.
 *   'all'       — any host with a meaningful subdomain, the older behavior.
 *
 * @param {string} url
 * @param {'ai'|'subdomain'|'prefix'|'host'} [strategy]
 * @param {{scope?:'internal'|'all', internalDomains?:string[]}} [opts]
 * @returns {string|null}
 */
export function subdomainGroupLabel(url, strategy = 'subdomain', opts = {}) {
  // 'ai' (and any unknown value) means: let the AI group these hosts.
  if (strategy !== 'subdomain' && strategy !== 'prefix' && strategy !== 'host') {
    return null;
  }

  const { hasMeaningfulSub, leftmost, host } = parseHost(url);
  if (!host) return null;

  // Default scope: reserve deterministic host grouping for internal tools.
  const internal = isInternalHost(url, opts.internalDomains);
  if (opts.scope !== 'all' && !internal) return null;

  // Bare hostnames and IP literals have no parseable subdomain; the whole host
  // is the identity, under every strategy.
  if (isBareOrIp(host)) return clip(host);

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
