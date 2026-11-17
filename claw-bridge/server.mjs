#!/usr/bin/env node
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HOST = '127.0.0.1';
const PORT = Number(process.env.WB_CLAW_BRIDGE_PORT || 18999);
const EXPECTED_BOT_ID = process.env.WB_CLAW_BOT_ID || 'local-claw-bridge';
const EXPECTED_BOT_SECRET = process.env.WB_CLAW_BOT_SECRET || 'local-claw-bridge-secret';

const WB_DIR = path.join(os.homedir(), '.workbuddy');
const BRIDGE_DIR = path.join(WB_DIR, 'claw-bridge');
const PID_FILE = path.join(BRIDGE_DIR, 'bridge.pid');
const LOG_FILE = path.join(BRIDGE_DIR, 'server.log');
const SETTINGS_PATH = path.join(WB_DIR, 'settings.json');
const PROJECTS_DIR = path.join(WB_DIR, 'projects');
const STEERING_FILE = path.join(WB_DIR, 'hooks', 'live-steering.json');

fs.mkdirSync(BRIDGE_DIR, { recursive: true });

function log(level, msg, extra) {
  const line = `${new Date().toISOString()} [${level}] ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}\n`;
  try {
    fs.appendFileSync(LOG_FILE, line, 'utf8');
  } catch {
    // ignore log write failure
  }
}

// --- RFC6455 minimal server connection ---
class WsConn {
  constructor(socket, onFrame, onClose) {
    this.socket = socket;
    this.onFrame = onFrame;
    this.onClose = onClose;
    this.buf = Buffer.alloc(0);
    this.fragChunks = [];
    this.fragOpcode = null;
    this.closed = false;

    socket.on('data', (chunk) => this.handleData(chunk));
    socket.on('close', () => this.cleanup());
    socket.on('error', (err) => {
      log('WARN', 'WS socket error', { error: err.message });
      this.cleanup();
    });
  }

  cleanup() {
    if (this.closed) return;
    this.closed = true;
    try { this.socket.destroy(); } catch {}
    this.onClose();
  }

  handleData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= 2) {
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;

      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        const hi = this.buf.readUInt32BE(2);
        const lo = this.buf.readUInt32BE(6);
        len = hi * 4294967296 + lo;
        offset = 10;
      }

      const maskLen = masked ? 4 : 0;
      if (this.buf.length < offset + maskLen + len) return;

      let payload = this.buf.subarray(offset + maskLen, offset + maskLen + len);
      if (masked) {
        const mask = this.buf.subarray(offset, offset + 4);
        const unmasked = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i++) {
          unmasked[i] = payload[i] ^ mask[i & 3];
        }
        payload = unmasked;
      }
      this.buf = this.buf.subarray(offset + maskLen + len);

      if (opcode === 0x8) {
        this.sendControl(0x8, payload.subarray(0, 2));
        this.cleanup();
        return;
      }
      if (opcode === 0x9) {
        this.sendControl(0xA, payload);
        continue;
      }
      if (opcode === 0xA) {
        continue;
      }

      if (opcode === 0x0) {
        if (this.fragOpcode === null) continue;
        this.fragChunks.push(payload);
        if (fin) {
          const full = Buffer.concat(this.fragChunks);
          const op = this.fragOpcode;
          this.fragChunks = [];
          this.fragOpcode = null;
          if (op === 0x1) this.onFrame(full.toString('utf8'));
        }
        continue;
      }

      if (fin) {
        if (opcode === 0x1) this.onFrame(payload.toString('utf8'));
      } else {
        this.fragOpcode = opcode;
        this.fragChunks = [payload];
      }
    }
  }

  sendControl(opcode, payload = Buffer.alloc(0)) {
    if (this.closed || this.socket.destroyed) return;
    const len = Math.min(payload.length, 125);
    const frame = Buffer.allocUnsafe(2 + len);
    frame[0] = 0x80 | opcode;
    frame[1] = len;
    if (len > 0) payload.copy(frame, 2, 0, len);
    try { this.socket.write(frame); } catch {}
  }

  sendJson(obj) {
    if (this.closed || this.socket.destroyed) return false;
    const data = Buffer.from(JSON.stringify(obj), 'utf8');
    let header;
    if (data.length < 126) {
      header = Buffer.allocUnsafe(2);
      header[0] = 0x81;
      header[1] = data.length;
    } else if (data.length < 65536) {
      header = Buffer.allocUnsafe(4);
      header[0] = 0x81;
      header[1] = 126;
      header.writeUInt16BE(data.length, 2);
    } else {
      header = Buffer.allocUnsafe(10);
      header[0] = 0x81;
      header[1] = 127;
      header.writeUInt32BE(Math.floor(data.length / 4294967296), 2);
      header.writeUInt32BE(data.length >>> 0, 6);
    }
    try {
      this.socket.write(Buffer.concat([header, data]));
      return true;
    } catch {
      return false;
    }
  }
}

