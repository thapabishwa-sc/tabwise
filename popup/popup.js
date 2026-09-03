// --- DOM refs ---
const aiBadge = document.getElementById('ai-badge');
const btnSettings = document.getElementById('btn-settings');
const btnOrganize = document.getElementById('btn-organize');
const btnUngroup = document.getElementById('btn-ungroup');
const statusEl = document.getElementById('status');
const groupsEl = document.getElementById('groups');

const aiPrepareBox = document.getElementById('ai-prepare');
const aiPrepareText = document.getElementById('ai-prepare-text');
const btnPrepareAi = document.getElementById('btn-prepare-ai');
const aiProgressWrap = document.getElementById('ai-progress-wrap');
const aiProgressBar = document.getElementById('ai-progress-bar');

const nlInput = document.getElementById('nl-input');
const btnNl = document.getElementById('btn-nl');
const btnTask = document.getElementById('btn-task');
const searchInput = document.getElementById('search');
const btnSessions = document.getElementById('btn-sessions');
const sessionsPanel = document.getElementById('sessions-panel');
const sessionName = document.getElementById('session-name');
const btnSaveSession = document.getElementById('btn-save-session');
const sessionListEl = document.getElementById('session-list');

let currentSnapshot = { groups: [], ungrouped: [], totalTabs: 0 };

// =============================================
// INIT + RENDER
// =============================================

async function init() {
  currentSnapshot = await chrome.runtime.sendMessage({ type: 'GET_SNAPSHOT' })
    || { groups: [], ungrouped: [], totalTabs: 0 };
  renderGroups();
  refreshAiBadge();
}

function renderGroups() {
  const { groups = [], ungrouped = [] } = currentSnapshot;
  groupsEl.innerHTML = '';

  if (groups.length === 0 && ungrouped.length === 0) {
    groupsEl.innerHTML = '<div class="empty-state">No tabs to show.</div>';
    return;
  }

  for (const g of groups) {
    groupsEl.appendChild(groupCard(g.id, g.title, g.color || 'grey', g.tabs, g.lastActive));
  }
  if (ungrouped.length > 0) {
    groupsEl.appendChild(groupCard(null, `Ungrouped (${ungrouped.length})`, 'grey', ungrouped));
  }
  applyFilter();
}

// =============================================
// SEARCH / QUICK-SWITCHER
// =============================================

function applyFilter() {
  const q = (searchInput.value || '').trim().toLowerCase();
  for (const card of groupsEl.querySelectorAll('.group')) {
    const headerTitle = (card.querySelector('.group-title')?.textContent || '').toLowerCase();
    let visible = 0;
    for (const row of card.querySelectorAll('.tab-row')) {
      const text = (row.textContent + ' ' + (row.title || '')).toLowerCase();
      const match = !q || text.includes(q) || headerTitle.includes(q);
      row.style.display = match ? '' : 'none';
      if (match) visible++;
    }
    const show = !q || visible > 0 || headerTitle.includes(q);
    card.style.display = show ? '' : 'none';
    if (q && visible > 0) card.classList.add('open');
  }
}

searchInput.addEventListener('input', applyFilter);
searchInput.addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter') return;
  const firstRow = [...groupsEl.querySelectorAll('.tab-row')].find(r => r.style.display !== 'none');
  if (firstRow) {
    await chrome.runtime.sendMessage({ type: 'FOCUS_TAB', tabId: Number(firstRow.dataset.tabId) });
    window.close();
  }
});

