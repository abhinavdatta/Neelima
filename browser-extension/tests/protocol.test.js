'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
require('../protocol.js');

const valid = () => ({
  version: 1,
  request_id: '0f8fad5b-d9cb-469f-a165-70867728950e',
  operation: 'tool.propose',
  task_id: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
  workspace_id: '2c9e6679-7425-40de-944b-e07fc1f90ae7',
  tool: 'read_file',
  args: { path: 'README.md' },
});

test('valid proposal gets trusted origin metadata from the extension', () => {
  const proposal = NeelimaProtocol.validateProposal(valid(), 'chatgpt', 'https://chatgpt.com');
  assert.equal(proposal.site, 'chatgpt');
  assert.equal(proposal.page_origin, 'https://chatgpt.com');
  assert.equal(proposal.user_activated, true);
  assert.match(proposal.request_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal('task_id' in proposal, false);
  assert.equal('workspace_id' in proposal, false);
  assert.notEqual(proposal.request_id, valid().request_id);
});

for (const [name, change] of [
  ['rejects unsupported protocol versions', p => { p.version = 2; }],
  ['rejects arbitrary tools', p => { p.tool = 'run_command'; }],
  ['rejects non-object args', p => { p.args = []; }],
  ['rejects oversize payloads', p => { p.args.path = 'x'.repeat(300_000); }],
]) {
  test(name, () => assert.throws(() => NeelimaProtocol.validateProposal(change(valid()), 'chatgpt', 'https://chatgpt.com')));
}

test('webpage-supplied task/workspace IDs are never forwarded', () => {
  const proposal = NeelimaProtocol.validateProposal(valid(), 'chatgpt', 'https://chatgpt.com');
  assert.equal(Object.hasOwn(proposal, 'task_id'), false);
  assert.equal(Object.hasOwn(proposal, 'workspace_id'), false);
});
