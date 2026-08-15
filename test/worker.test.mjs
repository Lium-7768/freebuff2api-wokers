import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { after, beforeEach, test } from 'node:test';

import worker from '../worker.js';

const originalFetch = globalThis.fetch;
const API_KEY = 'test-api-key';
let tokenCounter = 0;

after(() => {
  globalThis.fetch = originalFetch;
});

beforeEach(() => {
  tokenCounter += 1;
});

function env(tokens = [`token-test-${tokenCounter}-aaaaaaaa`]) {
  return {
    FREEBUFF_TOKEN: tokens.join(','),
    FREEBUFF_API_KEY: API_KEY,
    FREEBUFF_DEBUG: 'false',
  };
}

function request(path, body, signal, apiKey = API_KEY) {
  return new Request(`http://local.test${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
}

function sse(content = 'ok') {
  return new Response(
    `data: ${JSON.stringify({
      id: 'chat-1',
      model: 'deepseek/deepseek-v4-flash',
      choices: [{ index: 0, delta: { content }, finish_reason: 'stop' }],
    })}\n\ndata: [DONE]\n\n`,
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  );
}

function mockUpstream({ onChat, onSessionPost, calls }) {
  let runNumber = 0;
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    const body = init.body ? JSON.parse(init.body) : null;
    const call = {
      path: parsed.pathname,
      method: init.method || 'GET',
      auth: init.headers?.Authorization || init.headers?.authorization || null,
      body,
      signal: init.signal,
    };
    calls.push(call);

    if (parsed.pathname === '/api/v1/usage') return Response.json({ ok: true });
    if (parsed.pathname === '/api/v1/freebuff/session' && call.method === 'GET') {
      return Response.json({ status: 'ended' }, { status: 200 });
    }
    if (parsed.pathname === '/api/v1/freebuff/session' && call.method === 'POST') {
      return Response.json(onSessionPost ? onSessionPost(call) : {
        status: 'active',
        instanceId: `instance-${call.auth}`,
        model: init.headers['x-freebuff-model'],
        remainingMs: 3_600_000,
      });
    }
    if (parsed.pathname === '/api/v1/freebuff/session' && call.method === 'DELETE') {
      return Response.json({ ok: true });
    }
    if (parsed.pathname === '/api/v1/agent-runs' && body?.action === 'START') {
      runNumber += 1;
      return Response.json({ runId: `run-${runNumber}` });
    }
    if (parsed.pathname === '/api/v1/agent-runs' && body?.action === 'FINISH') {
      return Response.json({ ok: true });
    }
    if (parsed.pathname === '/api/v1/chat/completions') {
      return onChat ? onChat(call) : sse();
    }
    throw new Error(`unexpected upstream request: ${call.method} ${call.path}`);
  };
}

function chatBody(model = 'deepseek/deepseek-v4-flash', extra = {}) {
  return {
    model,
    messages: [{ role: 'user', content: 'test' }],
    stream: false,
    ...extra,
  };
}

test('requires an explicitly configured API key', async () => {
  const response = await worker.fetch(request('/v1/models'), { FREEBUFF_TOKEN: 'token-aaaaaaaa' });
  assert.equal(response.status, 401);
});

test('VPS server refuses to start without FREEBUFF_API_KEY', () => {
  const childEnv = { ...process.env };
  delete childEnv.FREEBUFF_API_KEY;
  const result = spawnSync(process.execPath, ['server.js'], {
    cwd: new URL('..', import.meta.url),
    env: childEnv,
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /FREEBUFF_API_KEY is required/);
});

test('/healthz exposes aggregates but no token or uid prefixes', async () => {
  const marker = 'sensitive-token-prefix-aaaaaaaa';
  const response = await worker.fetch(new Request('http://local.test/healthz'), env([marker]));
  const text = await response.text();
  const data = JSON.parse(text);
  assert.equal(data.accounts, 1);
  assert.equal(data.status, 'degraded');
  assert.equal(data.version, '1.9.0');
  assert.equal(text.includes(marker.slice(0, 8)), false);
  assert.equal(Object.hasOwn(data, 'account_details'), false);
  assert.equal(Object.hasOwn(data, 'account_states'), false);
});

test('/v1/models returns only the ordinary CLI picker catalog', async () => {
  const response = await worker.fetch(request('/v1/models'), env());
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual(data.data.map((model) => model.id), [
    'deepseek/deepseek-v4-pro',
    'deepseek/deepseek-v4-flash',
    'openai/gpt-5.6-luna',
    'minimax/minimax-m3',
    'mimo/mimo-v2.5',
  ]);
});

test('/v1/models narrows to standard models after every account is observed as limited', async () => {
  const calls = [];
  const token = `token-limited-${tokenCounter}-aaaaaaaa`;
  mockUpstream({
    calls,
    onSessionPost: (call) => ({
      status: 'active',
      instanceId: `instance-${call.auth}`,
      model: 'deepseek/deepseek-v4-flash',
      remainingMs: 3_600_000,
      accessTier: 'limited',
    }),
  });
  const chat = await worker.fetch(request('/v1/chat/completions', chatBody()), env([token]));
  assert.equal(chat.status, 200);
  const response = await worker.fetch(request('/v1/models'), env([token]));
  const data = await response.json();
  assert.deepEqual(data.data.map((model) => model.id), [
    'deepseek/deepseek-v4-flash',
    'mimo/mimo-v2.5',
  ]);
});

test('normal chat uses one base3 root and records an accurate completed finish', async () => {
  const calls = [];
  mockUpstream({ calls });
  const response = await worker.fetch(request('/v1/chat/completions', chatBody()), env());
  assert.equal(response.status, 200);

  const starts = calls.filter((call) => call.path === '/api/v1/agent-runs' && call.body?.action === 'START');
  assert.equal(starts.length, 1);
  assert.equal(starts[0].body.agentId, 'base3-free-deepseek-flash');
  assert.deepEqual(starts[0].body.ancestorRunIds, []);

  const finishes = calls.filter((call) => call.path === '/api/v1/agent-runs' && call.body?.action === 'FINISH');
  assert.equal(finishes.length, 1);
  assert.equal(finishes[0].body.status, 'completed');
  assert.equal(finishes[0].body.totalSteps, 1);
  assert.equal(finishes[0].body.steps.length, 1);
  assert.equal(finishes[0].body.steps[0].stepNumber, 1);
  assert.equal(finishes[0].body.steps[0].status, 'completed');

  const chat = calls.find((call) => call.path === '/api/v1/chat/completions');
  assert.equal(chat.body.codebuff_metadata.llm_step_number, '1');
  assert.match(chat.body.messages[0].content, /^You are Buffy, the coding agent behind Codebuff\./);
});

for (const gate of [
  { code: 'session_superseded', status: 409 },
  { code: 'waiting_room_queued', status: 429 },
]) {
  test(`${gate.code} is terminal for the request and never fans out`, async () => {
    const calls = [];
    mockUpstream({
      calls,
      onChat: () => Response.json({ error: gate.code, message: 'gate message' }, { status: gate.status }),
    });
    const tokens = [
      `token-gate-${tokenCounter}-aaaaaaaa`,
      `token-gate-${tokenCounter}-bbbbbbbb`,
    ];
    const response = await worker.fetch(request('/v1/chat/completions', chatBody()), env(tokens));
    assert.equal(response.status, gate.status);
    const data = await response.json();
    assert.equal(data.error.code, gate.code);
    assert.equal(calls.filter((call) => call.path === '/api/v1/chat/completions').length, 1);
    assert.equal(calls.filter((call) => call.path === '/api/v1/freebuff/session' && call.method === 'DELETE').length, 0);
    const finish = calls.find((call) => call.path === '/api/v1/agent-runs' && call.body?.action === 'FINISH');
    assert.equal(finish.body.status, 'failed');

    if (gate.code === 'waiting_room_queued') {
      const health = await worker.fetch(new Request('http://local.test/healthz'), env(tokens));
      const snapshot = await health.json();
      assert.equal(snapshot.alive_accounts, 1);
      assert.equal(snapshot.unhealthy_accounts, 0);
    }
  });
}

test('session gate parsing ignores message and nested fields', async () => {
  const calls = [];
  mockUpstream({
    calls,
    onChat: () => Response.json(
      { error: 'other', nested: { value: 'session_superseded' }, message: 'session_superseded' },
      { status: 409 },
    ),
  });
  const tokens = [
    `token-exact-${tokenCounter}-aaaaaaaa`,
    `token-exact-${tokenCounter}-bbbbbbbb`,
  ];
  const response = await worker.fetch(request('/v1/chat/completions', chatBody()), env(tokens));
  assert.equal(response.status, 409);
  const chats = calls.filter((call) => call.path === '/api/v1/chat/completions');
  assert.equal(chats.length, 2);
  assert.equal(
    chats[0].body.codebuff_metadata.trace_session_id,
    chats[1].body.codebuff_metadata.trace_session_id,
  );
  assert.equal(
    chats[0].body.codebuff_metadata.client_id,
    chats[1].body.codebuff_metadata.client_id,
  );
});

test('session gate parsing also requires the matching HTTP status', async () => {
  const calls = [];
  mockUpstream({
    calls,
    onChat: () => Response.json({ error: 'session_superseded' }, { status: 429 }),
  });
  const tokens = [
    `token-status-${tokenCounter}-aaaaaaaa`,
    `token-status-${tokenCounter}-bbbbbbbb`,
  ];
  const response = await worker.fetch(request('/v1/chat/completions', chatBody()), env(tokens));
  assert.equal(response.status, 429);
  assert.equal(calls.filter((call) => call.path === '/api/v1/chat/completions').length, 2);
});

test('reasoning effort and trace metadata match the current model contract', async () => {
  const calls = [];
  mockUpstream({ calls });

  const pro = await worker.fetch(request(
    '/v1/chat/completions',
    chatBody('deepseek/deepseek-v4-pro', { reasoning_effort: 'low' }),
  ), env());
  assert.equal(pro.status, 200);

  const luna = await worker.fetch(request(
    '/v1/chat/completions',
    chatBody('openai/gpt-5.6-luna', { reasoning_effort: 'xhigh' }),
  ), env());
  assert.equal(luna.status, 200);

  const deepseekMedium = await worker.fetch(request(
    '/v1/chat/completions',
    chatBody('deepseek/deepseek-v4-flash', { reasoning_effort: 'medium' }),
  ), env());
  assert.equal(deepseekMedium.status, 200);

  const lunaUnknown = await worker.fetch(request(
    '/v1/chat/completions',
    chatBody('openai/gpt-5.6-luna', { reasoning_effort: 'bogus' }),
  ), env());
  assert.equal(lunaUnknown.status, 200);

  const payloads = calls
    .filter((call) => call.path === '/api/v1/chat/completions')
    .map((call) => call.body);
  assert.equal(payloads[0].reasoning_effort, 'low');
  assert.equal(payloads[1].reasoning_effort, 'xhigh');
  assert.equal(payloads[2].reasoning_effort, 'high');
  assert.equal(payloads[3].reasoning_effort, 'high');
  assert.ok(payloads.every((payload) => payload.codebuff_metadata.trace_session_id));
});

test('streaming inference stays serialized until the complete body finishes', async () => {
  const calls = [];
  let active = 0;
  let maxActive = 0;
  mockUpstream({
    calls,
    onChat: () => new Response(new ReadableStream({
      start(controller) {
        active += 1;
        maxActive = Math.max(maxActive, active);
        controller.enqueue(new TextEncoder().encode(
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'first' } }] })}\n\n`,
        ));
        setTimeout(() => {
          controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          active -= 1;
          controller.close();
        }, 120);
      },
    }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
  });

  const firstResponse = await worker.fetch(
    request('/v1/chat/completions', chatBody(undefined, { stream: true })),
    env([`token-serial-${tokenCounter}-aaaaaaaa`]),
  );
  const secondPending = worker.fetch(
    request('/v1/chat/completions', chatBody(undefined, { stream: true })),
    env([`token-serial-${tokenCounter}-bbbbbbbb`]),
  );
  const firstBody = firstResponse.text();
  const secondResponse = await secondPending;
  const secondBody = secondResponse.text();
  await Promise.all([firstBody, secondBody]);

  assert.equal(firstResponse.status, 200);
  assert.equal(secondResponse.status, 200);
  assert.equal(maxActive, 1);
});

