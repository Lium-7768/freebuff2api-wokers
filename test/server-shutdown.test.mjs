import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';

const projectRoot = new URL('..', import.meta.url);

function withTimeout(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function unusedPort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
}

async function readUntil(reader, expected) {
  const decoder = new TextDecoder();
  let text = '';
  while (!text.includes(expected)) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

test('SIGTERM aborts a request whose FINISH is hanging and still deletes the owned session', async () => {
  const upstreamSockets = new Set();
  const finishes = [];
  let deleteCount = 0;
  const instanceId = 'shutdown-owned-instance';

  const upstream = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const body = await readJson(req);

    if (url.pathname === '/api/v1/freebuff/session' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ended' }));
      return;
    }
    if (url.pathname === '/api/v1/freebuff/session' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        status: 'active',
        instanceId,
        model: req.headers['x-freebuff-model'],
        remainingMs: 3_600_000,
      }));
      return;
    }
    if (url.pathname === '/api/v1/freebuff/session' && req.method === 'DELETE') {
      assert.equal(req.headers['x-freebuff-instance-id'], undefined);
      deleteCount += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (url.pathname === '/api/v1/agent-runs' && body?.action === 'START') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ runId: 'shutdown-run' }));
      return;
    }
    if (url.pathname === '/api/v1/agent-runs' && body?.action === 'FINISH') {
      finishes.push(body);
      // Deliberately hang the control request. The proxy must propagate the
      // shutdown abort signal to FINISH so the shared queue can reach DELETE.
      return new Promise(() => {});
    }
    if (url.pathname === '/api/v1/chat/completions' && req.method === 'POST') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(`data: ${JSON.stringify({
        id: 'shutdown-chat',
        choices: [{ index: 0, delta: { content: 'started' }, finish_reason: null }],
      })}\n\n`);
      setTimeout(() => {
        res.write('data: [DONE]\n\n');
        res.end();
      }, 50);
      return;
    }

    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: `unexpected ${req.method} ${url.pathname}` }));
  });
  upstream.on('connection', (socket) => {
    upstreamSockets.add(socket);
    socket.once('close', () => upstreamSockets.delete(socket));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const upstreamPort = upstream.address().port;
  const proxyPort = await unusedPort();

  const child = spawn(process.execPath, ['server.js'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(proxyPort),
      CODEBUFF_API: `http://127.0.0.1:${upstreamPort}`,
      FREEBUFF_TOKEN: 'token-shutdown-test-aaaaaaaa',
      FREEBUFF_API_KEY: 'shutdown-api-key',
      FREEBUFF_DEBUG: 'false',
      SHUTDOWN_GRACE_MS: '0',
      SHUTDOWN_CLEANUP_TIMEOUT_MS: '2500',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let logs = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { logs += chunk; });
  child.stderr.on('data', (chunk) => { logs += chunk; });
  const childExit = once(child, 'exit').then(([code, signal]) => ({ code, signal }));

  try {
    const listeningLine = `[server] listening on 127.0.0.1:${proxyPort}`;
    if (!logs.includes(listeningLine)) {
      await withTimeout(new Promise((resolve, reject) => {
        const check = (chunk) => {
          if (String(chunk).includes(listeningLine)) resolve();
        };
        child.stdout.on('data', check);
        child.once('exit', (code, signal) => reject(new Error(
          `server exited before listening (code=${code}, signal=${signal})\n${logs}`,
        )));
      }), 3_000, 'server startup');
    }

    const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer shutdown-api-key',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'deepseek/deepseek-v4-flash',
        messages: [{ role: 'user', content: 'test shutdown' }],
        stream: true,
      }),
    });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const firstEvent = await withTimeout(readUntil(reader, 'started'), 3_000, 'first SSE chunk');
    assert.match(firstEvent, /started/);

    await withTimeout(new Promise((resolve) => {
      const timer = setInterval(() => {
        if (finishes.length > 0) {
          clearInterval(timer);
          resolve();
        }
      }, 10);
    }), 3_000, 'hanging FINISH start');
    const shutdownAt = Date.now();
    child.kill('SIGTERM');
    const exit = await withTimeout(childExit, 4_000, 'server shutdown');
    assert.ok(Date.now() - shutdownAt < 3_000, logs);
    assert.deepEqual(exit, { code: 0, signal: null }, logs);
    assert.match(logs, /SIGTERM: shutting down/);
    assert.equal(finishes.length, 1, logs);
    assert.equal(finishes[0].status, 'completed');
    assert.equal(deleteCount, 1, logs);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await childExit.catch(() => {});
    for (const socket of upstreamSockets) socket.destroy();
    await new Promise((resolve) => upstream.close(resolve));
  }
});
