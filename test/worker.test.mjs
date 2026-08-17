import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { after, beforeEach, test } from 'node:test';

import worker, { closeOwnedSessions } from '../worker.js';

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
  const accounts = Object.fromEntries(tokens.map((authToken, index) => [
    `test-account-${index}`,
    { id: `test-account-${index}`, authToken, fingerprintId: `test-fingerprint-${index}` },
  ]));
  return {
    FREEBUFF_CREDENTIALS_JSON: JSON.stringify({ accounts }),
    FREEBUFF_API_KEY: API_KEY,
    FREEBUFF_DEBUG: 'false',
  };
}

function request(path, body, signal, apiKey = API_KEY, extraHeaders = {}) {
  return new Request(`http://local.test${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...extraHeaders,
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

function sseError(message = 'upstream overloaded') {
  return new Response([
    `data: ${JSON.stringify({ error: { message, type: 'server_error', code: 'overloaded' } })}\n\n`,
    'data: [DONE]\n\n',
  ].join(''), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function mockUpstream({ onChat, onSessionGet, onSessionPost, onSessionDelete, calls }) {
  let runNumber = 0;
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    const body = init.body ? JSON.parse(init.body) : null;
    const call = {
      path: parsed.pathname,
      method: init.method || 'GET',
      auth: init.headers?.Authorization || init.headers?.authorization || null,
      headers: Object.fromEntries(Object.entries(init.headers || {}).map(([key, value]) => [key.toLowerCase(), value])),
      body,
      signal: init.signal,
    };
    calls.push(call);

    if (parsed.pathname === '/api/v1/ads' && call.method === 'POST') {
      return Response.json({ ads: [{ impUrl: 'https://ads.local/impression/1' }] });
    }
    if (parsed.pathname === '/api/v1/ads/impression' && call.method === 'POST') {
      return Response.json({ ok: true });
    }
    if (parsed.pathname === '/api/v1/usage') return Response.json({ ok: true });
    if (parsed.pathname === '/api/v1/freebuff/session' && call.method === 'GET') {
      return Response.json(onSessionGet ? onSessionGet(call) : { status: 'ended' }, { status: 200 });
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
      const result = onSessionDelete ? onSessionDelete(call) : { ok: true };
      return result instanceof Response ? result : Response.json(result);
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
  const response = await worker.fetch(request('/v1/models'), { FREEBUFF_CREDENTIALS_JSON: JSON.stringify({ accounts: { test: { authToken: 'token-aaaaaaaa', fingerprintId: 'fp-test' } } }) });
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

test('main-branch client behavior uses the account fingerprint', async () => {
  const calls = [];
  mockUpstream({ calls });
  const response = await worker.fetch(
    request('/v1/chat/completions', chatBody()),
    {
      ...env(),
      FREEBUFF_CLIENT_BEHAVIOR: 'cli',
      FREEBUFF_CREDENTIALS_JSON: JSON.stringify({ accounts: { test: { authToken: `token-test-${tokenCounter}-aaaaaaaa`, fingerprintId: 'fp-test-stable' } } }),
    },
  );
  assert.equal(response.status, 200);
  const behaviorCalls = calls.filter((call) => ['/api/v1/ads', '/api/v1/ads/impression', '/api/v1/usage'].includes(call.path));
  assert.deepEqual(behaviorCalls.map((call) => call.path), [
    '/api/v1/ads',
    '/api/v1/ads/impression',
    '/api/v1/usage',
  ]);
  assert.deepEqual(behaviorCalls[2].body, { fingerprintId: 'fp-test-stable' });
});

test('an owned session below the reuse window is deleted and recreated', async () => {
  const calls = [];
  const token = `token-expiring-${tokenCounter}-aaaaaaaa`;
  let currentSession = null;
  let sessionNumber = 0;
  mockUpstream({
    calls,
    onSessionGet: () => currentSession || { status: 'ended' },
    onSessionPost: () => {
      sessionNumber += 1;
      currentSession = {
        status: 'active',
        instanceId: `expiring-instance-${sessionNumber}`,
        model: 'deepseek/deepseek-v4-flash',
        remainingMs: sessionNumber === 1 ? 30_000 : 3_600_000,
      };
      return currentSession;
    },
    onSessionDelete: (call) => {
      assert.equal(call.signal.aborted, false);
      assert.equal(currentSession.instanceId, 'expiring-instance-1');
      assert.equal(call.headers['x-freebuff-instance-id'], undefined);
      currentSession = null;
      return { ok: true };
    },
  });

  const first = await worker.fetch(request('/v1/chat/completions', chatBody()), env([token]));
  const second = await worker.fetch(request('/v1/chat/completions', chatBody()), env([token]));

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(calls.filter((call) => call.path === '/api/v1/freebuff/session' && call.method === 'POST').length, 2);
  assert.equal(calls.filter((call) => call.path === '/api/v1/freebuff/session' && call.method === 'DELETE').length, 1);
  assert.equal(calls.filter((call) => call.path === '/api/v1/chat/completions').length, 2);
});

test('a failed session DELETE retains owner evidence for a later cleanup retry', async () => {
  const calls = [];
  const token = `token-delete-retry-${tokenCounter}-aaaaaaaa`;
  let deleteAttempts = 0;
  mockUpstream({
    calls,
    onSessionPost: () => ({
      status: 'active',
      instanceId: 'delete-retry-instance',
      model: 'deepseek/deepseek-v4-flash',
      remainingMs: 3_600_000,
    }),
    onSessionDelete: (call) => {
      if (call.auth === `Bearer ${token}`) deleteAttempts += 1;
      return Response.json({ error: 'temporary failure' }, { status: 500 });
    },
  });

  const response = await worker.fetch(request('/v1/chat/completions', chatBody()), env([token]));
  assert.equal(response.status, 200);
  await closeOwnedSessions();
  await closeOwnedSessions();
  assert.equal(deleteAttempts, 2);
});

test('waiting_room_required preserves ownership for a subsequent retry', async () => {
  const calls = [];
  const token = `token-waiting-owner-${tokenCounter}-aaaaaaaa`;
  let currentSession = null;
  let chatCount = 0;
  mockUpstream({
    calls,
    onSessionGet: () => currentSession || { status: 'ended' },
    onSessionPost: () => {
      currentSession = {
        status: 'active',
        instanceId: 'waiting-owner-instance',
        model: 'deepseek/deepseek-v4-flash',
        remainingMs: 3_600_000,
      };
      return currentSession;
    },
    onChat: () => {
      chatCount += 1;
      return chatCount === 1
        ? Response.json({ error: 'waiting_room_required', message: 'try again' }, { status: 428 })
        : sse('recovered');
    },
  });

  const first = await worker.fetch(request('/v1/chat/completions', chatBody()), env([token]));
  const second = await worker.fetch(request('/v1/chat/completions', chatBody()), env([token]));

  assert.equal(first.status, 428);
  assert.equal(second.status, 200);
  assert.equal(calls.filter((call) => call.path === '/api/v1/freebuff/session' && call.method === 'POST').length, 1);
  assert.equal(calls.filter((call) => call.path === '/api/v1/freebuff/session' && call.method === 'DELETE').length, 0);
  assert.equal(calls.filter((call) => call.path === '/api/v1/chat/completions').length, 2);
});

test('top-level SSE errors fail non-stream Chat and Responses runs', async () => {
  const calls = [];
  mockUpstream({ calls, onChat: () => sseError() });

  const chat = await worker.fetch(
    request('/v1/chat/completions', chatBody()),
    env([`token-sse-error-chat-${tokenCounter}-aaaaaaaa`]),
  );
  const responses = await worker.fetch(
    request('/v1/responses', {
      model: 'deepseek/deepseek-v4-flash',
      input: 'test',
      stream: false,
    }),
    env([`token-sse-error-responses-${tokenCounter}-aaaaaaaa`]),
  );

  assert.equal(chat.status, 502);
  assert.equal(responses.status, 502);
  const finishes = calls.filter((call) => call.path === '/api/v1/agent-runs' && call.body?.action === 'FINISH');
  assert.equal(finishes.length, 2);
  assert.ok(finishes.every((finish) => finish.body.status === 'failed'));
  assert.ok(finishes.every((finish) => /upstream SSE error/.test(finish.body.errorMessage)));
});

test('top-level SSE errors terminate streaming Chat and Responses as failures', async () => {
  const calls = [];
  mockUpstream({ calls, onChat: () => sseError('stream failed') });

  const chat = await worker.fetch(
    request('/v1/chat/completions', chatBody(undefined, { stream: true })),
    env([`token-sse-stream-chat-${tokenCounter}-aaaaaaaa`]),
  );
  const chatText = await chat.text();
  const responses = await worker.fetch(
    request('/v1/responses', {
      model: 'deepseek/deepseek-v4-flash',
      input: 'test',
      stream: true,
    }),
    env([`token-sse-stream-responses-${tokenCounter}-aaaaaaaa`]),
  );
  const responsesText = await responses.text();

  assert.equal(chat.status, 200);
  assert.match(chatText, /"type":"upstream_protocol_error"/);
  assert.match(chatText, /data: \[DONE\]/);
  assert.equal(responses.status, 200);
  assert.match(responsesText, /"type":"response\.failed"/);
  assert.doesNotMatch(responsesText, /"type":"response\.completed"/);
  const finishes = calls.filter((call) => call.path === '/api/v1/agent-runs' && call.body?.action === 'FINISH');
  assert.equal(finishes.length, 2);
  assert.ok(finishes.every((finish) => finish.body.status === 'failed'));
});

test('top-level SSE errors become Anthropic error events', async () => {
  const calls = [];
  mockUpstream({ calls, onChat: () => sseError('anthropic stream failed') });
  const response = await worker.fetch(new Request('http://local.test/v1/messages', {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek/deepseek-v4-flash',
      max_tokens: 64,
      stream: true,
      messages: [{ role: 'user', content: 'test' }],
    }),
  }), env([`token-sse-anthropic-${tokenCounter}-aaaaaaaa`]));
  const text = await response.text();

  assert.equal(response.status, 200);
  assert.match(text, /event: error/);
  assert.match(text, /anthropic stream failed/);
  assert.doesNotMatch(text, /event: message_stop/);
  const finish = calls.find((call) => call.path === '/api/v1/agent-runs' && call.body?.action === 'FINISH');
  assert.equal(finish.body.status, 'failed');
});

test('session_model_mismatch releases the proven owner instead of forgetting it', async () => {
  const calls = [];
  mockUpstream({
    calls,
    onChat: () => Response.json({ error: 'session_model_mismatch', message: 'wrong model' }, { status: 409 }),
  });
  const token = `token-model-mismatch-${tokenCounter}-aaaaaaaa`;
  const response = await worker.fetch(request('/v1/chat/completions', chatBody()), env([token]));
  assert.equal(response.status, 409);
  const deletes = calls.filter((call) => call.path === '/api/v1/freebuff/session' && call.method === 'DELETE');
  assert.equal(deletes.length, 1);
  assert.equal(deletes[0].auth, `Bearer ${token}`);
});

test('retries no_endpoints_found with one session rebuild', async () => {
  const calls = [];
  let attempts = 0;
  mockUpstream({ calls, onChat: () => ++attempts === 1
    ? Response.json({ error: 'no_endpoints_found', message: 'No endpoints found' }, { status: 404 })
    : sse('recovered') });
  const r = await worker.fetch(request('/v1/chat/completions', chatBody()), env());
  assert.equal(r.status, 200);
  assert.equal(attempts, 2);
  assert.equal(calls.filter((x) => x.path === '/api/v1/freebuff/session' && x.method === 'POST').length, 2);
  assert.equal(calls.filter((x) => x.path === '/api/v1/freebuff/session' && x.method === 'DELETE').length, 1);
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
  const finish = calls.find((call) => call.path === '/api/v1/agent-runs' && call.body?.action === 'FINISH');
  assert.equal(finish.body.status, 'cancelled');
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

test('Harness mode aliases its generic tools to the native Freebuff tool names', async () => {
  const calls = [];
  mockUpstream({
    calls,
    onChat: (call) => {
      assert.deepEqual(call.body.tools.map((tool) => tool.function.name), [
        'run_terminal_command', 'read_files', 'write_file', 'str_replace', 'write_todos',
      ]);
      assert.equal(call.body.messages[2].tool_calls[0].function.name, 'run_terminal_command');
      return new Response([
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'native-call', type: 'function', function: { name: 'run_terminal_command', arguments: '{"command":"pwd"}' } }] }, finish_reason: 'tool_calls' }] })}\n\n`,
        'data: [DONE]\n\n',
      ].join(''), { headers: { 'Content-Type': 'text/event-stream' } });
    },
  });
  const response = await worker.fetch(request('/v1/chat/completions', chatBody(undefined, {
    tools: [
      { type: 'function', function: { name: 'bash', description: 'run', parameters: { type: 'object' } } },
      { type: 'function', function: { name: 'read', description: 'read', parameters: { type: 'object' } } },
      { type: 'function', function: { name: 'write', description: 'write', parameters: { type: 'object' } } },
      { type: 'function', function: { name: 'edit', description: 'edit', parameters: { type: 'object' } } },
      { type: 'function', function: { name: 'todo_write', description: 'todo', parameters: { type: 'object' } } },
    ],
    messages: [
      { role: 'user', content: 'run a command' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'old-call', type: 'function', function: { name: 'bash', arguments: '{"command":"pwd"}' } }] },
      { role: 'tool', tool_call_id: 'old-call', content: '/workspace' },
    ],
  }), undefined, API_KEY, { 'x-deepseek-harness-user-id': 'harness-user' }), env());
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.choices[0].finish_reason, 'tool_calls');
  assert.equal(body.choices[0].message.tool_calls[0].function.name, 'bash');
});