test('downstream abort reaches the upstream chat fetch', async () => {
  const calls = [];
  let chatStarted;
  const started = new Promise((resolve) => { chatStarted = resolve; });
  let observedAbort = false;
  mockUpstream({
    calls,
    onChat: (call) => new Promise((resolve, reject) => {
      chatStarted();
      call.signal.addEventListener('abort', () => {
        observedAbort = true;
        reject(call.signal.reason || new Error('aborted'));
      }, { once: true });
    }),
  });

  const controller = new AbortController();
  const pending = worker.fetch(
    request('/v1/chat/completions', chatBody(), controller.signal),
    env([`token-abort-${tokenCounter}-aaaaaaaa`]),
  );
  await started;
  controller.abort(new Error('client closed'));
  const response = await pending;
  assert.equal(response.status, 499);
  assert.equal(observedAbort, true);
});

test('non-stream chat reconstructs fragmented tool calls', async () => {
  const calls = [];
  mockUpstream({
    calls,
    onChat: () => new Response([
      `data: ${JSON.stringify({ id: 'chat-tools', choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":' } }] }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"README.md"}' } }] }, finish_reason: 'tool_calls' }] })}\n\n`,
      'data: [DONE]\n\n',
    ].join(''), { headers: { 'Content-Type': 'text/event-stream' } }),
  });

  const response = await worker.fetch(request('/v1/chat/completions', chatBody()), env());
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.choices[0].finish_reason, 'tool_calls');
  assert.deepEqual(body.choices[0].message.tool_calls, [{
    id: 'call_1',
    type: 'function',
    function: { name: 'read_file', arguments: '{"path":"README.md"}' },
  }]);
});

