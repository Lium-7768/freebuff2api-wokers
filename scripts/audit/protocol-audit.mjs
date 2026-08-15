import assert from 'node:assert/strict';

import worker from '../../worker.js';

const API_KEY = 'audit-key';
let tokenNumber = 0;
let calls = [];

function env() {
  tokenNumber += 1;
  return {
    FREEBUFF_TOKEN: `audit-token-${tokenNumber}-aaaaaaaa`,
    FREEBUFF_API_KEY: API_KEY,
    FREEBUFF_DEBUG: 'false',
  };
}

function request(path, body) {
  return new Request(`http://audit.local${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

function sse(events, { trailingNewline = true } = {}) {
  const text = events
    .map((event) => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`)
    .join('');
  return new Response(trailingNewline ? text : text.replace(/\n\n$/, ''), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function installMock(chatResponse) {
  let runNumber = 0;
  calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(String(url)).pathname;
    let body = null;
    try { body = init.body ? JSON.parse(init.body) : null; } catch {}
    calls.push({ path, method: init.method || 'GET', body, headers: init.headers });

    if (path === '/api/v1/freebuff/session' && (init.method || 'GET') === 'GET') {
      return Response.json({ status: 'none' }, { status: 404 });
    }
    if (path === '/api/v1/freebuff/session' && init.method === 'POST') {
      return Response.json({
        status: 'active',
        instanceId: 'audit-instance',
        model: init.headers['x-freebuff-model'],
        remainingMs: 3_600_000,
      });
    }
    if (path === '/api/v1/agent-runs' && body?.action === 'START') {
      return Response.json({ runId: `audit-run-${++runNumber}` });
    }
    if (path === '/api/v1/agent-runs' && body?.action === 'FINISH') {
      return Response.json({ ok: true });
    }
    if (path === '/api/v1/chat/completions') return chatResponse();
    throw new Error(`unexpected mock request: ${path}`);
  };
}

function fragmentedToolEvents() {
  return [
    {
      id: 'chat-audit',
      model: 'deepseek/deepseek-v4-flash',
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: 0,
            id: 'call-fixed',
            type: 'function',
            function: { name: 'apply_patch', arguments: '{"x":' },
          }],
        },
        finish_reason: null,
      }],
    },
    {
      id: 'chat-audit',
      model: 'deepseek/deepseek-v4-flash',
      choices: [{
        index: 0,
        delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    },
    '[DONE]',
  ];
}

installMock(() => sse(fragmentedToolEvents()));
let response = await worker.fetch(request('/v1/chat/completions', {
  model: 'deepseek/deepseek-v4-flash',
  messages: [{ role: 'system', content: 'CALLER_SYSTEM' }, { role: 'user', content: 'x' }],
  tools: [{ type: 'function', function: { name: 'apply_patch', parameters: { type: 'object' } } }],
  stream: false,
}), env());
let output = await response.json();
let chatCall = calls.find((call) => call.path === '/api/v1/chat/completions');
let finishCall = calls.find((call) => call.path === '/api/v1/agent-runs' && call.body?.action === 'FINISH');
assert.equal(response.status, 200);
assert.equal(output.choices[0].message.tool_calls.length, 1);
assert.equal(finishCall.body.totalSteps, 1);
assert.equal(finishCall.body.steps.length, 1);
console.log(JSON.stringify({
  case: 'chat_nonstream_split_tool',
  status: response.status,
  tool_call_count: output.choices[0].message.tool_calls.length,
  system_prefix: chatCall.body.messages[0].content.slice(0, 60),
  metadata_keys: Object.keys(chatCall.body.codebuff_metadata).sort(),
  total_steps: finishCall.body.totalSteps,
}));

installMock(() => sse(fragmentedToolEvents()));
response = await worker.fetch(request('/v1/responses', {
  model: 'deepseek/deepseek-v4-flash',
  input: 'x',
  tools: [{ type: 'function', name: 'apply_patch', parameters: { type: 'object' } }],
  stream: false,
}), env());
output = await response.json();
assert.equal(response.status, 200);
assert.equal(output.output[0].type, 'function_call');
console.log(JSON.stringify({
  case: 'responses_nonstream_split_tool',
  status: response.status,
  output_types: output.output.map((item) => item.type),
  arguments: output.output[0].arguments,
}));

installMock(() => sse(['{not-json}', '[DONE]']));
response = await worker.fetch(request('/v1/chat/completions', {
  model: 'deepseek/deepseek-v4-flash',
  messages: [{ role: 'user', content: 'x' }],
  stream: false,
}), env());
output = await response.json();
finishCall = calls.find((call) => call.path === '/api/v1/agent-runs' && call.body?.action === 'FINISH');
assert.equal(response.status, 502);
assert.equal(finishCall.body.status, 'failed');
console.log(JSON.stringify({
  case: 'invalid_sse_json',
  status: response.status,
  error_type: output.error.type,
  finish_status: finishCall.body.status,
}));

installMock(() => sse([
  { choices: [{ delta: { content: 'tail' }, finish_reason: 'stop' }] },
], { trailingNewline: false }));
response = await worker.fetch(request('/v1/chat/completions', {
  model: 'deepseek/deepseek-v4-flash',
  messages: [{ role: 'user', content: 'x' }],
  stream: false,
}), env());
output = await response.json();
assert.equal(output.choices[0].message.content, 'tail');
console.log(JSON.stringify({
  case: 'sse_final_event_without_newline',
  status: response.status,
  content: output.choices[0].message.content,
}));
