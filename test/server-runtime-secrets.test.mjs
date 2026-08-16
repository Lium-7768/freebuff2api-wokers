import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';

async function waitForStart(child) {
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (/listening on/.test(output)) return output;
    if (child.exitCode !== null) throw new Error('server exited early: ' + output);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('server did not start: ' + output);
}

test('server loads production runtime secrets from files without app secret environment variables', async () => {
  const secretDir = await mkdtemp(join(tmpdir(), 'freebuff-runtime-secrets-'));
  await writeFile(join(secretDir, 'api_key'), 'runtime-api-key');
  await writeFile(join(secretDir, 'upstream_credentials_json'), JSON.stringify({
    accounts: {
      a: { authToken: 'token-a-aaaaaaaa', fingerprintId: 'fp-a' },
      b: { authToken: 'token-b-bbbbbbbb', fingerprintId: 'fp-b' },
    },
  }));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      FREEBUFF_SECRETS_DIR: secretDir,
      FREEBUFF_API_KEY: '',
      FREEBUFF_CREDENTIALS_JSON: '',
      PORT: '0',
      HOST: '127.0.0.1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const output = await waitForStart(child);
    assert.match(output, /start: 1 credential document, apiKeyConfigured=true/);
  } finally {
    child.kill('SIGTERM');
    await once(child, 'exit');
    await rm(secretDir, { recursive: true, force: true });
  }
});

test("server loads official credentials JSON from the root-only runtime secret directory", async () => {
  const secretDir = await mkdtemp(join(tmpdir(), "freebuff-runtime-credentials-"));
  await writeFile(join(secretDir, "api_key"), "runtime-api-key");
  await writeFile(join(secretDir, "upstream_credentials_json"), JSON.stringify({
    accounts: { official: { authToken: "official-token-aaaaaaaa", fingerprintId: "enhanced-runtime-fingerprint" } },
  }));
  const child = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      FREEBUFF_SECRETS_DIR: secretDir,
      FREEBUFF_API_KEY: "",
      FREEBUFF_CREDENTIALS_JSON: "",
      PORT: "0",
      HOST: "127.0.0.1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const output = await waitForStart(child);
    assert.match(output, /start: 1 credential document, apiKeyConfigured=true/);
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit");
    await rm(secretDir, { recursive: true, force: true });
  }
});