test('Responses function_call history keeps the assistant call before its tool output', async () => {
  const calls = [];
  mockUpstream({ calls });
  const response = await worker.fetch(request('/v1/responses', {
    model: 'deepseek/deepseek-v4-flash',
    input: [
      { type: 'function_call', call_id: 'call_history', name: 'read_file', arguments: '{"path":"README.md"}' },
      { type: 'function_call_output', call_id: 'call_history', output: 'contents' },
    ],
    tools: [{ type: 'function', name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
    stream: false,
  }), env());
  assert.equal(response.status, 200);

  const upstream = calls.find((call) => call.path === '/api/v1/chat/completions');
  assert.deepEqual(upstream.body.messages.map((message) => message.role), ['system', 'assistant', 'tool']);
  assert.equal(upstream.body.messages[1].tool_calls[0].id, 'call_history');
  assert.equal(upstream.body.messages[2].tool_call_id, 'call_history');
});

test('Responses previous_response_id preserves trace_session_id but creates a new client id', async () => {
  const calls = [];
  mockUpstream({ calls });
  const firstResponse = await worker.fetch(request('/v1/responses', {
    model: 'deepseek/deepseek-v4-flash', input: 'first', stream: false,
  }), env());
  const first = await firstResponse.json();
  const secondResponse = await worker.fetch(request('/v1/responses', {
    model: 'deepseek/deepseek-v4-flash', input: 'second', previous_response_id: first.id, stream: false,
  }), env());
  const second = await secondResponse.json();
  assert.equal(second.previous_response_id, first.id);

  const payloads = calls.filter((call) => call.path === '/api/v1/chat/completions').map((call) => call.body);
  assert.equal(payloads.length, 2);
  assert.equal(payloads[0].codebuff_metadata.trace_session_id, payloads[1].codebuff_metadata.trace_session_id);
  assert.notEqual(payloads[0].codebuff_metadata.client_id, payloads[1].codebuff_metadata.client_id);
});

test('streaming Responses emits complete function-call argument events', async () => {
  const calls = [];
  mockUpstream({
    calls,
    onChat: () => new Response([
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_stream', type: 'function', function: { name: 'read_file', arguments: '{"path":' } }] } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"worker.js"}' } }] }, finish_reason: 'tool_calls' }] })}\n\n`,
      'data: [DONE]\n\n',
    ].join(''), { headers: { 'Content-Type': 'text/event-stream' } }),
  });
  const response = await worker.fetch(request('/v1/responses', {
    model: 'deepseek/deepseek-v4-flash', input: 'use tool', stream: true,
  }), env());
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.match(text, /"type":"response\.function_call_arguments\.delta"/);
  assert.match(text, /"type":"response\.function_call_arguments\.done"/);
  assert.match(text, /"arguments":"\{\\"path\\":\\"worker\.js\\"\}"/);
  assert.match(text, /"type":"response\.completed"/);
});

test('final SSE event without a trailing newline is still consumed', async () => {
  const calls = [];
  mockUpstream({
    calls,
    onChat: () => new Response(
      `data: ${JSON.stringify({ id: 'chat-final', choices: [{ delta: { content: 'last' }, finish_reason: 'stop' }] })}`,
      { headers: { 'Content-Type': 'text/event-stream' } },
    ),
  });
  const response = await worker.fetch(request('/v1/chat/completions', chatBody()), env());
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.choices[0].message.content, 'last');
});

test('invalid upstream SSE fails the run instead of returning an empty completed response', async () => {
  const calls = [];
  mockUpstream({
    calls,
    onChat: () => new Response('data: {not-json}\n\n', { headers: { 'Content-Type': 'text/event-stream' } }),
  });
  const response = await worker.fetch(request('/v1/chat/completions', chatBody()), env());
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.match(body.error.message, /invalid upstream SSE JSON/);
  const finish = calls.find((call) => call.path === '/api/v1/agent-runs' && call.body?.action === 'FINISH');
  assert.equal(finish.body.status, 'failed');
  assert.equal(finish.body.totalSteps, 1);
  assert.deepEqual(finish.body.steps, []);
});

test('multiple accounts are used in stable round-robin order while each reuses its own session', async () => {
  const calls = [];
  mockUpstream({ calls });
  const tokens = [
    `token-round-${tokenCounter}-aaaaaaaa`,
    `token-round-${tokenCounter}-bbbbbbbb`,
  ];
  for (let i = 0; i < 4; i++) {
    const response = await worker.fetch(request('/v1/chat/completions', chatBody()), env(tokens));
    assert.equal(response.status, 200);
  }
  const routes = calls
    .filter((call) => call.path === '/api/v1/chat/completions')
    .map((call) => call.auth);
  assert.equal(routes.length, 4);
  assert.notEqual(routes[0], routes[1]);
  assert.equal(routes[0], routes[2]);
  assert.equal(routes[1], routes[3]);
  const sessionCreates = calls.filter((call) => call.path === '/api/v1/freebuff/session' && call.method === 'POST');
  assert.equal(sessionCreates.length, 2);
});

test('account retry never selects the same account twice in one request', async () => {
  const calls = [];
  let attempt = 0;
  mockUpstream({
    calls,
    onChat: () => {
      attempt += 1;
      return attempt === 1 ? Response.json({ error: 'temporary' }, { status: 500 }) : sse('recovered');
    },
  });
  const tokens = [
    `token-retry-${tokenCounter}-aaaaaaaa`,
    `token-retry-${tokenCounter}-bbbbbbbb`,
  ];
  const response = await worker.fetch(request('/v1/chat/completions', chatBody()), env(tokens));
  assert.equal(response.status, 200);
  const routes = calls.filter((call) => call.path === '/api/v1/chat/completions').map((call) => call.auth);
  assert.equal(routes.length, 2);
  assert.notEqual(routes[0], routes[1]);
});
