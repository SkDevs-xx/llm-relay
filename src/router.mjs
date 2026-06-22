import http from 'node:http';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { toOpenAIRequest, fromOpenAIResponse, streamOpenAIToAnthropic } from './openai-adapter.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JSON_PATH = path.join(__dirname, '..', 'models.json');
const PORT = Number(process.env.PORT || 8787);
const ANTHROPIC_UPSTREAM = 'https://api.anthropic.com';
const MARKER_RE = /(?:^|\s)RELAY-MODEL:\s*(\S+)/m;
const IDLE_MS = Number(process.env.RELAY_IDLE_MS || 20 * 60 * 1000);
const UPSTREAM_TIMEOUT_MS = Number(process.env.RELAY_UPSTREAM_TIMEOUT_MS || 90 * 1000);

let inflight = 0;
let idleTimer = null;

function armIdle() {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (inflight > 0) return;
  idleTimer = setTimeout(() => {
    server.close(() => process.exit(0));
  }, IDLE_MS);
}

function loadModels() {
  const cfg = JSON.parse(readFileSync(JSON_PATH, 'utf8'));
  const map = new Map();
  for (const entry of cfg.models) {
    const base_url = String(entry.base_url || '').replace(/\/+$/, '');
    const format = String(entry.format || 'anthropic').toLowerCase();
    map.set(entry.alias, { model: entry.model, base_url, api_key: entry.api_key, format });
  }
  return map;
}

function extractSystemText(system) {
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) return system.map(b => b.text || '').join(' ');
  return '';
}

const modelsMap = loadModels();

const server = http.createServer((req, res) => {
  inflight++;
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  let settled = false;
  const onDone = () => {
    if (settled) return;
    settled = true;
    inflight--;
    armIdle();
  };
  res.on('finish', onDone);
  res.on('close', onDone);
  res.on('error', () => {});
  req.on('error', () => {});

  const reqID = randomUUID().slice(0, 8);

  if (req.method === 'HEAD' || req.method === 'GET') {
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end();
    return;
  }

  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', async () => {
    const rawBody = Buffer.concat(chunks);

    let alias = null;
    let parsedBody = null;
    try {
      parsedBody = JSON.parse(rawBody.toString('utf8'));
      const sysText = extractSystemText(parsedBody.system);
      const m = sysText.match(MARKER_RE);
      if (m) alias = m[1];
    } catch {}

    let upstreamUrl, forwardHeaders, bodyToSend, isOpenAI = false;

    if (alias !== null) {
      const cfg = modelsMap.get(alias);
      if (!cfg) {
        console.warn(`[${reqID}] WARN unknown alias="${alias}" -> fallback anthropic`);
        alias = null;
      } else if (cfg.format === 'openai') {
        isOpenAI = true;
        let oaBody;
        try {
          oaBody = toOpenAIRequest(parsedBody, cfg.model);
        } catch (e) {
          console.warn(`[${reqID}] request translate error: ${e.message}`);
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end('{"type":"error","error":{"type":"api_error","message":"relay translate failed"}}');
          return;
        }
        bodyToSend = Buffer.from(JSON.stringify(oaBody), 'utf8');
        upstreamUrl = cfg.base_url + '/chat/completions';
        forwardHeaders = {};
        for (const [k, v] of Object.entries(req.headers)) {
          if (k === 'host' || k === 'content-length' || k === 'authorization' || k === 'x-api-key' || k === 'accept-encoding' || k === 'anthropic-version' || k === 'anthropic-beta') continue;
          forwardHeaders[k] = v;
        }
        forwardHeaders['authorization'] = 'Bearer ' + cfg.api_key;
        forwardHeaders['content-type'] = 'application/json';
        forwardHeaders['content-length'] = String(bodyToSend.length);
        forwardHeaders['accept-encoding'] = 'identity';
      } else {
        const rewritten = Object.assign({}, parsedBody, { model: cfg.model });
        bodyToSend = Buffer.from(JSON.stringify(rewritten), 'utf8');
        upstreamUrl = cfg.base_url + req.url;
        forwardHeaders = {};
        for (const [k, v] of Object.entries(req.headers)) {
          if (k === 'host' || k === 'content-length' || k === 'authorization' || k === 'x-api-key' || k === 'accept-encoding') continue;
          forwardHeaders[k] = v;
        }
        forwardHeaders['authorization'] = 'Bearer ' + cfg.api_key;
        forwardHeaders['content-type'] = 'application/json';
        forwardHeaders['content-length'] = String(bodyToSend.length);
        forwardHeaders['accept-encoding'] = 'identity';
      }
    }

    if (alias === null) {
      bodyToSend = rawBody;
      upstreamUrl = ANTHROPIC_UPSTREAM + req.url;
      forwardHeaders = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (k === 'host' || k === 'accept-encoding') continue;
        forwardHeaders[k] = v;
      }
      forwardHeaders['accept-encoding'] = 'identity';
    }

    const ac = new AbortController();
    const upstreamTimer = setTimeout(() => ac.abort(), UPSTREAM_TIMEOUT_MS);
    try {
      const up = await fetch(upstreamUrl, {
        method: 'POST',
        headers: forwardHeaders,
        body: bodyToSend,
        duplex: 'half',
        signal: ac.signal,
      });
      clearTimeout(upstreamTimer);

      if (up.status >= 400) {
        console.warn(`[${reqID}] upstream error alias=${alias ?? 'anthropic'} status=${up.status}`);
        if (isOpenAI) {
          const errBody = await up.text();
          res.writeHead(up.status, { 'content-type': 'application/json' });
          res.end(errBody);
          return;
        }
      }

      if (isOpenAI && up.status < 400) {
        if (!up.body) { res.end(); return; }
        if (parsedBody.stream === true) {
          await streamOpenAIToAnthropic(up.body, res, parsedBody.model || alias, reqID);
        } else {
          const oj = await up.json();
          const aj = fromOpenAIResponse(oj, parsedBody.model || alias, reqID);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(aj));
        }
        return;
      }

      const outHeaders = {};
      for (const [k, v] of up.headers.entries()) {
        outHeaders[k] = v;
      }
      delete outHeaders['transfer-encoding'];

      res.writeHead(up.status, outHeaders);

      if (!up.body) {
        res.end();
        return;
      }

      pipeline(Readable.fromWeb(up.body), res).catch(() => {
        if (!res.writableEnded) res.end();
      });
    } catch (e) {
      clearTimeout(upstreamTimer);
      if (!res.headersSent) {
        const aborted = e.name === 'AbortError';
        res.writeHead(aborted ? 504 : 502, { 'Content-Type': 'application/json' });
        res.end(aborted
          ? '{"type":"error","error":{"type":"timeout_error","message":"relay upstream timeout"}}'
          : '{"type":"error","error":{"type":"api_error","message":"relay forward failed"}}');
      } else {
        res.end();
      }
    }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  armIdle();
});