// --- Bridge State ---
const state = {
  conn: null,
  authenticated: false,
  botId: null,
  connectedAt: null,
  authenticatedAt: null,
  lastHeartbeatAt: null,
  turns: new Map(), // msgId -> turn
  turnOrder: [],
  activeTurnId: null,
  unsolicited: [],
};

function recordTurn(turn) {
  state.turns.set(turn.msgId, turn);
  state.turnOrder.push(turn.msgId);
  while (state.turnOrder.length > 50) {
    const oldest = state.turnOrder.shift();
    if (oldest) state.turns.delete(oldest);
  }
  state.activeTurnId = turn.msgId;
}

function summarizeTurn(turn) {
  return {
    msgId: turn.msgId,
    reqId: turn.reqId,
    prompt: turn.text,
    createdAt: turn.createdAt,
    updatedAt: turn.updatedAt,
    finished: turn.finished,
    latestText: turn.latestText,
    ackPlaceholderSeen: turn.ackPlaceholderSeen,
    eventCount: turn.events.length,
    events: turn.events,
  };
}

function resolveFinish(turn) {
  turn.finished = true;
  turn.updatedAt = Date.now();
  if (state.activeTurnId === turn.msgId) {
    state.activeTurnId = null;
  }
  const waiters = turn.waiters.splice(0, turn.waiters.length);
  for (const w of waiters) {
    clearTimeout(w.timer);
    w.resolve({ timedOut: false, turn: summarizeTurn(turn) });
  }
}

function findTurnForRespond(frame) {
  const reqId = frame.headers?.req_id || '';
  if (reqId) {
    for (const turn of state.turns.values()) {
      if (turn.reqId === reqId) return turn;
    }
  }
  if (state.activeTurnId && state.turns.has(state.activeTurnId)) {
    return state.turns.get(state.activeTurnId);
  }
  return null;
}

function isPlaceholderText(text) {
  return text === '💭正在思考中…' || text === '💭thinking...';
}

