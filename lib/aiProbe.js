/**
 * What on-device AI does THIS browser actually have?
 *
 * Chrome's built-in AI surface moves quickly, and the honest answer to "can we
 * use a better local model" is not something to recall — it is something to
 * measure in the browser doing the work. This probe reports what exists here,
 * right now, rather than what was true when the code was written.
 *
 * It only reads capability descriptors. Nothing is created, nothing is
 * downloaded, no model is invoked.
 */

/**
 * The built-in AI entry points worth asking about, and what each would be for.
 *
 * `global` is the modern spelling; `legacy` the older `self.ai.*` path some
 * builds still expose. Unknown names are not an error — a missing API simply
 * reports as absent, so this list can lag Chrome without lying.
 */
const CANDIDATES = [
  {
    key: 'LanguageModel',
    global: 'LanguageModel',
    legacy: ['ai', 'languageModel'],
    used: true,
    purpose: 'General prompting. Names groups and judges which are the same work.',
  },
  {
    key: 'Summarizer',
    global: 'Summarizer',
    legacy: ['ai', 'summarizer'],
    used: false,
    purpose: 'Condensing text. A better fit than prompting for turning page content into a short name.',
  },
  {
    key: 'LanguageDetector',
    global: 'LanguageDetector',
    legacy: ['translation', 'detector'],
    used: false,
    purpose: 'Detecting a page language, which would let non-English titles be tokenized properly.',
  },
  {
    key: 'Translator',
    global: 'Translator',
    legacy: ['translation', 'translator'],
    used: false,
    purpose: 'Translation. Could normalize mixed-language tabs before comparing them.',
  },
  { key: 'Writer', global: 'Writer', used: false, purpose: 'Generating prose. Not useful here.' },
  { key: 'Rewriter', global: 'Rewriter', used: false, purpose: 'Rephrasing. Not useful here.' },
  { key: 'Proofreader', global: 'Proofreader', used: false, purpose: 'Correcting text. Not useful here.' },
];

/** Resolve a candidate to its object, whichever spelling this build uses. */
function resolveApi(candidate) {
  const g = globalThis;
  if (candidate.global && typeof g[candidate.global] !== 'undefined') {
    return { api: g[candidate.global], via: candidate.global };
  }
  if (candidate.legacy && g.self) {
    const [ns, name] = candidate.legacy;
    const obj = g.self[ns] && g.self[ns][name];
    if (obj) return { api: obj, via: `self.${ns}.${name}` };
  }
  return { api: null, via: null };
}

/** Ask an API whether it is ready, tolerating both spellings of the check. */
async function availabilityOf(api) {
  try {
    if (typeof api.availability === 'function') return await api.availability();
    if (typeof api.capabilities === 'function') {
      const caps = await api.capabilities();
      return caps && caps.available ? String(caps.available) : 'unknown';
    }
  } catch { /* a throwing probe is the same as unknown */ }
  return 'unknown';
}

/**
 * Report every built-in AI API this browser exposes.
 *
 * @returns {Promise<{apis: Array<object>, promptParams: object|null, chrome: string}>}
 */
export async function probeAi() {
  const apis = [];
  for (const candidate of CANDIDATES) {
    const { api, via } = resolveApi(candidate);
    apis.push({
      name: candidate.key,
      purpose: candidate.purpose,
      usedByThisExtension: candidate.used,
      present: !!api,
      via,
      availability: api ? await availabilityOf(api) : 'absent',
    });
  }

  // The Prompt API's tunable ranges. Worth surfacing because this extension
  // asks for a low temperature to keep labels stable, and a build whose limits
  // are lower would reject that request.
  let promptParams = null;
  const { api: lm } = resolveApi(CANDIDATES[0]);
  if (lm && typeof lm.params === 'function') {
    try {
      const p = await lm.params();
      promptParams = {
        defaultTopK: p.defaultTopK,
        maxTopK: p.maxTopK,
        defaultTemperature: p.defaultTemperature,
        maxTemperature: p.maxTemperature,
      };
    } catch { /* not exposed on this build */ }
  }

  const ua = (globalThis.navigator && navigator.userAgent) || '';
  const version = (ua.match(/Chrome\/(\d+)/) || [])[1] || 'unknown';

  return { apis, promptParams, chrome: version };
}