function groupCard(groupId, title, color, tabs, lastActive) {
  const card = document.createElement('div');
  card.className = 'group';

  // --- header ---
  const header = document.createElement('div');
  header.className = 'group-header';

  const dot = document.createElement('span');
  dot.className = `dot c-${color}`;

  const titleEl = document.createElement('span');
  titleEl.className = 'group-title';
  titleEl.textContent = title;

  const count = document.createElement('span');
  count.className = 'group-count';
  count.textContent = tabs.length;

  header.append(dot, titleEl);
  if (lastActive) {
    const when = document.createElement('span');
    when.className = 'group-when';
    when.textContent = relativeTime(lastActive);
    when.title = `Last used ${new Date(lastActive).toLocaleString()}`;
    header.append(when);
  }

  // Inline rename + move-to-window (real groups only)
  if (groupId != null) {
    const edit = document.createElement('button');
    edit.className = 'icon-btn';
    edit.title = 'Rename group';
    edit.textContent = '✎';
    edit.addEventListener('click', (e) => {
      e.stopPropagation();
      startRename(groupId, titleEl, title);
    });

    const toWindow = document.createElement('button');
    toWindow.className = 'icon-btn';
    toWindow.title = 'Move group to a new window';
    toWindow.textContent = '⤢';
    toWindow.addEventListener('click', async (e) => {
      e.stopPropagation();
      await chrome.runtime.sendMessage({ type: 'MOVE_GROUP_TO_WINDOW', groupId });
      await init();
    });

    header.append(edit, toWindow);
  }

  header.append(count);
  header.addEventListener('click', () => card.classList.toggle('open'));
  card.appendChild(header);

  // --- tab list ---
  const list = document.createElement('div');
  list.className = 'tab-list';
  for (const t of tabs) list.appendChild(tabRow(t, title));
  card.appendChild(list);

  return card;
}

/** "3m", "2h", "4d" — compact enough to sit in a group header. */
function relativeTime(ts) {
  const secs = Math.max(0, (Date.now() - ts) / 1000);
  if (secs < 90) return 'now';
  const mins = secs / 60;
  if (mins < 60) return `${Math.round(mins)}m`;
  const hours = mins / 60;
  if (hours < 24) return `${Math.round(hours)}h`;
  const days = hours / 24;
  if (days < 7) return `${Math.round(days)}d`;
  return `${Math.round(days / 7)}w`;
}

/**
 * Short label for why a tab is in its group. The long form goes in the
 * tooltip; the badge has to fit on one line next to the title.
 */
const VIA_TEXT = {
  trail: 'link trail',
  key: 'same work item',
  topic: 'same subject',
  alone: '',
};

const REASON_BADGE = {
  pin: 'you',
  rule: 'rule',
  internal: 'host',
  learned: 'learned',
  ai: 'AI',
  summary: 'titles',
  host: 'site',
  misc: 'leftover',
};

function whyBadge(t) {
  if (!t.reason) return null;
  const badge = document.createElement('span');
  // An AI guess is the one worth double-checking, so it is the one marked.
  badge.className = `why why-${t.reason}`;
  const via = VIA_TEXT[t.via] || '';
  badge.textContent = REASON_BADGE[t.reason] || t.reason;
  badge.title = [t.reasonText, via && `joined by ${via}`].filter(Boolean).join(' · ');
  return badge;
}

function tabRow(t, currentGroupTitle) {
  const row = document.createElement('div');
  row.className = 'tab-row';
  row.dataset.tabId = t.id;

  const icon = document.createElement('img');
  if (t.favIconUrl) {
    icon.src = t.favIconUrl;
    icon.onerror = () => { icon.style.visibility = 'hidden'; };
  } else {
    icon.style.visibility = 'hidden';
  }

  const titleSpan = document.createElement('span');
  titleSpan.className = 'tab-title';
  titleSpan.textContent = (t.pinned ? '📌 ' : '') + (t.title || t.url);
  row.title = t.url;

  row.append(icon, titleSpan);

  const badge = whyBadge(t);
  if (badge) row.append(badge);

  // Move control — not for pinned tabs (Chrome can't group them).
  if (!t.pinned) {
    const move = document.createElement('button');
    move.className = 'icon-btn move-btn';
    move.title = 'Move to another group';
    move.textContent = '↪';
    move.addEventListener('click', (e) => {
      e.stopPropagation();
      showMovePicker(row, t.id, currentGroupTitle);
    });
    row.append(move);
  }

  row.addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'FOCUS_TAB', tabId: t.id });
    window.close();
  });
  return row;
}

// =============================================
// RENAME / MOVE
// =============================================

