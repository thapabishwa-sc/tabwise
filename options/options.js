const fields = {
  groupingMode: document.getElementById('groupingMode'),
  aiProjectMode: document.getElementById('aiProjectMode'),
  aiMergePass: document.getElementById('aiMergePass'),
  readPageContent: document.getElementById('readPageContent'),
  collapseInactive: document.getElementById('collapseInactive'),
  respectManualGroups: document.getElementById('respectManualGroups'),
  minGroupSize: document.getElementById('minGroupSize'),
  miscLabel: document.getElementById('miscLabel'),
  useOpenerAffinity: document.getElementById('useOpenerAffinity'),
  subdomainStrategy: document.getElementById('subdomainStrategy'),
  subdomainScope: document.getElementById('subdomainScope'),
  internalDomains: document.getElementById('internalDomains'),
  clusterServiceTokens: document.getElementById('clusterServiceTokens'),
  pinnedRules: document.getElementById('pinnedRules'),
};

// Regex/capture pinned rules aren't editable in the textarea; we preserve them
// across a Save so an imported Jira-style rule isn't lost.
let advancedRules = [];

const aiStatusHint = document.getElementById('ai-status-hint');
const aiStatusBadge = document.getElementById('ai-status-badge');
const btnPrepare = document.getElementById('btn-prepare');
const progressWrap = document.getElementById('progress-wrap');
const progressBar = document.getElementById('progress-bar');
const btnSave = document.getElementById('btn-save');
const btnReset = document.getElementById('btn-reset');
const toast = document.getElementById('toast');

// --- Load ---

async function loadSettings() {
  const s = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
  fields.groupingMode.value = s.groupingMode === 'auto' ? 'auto' : 'manual';
  fields.aiProjectMode.checked = !!s.aiProjectMode;
  fields.aiMergePass.checked = s.aiMergePass !== false;
  fields.readPageContent.checked = s.readPageContent !== false;
  fields.collapseInactive.checked = !!s.collapseInactive;
  fields.useOpenerAffinity.checked = s.useOpenerAffinity !== false;
  fields.respectManualGroups.checked = s.respectManualGroups !== false;
  fields.minGroupSize.value = s.minGroupSize || 2;
  fields.miscLabel.value = s.miscLabel || 'Other';
  // Preserve a non-standard strategy applied via Import (e.g. 'prefix')
  // so it shows in the dropdown and isn't clobbered on Save.
  const strat = s.subdomainStrategy || 'cluster';
  const sel = fields.subdomainStrategy;
  if (![...sel.options].some(o => o.value === strat)) {
    const opt = document.createElement('option');
    opt.value = strat;
    opt.textContent = `${strat} (override)`;
    sel.appendChild(opt);
  }
  sel.value = strat;
  fields.subdomainScope.value = s.subdomainScope === 'all' ? 'all' : 'internal';
  fields.internalDomains.value = (s.internalDomains || []).join('\n');
  fields.clusterServiceTokens.value = (s.clusterServiceTokens || []).join('\n');
  // Textarea manages only simple substring rules; keep pattern rules aside.
  const allRules = s.pinnedRules || [];
  advancedRules = allRules.filter(r => r.pattern);
  fields.pinnedRules.value = allRules
    .filter(r => !r.pattern && r.match)
    .map(r => `${r.match} = ${r.label}`)
    .join('\n');
  refreshAiStatus();
  loadMemoryList();
  refreshContentAccess();
  loadProbe();
}

// --- Save ---

/** Split a textarea into trimmed, non-empty, lowercased lines. */
function parseLines(text) {
  return (text || '')
    .split('\n')
    .map(l => l.trim().toLowerCase().replace(/^\.+/, ''))
    .filter(Boolean);
}

function parseRules(text) {
  return text
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => {
      const eq = l.indexOf('=');
      if (eq === -1) return null;
      const match = l.slice(0, eq).trim().toLowerCase();
      const label = l.slice(eq + 1).trim();
      return match && label ? { match, label } : null;
    })
    .filter(Boolean);
}

