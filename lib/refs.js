/**
 * Recognizing a work-item reference in text.
 *
 * "AUTH-482" is a ticket. "UTF-8" is a character encoding, "ISO-8601" a date
 * format, "Q3-2026" a quarter. They are the same shape, and treating the second
 * kind as a work item merges every page that happens to mention it — the same
 * coincidence-for-purpose error that grouping by hostname makes.
 *
 * This is the single source of truth for that distinction. It lived in two
 * copies before — one for grouping, one for prompt hints — and they had already
 * drifted sixteen entries apart, so the copy doing the actual grouping was the
 * weaker of the two and invented identities out of quarters.
 */

/** A ticket-shaped reference: two or more capitals, a dash, a number. */
export const REF_PATTERN = String.raw`\b([A-Z][A-Z0-9]{1,9})-(\d{1,6})\b`;

/** Non-global matcher, for a single lookup. */
export const REF_RE = new RegExp(REF_PATTERN);

/** Fresh global matcher, for iterating every reference in a string. */
export function refMatcher() {
  return new RegExp(REF_PATTERN, 'g');
}

/**
 * Prefixes that look like a work item and name a standard, encoding, format,
 * quarter or section instead.
 */
export const NOT_REFERENCES = new Set([
  // character encodings
  'UTF', 'ASCII', 'ISO', 'IEC', 'ANSI', 'LATIN', 'CP', 'WIN', 'GB', 'BIG',
  // hashes and ciphers
  'SHA', 'MD', 'AES', 'DES', 'RSA', 'HMAC', 'CRC', 'ECDSA', 'PBKDF', 'BCRYPT',
  // specs and standards bodies
  'RFC', 'BCP', 'STD', 'PEP', 'ECMA', 'IEEE', 'WCAG', 'ARIA', 'DIN', 'EN',
  // protocols
  'HTTP', 'HTTPS', 'TLS', 'SSL', 'TCP', 'UDP', 'IP', 'IPV', 'DNS', 'SMTP',
  'IMAP', 'POP', 'LDAP', 'SSH', 'FTP', 'OAUTH', 'SAML', 'JWT', 'OIDC',
  // compliance and vulnerability identifiers
  'GDPR', 'PCI', 'SOC', 'HIPAA', 'FIPS', 'NIST', 'CVE', 'CWE', 'CVSS',
  // media formats and hardware
  'JPEG', 'MPEG', 'MP', 'AV', 'HDMI', 'VGA', 'USB', 'SATA', 'NVME', 'DDR',
  // time zones, quarters, misc numbering
  'GMT', 'UTC', 'EST', 'PST', 'CET', 'Q', 'Q1', 'Q2', 'Q3', 'Q4',
  'V', 'VER', 'REV', 'VOL', 'NO', 'PART', 'CH', 'FIG', 'SECTION', 'PAGE',
  // epidemiology (dashboards and news, not tickets)
  'COVID', 'SARS', 'MERS', 'H1N1',
]);

/** Is this prefix a real work-item reference rather than a standard's name? */
export function isRealRef(prefix) {
  return typeof prefix === 'string'
    && prefix.length >= 2
    && !NOT_REFERENCES.has(prefix);
}

/**
 * The full reference in a string, when it is confidently a work item.
 * @returns {string|null} e.g. 'AUTH-482'
 */
export function findRef(text) {
  const m = String(text || '').match(REF_RE);
  if (!m || !isRealRef(m[1])) return null;
  return `${m[1]}-${m[2]}`;
}

/** Every distinct confident reference in a string. */
export function findAllRefs(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(refMatcher())) {
    if (isRealRef(m[1])) out.add(`${m[1]}-${m[2]}`);
  }
  return [...out];
}