test('Harness model aliases resolve to the canonical Freebuff model', async () => {
  const calls = [];
  mockUpstream({ calls });
  const response = await worker.fetch(request('/v1/chat/completions', chatBody('deepseek-v4-flash')), env());
  assert.equal(response.status, 200);
  const chat = calls.find((call) => call.path === '/api/v1/chat/completions');
  assert.equal(chat.body.model, 'deepseek/deepseek-v4-flash');
});

test('Harness thinking mode is forwarded to the Freebuff chat request', async () => {
  const calls = [];
  mockUpstream({ calls });
  const response = await worker.fetch(request('/v1/chat/completions', chatBody('deepseek-v4-flash', {
    thinking: { type: 'enabled' },
    stream_options: { include_usage: true },
  })), env());
  assert.equal(response.status, 200);
  const chat = calls.find((call) => call.path === '/api/v1/chat/completions');
  assert.deepEqual(chat.body.thinking, { type: 'enabled' });
  assert.deepEqual(chat.body.stream_options, { include_usage: true });
});

test('Harness tool aliases are opt-in for non-Harness clients', async () => {
  const calls = [];
  mockUpstream({
    calls,
    onChat: (call) => {
      assert.equal(call.body.tools[0].function.name, 'bash');
      return sse('plain');
    },
  });
  const response = await worker.fetch(request('/v1/chat/completions', chatBody(undefined, {
    tools: [{ type: 'function', function: { name: 'bash', description: 'run', parameters: { type: 'object' } } }],
  })), env());
  assert.equal(response.status, 200);
});