btnSave.addEventListener('click', async () => {
  const settings = {
    groupingMode: fields.groupingMode.value === 'auto' ? 'auto' : 'manual',
    aiProjectMode: fields.aiProjectMode.checked,
    aiMergePass: fields.aiMergePass.checked,
    readPageContent: fields.readPageContent.checked,
    collapseInactive: fields.collapseInactive.checked,
    respectManualGroups: fields.respectManualGroups.checked,
    minGroupSize: Math.max(1, parseInt(fields.minGroupSize.value, 10) || 1),
    miscLabel: fields.miscLabel.value.trim() || 'Other',
    useOpenerAffinity: fields.useOpenerAffinity.checked,
    subdomainStrategy: fields.subdomainStrategy.value,
    subdomainScope: fields.subdomainScope.value === 'all' ? 'all' : 'internal',
    internalDomains: parseLines(fields.internalDomains.value),
    clusterServiceTokens: parseLines(fields.clusterServiceTokens.value),
    // Pattern rules first (more specific) so they win, then substring rules.
    pinnedRules: [...advancedRules, ...parseRules(fields.pinnedRules.value)],
  };
  await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings });
  showToast('Settings saved!');
});

btnReset.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'RESET_SETTINGS' });
  await loadSettings();
  showToast('Reset to defaults!');
});

// --- Learned tasks ---

const memoryListEl = document.getElementById('memory-list');
const btnRefreshMemory = document.getElementById('btn-refresh-memory');
const btnClearMemory = document.getElementById('btn-clear-memory');

/**
 * Group a task's raw feature keys into the kinds worth showing separately.
 *
 * Tickets and pages are both decisive identities, but they read completely
 * differently: "SASOBD-603" tells you what it is, while a generated page id is
 * a meaningless number unless you know it only ever matches that one page.
 * Lumping them together made the list look like it was full of noise.
 */
function groupSignals(features) {
  const out = { ticket: [], page: [], word: [], tag: [] };
  for (const key of features || []) {
    const kind = key.slice(0, key.indexOf(':'));
    const value = key.slice(key.indexOf(':') + 1);
    if (kind === 'ref') out.ticket.push([key, value, value]);
    else if (kind === 'opaque' || kind === 'item') {
      // Namespaced as host/id — show the id, keep the host for the tooltip.
      const slash = value.lastIndexOf('/');
      const host = slash === -1 ? '' : value.slice(0, slash);
      const id = slash === -1 ? value : value.slice(slash + 1);
      out.page.push([key, id, host]);
    } else if (kind === 'word') out.word.push([key, value, value]);
    else out.tag.push([key, value, value]);
  }
  return out;
}

const SIGNAL_KINDS = [
  ['ticket', 'tickets', 'A ticket or pull request. Decisive on its own.'],
  ['page', 'pages', 'One specific page or document. It only ever matches that exact page, '
    + 'so the number means nothing on its own — and it is safe to remove if you would '
    + 'rather this task were recognized by its words.'],
  ['word', 'words', 'A distinctive word. Several must agree before they match.'],
  ['tag', 'tags', 'A bracketed label from a title, such as an environment or region. '
    + 'Weak: it can support a match but never make one.'],
];

