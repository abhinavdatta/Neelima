'use strict';

// Shared validation for the untrusted webpage -> extension boundary.
// The native backend must repeat all authorization and path checks.
(() => {
  const TOOLS = new Set(['list_dir', 'read_file', 'grep', 'glob', 'write_file', 'edit_file', 'move_file', 'delete_file']);
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const MAX_BYTES = 256 * 1024;
  const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

  function validateProposal(input, site, origin) {
    if (!isRecord(input)) throw new Error('Tool request must be a JSON object.');
    if (input.version !== 1 || input.operation !== 'tool.propose') throw new Error('Unsupported Neelima tool protocol.');
    if (!TOOLS.has(input.tool)) throw new Error('Unsupported tool.');
    if (!isRecord(input.args)) throw new Error('Tool args must be an object.');
    const bytes = new TextEncoder().encode(JSON.stringify(input)).byteLength;
    if (bytes > MAX_BYTES) throw new Error('Request exceeds the 256 KiB limit.');
    // The webpage/LLM must never choose a Neelima task, workspace, or transport ID.
    // Generate a fresh request ID in the extension and forward only the allowlisted fields.
    const args = JSON.parse(JSON.stringify(input.args));
    return {
      version: 1,
      request_id: crypto.randomUUID(),
      operation: 'tool.propose',
      tool: input.tool,
      args,
      site,
      page_origin: origin,
      user_activated: true
    };
  }

  globalThis.NeelimaProtocol = { validateProposal };
})();