function handleWsFrame(raw) {
  let frame;
  try {
    frame = JSON.parse(raw);
  } catch (err) {
    log('WARN', 'Invalid JSON from WS client', { error: err.message });
    return;
  }

  const cmd = frame.cmd || '';
  const reqId = frame.headers?.req_id || '';

  if (cmd === 'aibot_subscribe') {
    const botId = frame.body?.bot_id || '';
    const secret = frame.body?.secret || '';
    const valid = botId === EXPECTED_BOT_ID && secret === EXPECTED_BOT_SECRET;
    if (!valid) {
      log('WARN', 'Auth rejected', { botId });
      state.conn?.sendJson({
        headers: { req_id: reqId },
        errcode: 853000,
        errmsg: 'invalid bot_id or secret',
      });
      return;
    }
    state.authenticated = true;
    state.botId = botId;
    state.authenticatedAt = Date.now();
    state.lastHeartbeatAt = Date.now();
    log('INFO', 'WorkBuddy wecomaibot authenticated', { botId });
    state.conn?.sendJson({ headers: { req_id: reqId }, errcode: 0, errmsg: 'ok' });
    return;
  }

  if (cmd === 'ping') {
    state.lastHeartbeatAt = Date.now();
    state.conn?.sendJson({ headers: { req_id: reqId }, errcode: 0, errmsg: 'ok' });
    return;
  }

  if (cmd === 'aibot_respond_msg') {
    state.conn?.sendJson({ headers: { req_id: reqId }, errcode: 0, errmsg: 'ok' });
    const body = frame.body || {};
    const turn = findTurnForRespond(frame);
    const ev = { ts: Date.now(), cmd, body };

    if (!turn) {
      state.unsolicited.push(ev);
      if (state.unsolicited.length > 50) state.unsolicited.shift();
      return;
    }

    turn.updatedAt = Date.now();
    if (body.msgtype === 'stream' && body.stream) {
      const content = String(body.stream.content ?? '');
      const finish = Boolean(body.stream.finish);
      const placeholder = !finish && isPlaceholderText(content);
      if (placeholder) turn.ackPlaceholderSeen = true;
      turn.events.push({
        ts: Date.now(),
        type: placeholder ? 'ack' : finish ? 'final' : 'streaming',
        streamId: body.stream.id || '',
        finish,
        content,
      });
      if (!placeholder) turn.latestText = content;
      if (finish) resolveFinish(turn);
    } else {
      const content = body.markdown?.content || body.text?.content || JSON.stringify(body);
      turn.events.push({ ts: Date.now(), type: 'reply', finish: true, content });
      turn.latestText = String(content);
      resolveFinish(turn);
    }
    return;
  }

  if (cmd === 'aibot_send_msg') {
    state.conn?.sendJson({ headers: { req_id: reqId }, errcode: 0, errmsg: 'ok' });
    const body = frame.body || {};
    const content = body.markdown?.content || body.text?.content || JSON.stringify(body);
    const turn = state.activeTurnId ? state.turns.get(state.activeTurnId) : null;
    if (turn) {
      turn.events.push({ ts: Date.now(), type: 'send_msg', finish: true, content: String(content) });
      turn.latestText = String(content);
      resolveFinish(turn);
    } else {
      state.unsolicited.push({ ts: Date.now(), cmd, content: String(content) });
      if (state.unsolicited.length > 50) state.unsolicited.shift();
    }
    return;
  }

  if (cmd === 'ww_ai_robot_enter_event') {
    state.conn?.sendJson({ headers: { req_id: reqId }, errcode: 0, errmsg: 'ok' });
    return;
  }

  // Fallback ack for any other SDK command
  if (reqId) {
    state.conn?.sendJson({ headers: { req_id: reqId }, errcode: 0, errmsg: 'ok' });
  }
}

// --- Transcript (.jsonl) reader ---
function cwdToSlug(cwd) {
  if (!cwd) return '';
  return cwd.replace(/:/g, '').replace(/[\\/]+/g, '-').replace(/^-+|-+$/g, '');
}

function findTranscriptLocation() {
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
  } catch (err) {
    return { error: `Failed to read settings.json: ${err.message}` };
  }

  const users = settings.claw?.users || {};
  let binding = null;
  let bindingKey = null;
  for (const [, userObj] of Object.entries(users)) {
    const cb = userObj?.conversationBindings || {};
    for (const [k, v] of Object.entries(cb)) {
      if (k.startsWith('claw:user:') && v?.agentConversationId) {
        bindingKey = k;
        binding = v;
        break;
      }
    }
    if (binding) break;
  }

  if (!binding?.agentConversationId) {
    return { error: 'No claw:user:* conversation binding found in settings.json' };
  }

  const sessionId = binding.agentConversationId;
  const cwd = binding.cwd || '';
  const candidates = [];

  if (cwd) {
    const directSlug = cwdToSlug(cwd);
    candidates.push(path.join(PROJECTS_DIR, directSlug, `${sessionId}.jsonl`));
    candidates.push(path.join(PROJECTS_DIR, directSlug.charAt(0).toLowerCase() + directSlug.slice(1), `${sessionId}.jsonl`));
  }

  let jsonlPath = candidates.find((p) => fs.existsSync(p)) || null;
  if (!jsonlPath && fs.existsSync(PROJECTS_DIR)) {
    for (const dir of fs.readdirSync(PROJECTS_DIR)) {
      const p = path.join(PROJECTS_DIR, dir, `${sessionId}.jsonl`);
      if (fs.existsSync(p)) {
        jsonlPath = p;
        break;
      }
    }
  }

  return {
    bindingKey,
    sessionId,
    cwd,
    updatedAt: binding.updatedAt || null,
    jsonlPath,
    exists: Boolean(jsonlPath && fs.existsSync(jsonlPath)),
  };
}

