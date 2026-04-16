/**
 * Background service worker — event hub for AI Tab Grouper.
 *
 * Listens for tab create/navigate events and auto-groups tabs by topic using
 * on-device AI (with deterministic subdomain grouping for internal hosts).
 */

import {
  organizeAllTabs,
  autoGroupTab,
  ungroupAll,
  getGroupsSnapshot,
  collapseInactiveGroups,
  foldOthers,
  renameGroup,
  moveTab,
  moveGroupToWindow,
  organizeByInstruction,
  snapshotSession,
  restoreSession,
  isBusy,
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
    if (!settings.autoGroup) return;
    await autoGroupTab(tabId);
  } catch {
    // Tab closed before we could process it
  }
}

// --- Tab events ---

chrome.tabs.onCreated.addListener((tab) => {
  if (tab.url && tab.url !== 'about:blank') debounceTabUpdate(tab.id);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // Group once the URL is known and the page has settled.
  if (changeInfo.url || changeInfo.status === 'complete') debounceTabUpdate(tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (pendingUpdates.has(tabId)) {
    clearTimeout(pendingUpdates.get(tabId));
    pendingUpdates.delete(tabId);
  }
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
    case 'GET_SNAPSHOT':
      return await getGroupsSnapshot(message.windowId);

    case 'ORGANIZE_ALL':
      return await organizeAllTabs();

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
  if (settings.autoGroup) {
    // Group whatever is already open, once, on install.
    try { await organizeAllTabs(); } catch { /* AI may still be downloading */ }
  }
});