function renderMemory(tasks) {
  memoryListEl.innerHTML = '';
  if (!tasks || tasks.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'mem-empty';
    empty.textContent = 'Nothing learned yet. Rename a group, or drag a tab into one, '
      + 'and it will show up here.';
    memoryListEl.appendChild(empty);
    return;
  }

  const edit = async (body) => {
    const r = await chrome.runtime.sendMessage({ type: 'EDIT_TASK', ...body });
    renderMemory(r.tasks);
  };

  for (const t of tasks) {
    const row = document.createElement('div');
    row.className = 'mem-row';

    // --- header: name, provenance, and the whole-task actions ---
    const head = document.createElement('div');
    head.className = 'mem-head';

    const name = document.createElement('span');
    name.className = 'mem-name';
    name.textContent = t.label;
    head.appendChild(name);

    if (t.userNamed) {
      const badge = document.createElement('span');
      badge.className = 'mem-badge';
      badge.textContent = 'your name';
      head.appendChild(badge);
    }

    const spacer = document.createElement('span');
    spacer.className = 'mem-facts';
    spacer.textContent = `${t.hits || 0} sighting${t.hits === 1 ? '' : 's'}`;
    head.appendChild(spacer);

    const rename = document.createElement('button');
    rename.className = 'btn';
    rename.textContent = 'Rename';
    rename.addEventListener('click', () => {
      const next = prompt(`Rename "${t.label}" to:`, t.label);
      if (next && next.trim() && next.trim() !== t.label) {
        edit({ label: t.label, action: 'rename', newLabel: next.trim() });
      }
    });
    head.appendChild(rename);

    const forget = document.createElement('button');
    forget.className = 'btn danger';
    forget.textContent = 'Forget';
    forget.addEventListener('click', async () => {
      const r = await chrome.runtime.sendMessage({ type: 'FORGET_TASK', label: t.label });
      renderMemory(r.tasks);
      showToast(`Forgot "${t.label}".`);
    });
    head.appendChild(forget);
    row.appendChild(head);

    // --- the signals themselves, each removable ---
    const signals = groupSignals(t.features);
    const sig = document.createElement('div');
    sig.className = 'mem-sig';

    for (const [kind, heading, help] of SIGNAL_KINDS) {
      if (signals[kind].length === 0) continue;
      const group = document.createElement('div');
      group.className = 'sig-group';

      const label = document.createElement('span');
      label.className = 'sig-label';
      label.textContent = heading;
      label.title = help;
      group.appendChild(label);

      for (const [key, shown, context] of signals[kind]) {
        const chip = document.createElement('span');
        chip.className = `chip ${kind === 'ticket' || kind === 'page' ? 'id' : kind === 'word' ? 'word' : 'place'}`;
        chip.append(document.createTextNode(shown));
        chip.title = kind === 'page' && context
          ? `Matches only this page on ${context}`
          : help;

        const x = document.createElement('button');
        x.textContent = '×';
        x.title = 'Remove this signal, and never learn it again';
        x.addEventListener('click', () => edit({ label: t.label, action: 'remove', feature: key }));
        chip.appendChild(x);
        group.appendChild(chip);
      }
      sig.appendChild(group);
    }
    row.appendChild(sig);

    // --- add a word by hand ---
    const add = document.createElement('div');
    add.className = 'sig-add';
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'add a word this task is about…';
    const go = document.createElement('button');
    go.className = 'btn';
    go.textContent = 'Add';
    const submit = () => {
      const text = input.value.trim();
      if (text) edit({ label: t.label, action: 'add', text });
    };
    go.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    add.append(input, go);
    row.appendChild(add);

    memoryListEl.appendChild(row);
  }
}

async function loadMemoryList() {
  const r = await chrome.runtime.sendMessage({ type: 'GET_MEMORY' });
  renderMemory(r && r.tasks);
}

btnRefreshMemory.addEventListener('click', loadMemoryList);
const btnResetProfiles = document.getElementById('btn-reset-profiles');
btnResetProfiles.addEventListener('click', async () => {
  const r = await chrome.runtime.sendMessage({ type: 'RESET_PROFILES' });
  renderMemory(r.tasks);
  showToast('Forgot every profile. Your names and filed pages are kept.');
});

btnClearMemory.addEventListener('click', async () => {
  const r = await chrome.runtime.sendMessage({ type: 'CLEAR_MEMORY' });
  renderMemory(r.tasks);
  showToast('Forgot every learned task.');
});

// --- On-device AI capabilities ---

const aiProbeEl = document.getElementById('ai-probe');
const btnProbe = document.getElementById('btn-probe');

