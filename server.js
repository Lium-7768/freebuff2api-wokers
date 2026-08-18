import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Load worker module
const worker = await import('./worker.js');
const handler = worker.default;
const closeOwnedSessions = worker.closeOwnedSessions;

// === Build env from config ===

// Production may mount root-owned one-secret-per-file runtime secrets. The
// environment-variable fallback remains for local development only; no secret
// values are logged.
const runtimeSecretsDir = String(process.env.FREEBUFF_SECRETS_DIR || '').trim();
function readRuntimeSecret(name) {
  if (!runtimeSecretsDir) return '';
  try {
    return readFileSync(resolve(runtimeSecretsDir, name), 'utf-8').trim();
  } catch (err) {
    if (err?.code !== 'ENOENT') console.error(`[server] cannot read runtime secret ${name}: ${err.message}`);
    return '';
  }
}

const credentialsJson = readRuntimeSecret("upstream_credentials_json") || process.env.FREEBUFF_CREDENTIALS_JSON || "";

const apiKey = String(readRuntimeSecret("api_key") || process.env.FREEBUFF_API_KEY || "").trim();
if (!apiKey) {
  throw new Error("FREEBUFF_API_KEY is required; refusing to start with a public default key");
}
if (String(process.env.FREEBUFF_TOKEN || "").trim() || String(process.env.FREEBUFF_FINGERPRINT_ID || "").trim()) {
  throw new Error("FREEBUFF_TOKEN and FREEBUFF_FINGERPRINT_ID are unsupported; use FREEBUFF_CREDENTIALS_JSON");
}

const env = {
  FREEBUFF_CREDENTIALS_JSON: credentialsJson,
  FREEBUFF_API_KEY: apiKey,
  FREEBUFF_DEBUG: process.env.FREEBUFF_DEBUG || "false",
  FREEBUFF_CLIENT_BEHAVIOR: process.env.FREEBUFF_CLIENT_BEHAVIOR || "cli",
  FREEBUFF_OPENAI_RESPONSE_COMPAT: process.env.FREEBUFF_OPENAI_RESPONSE_COMPAT || "true",
  FREEBUFF_ACTING_USER_ID: process.env.FREEBUFF_ACTING_USER_ID || "",
  FREEBUFF_COMPACT_SESSION: process.env.FREEBUFF_COMPACT_SESSION || "",
  FREEBUFF_AD_PROVIDER: process.env.FREEBUFF_AD_PROVIDER || "",
  FREEBUFF_AD_SURFACE: process.env.FREEBUFF_AD_SURFACE || "",
  FREEBUFF_AD_PLACEMENT_ID: process.env.FREEBUFF_AD_PLACEMENT_ID || "",
  FREEBUFF_AGENT_MODE: process.env.FREEBUFF_AGENT_MODE || "",
  FREEBUFF_CHAT_SESSION_ID: process.env.FREEBUFF_CHAT_SESSION_ID || "",
  ORCA_API_KEY: readRuntimeSecret("orca_api_key") || process.env.ORCA_API_KEY || "",
  ORCA_API_BASE: process.env.ORCA_API_BASE || "https://api.orcarouter.ai/v1",
  BAI_API_KEY: readRuntimeSecret("bai_api_key") || process.env.BAI_API_KEY || "",
  MANUS_API_KEY: readRuntimeSecret("manus_api_key") || process.env.MANUS_API_KEY || "",
  MANUS_API_BASE: process.env.MANUS_API_BASE || "https://api.manus.ai",
  MANUS_TASK_TIMEOUT_MS: process.env.MANUS_TASK_TIMEOUT_MS || "120000",
  MANUS_POLL_INTERVAL_MS: process.env.MANUS_POLL_INTERVAL_MS || "1500",
  BAI_API_BASE: process.env.BAI_API_BASE || "https://api.b.ai",
  FREEBUFF_ORCA_REQUEST_MODE: process.env.FREEBUFF_ORCA_REQUEST_MODE || "harness-compact",
  CODEBUFF_API: readRuntimeSecret("codebuff_api") || process.env.CODEBUFF_API || "",
};
const shutdownSignalController = new AbortController();
env.SHUTDOWN_SIGNAL = shutdownSignalController.signal;

console.log(`[server] start: ${credentialsJson ? 1 : 0} credential document, apiKeyConfigured=true, debug=${env.FREEBUFF_DEBUG}`);
if (env.CODEBUFF_API) console.log('[server] CODEBUFF_API configured');

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
