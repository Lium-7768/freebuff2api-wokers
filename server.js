import { createServer } from 'node:http';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load worker module
const worker = await import('./worker.js');
const handler = worker.default;
const closeOwnedSessions = worker.closeOwnedSessions;

// === Build env from config ===

// Read tokens from credentials/ directory
const credDir = resolve(__dirname, 'credentials');
let tokenLines = [];
if (existsSync(credDir)) {
  for (const f of readdirSync(credDir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const raw = readFileSync(resolve(credDir, f), 'utf-8');
      const obj = JSON.parse(raw);
      if (obj.authToken) tokenLines.push(obj.authToken.trim());
    } catch (err) {
      console.error(`[server] skip bad credential ${f}: ${err.message}`);
    }
  }
}

// Also allow FREEBUFF_TOKEN env var for non-credential token sources
const envToken = process.env.FREEBUFF_TOKEN || '';
if (envToken) {
  for (const tok of envToken.split(/[\n,]/)) {
    const t = tok.trim();
    if (t && !tokenLines.includes(t)) tokenLines.push(t);
  }
}

const apiKey = String(process.env.FREEBUFF_API_KEY || '').trim();
if (!apiKey) {
  throw new Error('FREEBUFF_API_KEY is required; refusing to start with a public default key');
}

const env = {
  FREEBUFF_TOKEN: tokenLines.join(','),
  FREEBUFF_API_KEY: apiKey,
  FREEBUFF_DEBUG: process.env.FREEBUFF_DEBUG || 'false',
  FREEBUFF_CLIENT_BEHAVIOR: process.env.FREEBUFF_CLIENT_BEHAVIOR || 'off',
  FREEBUFF_FINGERPRINT_ID: process.env.FREEBUFF_FINGERPRINT_ID || '',
  CODEBUFF_API: process.env.CODEBUFF_API || '',
};
const shutdownSignalController = new AbortController();
env.SHUTDOWN_SIGNAL = shutdownSignalController.signal;

console.log(`[server] start: ${tokenLines.length} tokens, apiKeyConfigured=true, debug=${env.FREEBUFF_DEBUG}`);
if (env.CODEBUFF_API) console.log(`[server] CODEBUFF_API=${env.CODEBUFF_API}`);

// === HTTP server ===
const port = parseInt(process.env.PORT || '8787', 10);
const host = process.env.HOST || '0.0.0.0';
function nonNegativeEnvMs(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}
const shutdownGraceMs = nonNegativeEnvMs('SHUTDOWN_GRACE_MS', 5000);
const shutdownCleanupMs = nonNegativeEnvMs('SHUTDOWN_CLEANUP_TIMEOUT_MS', 5000);
const activeRequests = new Set();
let shuttingDown = false;

const server = createServer(async (nodeReq, nodeRes) => {
  if (shuttingDown) {
    nodeRes.writeHead(503, { 'content-type': 'application/json', connection: 'close' });
    nodeRes.end(JSON.stringify({ error: { message: 'server shutting down', type: 'server_shutdown' } }));
    return;
  }
  const abortController = new AbortController();
  activeRequests.add(abortController);
  const abortRequest = () => {
    if (!abortController.signal.aborted) {
      abortController.abort(new Error('downstream client disconnected'));
    }
  };
  const abortOnResponseClose = () => {
    if (!nodeRes.writableEnded) abortRequest();
  };
  nodeReq.once('aborted', abortRequest);
  nodeRes.once('close', abortOnResponseClose);

  try {
    // Build array of raw bytes from Node request
    const chunks = [];
    for await (const chunk of nodeReq) chunks.push(chunk);
    const body = Buffer.concat(chunks);

    // Build a standard Web Request for the protocol adapter
    const url = `http://${nodeReq.headers.host || 'localhost'}${nodeReq.url}`;
    const request = new Request(url, {
      method: nodeReq.method,
      headers: new Headers(nodeReq.headers),
      body: body.length > 0 ? body : null,
      signal: abortController.signal,
    });

    // Call the worker's fetch handler
    const response = await handler.fetch(request, env);

    // Write response back to Node socket
    nodeRes.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    if (response.body) {
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) nodeRes.write(Buffer.from(value));
        }
      } catch (err) {
        // Stream errors are expected on client disconnect
        if (!nodeRes.writableEnded) nodeRes.end();
        return;
      }
    }
    if (!nodeRes.writableEnded) nodeRes.end();
  } catch (err) {
    if (abortController.signal.aborted) return;
    console.error('[server] request error:', err.message);
    if (!nodeRes.headersSent) {
      nodeRes.writeHead(502, { 'content-type': 'application/json' });
      nodeRes.end(JSON.stringify({ error: { message: 'proxy error', type: 'proxy_error' } }));
    } else if (!nodeRes.writableEnded) {
      nodeRes.end();
    }
  } finally {
    activeRequests.delete(abortController);
    nodeReq.off('aborted', abortRequest);
    nodeRes.off('close', abortOnResponseClose);
  }
});

server.listen(port, host, () => {
  console.log(`[server] listening on ${host}:${port}`);
});

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${signal}: shutting down`);
  shutdownSignalController.abort(new Error(`${signal}: server shutting down`));

  for (const controller of activeRequests) {
    if (!controller.signal.aborted) controller.abort(new Error(`${signal}: server shutting down`));
  }

  let closeTimer;
  const serverClosed = new Promise((resolveClose) => server.close(resolveClose));
  const closeTimedOut = await Promise.race([
    serverClosed.then(() => false),
    new Promise((resolveTimeout) => {
      closeTimer = setTimeout(() => resolveTimeout(true), shutdownGraceMs);
    }),
  ]);
  clearTimeout(closeTimer);
  if (closeTimedOut) {
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
  }

  let cleanupTimer;
  try {
    await Promise.race([
      closeOwnedSessions(),
      new Promise((_, reject) => {
        cleanupTimer = setTimeout(
          () => reject(new Error(`session cleanup timed out after ${shutdownCleanupMs}ms`)),
          shutdownCleanupMs,
        );
      }),
    ]);
  } catch (error) {
    console.error(`[server] session cleanup failed: ${error.message}`);
  } finally {
    clearTimeout(cleanupTimer);
  }
  process.exit(0);
}

process.once('SIGINT', () => { void shutdown('SIGINT'); });
process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