function renderProbe(r) {
  aiProbeEl.innerHTML = '';
  if (!r || !r.apis) {
    aiProbeEl.innerHTML = '<div class="mem-empty">Could not read AI capabilities.</div>';
    return;
  }

  for (const a of r.apis) {
    const row = document.createElement('div');
    row.className = 'mem-row';

    const name = document.createElement('span');
    name.className = 'mem-name';
    name.textContent = a.name;
    row.appendChild(name);

    const state = document.createElement('span');
    state.className = 'mem-badge';
    state.textContent = a.present ? a.availability : 'absent';
    if (!a.present) {
      state.style.color = '#6a6a8a';
      state.style.borderColor = '#2a2a4a';
      state.style.background = '#1a1a2e';
    } else if (a.availability !== 'available') {
      state.style.color = '#f5c86a';
      state.style.borderColor = '#5a4a2a';
      state.style.background = '#2a2418';
    }
    row.appendChild(state);

    if (a.usedByThisExtension) {
      const used = document.createElement('span');
      used.className = 'mem-badge';
      used.textContent = 'in use';
      used.style.color = '#7fb2ff';
      used.style.borderColor = '#24406b';
      used.style.background = '#16203a';
      row.appendChild(used);
    }

    const purpose = document.createElement('span');
    purpose.className = 'mem-facts';
    purpose.textContent = a.purpose;
    purpose.title = a.via ? `Exposed as ${a.via}` : a.purpose;
    row.appendChild(purpose);

    aiProbeEl.appendChild(row);
  }

  const foot = document.createElement('div');
  foot.className = 'mem-empty';
  const p = r.promptParams;
  foot.textContent = `Chrome ${r.chrome}. `
    + (p
      ? `Prompt API sampling: topK up to ${p.maxTopK} (default ${p.defaultTopK}), `
        + `temperature up to ${p.maxTemperature} (default ${p.defaultTemperature}).`
      : 'Prompt API sampling limits not reported by this build.');
  aiProbeEl.appendChild(foot);
}

async function loadProbe() {
  const r = await chrome.runtime.sendMessage({ type: 'AI_PROBE' });
  renderProbe(r);
}

btnProbe.addEventListener('click', loadProbe);

const btnRefreshAi = document.getElementById('btn-refresh-ai');
btnRefreshAi.addEventListener('click', async () => {
  btnRefreshAi.disabled = true;
  await chrome.runtime.sendMessage({ type: 'REFRESH_AI_CONTEXT' });
  btnRefreshAi.disabled = false;
  showToast('Model session reset and cached page summaries cleared.');
});

// --- Page access ---

// chrome.permissions.request() only works inside a user gesture, so it is
// called here in the click handler rather than routed through the service
// worker, where it would silently fail.
const CONTENT_PERMISSIONS = { permissions: ['scripting'], origins: ['<all_urls>'] };

const btnContentAccess = document.getElementById('btn-content-access');
const contentAccessHint = document.getElementById('content-access-hint');

async function refreshContentAccess() {
  let granted = false;
  try {
    granted = await chrome.permissions.contains(CONTENT_PERMISSIONS);
  } catch { /* treat as not granted */ }

  contentAccessHint.textContent = granted
    ? 'Granted. Page summaries are read when grouping.'
    : 'Not granted. Grouping uses tab titles and URLs only.';
  contentAccessHint.style.color = granted ? '#7ee0a8' : '#6a6a8a';
  btnContentAccess.textContent = granted ? 'Revoke access' : 'Grant access';
  btnContentAccess.classList.toggle('danger', granted);
  fields.readPageContent.disabled = !granted;
  return granted;
}

btnContentAccess.addEventListener('click', async () => {
  const granted = await chrome.permissions.contains(CONTENT_PERMISSIONS).catch(() => false);
  if (granted) {
    await chrome.runtime.sendMessage({ type: 'REVOKE_CONTENT_ACCESS' });
    showToast('Page access revoked and cached content cleared.');
  } else {
    let ok = false;
    try {
      ok = await chrome.permissions.request(CONTENT_PERMISSIONS);
    } catch { ok = false; }
    showToast(ok ? 'Page access granted.' : 'Page access not granted.');
  }
  await refreshContentAccess();
});

