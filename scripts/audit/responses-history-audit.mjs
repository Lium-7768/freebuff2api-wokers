import assert from 'node:assert/strict';

import worker from '../../worker.js';

let chatBody = null;
let finishBody = null;
globalThis.fetch = async (url, init = {}) => {
  const path = new URL(String(url)).pathname;
  let body = null;
  try { body = init.body ? JSON.parse(init.body) : null; } catch {}

  if (path === '/api/v1/freebuff/session' && (init.method || 'GET') === 'GET') {
    return Response.json({ status: 'none' }, { status: 404 });
  }
  if (path === '/api/v1/freebuff/session' && init.method === 'POST') {
    return Response.json({
      status: 'active',
      instanceId: 'history-instance',
      model: init.headers['x-freebuff-model'],
      remainingMs: 3_600_000,
    });
  }
  if (path === '/api/v1/agent-runs' && body?.action === 'START') {
    return Response.json({ runId: 'history-run' });
  }
  if (path === '/api/v1/agent-runs' && body?.action === 'FINISH') {
    finishBody = body;
    return Response.json({ ok: true });
  }
  if (path === '/api/v1/chat/completions') {
    chatBody = body;
    return new Response(
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    );
  }
  throw new Error(`unexpected mock request: ${path}`);
};

const request = new Request('http://local/v1/responses', {
  method: 'POST',
  headers: {
    Authorization: 'Bearer audit',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    model: 'deepseek/deepseek-v4-flash',
    input: [
      { type: 'function_call', call_id: 'call-1', name: 'apply_patch', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call-1', output: 'ok' },
    ],
    stream: false,
  }),
});
const response = await worker.fetch(request, {
  FREEBUFF_CREDENTIALS_JSON: JSON.stringify({ accounts: { history: { authToken: 'history-audit-token-aaaaaaaa', fingerprintId: 'fp-history' } } }),
  FREEBUFF_API_KEY: 'audit',
  FREEBUFF_DEBUG: 'false',
});
await response.json();

const roles = chatBody.messages.map((message) => message.role);
assert.deepEqual(roles, ['system', 'assistant', 'tool']);
assert.equal(chatBody.messages[1].tool_calls[0].id, 'call-1');
assert.equal(chatBody.messages[2].tool_call_id, 'call-1');
assert.equal(finishBody.totalSteps, 1);
console.log(JSON.stringify({
  case: 'responses_tool_history',
  outbound_roles: roles,
  assistant_tool_call_messages: 1,
  tool_result_messages: 1,
  finish_total_steps: finishBody.totalSteps,
}));