test('Harness Chat tool turns reuse one native run across the session header', async () => {
  const calls = [];
  let chatCount = 0;
  mockUpstream({
    calls,
    onChat: () => {
      chatCount += 1;
      if (chatCount === 1) {
        return new Response([
          `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'native-call', type: 'function', function: { name: 'run_terminal_command', arguments: '{"command":"pwd"}' } }] }, finish_reason: 'tool_calls' }] })}\n\n`,
          'data: [DONE]\n\n',
        ].join(''), { headers: { 'Content-Type': 'text/event-stream' } });
      }
      return sse('done');
    },
  });
  const headers = { 'x-deepseek-harness-session-id': 'harness-session-1' };
  const first = await worker.fetch(request('/v1/chat/completions', chatBody(undefined, {
    tools: [{ type: 'function', function: { name: 'bash', description: 'run', parameters: { type: 'object' } } }],
  }), undefined, API_KEY, headers), env());
  assert.equal(first.status, 200);
  const firstBody = await first.json();
  assert.equal(firstBody.choices[0].message.tool_calls[0].function.name, 'bash');

  const second = await worker.fetch(request('/v1/chat/completions', chatBody(undefined, {
    tools: [{ type: 'function', function: { name: 'bash', description: 'run', parameters: { type: 'object' } } }],
    messages: [
      { role: 'user', content: 'run a command' },
      firstBody.choices[0].message,
      { role: 'tool', tool_call_id: 'native-call', content: '/workspace' },
    ],
  }), undefined, API_KEY, headers), env());
  assert.equal(second.status, 200);
  const starts = calls.filter((call) => call.path === '/api/v1/agent-runs' && call.body?.action === 'START');
  const finishes = calls.filter((call) => call.path === '/api/v1/agent-runs' && call.body?.action === 'FINISH');
  assert.equal(starts.length, 1);
  assert.equal(finishes.length, 1);
  assert.equal(finishes[0].body.totalSteps, 2);
  assert.equal(finishes[0].body.steps.length, 2);
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

test('Responses tool continuation reuses the run and accumulates the step ledger', async () => {
  const calls = [];
  let chatNumber = 0;
  mockUpstream({
    calls,
    onChat: () => {
      chatNumber += 1;
      if (chatNumber === 1) {
        return new Response([
          `data: ${JSON.stringify({ id: 'chat-continuation-1', choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_continue', type: 'function', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }] }, finish_reason: 'tool_calls' }] })}\n\n`,
          'data: [DONE]\n\n',
        ].join(''), { headers: { 'Content-Type': 'text/event-stream' } });
      }
      return sse('continuation complete');
    },
  });

  const firstResponse = await worker.fetch(request('/v1/responses', {
    model: 'deepseek/deepseek-v4-flash',
    input: 'use a tool',
    tools: [{ type: 'function', name: 'read_file', parameters: { type: 'object' } }],
    stream: false,
  }), env());
  const first = await firstResponse.json();
  assert.equal(firstResponse.status, 200);
  assert.equal(first.output[0].type, 'function_call');

  const secondResponse = await worker.fetch(request('/v1/responses', {
    model: 'deepseek/deepseek-v4-flash',
    previous_response_id: first.id,
    input: [
      { type: 'function_call', call_id: 'call_continue', name: 'read_file', arguments: '{"path":"README.md"}' },
      { type: 'function_call_output', call_id: 'call_continue', output: 'contents' },
    ],
    stream: false,
  }), env());
  assert.equal(secondResponse.status, 200);

  const starts = calls.filter((call) => call.path === '/api/v1/agent-runs' && call.body?.action === 'START');
  const finishes = calls.filter((call) => call.path === '/api/v1/agent-runs' && call.body?.action === 'FINISH');
  const payloads = calls.filter((call) => call.path === '/api/v1/chat/completions').map((call) => call.body);
  assert.equal(starts.length, 1);
  assert.equal(finishes.length, 1);
  assert.equal(finishes[0].body.totalSteps, 2);
  assert.equal(finishes[0].body.steps.length, 2);
  assert.equal(payloads[0].codebuff_metadata.run_id, payloads[1].codebuff_metadata.run_id);
  assert.equal(payloads[0].codebuff_metadata.llm_step_number, '1');
  assert.equal(payloads[1].codebuff_metadata.llm_step_number, '2');
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
  assert.equal(calls.filter((call) => call.path === '/api/v1/agent-runs' && call.body?.action === 'FINISH').length, 0);
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

test('explicit acting-user identity is forwarded only to agent-runs', async () => {
  const calls = [];
  mockUpstream({ calls });
  const response = await worker.fetch(
    request('/v1/chat/completions', chatBody()),
    { ...env(), FREEBUFF_ACTING_USER_ID: 'user-explicit-1' },
  );
  assert.equal(response.status, 200);
  const runs = calls.filter((call) => call.path === '/api/v1/agent-runs');
  assert.equal(runs.length, 2);
  assert.equal(runs[0].headers['x-freebuff-acting-user-id'], 'user-explicit-1');
  assert.equal(runs[1].headers['x-freebuff-acting-user-id'], 'user-explicit-1');
  const nonRuns = calls.filter((call) => call.path !== '/api/v1/agent-runs');
  assert.equal(nonRuns.some((call) => call.headers['x-freebuff-acting-user-id']), false);
});

test('an omitted model follows the CLI selectedModel default to DeepSeek V4 Pro', async () => {
  const calls = [];
  mockUpstream({ calls });
  const body = chatBody();
  delete body.model;
  const response = await worker.fetch(request('/v1/chat/completions', body), env());
  assert.equal(response.status, 200);
  const sessionPost = calls.find((call) => call.path === '/api/v1/freebuff/session' && call.method === 'POST');
  const chat = calls.find((call) => call.path === '/api/v1/chat/completions');
  assert.equal(sessionPost.headers['x-freebuff-model'], 'deepseek/deepseek-v4-pro');
  assert.equal(chat.body.model, 'deepseek/deepseek-v4-pro');
});

test('default CLI request sequence keeps account fingerprint only in usage and preserves wire fields', async () => {
  const calls = [];
  mockUpstream({ calls });
  const response = await worker.fetch(request('/v1/chat/completions', chatBody()), env());
  assert.equal(response.status, 200);
  const ads = calls.find((call) => call.path === '/api/v1/ads');
  const usage = calls.find((call) => call.path === '/api/v1/usage');
  const sessionPost = calls.find((call) => call.path === '/api/v1/freebuff/session' && call.method === 'POST');
  const chat = calls.find((call) => call.path === '/api/v1/chat/completions');
  const runCalls = calls.filter((call) => call.path === '/api/v1/agent-runs');
  assert.equal(ads.headers.authorization, sessionPost.headers.authorization);
  assert.equal(ads.headers['user-agent'], 'Freebuff-CLI/0.0.149');
  assert.equal(ads.body.provider, 'gravity');
  assert.equal(ads.body.messages[0].role, 'user');
  assert.equal(typeof ads.body.sessionId, 'string');
  assert.equal(ads.body.device.os, 'linux');
  assert.match(ads.body.userAgent, /Chrome\/124\.0\.0\.0/);
  assert.deepEqual(usage.body, { fingerprintId: 'test-fingerprint-0' });
  assert.equal(usage.headers.authorization, sessionPost.headers.authorization);
  assert.equal(sessionPost.headers['x-freebuff-model'], 'deepseek/deepseek-v4-flash');
  assert.equal(chat.headers['user-agent'], 'ai-sdk/openai-compatible/0.0.149/codebuff');
  assert.equal(chat.headers['x-freebuff-instance-id'], sessionPost.body?.instanceId || `instance-${sessionPost.auth}`);
  assert.equal(chat.body.provider.data_collection, 'deny');
  assert.equal(chat.body.codebuff_metadata.cost_mode, 'free');
  assert.equal(chat.body.codebuff_metadata.llm_step_number, '1');
  for (const call of [sessionPost, chat, ...runCalls]) {
    assert.equal(Object.hasOwn(call.body || {}, 'fingerprintId'), false);
    assert.equal(Object.hasOwn(call.headers, 'fingerprintid'), false);
  }
});

test("official credentials JSON maps only authToken and usage fingerprintId", async () => {
  const calls = [];
  mockUpstream({ calls });
  const credentials = {
    accounts: {
      official: {
        id: "official-user-42",
        name: "official-name-must-not-leak",
        email: "official-email-must-not-leak@example.test",
        authToken: "official-token-aaaaaaaa",
        fingerprintId: "enhanced-official-fingerprint",
        fingerprintHash: "official-hash-must-not-leak",
      },
    },
  };
  const runtime = env([]);
  runtime.FREEBUFF_CREDENTIALS_JSON = JSON.stringify(credentials);
  const response = await worker.fetch(request("/v1/chat/completions", chatBody()), runtime);
  assert.equal(response.status, 200);
  assert.equal(calls.every((call) => call.auth === "Bearer official-token-aaaaaaaa"), true);
  const usage = calls.find((call) => call.path === "/api/v1/usage");
  assert.deepEqual(usage.body, { fingerprintId: "enhanced-official-fingerprint" });
  const agentRuns = calls.filter((call) => call.path === "/api/v1/agent-runs");
  assert.equal(agentRuns.some((call) => Object.hasOwn(call.headers, "x-freebuff-acting-user-id")), false);
  for (const call of calls) {
    const requestWire = JSON.stringify({ headers: call.headers, body: call.body });
    assert.equal(requestWire.includes(credentials.accounts.official.id), false);
    assert.equal(requestWire.includes(credentials.accounts.official.name), false);
    assert.equal(requestWire.includes(credentials.accounts.official.email), false);
    assert.equal(requestWire.includes(credentials.accounts.official.fingerprintHash), false);
  }
});

test("rotates complete accounts and keeps each authToken paired with its fingerprintId", async () => {
  const calls = [];
  mockUpstream({ calls });
  const accountA = {
    id: `rotation-user-a-${tokenCounter}`,
    authToken: `rotation-token-a-${tokenCounter}-aaaaaaaa`,
    fingerprintId: `rotation-fingerprint-a-${tokenCounter}`,
    email: "must-not-enter-wire-a@example.test",
  };
  const accountB = {
    id: `rotation-user-b-${tokenCounter}`,
    authToken: `rotation-token-b-${tokenCounter}-bbbbbbbb`,
    fingerprintId: `rotation-fingerprint-b-${tokenCounter}`,
    email: "must-not-enter-wire-b@example.test",
  };
  const runtime = env([]);
  runtime.FREEBUFF_CREDENTIALS_JSON = JSON.stringify({
    accounts: { first: accountA, second: accountB },
  });

  const first = await worker.fetch(request("/v1/chat/completions", chatBody("deepseek/deepseek-v4-flash", {
    messages: [{ role: "user", content: "rotation request one" }],
  })), runtime);
  const second = await worker.fetch(request("/v1/chat/completions", chatBody("deepseek/deepseek-v4-flash", {
    messages: [{ role: "user", content: "rotation request two" }],
  })), runtime);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);

  const chatCalls = calls.filter((call) => call.path === "/api/v1/chat/completions");
  assert.equal(chatCalls.length, 2);
  assert.deepEqual(new Set(chatCalls.map((call) => call.auth)), new Set([
    `Bearer ${accountA.authToken}`,
    `Bearer ${accountB.authToken}`,
  ]));

  const usageByAuth = new Map(calls
    .filter((call) => call.path === "/api/v1/usage")
    .map((call) => [call.auth, call.body?.fingerprintId]));
  assert.equal(usageByAuth.get(`Bearer ${accountA.authToken}`), accountA.fingerprintId);
  assert.equal(usageByAuth.get(`Bearer ${accountB.authToken}`), accountB.fingerprintId);

  const wire = JSON.stringify(calls);
  assert.equal(wire.includes(accountA.email), false);
  assert.equal(wire.includes(accountB.email), false);
  assert.equal(wire.includes(accountA.id), false);
  assert.equal(wire.includes(accountB.id), false);
});

test("invalid or non-canonical credentials JSON does not create an account", async () => {
  for (const raw of [undefined, "{invalid-json", JSON.stringify({ default: { authToken: "short" } }), JSON.stringify([{ authToken: "token-aaaaaaaa", fingerprintId: "fp" }]), JSON.stringify({ accounts: { only: { authToken: "token-aaaaaaaa" } } })]) {
    const runtime = env([]);
    if (raw !== undefined) runtime.FREEBUFF_CREDENTIALS_JSON = raw;
    const response = await worker.fetch(request("/v1/chat/completions", chatBody()), runtime);
    assert.equal(response.status, 503);
  }
});

test("mixed valid and invalid accounts fail closed", async () => {
  const runtime = env([]);
  runtime.FREEBUFF_CREDENTIALS_JSON = JSON.stringify({
    accounts: {
      valid: { authToken: "token-valid-aaaaaaaa", fingerprintId: "fp-valid" },
      invalid: { authToken: "token-invalid-aaaaaaaa" },
    },
  });
  const response = await worker.fetch(request("/v1/chat/completions", chatBody()), runtime);
  assert.equal(response.status, 503);
});
test("legacy token and global fingerprint inputs are not accepted", async () => {
  const tokenOnly = await worker.fetch(request('/v1/chat/completions', chatBody()), {
    FREEBUFF_TOKEN: 'legacy-token-aaaaaaaa',
    FREEBUFF_API_KEY: API_KEY,
  });
  assert.equal(tokenOnly.status, 503);
  const fingerprintOnly = await worker.fetch(request('/v1/chat/completions', chatBody()), {
    FREEBUFF_FINGERPRINT_ID: 'legacy-fingerprint',
    FREEBUFF_API_KEY: API_KEY,
  });
  assert.equal(fingerprintOnly.status, 503);
});
