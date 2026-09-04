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

/**
 * Trailing hostname tokens that name a SERVICE running on a cluster rather than
 * the cluster itself: `prod-eu-1-grafana` and `prod-eu-1-kibana` are two views
 * of one cluster, and `gamma-dl` and `gamma-da` are two halves of one
 * deployment. Extend via the `clusterServiceTokens` setting.
 */
export const DEFAULT_SERVICE_TOKENS = [
  // deployment components
  'dl', 'da', 'jumper', 'jump', 'bastion', 'mgmt', 'master', 'worker',
  'primary', 'secondary', 'replica', 'standby', 'leader', 'follower',
  // observability
  'grafana', 'kibana', 'prometheus', 'alertmanager', 'logs', 'metrics',
  'monitor', 'monitoring', 'alert', 'trace',
  // data stores
  'es', 'elastic', 'elasticsearch', 'db', 'sql', 'redis', 'kafka', 'zk',
  // front doors
  'api', 'web', 'www', 'app', 'ui', 'admin', 'console', 'portal', 'dashboard',
  'proxy', 'lb', 'ingress', 'gateway', 'vpn', 'auth',
  // build and delivery
  'ci', 'cd', 'build', 'registry', 'artifacts', 'jenkins',
];

/**
 * The cluster a hostname belongs to, from its leftmost label.
 *
 * Two steps, in this order:
 *
 *   1. Drop trailing service tokens, so every service on one cluster shares a
 *      label: `prod-eu-1-grafana`, `prod-eu-1-kibana` and `prod-eu-1-jumper`
 *      all become `prod-eu-1`, and `gamma-dl`/`gamma-da` both become `gamma`.
 *   2. Truncate after the last token containing a digit, which is where the
 *      cluster ordinal sits in `env-region-N-service` naming.
 *
 * Step 2 is what stops step 1's idea being applied blindly. Simply dropping the
 * last token — the older `prefix` strategy — turns `dev-qa3` into `dev`, so
 * `dev-qa3` and `dev-qa4` land in one group: two different clusters merged,
 * which is the exact failure this whole rule exists to prevent. Anchoring on
 * the digit keeps `dev-qa3` whole while still collapsing the services above.
 *
 * Never returns empty, and never returns something shorter than the evidence
 * supports: with no service suffix and no digit, the label is left alone.
 */
function clusterLabel(leftmost, serviceTokens) {
  let tokens = leftmost.split('-').filter(Boolean);
  if (tokens.length < 2) return leftmost;

  const services = new Set(
    (serviceTokens && serviceTokens.length ? serviceTokens : DEFAULT_SERVICE_TOKENS)
      .map((t) => String(t).toLowerCase()),
  );

  // Peel service tokens off the end, never taking the last token standing.
  while (tokens.length > 1 && services.has(tokens[tokens.length - 1])) tokens.pop();

  let lastDigit = -1;
  for (let i = 0; i < tokens.length; i++) {
    if (/\d/.test(tokens[i])) lastDigit = i;
  }
  if (lastDigit >= 0) tokens = tokens.slice(0, lastDigit + 1);

  return tokens.join('-') || leftmost;
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
 *   - the host is bare (no dot at all) or an IP literal.
 *
 * There used to be a fourth: a leftmost label of two or more dash-separated
 * tokens including a digit, meant to catch `prod-eu-frankfurt-1-grafana`
 * without catching `my-cool-app.vercel.app`. It caught almost every sharded or
 * versioned public host as well — `mail-1.google.com`, `api-v2.stripe.com`,
 * `chat-2.slack.com`, `s3-us-west-2.amazonaws.com` — and each one then got a
 * deterministic per-host group, which is domain grouping wearing a different
 * hat. Thirteen of fifteen ordinary hostnames tripped it.
 *
 * It is gone, because the shape of a hostname cannot distinguish an internal
 * cluster from a public shard: `prod-eu-1-grafana.acme.io` and
 * `api-v2.stripe.com` are the same string pattern. Only a marker, a bare host,
 * or your own say-so can. Internal hosts on a public-looking domain therefore
 * need `internalDomains` set — and the cost of not setting it is merely that
 * they get task grouped like everything else, which is the better failure.
 *
 * @param {string} url
 * @param {string[]} [internalDomains] - configured suffixes, e.g. ['corp.acme.com']
 * @returns {boolean}
 */
export function isInternalHost(url, internalDomains = []) {
  const { host } = parseHost(url);
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

  return false;
}

/**
 * The deterministic group label for a host that has a meaningful subdomain,
 * or null when the host should be left to the AI to topic-group.
 *
 * Strategy controls how dashed subdomains map to a group:
 *   'cluster' (default) — every service on one cluster shares a group. See
 *                 clusterLabel: trailing service tokens are dropped and the
 *                 label is anchored on the cluster ordinal.
 *   'subdomain' — use the whole leftmost subdomain segment, so each service on
 *                 a cluster gets its own group.
 *   'ai'        — no deterministic grouping; the AI handles these hosts like
 *                 everything else (returns null).
 *   'prefix'    — drop the trailing dash-token unconditionally. Superseded by
 *                 'cluster', which does not mangle labels like `dev-qa3`.
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
export function subdomainGroupLabel(url, strategy = 'cluster', opts = {}) {
  // 'ai' (and any unknown value) means: let the AI group these hosts.
  const known = ['cluster', 'subdomain', 'prefix', 'host'];
  if (!known.includes(strategy)) return null;

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

  if (strategy === 'cluster') {
    return clip(clusterLabel(leftmost, opts.clusterServiceTokens));
  }

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
