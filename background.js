/**
 * Background service worker — event hub for AI Tab Grouper.
 *
 * Listens for tab create/navigate events and groups each tab by the work it
 * serves (lib/resolve.js), and routes messages from the popup and options page.
 */

import {
  organizeAllTabs,
  organizeLooseTabs,
  autoGroupTab,
  ungroupAll,
  getGroupsSnapshot,
  collapseInactiveGroups,
  foldOthers,
  renameGroup,
  moveTab,
  moveGroupToWindow,
  organizeByInstruction,
  captureTaskGroup,
  snapshotSession,
  restoreSession,
  captureFixture,
  isBusy,
  getReasons,
  reasonText,
  noteTabOrigin,
  forgetTabOrigin,
} from './lib/tabManager.js';
import {
  getSettings,
  saveSettings,
  resetSettings,
  invalidateCache,
  getSessions,
  deleteSession,
} from './lib/storage.js';
import { checkAvailability, resetSession, prepareModel } from './lib/aiGrouper.js';
import { probeAi } from './lib/aiProbe.js';
import {
  loadMemory, updateMemory, clearMemory, forgetTask, listTasks,
  invalidateMemoryCache,
} from './lib/taskMemory.js';
import {
  hasContentAccess, revokeContentAccess, forgetContent, clearContentCache,
} from './lib/pageContent.js';

// --- Debounce: wait for a tab to settle before grouping it ---
const pendingUpdates = new Map();
const DEBOUNCE_MS = 600;

function debounceTabUpdate(tabId) {
  if (pendingUpdates.has(tabId)) clearTimeout(pendingUpdates.get(tabId));
  pendingUpdates.set(tabId, setTimeout(async () => {
    pendingUpdates.delete(tabId);
    await processTabUpdate(tabId);
  }, DEBOUNCE_MS));
}

async function processTabUpdate(tabId) {
  if (isBusy()) return;
  try {
    const settings = await getSettings();
    if (settings.groupingMode !== 'auto') return; // manual mode: don't auto-group
    await autoGroupTab(tabId);
  } catch {
    // Tab closed before we could process it
  }
}

// --- Tab events ---

// A tab is grouped only once it can say what it is.
//
// Grouping on creation, or on the first URL change, meant deciding before the
// page had a title — so a tab was placed on its hostname alone, which is the
// one signal this whole project exists to stop grouping by. It looked like the
// tab "jumping into" whatever group was nearby. A tab now stays ungrouped,
// visibly loose, until it has loaded enough to be judged.
chrome.tabs.onCreated.addListener((tab) => {
  // Remember whether this tab began life following a link. A tab opened blank
  // (Ctrl+T, the new-tab button) still carries openerTabId pointing at whatever
  // happened to be focused, and inheriting that tab's group is wrong: nothing
  // was followed, the address was typed.
  const followedALink = !!tab.url && /^https?:\/\//i.test(tab.url);
  noteTabOrigin(tab.id, followedALink);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // A navigation invalidates whatever was read from the old page.
  if (changeInfo.url) forgetContent(tabId);
  // 'complete' means the page has loaded; a title change means it has told us
  // what it is. Either is enough to judge it; a bare URL change is not.
  if (changeInfo.status === 'complete' || changeInfo.title) debounceTabUpdate(tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (pendingUpdates.has(tabId)) {
    clearTimeout(pendingUpdates.get(tabId));
    pendingUpdates.delete(tabId);
  }
  forgetTabOrigin(tabId);
  forgetContent(tabId);
});

// --- Accordion: collapse groups that lose focus as you switch tabs ---

async function maybeAccordion(windowId) {
  if (isBusy() || windowId == null || windowId < 0) return;
  try {
    const settings = await getSettings();
    if (settings.collapseInactive) await collapseInactiveGroups(windowId);
  } catch { /* noop */ }
}

chrome.tabs.onActivated.addListener(({ windowId }) => { maybeAccordion(windowId); });
chrome.windows.onFocusChanged.addListener((windowId) => { maybeAccordion(windowId); });

// Also fold others when a group is expanded by clicking its header. We only
// react to expansion (collapsed === false); the resulting collapses fire
// onUpdated with collapsed === true and are ignored, so there's no loop.
chrome.tabGroups.onUpdated.addListener(async (group) => {
  if (isBusy() || group.collapsed) return;
  try {
    const settings = await getSettings();
    if (settings.collapseInactive) await foldOthers(group.windowId, group.id);
  } catch { /* noop */ }
});

// --- Keyboard command ---

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'organize-all') await organizeAllTabs();
});

