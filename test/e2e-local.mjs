import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const upstreamPort = Number(process.env.E2E_UPSTREAM_PORT || 18999);
const serverPort = Number(process.env.E2E_SERVER_PORT || 19000);
const upstreamCalls = [];
let runNumber = 0;

const upstream = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const bodyText = Buffer.concat(chunks).toString();
  const body = bodyText ? JSON.parse(bodyText) : null;
  upstreamCalls.push({
    method: request.method,
    path: request.url,
    auth: request.headers.authorization,
    body,
  });

  response.setHeader('content-type', 'application/json');
  if (request.url === '/api/v1/freebuff/session' && request.method === 'GET') {
    return response.end(JSON.stringify({ status: 'ended' }));
  }
  if (request.url === '/api/v1/freebuff/session' && request.method === 'POST') {
    return response.end(JSON.stringify({
      status: 'active',
      instanceId: `inst-${request.headers.authorization}`,
      model: request.headers['x-freebuff-model'],
      remainingMs: 3_600_000,
    }));
  }
  if (request.url === '/api/v1/freebuff/session' && request.method === 'DELETE') {
    return response.end(JSON.stringify({ ok: true }));
  }
  if (request.url === '/api/v1/agent-runs' && body?.action === 'START') {
    return response.end(JSON.stringify({ runId: `run-${++runNumber}` }));
  }
  if (request.url === '/api/v1/agent-runs' && body?.action === 'FINISH') {
    return response.end(JSON.stringify({ ok: true }));
  }
  if (request.url === '/api/v1/chat/completions') {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(
      `data: ${JSON.stringify({
        id: 'chat-e2e',
        model: 'deepseek/deepseek-v4-flash',
        choices: [{ delta: { content: 'e2e-ok' }, finish_reason: 'stop' }],
      })}\n\ndata: [DONE]\n\n`,
    );
    return;
  }
  response.statusCode = 404;
  response.end(JSON.stringify({ error: 'not found' }));
});

function waitForExit(child) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolveExit) => child.once('exit', resolveExit));
}

let child = null;
try {
  await new Promise((resolveListen) => upstream.listen(upstreamPort, '127.0.0.1', resolveListen));
  child = spawn(process.execPath, ['server.js'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(serverPort),
      CODEBUFF_API: `http://127.0.0.1:${upstreamPort}`,
      FREEBUFF_API_KEY: 'e2e-key',
      FREEBUFF_CREDENTIALS_JSON: JSON.stringify({ accounts: {
        a: { authToken: 'token-e2e-a-aaaaaaaa', fingerprintId: 'fp-e2e-a' },
        b: { authToken: 'token-e2e-b-bbbbbbbb', fingerprintId: 'fp-e2e-b' },
      } }),
      FREEBUFF_DEBUG: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let logs = '';
  child.stdout.on('data', (buffer) => { logs += buffer; });
  child.stderr.on('data', (buffer) => { logs += buffer; });
  for (let attempt = 0; attempt < 50 && !logs.includes('listening'); attempt++) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  if (!logs.includes('listening')) throw new Error(`server did not start: ${logs}`);

  const headers = {
    authorization: 'Bearer e2e-key',
    'content-type': 'application/json',
  };
  const health = await fetch(`http://127.0.0.1:${serverPort}/healthz`).then((response) => response.json());
  const outputs = [];
  for (let index = 0; index < 4; index++) {
    const response = await fetch(`http://127.0.0.1:${serverPort}/v1/responses`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'deepseek/deepseek-v4-flash',
        input: 'test',
        stream: false,
      }),
    });
    outputs.push({ status: response.status, body: await response.json() });
  }

  const routes = upstreamCalls
    .filter((call) => call.path === '/api/v1/chat/completions')
    .map((call) => call.auth);
  child.kill('SIGTERM');
  await waitForExit(child);

  const finish = upstreamCalls
    .filter((call) => call.path === '/api/v1/agent-runs' && call.body?.action === 'FINISH')
    .map((call) => ({ totalSteps: call.body.totalSteps, steps: call.body.steps?.length }));
  const deletes = upstreamCalls
    .filter((call) => call.path === '/api/v1/freebuff/session' && call.method === 'DELETE')
    .length;
  const result = {
    health,
    statuses: outputs.map((output) => output.status),
    texts: outputs.map((output) => output.body.output?.[0]?.content?.[0]?.text),
    routes,
    finish,
    deletes,
  };

  assert.deepEqual(result.statuses, [200, 200, 200, 200]);
  assert.deepEqual(result.texts, ['e2e-ok', 'e2e-ok', 'e2e-ok', 'e2e-ok']);
  assert.equal(routes[0], routes[2]);
  assert.equal(routes[1], routes[3]);
  assert.notEqual(routes[0], routes[1]);
  assert.ok(finish.every((record) => record.totalSteps === 1 && record.steps === 1));
  assert.equal(deletes, 2);
  console.log(JSON.stringify(result, null, 2));
} finally {
  if (child?.exitCode === null) {
    child.kill('SIGKILL');
    await waitForExit(child);
  }
  if (upstream.listening) {
    await new Promise((resolveClose) => upstream.close(resolveClose));
  }
}