function startRename(groupId, titleEl, oldTitle) {
  const input = document.createElement('input');
  input.className = 'rename-input';
  input.value = oldTitle;
  titleEl.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const commit = async (save) => {
    if (done) return;
    done = true;
    const next = input.value.trim();
    if (save && next && next !== oldTitle) {
      await chrome.runtime.sendMessage({ type: 'RENAME_GROUP', groupId, title: next });
    }
    await init();
  };
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') commit(true);
    if (e.key === 'Escape') commit(false);
  });
  input.addEventListener('blur', () => commit(true));
}

function showMovePicker(row, tabId, currentGroupTitle) {
  // Avoid duplicate pickers
  if (row.querySelector('.move-select')) return;

  const select = document.createElement('select');
  select.className = 'move-select';
  select.addEventListener('click', (e) => e.stopPropagation());

  const opts = [['', 'Move to…']];
  for (const g of currentSnapshot.groups) {
    if (g.title !== currentGroupTitle) opts.push([g.title, g.title]);
  }
  opts.push(['__new__', '＋ New group…']);
  if (currentGroupTitle && !currentGroupTitle.startsWith('Ungrouped')) {
    opts.push(['__ungroup__', 'Ungroup']);
  }
  for (const [value, label] of opts) {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    select.appendChild(o);
  }

  select.addEventListener('change', async () => {
    let label = select.value;
    if (!label) return;
    if (label === '__new__') {
      const name = (window.prompt('New group name:') || '').trim();
      if (!name) { select.remove(); return; }
      label = name;
    }
    await chrome.runtime.sendMessage({ type: 'MOVE_TAB', tabId, label });
    await init();
  });

  row.append(select);
  select.focus();
}

// =============================================
// ACTIONS
// =============================================

btnOrganize.addEventListener('click', async () => {
  btnOrganize.disabled = true;
  btnOrganize.textContent = 'Grouping…';
  statusEl.textContent = '';
  const res = await chrome.runtime.sendMessage({ type: 'ORGANIZE_ALL' });
  btnOrganize.disabled = false;
  btnOrganize.textContent = 'Group all tabs';

  if (res && res.mode === 'fallback') {
    statusEl.textContent = `AI not ready — grouped ${res.organized} by site. Prepare AI below for topic grouping.`;
  } else if (res && typeof res.organized === 'number') {
    statusEl.textContent = `Grouped ${res.organized} tab${res.organized === 1 ? '' : 's'}.`;
  }
  await init();
});

btnUngroup.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'UNGROUP_ALL' });
  statusEl.textContent = '';
  await init();
});

btnSettings.addEventListener('click', () => chrome.runtime.openOptionsPage());

// =============================================
// NATURAL-LANGUAGE GROUPING
// =============================================

async function runNlGroup() {
  const instruction = nlInput.value.trim();
  if (!instruction) return;
  btnNl.disabled = true;
  btnNl.textContent = '…';
  statusEl.textContent = 'Grouping with AI…';

  const res = await chrome.runtime.sendMessage({ type: 'NL_GROUP', instruction });

  btnNl.disabled = false;
  btnNl.textContent = 'Go';
  if (res && res.error === 'ai-unavailable') {
    statusEl.textContent = 'AI model not ready yet — prepare it below first.';
  } else if (res && typeof res.organized === 'number') {
    statusEl.textContent = `Regrouped ${res.organized} tab${res.organized === 1 ? '' : 's'}.`;
    nlInput.value = '';
  }
  await init();
}

btnNl.addEventListener('click', runNlGroup);
nlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') runNlGroup(); });

// Capture the loose (ungrouped) tabs into a named task group.
btnTask.addEventListener('click', async () => {
  const name = (window.prompt('Name this task group:') || '').trim();
  if (!name) return;
  const res = await chrome.runtime.sendMessage({ type: 'TASK_GROUP', name });
  if (res && res.grouped > 0) {
    statusEl.textContent = `Grouped ${res.grouped} loose tab${res.grouped === 1 ? '' : 's'} into “${name}”.`;
  } else {
    statusEl.textContent = 'No ungrouped tabs to capture.';
  }
  await init();
});

// =============================================
// SESSIONS
// =============================================

btnSessions.addEventListener('click', async () => {
  const showing = sessionsPanel.style.display !== 'none';
  sessionsPanel.style.display = showing ? 'none' : 'block';
  btnSessions.classList.toggle('active', !showing);
  if (!showing) await loadSessions();
});

