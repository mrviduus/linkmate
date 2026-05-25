import { draftComments } from '../lib/openai';
import { appendSsi, setProfileAudit } from '../lib/storage';
import type { Msg } from '../lib/types';

// Open the side panel when the toolbar icon is clicked.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((e) => console.warn('[linkmate] sidePanel.setPanelBehavior', e));

chrome.runtime.onMessage.addListener((msg: Msg, _sender, sendResponse) => {
  if (msg.type === 'SSI_SAVED') {
    appendSsi(msg.sample)
      .then((history) => sendResponse({ ok: true, count: history.length }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true; // keep channel open for async response
  }
  if (msg.type === 'PROFILE_AUDIT_SAVED') {
    setProfileAudit(msg.audit)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
  if (msg.type === 'DRAFT_COMMENTS') {
    draftComments(msg.postAuthor, msg.postBody)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ drafts: [], error: String(err) }));
    return true;
  }
  return false;
});

// Reset progress at local midnight — chrome.alarms in minutes.
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('midnight-reset', { periodInMinutes: 60 });
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'midnight-reset') return;
  const today = new Date().toISOString().slice(0, 10);
  const { dailyProgress } = await chrome.storage.local.get({ dailyProgress: { date: today } });
  if (dailyProgress.date !== today) {
    await chrome.storage.local.set({
      dailyProgress: { date: today, likes: 0, comments: 0, posts: 0, courses: 0 },
    });
  }
});
