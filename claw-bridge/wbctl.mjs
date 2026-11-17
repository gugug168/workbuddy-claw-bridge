#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.WB_CLAW_BRIDGE_PORT || 18999);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SERVER_PATH = path.join(__dirname, 'server.mjs');

async function req(method, urlPath, body) {
  const res = await fetch(`${BASE_URL}${urlPath}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json() };
}

async function ensureUp() {
  try {
    const r = await req('GET', '/api/health');
    if (r.status === 200) return;
  } catch {}
  const child = spawn(process.execPath, [SERVER_PATH], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 150));
    try {
      const r = await req('GET', '/api/health');
      if (r.status === 200) return;
    } catch {}
  }
  throw new Error('Bridge did not come up');
}

const [cmd, ...rest] = process.argv.slice(2);
await ensureUp();

if (!cmd || cmd === 'status') {
  console.log(JSON.stringify((await req('GET', '/api/status')).data, null, 2));
} else if (cmd === 'send') {
  const text = rest.join(' ');
  const r = await req('POST', '/api/send', { text, waitForFinish: true, waitMs: 120000 });
  console.log(JSON.stringify(r.data, null, 2));
} else if (cmd === 'send-async') {
  const text = rest.join(' ');
  const r = await req('POST', '/api/send', { text, waitForFinish: false });
  console.log(JSON.stringify(r.data, null, 2));
} else if (cmd === 'steps') {
  const limit = Number(rest[0] || 20);
  console.log(JSON.stringify((await req('GET', `/api/steps?limit=${limit}`)).data, null, 2));
} else if (cmd === 'turns') {
  console.log(JSON.stringify((await req('GET', '/api/turns')).data, null, 2));
} else if (cmd === 'steer') {
  const action = rest[0] || 'list';
  console.log(JSON.stringify((await req('POST', '/api/steer', { action })).data, null, 2));
} else {
  console.error('Usage: node wbctl.mjs <status|send <text>|send-async <text>|steps [n]|turns|steer <list|clear>>');
  process.exit(1);
}
