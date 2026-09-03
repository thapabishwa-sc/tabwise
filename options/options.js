const fields = {
  groupingMode: document.getElementById('groupingMode'),
  aiProjectMode: document.getElementById('aiProjectMode'),
  collapseInactive: document.getElementById('collapseInactive'),
  respectManualGroups: document.getElementById('respectManualGroups'),
  minGroupSize: document.getElementById('minGroupSize'),
  miscLabel: document.getElementById('miscLabel'),
  useOpenerAffinity: document.getElementById('useOpenerAffinity'),
  subdomainStrategy: document.getElementById('subdomainStrategy'),
  subdomainScope: document.getElementById('subdomainScope'),
  internalDomains: document.getElementById('internalDomains'),
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
  fields.collapseInactive.checked = !!s.collapseInactive;
  fields.useOpenerAffinity.checked = s.useOpenerAffinity !== false;
  fields.respectManualGroups.checked = s.respectManualGroups !== false;
  fields.minGroupSize.value = s.minGroupSize || 2;
  fields.miscLabel.value = s.miscLabel || 'Other';
  // Preserve a non-standard strategy applied via Import (e.g. 'prefix')
  // so it shows in the dropdown and isn't clobbered on Save.
  const strat = s.subdomainStrategy || 'subdomain';
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
  // Textarea manages only simple substring rules; keep pattern rules aside.
  const allRules = s.pinnedRules || [];
  advancedRules = allRules.filter(r => r.pattern);
  fields.pinnedRules.value = allRules
    .filter(r => !r.pattern && r.match)
    .map(r => `${r.match} = ${r.label}`)
    .join('\n');
  refreshAiStatus();
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
    collapseInactive: fields.collapseInactive.checked,
    respectManualGroups: fields.respectManualGroups.checked,
    minGroupSize: Math.max(1, parseInt(fields.minGroupSize.value, 10) || 1),
    miscLabel: fields.miscLabel.value.trim() || 'Other',
    useOpenerAffinity: fields.useOpenerAffinity.checked,
    subdomainStrategy: fields.subdomainStrategy.value,
    subdomainScope: fields.subdomainScope.value === 'all' ? 'all' : 'internal',
    internalDomains: parseLines(fields.internalDomains.value),
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
});

// --- Helpers ---

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2000);
}

loadSettings();