async function loadSessions() {
  const { sessions = [] } = await chrome.runtime.sendMessage({ type: 'GET_SESSIONS' });
  sessionListEl.innerHTML = '';
  if (sessions.length === 0) {
    sessionListEl.innerHTML = '<div class="empty-state" style="padding:10px 0">No saved sessions.</div>';
    return;
  }
  sessions.forEach((s, index) => {
    const row = document.createElement('div');
    row.className = 'session-row';

    const label = document.createElement('span');
    label.className = 'session-label';
    label.textContent = `${s.name} (${s.tabs.length})`;
    label.title = `Saved ${new Date(s.createdAt).toLocaleString()}`;

    const restore = document.createElement('button');
    restore.className = 'icon-btn';
    restore.textContent = '⮌';
    restore.title = 'Restore in a new window';
    restore.addEventListener('click', async () => {
      await chrome.runtime.sendMessage({ type: 'RESTORE_SESSION', index });
      window.close();
    });

    const del = document.createElement('button');
    del.className = 'icon-btn';
    del.textContent = '🗑';
    del.title = 'Delete session';
    del.addEventListener('click', async () => {
      await chrome.runtime.sendMessage({ type: 'DELETE_SESSION', index });
      await loadSessions();
    });

    row.append(label, restore, del);
    sessionListEl.appendChild(row);
  });
}

btnSaveSession.addEventListener('click', async () => {
  const name = sessionName.value.trim();
  if (!name) { sessionName.focus(); return; }
  const res = await chrome.runtime.sendMessage({ type: 'SAVE_SESSION', name });
  sessionName.value = '';
  statusEl.textContent = `Saved session “${name}” (${res?.saved ?? 0} tabs).`;
  await loadSessions();
});

// =============================================
// AI STATUS + MODEL DOWNLOAD
// =============================================

const AI_BADGE = {
  available: ['AI ready', '#2ecc71', 'On-device AI is ready to group tabs.'],
  downloadable: ['AI ⬇', '#f39c12', 'Model needs downloading.'],
  downloading: ['AI ⬇', '#f39c12', 'Model is downloading…'],
  unavailable: ['AI n/a', '#ff6b6b', 'On-device AI unavailable on this device.'],
  'no-api': ['AI n/a', '#ff6b6b', 'Prompt API missing — needs Chrome 138+.'],
};

async function refreshAiBadge() {
  aiPrepareBox.style.display = 'none';
  try {
    const { status } = await chrome.runtime.sendMessage({ type: 'AI_STATUS' });
    const [label, color, title] = AI_BADGE[status] || AI_BADGE.unavailable;
    aiBadge.textContent = label;
    aiBadge.style.color = color;
    aiBadge.title = title;

    if (status === 'downloadable' || status === 'downloading') {
      aiPrepareBox.style.display = 'block';
      aiPrepareText.textContent = status === 'downloading'
        ? 'On-device AI model is downloading…'
        : 'On-device AI model not downloaded yet.';
    }
  } catch {
    aiBadge.textContent = 'AI';
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'AI_DOWNLOAD_PROGRESS') {
    aiProgressWrap.style.display = 'block';
    const pct = Math.round((msg.loaded || 0) * 100);
    aiProgressBar.style.width = `${pct}%`;
    aiPrepareText.textContent = `Downloading model… ${pct}%`;
  }
});

btnPrepareAi.addEventListener('click', async () => {
  btnPrepareAi.disabled = true;
  btnPrepareAi.textContent = 'Preparing…';
  aiProgressWrap.style.display = 'block';
  aiProgressBar.style.width = '0%';
  aiPrepareText.textContent = 'Starting download…';

  const res = await chrome.runtime.sendMessage({ type: 'PREPARE_AI' });

  btnPrepareAi.disabled = false;
  btnPrepareAi.textContent = 'Prepare AI';
  if (res && res.ok) {
    aiProgressBar.style.width = '100%';
    aiPrepareText.textContent = 'AI model ready!';
    setTimeout(refreshAiBadge, 1200);
  } else {
    aiPrepareText.textContent = 'Could not prepare model. Check Wi-Fi / disk space.';
  }
});

init();
