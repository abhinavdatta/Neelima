'use strict';
const $ = id => document.getElementById(id);
const DEFAULTS = { enabledSites: ['chatgpt','claude','gemini'], permissionMode: 'approve_each_write', genericSites: [], paused: false };
let settings = { ...DEFAULTS, enabledSites: [...DEFAULTS.enabledSites], genericSites: [] };
const send = message => chrome.runtime.sendMessage(message);
function renderDomains() {
  const list = $('domain-list'); list.replaceChildren();
  for (const domain of settings.genericSites) {
    const li = document.createElement('li'); const text = document.createElement('span'); text.textContent = domain;
    const remove = document.createElement('button'); remove.textContent = 'Remove';
    remove.addEventListener('click', async () => { settings.genericSites = settings.genericSites.filter(x => x !== domain); await chrome.permissions.remove({ origins: [`https://${domain}/*`] }); renderDomains(); });
    li.append(text, remove); list.appendChild(li);
  }
}
async function load() {
  const response = await send({ type: 'NEELIMA_GET_SETTINGS' });
  if (response?.settings) settings = response.settings;
  for (const site of ['chatgpt','claude','gemini']) $(site).checked = settings.enabledSites.includes(site);
  const mode = document.querySelector(`input[name="mode"][value="${settings.permissionMode}"]`); if (mode) mode.checked = true;
  renderDomains();
}
$('add-domain').addEventListener('click', async () => {
  const input = $('domain');
  const raw = input.value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (!raw || raw.includes('/') || raw.includes('*') || raw.includes(':') || !/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(raw)) { $('save-status').textContent = 'Enter a hostname such as example.com (no path).'; return; }
  const granted = await chrome.permissions.request({ origins: [`https://${raw}/*`] });
  if (!granted) { $('save-status').textContent = 'Browser permission was not granted.'; return; }
  if (!settings.genericSites.includes(raw)) settings.genericSites.push(raw);
  input.value = ''; renderDomains(); $('save-status').textContent = `Authorized ${raw}. Save settings to persist the site list.`;
});
$('save').addEventListener('click', async () => {
  settings.enabledSites = ['chatgpt','claude','gemini'].filter(site => $(site).checked);
  settings.permissionMode = document.querySelector('input[name="mode"]:checked')?.value === 'workspace_auto_write' ? 'workspace_auto_write' : 'approve_each_write';
  const response = await send({ type: 'NEELIMA_SAVE_SETTINGS', settings });
  $('save-status').textContent = response?.ok ? 'Settings saved.' : (response?.error || 'Could not save settings.');
});
$('check-backend').addEventListener('click', async () => {
  const response = await send({ type: 'NEELIMA_GET_STATUS' });
  $('backend-status').textContent = response?.nativeHostConnected && !response?.connectionError ? 'Native host connected. Verify that the local backend supports the required protocol operations.' : `Not connected: ${response?.connectionError || 'Native host not registered. Install the Neelima desktop integration first.'}`;
});
void load();