// --- Messages from popup / options ---

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message).then(sendResponse);
  return true; // async response
});

async function handleMessage(message) {
  switch (message.type) {
    case 'GET_SNAPSHOT': {
      const snapshot = await getGroupsSnapshot(message.windowId);
      // Attach the explanation for each tab so the popup can say why a tab is
      // where it is, and offer to fix it when the answer is wrong.
      const reasons = await getReasons();
      for (const g of snapshot.groups) {
        for (const t of g.tabs) {
          const r = reasons[t.id];
          if (r && r.label === g.title) {
            t.reason = r.reason;
            t.via = r.via;
            t.reasonText = reasonText(r.reason);
          }
        }
      }
      return snapshot;
    }

    case 'CONTENT_ACCESS':
      return { granted: await hasContentAccess() };

    case 'REVOKE_CONTENT_ACCESS': {
      await revokeContentAccess();
      return { granted: await hasContentAccess() };
    }

    case 'CLEAR_CONTENT_CACHE':
      await clearContentCache();
      return { ok: true };

    case 'GET_MEMORY':
      return { tasks: listTasks(await loadMemory()) };

    case 'FORGET_TASK': {
      const m = await updateMemory((mem) => forgetTask(mem, message.label));
      return { tasks: listTasks(m) };
    }

    case 'CLEAR_MEMORY': {
      invalidateMemoryCache();
      const m = await clearMemory();
      return { tasks: listTasks(m) };
    }

    case 'ORGANIZE_ALL':
      return await organizeAllTabs();

    case 'ORGANIZE_LOOSE':
      return await organizeLooseTabs(message.windowId);

    case 'UNGROUP_ALL':
      return await ungroupAll(message.windowId);

    case 'RENAME_GROUP':
      return await renameGroup(message.groupId, message.title);

    case 'MOVE_TAB':
      return await moveTab(message.tabId, message.label);

    case 'MOVE_GROUP_TO_WINDOW':
      return await moveGroupToWindow(message.groupId);

    case 'NL_GROUP':
      return await organizeByInstruction(message.instruction, message.windowId);

    case 'TASK_GROUP':
      return await captureTaskGroup(message.name, message.windowId);

    case 'CAPTURE_FIXTURE':
      return { fixture: await captureFixture(message.windowId) };

    case 'GET_SESSIONS':
      return { sessions: await getSessions() };

    case 'SAVE_SESSION':
      return await snapshotSession(message.name, message.windowId);

    case 'RESTORE_SESSION':
      return await restoreSession(message.index);

    case 'DELETE_SESSION':
      return { sessions: await deleteSession(message.index) };

    case 'GET_SETTINGS':
      return await getSettings();

    case 'SAVE_SETTINGS': {
      invalidateCache();
      const updated = await saveSettings(message.settings);
      resetSession();
      return updated;
    }

    case 'RESET_SETTINGS': {
      invalidateCache();
      const defaults = await resetSettings();
      resetSession();
      return defaults;
    }

    case 'FOCUS_TAB':
      try {
        await chrome.tabs.update(message.tabId, { active: true });
        const tab = await chrome.tabs.get(message.tabId);
        await chrome.windows.update(tab.windowId, { focused: true });
        return { ok: true };
      } catch {
        return { ok: false, error: 'Tab not found' };
      }

    case 'AI_PROBE':
      return await probeAi();

    case 'AI_STATUS':
      return await checkAvailability();

    case 'PREPARE_AI': {
      const broadcast = (loaded) => {
        chrome.runtime.sendMessage({ type: 'AI_DOWNLOAD_PROGRESS', loaded })
          .catch(() => { /* no receiver open */ });
      };
      return await prepareModel(broadcast);
    }

    default:
      return { error: 'Unknown message type' };
  }
}

// --- First-run grouping ---

chrome.runtime.onInstalled.addListener(async () => {
  const settings = await getSettings();
  if (settings.groupingMode === 'auto') {
    // Group whatever is already open, once, on install.
    try { await organizeAllTabs(); } catch { /* AI may still be downloading */ }
  }
});
