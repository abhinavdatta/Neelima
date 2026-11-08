'use strict';
importScripts('protocol.js');
const HOST_NAME = 'com.neelima.browser_bridge';
const SETTINGS_KEY = 'neelima.settings.v1';
const ACTIVITY_KEY = 'neelima.activity.v1';
const REQUESTS_KEY = 'neelima.requests.v1';
const ACTIVITY_LIMIT = 40;
const REQUEST_LIMIT = 40;
const DEDUPE_WINDOW_MS = 4000;
const DEFAULTS = { enabledSites: ['chatgpt', 'claude', 'gemini'], permissionMode: 'approve_each_write', genericSites: [], paused: false };
let nativePort = null;
let connectionError = 'Native host has not been contacted yet.';
const pending = new Map();
const recentProposals = new Map();
let requestStorageQueue = Promise.resolve();
const uuid = () => crypto.randomUUID();
const validHostname = value => typeof value === 'string' && value.length <= 253 && /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(value);

async function getSettings() {
  const data = await chrome.storage.local.get(SETTINGS_KEY);
  const value = data[SETTINGS_KEY] || {};
  return {
    enabledSites: Array.isArray(value.enabledSites) ? value.enabledSites.filter(x => ['chatgpt','claude','gemini'].includes(x)) : [...DEFAULTS.enabledSites],
    permissionMode: value.permissionMode === 'workspace_auto_write' ? 'workspace_auto_write' : 'approve_each_write',
    genericSites: Array.isArray(value.genericSites) ? [...new Set(value.genericSites.filter(validHostname).map(x => x.toLowerCase()))] : [],
    paused: Boolean(value.paused)
  };
}
async function saveSettings(settings) { await chrome.storage.local.set({ [SETTINGS_KEY]: settings }); }
async function recordRequest(id, status, site, tool, message = '') {
  // Persist only status metadata; never prompt text, file contents, or tool arguments.
  const operation = requestStorageQueue.then(async () => {
    const stored = await chrome.storage.local.get(REQUESTS_KEY);
    const records = Array.isArray(stored[REQUESTS_KEY]) ? stored[REQUESTS_KEY] : [];
    const existing = records.findIndex(record => record.id === id);
    if (existing >= 0) records.splice(existing, 1);
    records.unshift({ id, status, site, tool, updatedAt: new Date().toISOString(), message: String(message).slice(0, 140) });
    await chrome.storage.local.set({ [REQUESTS_KEY]: records.slice(0, REQUEST_LIMIT) });
  });
  requestStorageQueue = operation.catch(() => {});
  try { await operation; } catch (_) { /* Diagnostics must never interrupt request handling. */ }
}
async function markInterruptedRequests() {
  const operation = requestStorageQueue.then(async () => {
    const stored = await chrome.storage.local.get(REQUESTS_KEY);
    const records = Array.isArray(stored[REQUESTS_KEY]) ? stored[REQUESTS_KEY] : [];
    let changed = false;
    for (const record of records) if (record.status === 'forwarding') {
      record.status = 'outcome_unknown';
      record.message = 'Extension restarted before acknowledgement; request was not resent.';
      record.updatedAt = new Date().toISOString();
      changed = true;
    }
    if (changed) await chrome.storage.local.set({ [REQUESTS_KEY]: records });
  });
  requestStorageQueue = operation.catch(() => {});
  try { await operation; } catch (_) { /* Never replay a request during recovery. */ }
}
async function recordActivity(type, details = {}) {
  // Deliberately record metadata only; never store prompts, file contents, tool args, or credentials.
  try {
    const stored = await chrome.storage.local.get(ACTIVITY_KEY);
    const entries = Array.isArray(stored[ACTIVITY_KEY]) ? stored[ACTIVITY_KEY] : [];
    entries.unshift({
      at: new Date().toISOString(),
      type: String(type).slice(0, 40),
      site: typeof details.site === 'string' ? details.site.slice(0, 30) : '',
      status: typeof details.status === 'string' ? details.status.slice(0, 40) : '',
      message: typeof details.message === 'string' ? details.message.slice(0, 180) : ''
    });
    await chrome.storage.local.set({ [ACTIVITY_KEY]: entries.slice(0, ACTIVITY_LIMIT) });
  } catch (_) { /* Diagnostics must never break task handling. */ }
}
function proposalDedupeKey(proposal) {
  // Stable key over the allowlisted proposal only. Never persist this key to disk.
  return JSON.stringify([proposal.site, proposal.page_origin, proposal.tool, proposal.args]);
}
async function sendProposalToNative(proposal, extension) {
  const key = proposalDedupeKey(proposal);
  const now = Date.now();
  for (const [existingKey, entry] of recentProposals) {
    if (now - entry.at > DEDUPE_WINDOW_MS) recentProposals.delete(existingKey);
  }
  const existing = recentProposals.get(key);
  if (existing && now - existing.at <= DEDUPE_WINDOW_MS) {
    if (existing.promise) return existing.promise;
    return existing.reply;
  }
  const promise = (async () => {
    await recordRequest(proposal.request_id, 'forwarding', proposal.site, proposal.tool);
    try {
      // Use the proposal's request_id as the transport request_id for unified identity.
      // The timeout must cover the backend's 120 s user-approval window: the
      // backend returns the REAL decision (executed / rejected / timed out)
      // inside this transport reply, so we do not treat an ack as completion.
      const reply = await nativeRequest({ version: 1, request_id: proposal.request_id, operation: 'tool.propose', proposal, extension }, 150000);
      if (reply.error) throw new Error(reply.error.message || reply.error.code || 'Neelima rejected the request.');
      const KNOWN_STATUSES = ['executed', 'accepted_by_backend', 'approved_and_executed', 'awaiting_approval', 'rejected', 'timeout', 'execution_failed', 'duplicate'];
      const rawStatus = typeof reply.status === 'string' ? reply.status : '';
      // Unknown statuses mean only "the backend acknowledged" — never claim
      // execution that the reply did not actually report.
      const status = KNOWN_STATUSES.includes(rawStatus) ? rawStatus : 'accepted_by_backend';
      // Metadata-only messages: never include tool output, file contents, or args.
      const STATUS_MESSAGES = {
        executed: 'Executed by the Neelima backend.',
        accepted_by_backend: 'Executed by the Neelima backend.',
        approved_and_executed: 'Approved in Neelima and executed.',
        awaiting_approval: 'Awaiting user approval in Neelima; execution status comes from the backend.',
        rejected: 'Rejected in Neelima; nothing was executed.',
        timeout: 'Approval timed out in Neelima; nothing was executed.',
        execution_failed: 'Neelima could not execute the request.',
        duplicate: 'Already decided by Neelima; not re-executed.'
      };
      const result = {
        ok: true,
        status,
        terminal: !['awaiting_approval'].includes(status),
        message: STATUS_MESSAGES[status] || 'Neelima acknowledged the request.'
      };
      await recordRequest(proposal.request_id, status, proposal.site, proposal.tool, result.message);
      recentProposals.set(key, { at: Date.now(), reply: result });
      await recordActivity('tool-proposal', { site: proposal.site, status, message: result.message });
      // Result-return path: terminal results are offered back to the page
      // that requested them. Nothing is inserted without an explicit user
      // click (see content/result-relay.js), and the payload is capped.
      if (extension?.tabId && result.terminal) {
        const output = reply.result?.output;
        const errorText = reply.result?.error;
        const resultText = typeof output === 'string' && output.trim()
          ? output.slice(0, 4000)
          : typeof errorText === 'string' && errorText.trim()
            ? `Error: ${errorText.slice(0, 2000)}`
            : '';
        const payload = { type: 'NEELIMA_RESULT', request_id: proposal.request_id, status, summary: result.message, result_text: resultText };
        try { await chrome.tabs.sendMessage(extension.tabId, payload); } catch (_) { /* tab may be gone */ }
      }
      return result;
    } catch (error) {
      recentProposals.delete(key);
      const message = error instanceof Error ? error.message : 'Request failed.';
      const uncertain = /timed out|disconnect|port/i.test(message);
      await recordRequest(proposal.request_id, uncertain ? 'outcome_unknown' : 'failed', proposal.site, proposal.tool,
        uncertain ? 'Transport ended before the decision arrived; execution may have occurred. Do not retry automatically.' : 'The backend rejected or could not process the proposal.');
      await recordActivity('tool-proposal-failed', { site: proposal.site, status: uncertain ? 'outcome unknown' : 'rejected', message: 'See the current Neelima error for details.' });
      throw error;
    }
  })();
  recentProposals.set(key, { at: now, promise });
  return promise;
}
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
    void recordActivity('native-disconnected', { status: 'disconnected', message: reason });
    for (const [id, p] of pending) { clearTimeout(p.timer); p.reject(new Error(reason)); pending.delete(id); }
  });
  return port;
}
function nativeRequest(request, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    let port;
    try { port = ensurePort(); } catch (e) { connectionError = e.message || 'Could not connect to native host.'; reject(e); return; }
    const id = request.request_id;
    if (typeof id !== 'string' || !id || pending.has(id)) { reject(new Error('Invalid or duplicate native request ID.')); return; }
    const timer = setTimeout(() => { pending.delete(id); void recordActivity('native-timeout', { status: 'timeout', message: `Native request timed out after ${timeoutMs} ms.` }); reject(new Error('Neelima request timed out.')); }, timeoutMs);
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
  return sendProposalToNative(proposal, { name: 'Neelima Browser Bridge', version: chrome.runtime.getManifest().version, tabId: sender.tab.id });
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
  return sendProposalToNative(proposal, { name: 'Neelima Browser Bridge', version: chrome.runtime.getManifest().version, relay: 'manual' });
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
          await recordActivity('connection-check', { status: connected ? 'connected' : 'unavailable', message: connected ? 'Native host responded to bridge.status.' : (connectionError || statusError || 'Backend did not confirm connection.') });
          return { ok: true, settings: await getSettings(), nativeHostConnected: connected, connectionError: connected ? '' : (connectionError || statusError || 'Native host did not confirm the Neelima backend connection.'), backend, checkedAt: new Date().toISOString(), protocolVersion: 1 };
        }
        case 'NEELIMA_GET_SETTINGS': return { ok: true, settings: await getSettings() };
        case 'NEELIMA_GET_ACTIVITY': {
          const stored = await chrome.storage.local.get(ACTIVITY_KEY);
          return { ok: true, activity: Array.isArray(stored[ACTIVITY_KEY]) ? stored[ACTIVITY_KEY].slice(0, ACTIVITY_LIMIT) : [] };
        }
        case 'NEELIMA_GET_REQUESTS': {
          const stored = await chrome.storage.local.get(REQUESTS_KEY);
          return { ok: true, requests: Array.isArray(stored[REQUESTS_KEY]) ? stored[REQUESTS_KEY].slice(0, REQUEST_LIMIT) : [] };
        }
        case 'NEELIMA_CLEAR_ACTIVITY':
          await chrome.storage.local.remove(ACTIVITY_KEY);
          return { ok: true };
        case 'NEELIMA_GET_DIAGNOSTICS': {
          const settings = await getSettings();
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          let site = null;
          try { if (tab?.url) site = siteForOrigin(new URL(tab.url).origin); } catch (_) {}
          const permissions = await chrome.permissions.getAll();
          const stored = await chrome.storage.local.get(ACTIVITY_KEY);
          return { ok: true, diagnostics: {
            extensionVersion: chrome.runtime.getManifest().version,
            protocolVersion: 1,
            paused: settings.paused,
            enabledSites: settings.enabledSites,
            genericSiteCount: settings.genericSites.length,
            activeTabSite: site,
            activeTabHttps: Boolean(tab?.url && tab.url.startsWith('https://')),
            grantedOptionalOriginCount: (permissions.origins || []).length,
            nativePortOpen: Boolean(nativePort),
            pendingNativeRequests: pending.size,
            recentActivityCount: Array.isArray(stored[ACTIVITY_KEY]) ? stored[ACTIVITY_KEY].length : 0,
            capturedAt: new Date().toISOString()
          } };
        }
        case 'NEELIMA_SAVE_SETTINGS': {
          const current = await getSettings();
          const incoming = message.settings || {};
          const next = {
            enabledSites: Array.isArray(incoming.enabledSites) ? incoming.enabledSites.filter(x => ['chatgpt','claude','gemini'].includes(x)) : current.enabledSites,
            permissionMode: incoming.permissionMode === 'workspace_auto_write' ? 'workspace_auto_write' : 'approve_each_write',
            genericSites: Array.isArray(incoming.genericSites) ? [...new Set(incoming.genericSites.filter(validHostname).map(x => x.toLowerCase()))] : current.genericSites,
            paused: typeof incoming.paused === 'boolean' ? incoming.paused : current.paused
          };
          // This preference is UI-only. The desktop backend is the sole authority
          // for effective permissions and must never trust extension-stored modes.
          await saveSettings(next);
          await recordActivity('settings-updated', { status: 'saved', message: 'Extension preferences updated.' });
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
          await recordActivity('generic-adapter-enabled', { site: hostname, status: 'enabled', message: 'Generic adapter injected into active tab.' });
          return { ok: true };
        }
        default: return { ok: false, error: 'Unknown extension request.' };
      }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'Unexpected extension error.' }; }
  })().then(sendResponse);
  return true;
});
chrome.runtime.onInstalled.addListener(async () => { await saveSettings(await getSettings()); });
void markInterruptedRequests();