function truncateText(val, max = 900) {
  const s = typeof val === 'string' ? val : JSON.stringify(val ?? '');
  return s.length > max ? s.slice(0, max) + `... [truncated ${s.length - max} chars]` : s;
}

function summarizeRecord(rec, includeReasoning) {
  const base = {
    id: rec.id || '',
    timestamp: rec.timestamp || 0,
    type: rec.type || '',
  };
  if (rec.type === 'reasoning') {
    if (!includeReasoning) return null;
    return { ...base, content: truncateText(rec.content || rec.rawContent || '', 700) };
  }
  if (rec.type === 'function_call') {
    return {
      ...base,
      callId: rec.callId || '',
      name: rec.name || '',
      arguments: truncateText(rec.arguments, 900),
    };
  }
  if (rec.type === 'function_call_result') {
    const out = typeof rec.output === 'object' && rec.output !== null ? rec.output.text ?? rec.output : rec.output;
    return {
      ...base,
      callId: rec.callId || '',
      name: rec.name || '',
      status: rec.status || '',
      output: truncateText(out, 900),
    };
  }
  if (rec.type === 'message') {
    const txt = Array.isArray(rec.content)
      ? rec.content.map((c) => (typeof c === 'string' ? c : c?.text || JSON.stringify(c))).join('\n')
      : rec.content;
    return {
      ...base,
      role: rec.role || '',
      status: rec.status || '',
      content: truncateText(txt, 1500),
    };
  }
  return null;
}

function readTranscriptSteps({ sinceTs = 0, limit = 40, includeReasoning = true } = {}) {
  const loc = findTranscriptLocation();
  if (!loc.exists || !loc.jsonlPath) {
    return { ok: false, location: loc, steps: [] };
  }
  const raw = fs.readFileSync(loc.jsonlPath, 'utf8');
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const steps = [];
  for (let i = Math.max(0, lines.length - Math.max(limit * 4, 250)); i < lines.length; i++) {
    let rec;
    try {
      rec = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (sinceTs && typeof rec.timestamp === 'number' && rec.timestamp < sinceTs) continue;
    const item = summarizeRecord(rec, includeReasoning);
    if (item) steps.push(item);
  }
  const sliced = steps.slice(-limit);
  return {
    ok: true,
    location: loc,
    totalMatched: steps.length,
    steps: sliced,
  };
}

// --- Live steering rules (hooks/live-steering.json) ---
function readSteeringFile() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STEERING_FILE, 'utf8'));
    return Array.isArray(parsed.rules) ? parsed : { rules: [] };
  } catch {
    return { rules: [] };
  }
}