// --- Capture a grouping problem as a test case ---

const btnCapture = document.getElementById('btn-capture');
const captureJson = document.getElementById('capture-json');

btnCapture.addEventListener('click', async () => {
  const r = await chrome.runtime.sendMessage({ type: 'CAPTURE_FIXTURE' });
  if (!r || !r.fixture) {
    showToast('Could not read the tabs.');
    return;
  }
  captureJson.value = JSON.stringify(r.fixture, null, 2);
  captureJson.focus();
  captureJson.select();
  showToast(`Captured ${r.fixture.tabs.length} tabs — review before sharing.`);
});

// --- Import / Export (runtime overrides) ---

const configJson = document.getElementById('config-json');
const btnImport = document.getElementById('btn-import');
const btnExport = document.getElementById('btn-export');

btnExport.addEventListener('click', async () => {
  const s = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
  configJson.value = JSON.stringify(s, null, 2);
  showToast('Exported current settings.');
});

btnImport.addEventListener('click', async () => {
  let parsed;
  try {
    parsed = JSON.parse(configJson.value);
  } catch {
    showToast('Invalid JSON.');
    return;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    showToast('Expected a settings object.');
    return;
  }
  // Keys starting with '_' are comments (see examples/example.json) — drop them
  // so they aren't persisted as settings and echoed back out by Export.
  const settings = Object.fromEntries(
    Object.entries(parsed).filter(([k]) => !k.startsWith('_')),
  );
  await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings });
  await loadSettings();
  showToast('Imported settings.');
});

// --- AI status + prepare ---

const AI_STATUS_TEXT = {
  available: ['Ready', '#2ecc71', 'On-device model is ready to group tabs.'],
  downloadable: ['Downloads on first use', '#f39c12', 'Click "Prepare AI" to download the model now.'],
  downloading: ['Downloading…', '#f39c12', 'The on-device model is downloading.'],
  unavailable: ['Unavailable', '#ff6b6b', 'On-device AI is not available on this device.'],
  'no-api': ['Needs Chrome 138+', '#ff6b6b', 'The Prompt API is not present. Update Chrome and enable the on-device model.'],
};

async function refreshAiStatus() {
  try {
    const { status } = await chrome.runtime.sendMessage({ type: 'AI_STATUS' });
    const [label, color, hint] = AI_STATUS_TEXT[status] || AI_STATUS_TEXT.unavailable;
    aiStatusBadge.textContent = label;
    aiStatusBadge.style.color = color;
    aiStatusHint.textContent = hint;
    btnPrepare.disabled = (status === 'available' || status === 'unavailable' || status === 'no-api');
  } catch {
    aiStatusBadge.textContent = 'Unknown';
    aiStatusHint.textContent = 'Could not query AI status.';
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'AI_DOWNLOAD_PROGRESS') {
    progressWrap.style.display = 'block';
    const pct = Math.round((msg.loaded || 0) * 100);
    progressBar.style.width = `${pct}%`;
    aiStatusHint.textContent = `Downloading model… ${pct}%`;
  }
});

btnPrepare.addEventListener('click', async () => {
  btnPrepare.disabled = true;
  btnPrepare.textContent = 'Preparing…';
  progressWrap.style.display = 'block';
  progressBar.style.width = '0%';

  const res = await chrome.runtime.sendMessage({ type: 'PREPARE_AI' });

  btnPrepare.textContent = 'Prepare AI';
  if (res && res.ok) {
    progressBar.style.width = '100%';
    showToast('AI model ready!');
  } else {
    aiStatusHint.textContent = 'Could not prepare model. Check Wi-Fi / disk space.';
  }
  refreshAiStatus();
  loadMemoryList();
  refreshContentAccess();
  loadProbe();
});

// --- Helpers ---

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2000);
}

loadSettings();
