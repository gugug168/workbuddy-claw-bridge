#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOST = '127.0.0.1';
const PORT = Number(process.env.WB_CLAW_BRIDGE_PORT || 18999);
const BASE_URL = `http://${HOST}:${PORT}`;
const SERVER_PATH = path.join(__dirname, 'server.mjs');
const ERR_LOG = path.join(__dirname, 'mcp.log');

function logErr(msg, extra) {
  try {
    fs.appendFileSync(ERR_LOG, `${new Date().toISOString()} ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}\n`, 'utf8');
  } catch {}
}

async function httpReq(method, urlPath, body) {
  const res = await fetch(`${BASE_URL}${urlPath}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(610000),
  });
  const text = await res.text();
  try {
    return { status: res.status, data: JSON.parse(text) };
  } catch {
    return { status: res.status, data: { raw: text } };
  }
}

async function ensureBridgeRunning() {
  try {
    const r = await httpReq('GET', '/api/health');
    if (r.status === 200 && r.data?.ok) return;
  } catch {}

  const child = spawn(process.execPath, [SERVER_PATH], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: process.env,
  });
  child.unref();

  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 150));
    try {
      const r = await httpReq('GET', '/api/health');
      if (r.status === 200 && r.data?.ok) return;
    } catch {}
  }
  throw new Error(`Claw Bridge daemon failed to start on ${BASE_URL}`);
}

const TOOLS = [
  {
    name: 'wb_status',
    description:
      'Check WorkBuddy Desktop local Claw bridge connection status, active session ID, and live .jsonl transcript path.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'wb_send',
    description:
      'Send a task instruction, mid-flight follow-up correction, or slash command (/clear, /compact) into the live WorkBuddy Desktop Claw session so the user can watch it run in the Desktop UI.',
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'Instruction text or slash command (/clear, /compact) to send to WorkBuddy Desktop.',
        },
        wait_for_finish: {
          type: 'boolean',
          description:
            'If true (default), wait up to timeout_ms for the final reply. Set false to dispatch immediately and monitor progress with wb_poll_steps.',
          default: true,
        },
        timeout_ms: {
          type: 'integer',
          description: 'Max wait time in ms when wait_for_finish=true (default 90000, max 600000).',
          default: 90000,
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'wb_poll_steps',
    description:
      'Inspect live intermediate execution steps (reasoning, function_call, function_call_result, message) from WorkBuddy Desktop active Claw .jsonl transcript, plus current IM stream turn state.',
    inputSchema: {
      type: 'object',
      properties: {
        msg_id: {
          type: 'string',
          description: 'Optional turn msgId returned by wb_send to include live streaming chunks.',
        },
        since_ts: {
          type: 'integer',
          description: 'Optional Unix ms timestamp filter to return only steps created at or after this time.',
          default: 0,
        },
        limit: {
          type: 'integer',
          description: 'Max number of recent steps to return (default 25, max 200).',
          default: 25,
        },
        include_reasoning: {
          type: 'boolean',
          description: 'Include reasoning entries (default true).',
          default: true,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'wb_steer_rule',
    description:
      'Manage mid-flight PreToolUse interception rules (live-steering.json) enforced by redline-guard.py. Blocking a bad tool call feeds the message back to WorkBuddy immediately via stderr (exit 2).',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'add', 'remove', 'clear'],
          description: 'Action to perform on live-steering rules.',
        },
        id: {
          type: 'string',
          description: 'Rule ID (required for remove; optional for add).',
        },
        tools: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tool names to match, e.g. ["Bash", "Write", "Edit", "MultiEdit"].',
        },
        command_contains: {
          type: 'string',
          description: 'Case-insensitive substring to match inside Bash command.',
        },
        path_contains: {
          type: 'string',
          description: 'Case-insensitive substring (forward slashes) to match inside Write/Edit file path.',
        },
        content_contains: {
          type: 'string',
          description: 'Substring to match inside Write/Edit content.',
        },
        regex: {
          type: 'string',
          description: 'Optional regex matched against combined tool input.',
        },
        message: {
          type: 'string',
          description: 'Correction message returned to WorkBuddy when the rule blocks an action (required for add).',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
];

async function handleToolCall(name, args = {}) {
  await ensureBridgeRunning();

  if (name === 'wb_status') {
    const r = await httpReq('GET', '/api/status');
    return r.data;
  }

  if (name === 'wb_send') {
    const r = await httpReq('POST', '/api/send', {
      text: args.text,
      waitForFinish: args.wait_for_finish !== false,
      waitMs: args.timeout_ms ?? 90000,
    });
    if (r.status >= 400) return { isError: true, ...r.data };
    return r.data;
  }

  if (name === 'wb_poll_steps') {
    const qs = new URLSearchParams({
      since_ts: String(args.since_ts || 0),
      limit: String(args.limit || 25),
      include_reasoning: String(args.include_reasoning !== false),
    });
    const stepsRes = await httpReq('GET', `/api/steps?${qs.toString()}`);
    let turn = null;
    if (args.msg_id) {
      const tr = await httpReq('GET', `/api/turns/${encodeURIComponent(args.msg_id)}`);
      if (tr.status === 200) turn = tr.data.turn;
    } else {
      const trs = await httpReq('GET', '/api/turns');
      if (trs.status === 200) {
        const list = trs.data.turns || [];
        turn = list.length ? list[list.length - 1] : null;
      }
    }
    return { ...stepsRes.data, latestTurn: turn };
  }

  if (name === 'wb_steer_rule') {
    const r = await httpReq('POST', '/api/steer', args);
    return r.data;
  }

  throw new Error(`Unknown tool: ${name}`);
}

function sendMsg(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let req;
  try {
    req = JSON.parse(trimmed);
  } catch (err) {
    logErr('Parse error', { error: err.message });
    return;
  }

  const { id, method, params } = req;
  if (id === undefined || id === null) {
    // notification
    return;
  }

  try {
    if (method === 'initialize') {
      return sendMsg({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params?.protocolVersion || '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'workbuddy-claw', version: '1.0.0' },
        },
      });
    }
    if (method === 'ping') {
      return sendMsg({ jsonrpc: '2.0', id, result: {} });
    }
    if (method === 'tools/list') {
      return sendMsg({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    }
    if (method === 'tools/call') {
      const res = await handleToolCall(params?.name, params?.arguments || {});
      const isError = Boolean(res?.isError || res?.ok === false && params?.name === 'wb_send');
      return sendMsg({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(res, null, 2) }],
          ...(isError ? { isError: true } : {}),
        },
      });
    }
    return sendMsg({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    });
  } catch (err) {
    logErr('Handler error', { method, error: err.message });
    return sendMsg({
      jsonrpc: '2.0',
      id,
      error: { code: -32603, message: err.message },
    });
  }
});