function writeSteeringFile(data) {
  fs.mkdirSync(path.dirname(STEERING_FILE), { recursive: true });
  fs.writeFileSync(STEERING_FILE, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

// --- HTTP helpers ---
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 2 * 1024 * 1024) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sendJsonRes(res, status, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url || '/', `http://${HOST}:${PORT}`);
  try {
    if (req.method === 'GET' && u.pathname === '/api/health') {
      return sendJsonRes(res, 200, { ok: true, pid: process.pid, port: PORT });
    }

    if (req.method === 'GET' && u.pathname === '/api/status') {
      return sendJsonRes(res, 200, {
        ok: true,
        pid: process.pid,
        wsUrl: `ws://${HOST}:${PORT}`,
        wsConnected: Boolean(state.conn && !state.conn.closed),
        wsAuthenticated: state.authenticated,
        botId: state.botId,
        connectedAt: state.connectedAt,
        authenticatedAt: state.authenticatedAt,
        lastHeartbeatAt: state.lastHeartbeatAt,
        activeTurnId: state.activeTurnId,
        turnCount: state.turns.size,
        transcript: findTranscriptLocation(),
      });
    }

    if (req.method === 'POST' && u.pathname === '/api/send') {
      const body = await readJsonBody(req);
      const text = String(body.text ?? '').trim();
      if (!text) return sendJsonRes(res, 400, { ok: false, error: 'Missing required field: text' });
      if (!state.conn || state.conn.closed || !state.authenticated) {
        return sendJsonRes(res, 503, {
          ok: false,
          error: 'WorkBuddy Desktop wecomaibot client is not connected/authenticated. Restart WorkBuddy Desktop if just configured.',
        });
      }

      const msgId = `wb_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
      const reqId = `aibot_msg_callback_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
      const chatId = String(body.chatId || 'local-claw-chat');
      const userId = String(body.userId || 'external-ai');
      const waitForFinish = body.waitForFinish !== false;
      const waitMs = Math.max(1000, Math.min(Number(body.waitMs || 120000), 600000));

      const turn = {
        msgId,
        reqId,
        text,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        finished: false,
        latestText: '',
        ackPlaceholderSeen: false,
        events: [],
        waiters: [],
      };
      recordTurn(turn);

      const sent = state.conn.sendJson({
        cmd: 'aibot_msg_callback',
        headers: { req_id: reqId },
        body: {
          msgid: msgId,
          msgtype: 'text',
          chattype: 'single',
          chatid: chatId,
          from: { userid: userId },
          text: { content: text },
        },
      });
      if (!sent) {
        return sendJsonRes(res, 502, { ok: false, error: 'Failed to write frame to WebSocket' });
      }
      log('INFO', 'Dispatched aibot_msg_callback', { msgId, reqId, textLen: text.length });

      if (!waitForFinish) {
        return sendJsonRes(res, 200, { ok: true, async: true, turn: summarizeTurn(turn) });
      }

      const result = await new Promise((resolve) => {
        if (turn.finished) return resolve({ timedOut: false, turn: summarizeTurn(turn) });
        const timer = setTimeout(() => {
          const idx = turn.waiters.findIndex((w) => w.timer === timer);
          if (idx >= 0) turn.waiters.splice(idx, 1);
          resolve({ timedOut: true, turn: summarizeTurn(turn) });
        }, waitMs);
        turn.waiters.push({ timer, resolve });
      });

      return sendJsonRes(res, 200, { ok: true, ...result });
    }

    if (req.method === 'GET' && u.pathname === '/api/turns') {
      const list = [...state.turns.values()].slice(-20).map(summarizeTurn);
      return sendJsonRes(res, 200, { ok: true, activeTurnId: state.activeTurnId, turns: list, unsolicited: state.unsolicited });
    }

    if (req.method === 'GET' && u.pathname.startsWith('/api/turns/')) {
      const msgId = decodeURIComponent(u.pathname.slice('/api/turns/'.length));
      const turn = state.turns.get(msgId);
      if (!turn) return sendJsonRes(res, 404, { ok: false, error: `Turn not found: ${msgId}` });
      return sendJsonRes(res, 200, { ok: true, turn: summarizeTurn(turn) });
    }

    if (req.method === 'GET' && u.pathname === '/api/steps') {
      const sinceTs = Number(u.searchParams.get('since_ts') || 0);
      const limit = Math.max(1, Math.min(Number(u.searchParams.get('limit') || 40), 200));
      const includeReasoning = u.searchParams.get('include_reasoning') !== 'false';
      return sendJsonRes(res, 200, readTranscriptSteps({ sinceTs, limit, includeReasoning }));
    }

    if (req.method === 'GET' && u.pathname === '/api/steer') {
      return sendJsonRes(res, 200, { ok: true, file: STEERING_FILE, ...readSteeringFile() });
    }

    if (req.method === 'POST' && u.pathname === '/api/steer') {
      const body = await readJsonBody(req);
      const action = body.action || 'list';
      const data = readSteeringFile();
      if (action === 'clear') {
        data.rules = [];
        writeSteeringFile(data);
        return sendJsonRes(res, 200, { ok: true, file: STEERING_FILE, ...data });
      }
      if (action === 'remove') {
        data.rules = data.rules.filter((r) => r.id !== body.id);
        writeSteeringFile(data);
        return sendJsonRes(res, 200, { ok: true, file: STEERING_FILE, ...data });
      }
      if (action === 'add') {
        if (!body.message) return sendJsonRes(res, 400, { ok: false, error: 'Missing rule message' });
        const rule = {
          id: body.id || `rule_${Date.now()}`,
          enabled: body.enabled !== false,
          tools: Array.isArray(body.tools) && body.tools.length > 0 ? body.tools : ['Bash', 'Write', 'Edit', 'MultiEdit'],
          command_contains: body.command_contains || '',
          path_contains: body.path_contains || '',
          content_contains: body.content_contains || '',
          regex: body.regex || '',
          message: String(body.message),
          createdAt: new Date().toISOString(),
        };
        data.rules = data.rules.filter((r) => r.id !== rule.id);
        data.rules.push(rule);
        writeSteeringFile(data);
        return sendJsonRes(res, 200, { ok: true, rule, file: STEERING_FILE, ...data });
      }
      return sendJsonRes(res, 200, { ok: true, file: STEERING_FILE, ...data });
    }

    return sendJsonRes(res, 404, { ok: false, error: 'Not found' });
  } catch (err) {
    log('ERROR', 'HTTP handler error', { path: u.pathname, error: err.message });
    return sendJsonRes(res, 500, { ok: false, error: err.message });
  }
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }
  const accept = crypto
    .createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11', 'utf8')
    .digest('base64');

  socket.write(
    [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '',
      '',
    ].join('\r\n'),
  );

  if (state.conn && !state.conn.closed) {
    log('INFO', 'Replacing previous WS connection');
    state.conn.sendJson({
      cmd: 'aibot_event_callback',
      headers: { req_id: `disconnect_${Date.now()}` },
      body: { msgtype: 'event', event: { eventtype: 'disconnected_event' } },
    });
    state.conn.cleanup();
  }

  state.authenticated = false;
  state.botId = null;
  state.connectedAt = Date.now();
  state.authenticatedAt = null;

  const conn = new WsConn(
    socket,
    (msg) => handleWsFrame(msg),
    () => {
      if (state.conn === conn) {
        state.conn = null;
        state.authenticated = false;
        log('INFO', 'WS client disconnected');
      }
    },
  );
  state.conn = conn;
  log('INFO', 'WS client connected, awaiting aibot_subscribe');
});

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    log('INFO', 'Port already in use, exiting cleanly', { host: HOST, port: PORT, pid: process.pid });
    process.exit(0);
  }
  log('ERROR', 'Server error', { error: err?.message || String(err) });
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  fs.writeFileSync(PID_FILE, String(process.pid), 'utf8');
  log('INFO', 'Claw Bridge listening', { host: HOST, port: PORT, pid: process.pid });
});

function shutdown() {
  log('INFO', 'Shutting down Claw Bridge');
  try {
    if (fs.existsSync(PID_FILE) && fs.readFileSync(PID_FILE, 'utf8').trim() === String(process.pid)) {
      fs.unlinkSync(PID_FILE);
    }
  } catch {}
  try { state.conn?.cleanup(); } catch {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
