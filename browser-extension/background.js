'use strict';
importScripts('protocol.js');
const HOST_NAME = 'com.neelima.browser_bridge';
const SETTINGS_KEY = 'neelima.settings.v1';
const DEFAULTS = { enabledSites: ['chatgpt', 'claude', 'gemini'], permissionMode: 'approve_each_write', genericSites: [], paused: false };
let nativePort = null;
let connectionError = 'Native host has not been contacted yet.';
const pending = new Map();
const uuid = () => crypto.randomUUID();

async function getSettings() {
  const data = await chrome.storage.local.get(SETTINGS_KEY);
  const value = data[SETTINGS_KEY] || {};
  return {
    enabledSites: Array.isArray(value.enabledSites) ? value.enabledSites.filter(x => ['chatgpt','claude','gemini'].includes(x)) : [...DEFAULTS.enabledSites],
    permissionMode: value.permissionMode === 'workspace_auto_write' ? 'workspace_auto_write' : 'approve_each_write',
    genericSites: Array.isArray(value.genericSites) ? value.genericSites.filter(x => typeof x === 'string') : [],
    paused: Boolean(value.paused)
  };
}
async function saveSettings(settings) { await chrome.storage.local.set({ [SETTINGS_KEY]: settings }); }
function closeNative(reason) {
  connectionError = reason;
  const port = nativePort;
  nativePort = null;
  for (const [id, p] of pending) { clearTimeout(p.timer); p.reject(new Error(reason)); pending.delete(id); }
  try { port?.disconnect(); } catch (_) {}
}
function ensurePort() {
  if (nativePort) return nativePort;
  const port = chrome.runtime.connectNative(HOST_NAME);
  nativePort = port;
  connectionError = '';
  port.onMessage.addListener(reply => {
    if (!reply || typeof reply.request_id !== 'string') return;
    const p = pending.get(reply.request_id);
    if (!p) return;
    clearTimeout(p.timer); pending.delete(reply.request_id); p.resolve(reply);
  });
  port.onDisconnect.addListener(() => {
    const reason = chrome.runtime.lastError?.message || 'Native host disconnected.';
    if (nativePort === port) nativePort = null;
    connectionError = reason;
    for (const [id, p] of pending) { clearTimeout(p.timer); p.reject(new Error(reason)); pending.delete(id); }
  });
  return port;
}
function nativeRequest(request, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    let port;
    try { port = ensurePort(); } catch (e) { connectionError = e.message || 'Could not connect to native host.'; reject(e); return; }
    const id = request.request_id;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Neelima request timed out.')); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    try { port.postMessage(request); } catch (e) { clearTimeout(timer); pending.delete(id); reject(e); }
  });
}
function siteForOrigin(origin) {
  try {
    const host = new URL(origin).hostname.toLowerCase();
    if (host === 'chatgpt.com' || host === 'chat.openai.com') return 'chatgpt';
    if (host === 'claude.ai') return 'claude';
    if (host === 'gemini.google.com') return 'gemini';
    return 'generic';
  } catch (_) { return null; }
}
async function senderIsAllowed(sender, settings, site, origin) {
  if (!sender.url || !sender.tab?.id) return false;
  let url;
  try { url = new URL(sender.url); } catch (_) { return false; }
  if (url.protocol !== 'https:' || url.origin !== origin || siteForOrigin(url.origin) !== site) return false;
  if (site !== 'generic') return settings.enabledSites.includes(site);
  return settings.genericSites.includes(url.hostname.toLowerCase()) && await chrome.permissions.contains({ origins: [`https://${url.hostname.toLowerCase()}/*`] });
}
async function handleProposal(message, sender) {
  const settings = await getSettings();
  if (settings.paused) throw new Error('Neelima Browser Bridge is paused. Resume it in the popup.');
  if (!sender.url) throw new Error('The request did not originate from a browser tab.');
  const origin = new URL(sender.url).origin;
  const site = siteForOrigin(origin);
  if (!site || !(await senderIsAllowed(sender, settings, site, origin))) throw new Error('This website is not enabled for Neelima.');
  const proposal = NeelimaProtocol.validateProposal(message.proposal, site, origin);
  const reply = await nativeRequest({ version: 1, request_id: uuid(), operation: 'tool.propose', proposal, extension: { name: 'Neelima Browser Bridge', version: chrome.runtime.getManifest().version } }, 30000);
  if (reply.error) throw new Error(reply.error.message || reply.error.code || 'Neelima rejected the request.');
  return { ok: true, status: reply.status || 'accepted', message: 'Request sent. Complete any required approval in Neelima.' };
}
async function handleManualProposal(message) {
  const settings = await getSettings();
  if (settings.paused) throw new Error('Neelima Browser Bridge is paused. Resume it in the popup.');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || tab.id !== Number(message.tabId) || !tab.url || tab.url !== message.url) throw new Error('The active tab changed. Reopen the popup and try again.');
  const url = new URL(tab.url);
  if (url.protocol !== 'https:') throw new Error('Only HTTPS websites are supported.');
  const origin = url.origin;
  const site = siteForOrigin(origin);
  if (!site) throw new Error('Unsupported website.');
  if (site === 'generic') {
    if (!settings.genericSites.includes(url.hostname.toLowerCase()) || !(await chrome.permissions.contains({ origins: [`https://${url.hostname.toLowerCase()}/*`] }))) throw new Error('Authorize this generic domain in Options first.');
  } else if (!settings.enabledSites.includes(site)) throw new Error('Enable this AI website in Options first.');
  const proposal = NeelimaProtocol.validateProposal(message.proposal, site, origin);
  const reply = await nativeRequest({ version: 1, request_id: uuid(), operation: 'tool.propose', proposal, extension: { name: 'Neelima Browser Bridge', version: chrome.runtime.getManifest().version, relay: 'manual' } }, 30000);
  if (reply.error) throw new Error(reply.error.message || reply.error.code || 'Neelima rejected the request.');
  return { ok: true, status: reply.status || 'accepted', message: 'Manual request sent. Complete any required approval in Neelima.' };
}
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return;
  (async () => {
    try {
      switch (message.type) {
        case 'NEELIMA_GET_STATUS': {
          let backend = null;
          let statusError = '';
          try { backend = await nativeRequest({ version: 1, request_id: uuid(), operation: 'bridge.status' }, 3500); }
          catch (e) { statusError = e instanceof Error ? e.message : 'Native host did not respond.'; }
          const connected = Boolean(nativePort && !connectionError && backend && !backend.error);
          return { ok: true, settings: await getSettings(), nativeHostConnected: connected, connectionError: connected ? '' : (connectionError || statusError || 'Native host did not confirm the Neelima backend connection.'), backend };
        }
        case 'NEELIMA_GET_SETTINGS': return { ok: true, settings: await getSettings() };
        case 'NEELIMA_SAVE_SETTINGS': {
          const current = await getSettings();
          const incoming = message.settings || {};
          const next = {
            enabledSites: Array.isArray(incoming.enabledSites) ? incoming.enabledSites.filter(x => ['chatgpt','claude','gemini'].includes(x)) : current.enabledSites,
            permissionMode: incoming.permissionMode === 'workspace_auto_write' ? 'workspace_auto_write' : 'approve_each_write',
            genericSites: Array.isArray(incoming.genericSites) ? incoming.genericSites.filter(x => typeof x === 'string' && /^[a-z0-9.-]+$/.test(x)) : current.genericSites,
            paused: typeof incoming.paused === 'boolean' ? incoming.paused : current.paused
          };
          // This preference is UI-only. The desktop backend is the sole authority
          // for effective permissions and must never trust extension-stored modes.
          await saveSettings(next);
          return { ok: true, settings: next };
        }
        case 'NEELIMA_PROPOSE_TOOL': return await handleProposal(message, sender);
        case 'NEELIMA_MANUAL_PROPOSE': return await handleManualProposal(message);
        case 'NEELIMA_ENABLE_GENERIC_ON_TAB': {
          const tabId = Number(message.tabId);
          const url = typeof message.url === 'string' ? new URL(message.url) : null;
          if (!Number.isInteger(tabId) || !url || url.protocol !== 'https:') throw new Error('Select an HTTPS website first.');
          const hostname = url.hostname.toLowerCase();
          const settings = await getSettings();
          if (!settings.genericSites.includes(hostname)) throw new Error('Authorize this domain in Options first.');
          if (!(await chrome.permissions.contains({ origins: [`https://${hostname}/*`] }))) throw new Error('Browser permission is missing. Re-authorize this domain in Options.');
          await chrome.scripting.executeScript({ target: { tabId }, files: ['content/generic.js'] });
          return { ok: true };
        }
        default: return { ok: false, error: 'Unknown extension request.' };
      }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'Unexpected extension error.' }; }
  })().then(sendResponse);
  return true;
});
chrome.runtime.onInstalled.addListener(async () => { await saveSettings(await getSettings()); });
