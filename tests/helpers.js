// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TechFlow IT
//
// Test helpers: start Folderpost in a temporary copy, talk to its API,
// wait for conditions. Nothing here touches the project folder.

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');

function tempDir(prefix = 'folderpost-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function copyApp(target) {
  fs.mkdirSync(target, { recursive: true });
  for (const f of fs.readdirSync(ROOT)) {
    if (f.endsWith('.js') || f === 'package.json') fs.copyFileSync(path.join(ROOT, f), path.join(target, f));
  }
  fs.cpSync(path.join(ROOT, 'public'), path.join(target, 'public'), { recursive: true });
}

function request(port, method, urlPath, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port, method, path: urlPath,
      headers: { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}), ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function waitFor(check, { timeout = 15000, interval = 200, what = 'condition' } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await check();
    if (last) return last;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** Starts Folderpost in a temporary folder. Returns { port, dir, api, stop }. */
async function startServer({ config = {}, env = {} } = {}) {
  const dir = tempDir();
  const app = path.join(dir, 'app');
  copyApp(app);
  const port = await freePort();
  fs.writeFileSync(path.join(app, 'config.json'), JSON.stringify({
    port, globalPollIntervalSec: 1, jobs: [], templates: [], ...config,
  }, null, 2));

  const proc = spawn(process.execPath, ['server.js'], {
    cwd: app,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  proc.stdout.on('data', (c) => { output += c; });
  proc.stderr.on('data', (c) => { output += c; });

  try {
    await waitFor(async () => {
      if (proc.exitCode !== null) throw new Error(`Server exited:\n${output}`);
      try { return (await request(port, 'GET', '/api/info')).status === 200; } catch { return false; }
    }, { what: 'server start' });
  } catch (e) {
    proc.kill();
    throw e;
  }

  const api = (method, urlPath, body, headers) => request(port, method, urlPath, { body, headers });
  const stop = () => new Promise((resolve) => {
    if (proc.exitCode !== null) return resolve();
    proc.once('exit', () => resolve());
    proc.kill();
  }).then(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

  return { port, dir, app, api, stop, output: () => output };
}

/** Minimal HTTP target that answers every request with `status`. */
function startHttpTarget(status = 200) {
  return new Promise((resolve) => {
    const received = [];
    const srv = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        received.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
        res.writeHead(srv.status);
        res.end(srv.status < 300 ? 'ok' : 'failure');
      });
    });
    srv.status = status;
    srv.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${srv.address().port}/upload`,
        received,
        setStatus: (s) => { srv.status = s; },
        close: () => new Promise((r) => srv.close(r)),
      });
    });
  });
}

/** Minimal SMTP server without TLS; collects the received messages. */
function startSmtpServer() {
  return new Promise((resolve) => {
    const messages = [];
    const srv = net.createServer((sock) => {
      let buffer = '';
      let inData = false;
      let current = { from: null, to: [], data: '' };
      sock.write('220 test.example.org ESMTP\r\n');
      sock.on('data', (chunk) => {
        buffer += chunk.toString('latin1');
        for (;;) {
          if (inData) {
            const end = buffer.indexOf('\r\n.\r\n');
            if (end < 0) return;
            current.data = buffer.slice(0, end);
            buffer = buffer.slice(end + 5);
            inData = false;
            messages.push(current);
            current = { from: null, to: [], data: '' };
            sock.write('250 OK\r\n');
            continue;
          }
          const nl = buffer.indexOf('\r\n');
          if (nl < 0) return;
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 2);
          const cmd = line.slice(0, 4).toUpperCase();
          if (cmd === 'EHLO' || cmd === 'HELO') sock.write('250-test.example.org\r\n250 8BITMIME\r\n');
          else if (cmd === 'MAIL') { current.from = line; sock.write('250 OK\r\n'); }
          else if (cmd === 'RCPT') { current.to.push(line); sock.write('250 OK\r\n'); }
          else if (cmd === 'DATA') { inData = true; sock.write('354 Go ahead\r\n'); }
          else if (cmd === 'QUIT') { sock.write('221 Bye\r\n'); sock.end(); return; }
          else sock.write('250 OK\r\n');
        }
      });
      sock.on('error', () => {});
    });
    srv.listen(0, '127.0.0.1', () => {
      resolve({ port: srv.address().port, messages, close: () => new Promise((r) => srv.close(r)) });
    });
  });
}

module.exports = { ROOT, tempDir, freePort, request, waitFor, startServer, startHttpTarget, startSmtpServer };
