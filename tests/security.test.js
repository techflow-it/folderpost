// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TechFlow IT
//
// Security cases: path traversal, secrets in API responses, HTML in job names,
// roles and the sign-in lockout.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { startServer, tempDir } = require('./helpers.js');

const XSS = '<img src=x onerror="window.__xss=1">';

test('security', async (t) => {
  const server = await startServer();
  const work = tempDir();
  t.after(async () => {
    await server.stop();
    fs.rmSync(work, { recursive: true, force: true });
  });
  const configText = () => fs.readFileSync(path.join(server.app, 'config.json'), 'utf8');

  await t.test('static files cannot escape the public folder', async () => {
    for (const p of ['/../config.json', '/%2e%2e/config.json', '/..%2fconfig.json', '/..%5cconfig.json',
      '/public/../../config.json', '//config.json', '/../server.js']) {
      const r = await server.api('GET', p);
      assert.ok(!r.text.includes('"globalPollIntervalSec"'), `${p} leaked config.json`);
      assert.ok(!r.text.includes("require('"), `${p} leaked server code`);
    }
  });

  let jobId;
  await t.test('stored passwords are never returned by the API', async () => {
    const src = path.join(work, 'src');
    fs.mkdirSync(src);
    const r = await server.api('POST', '/api/jobs', {
      name: XSS, category: XSS, notes: XSS, sourcePath: src, filePattern: '*.xml',
      targetUrl: 'https://api.example.com/upload', authType: 'basic', authUser: 'svc', authPassword: 'S3cret-Http',
      smtpPasswort: 'S3cret-Smtp', pollIntervalSec: 3600, active: false,
    });
    assert.equal(r.status, 201);
    jobId = r.json.id;
    for (const url of ['/api/jobs', '/api/status', '/api/config/export']) {
      const res = await server.api('GET', url);
      if (url === '/api/config/export') continue;   // the export is an explicit backup including credentials
      assert.ok(!res.text.includes('S3cret-Http') && !res.text.includes('S3cret-Smtp'), `${url} leaks a password`);
    }
    assert.ok(configText().includes('S3cret-Http'), 'the password is kept on the server');
  });

  await t.test('HTML in job names is returned as JSON data, not markup', async () => {
    const r = await server.api('GET', '/api/jobs');
    assert.match(r.headers['content-type'], /^application\/json/);
    assert.equal(r.json.find((j) => j.id === jobId).name, XSS);
  });

  await t.test('the download endpoint only serves files from the job folders', async () => {
    fs.writeFileSync(path.join(work, 'secret.txt'), 'top secret');
    for (const file of ['../secret.txt', '..\\secret.txt', '../../app/config.json', '/etc/passwd', 'C:\\Windows\\win.ini']) {
      const r = await server.api('GET', `/api/download?jobId=${jobId}&file=${encodeURIComponent(file)}`);
      assert.notEqual(r.status, 200, `${file} must not be served`);
      assert.ok(!r.text.includes('top secret'));
    }
  });

  let adminCookie;
  await t.test('after the first user exists, the API requires sign-in', async () => {
    const created = await server.api('POST', '/api/benutzer', { name: 'admin', passwort: 'correct-horse', rolle: 'verwaltung' });
    assert.equal(created.status, 201);
    assert.ok(!configText().includes('correct-horse'), 'user passwords are stored hashed');

    const anonymous = await server.api('GET', '/api/jobs');
    assert.equal(anonymous.status, 401);
    const page = await server.api('GET', '/');
    assert.ok([302, 303].includes(page.status), 'pages redirect to the sign-in screen');
    assert.equal((await server.api('GET', '/anmelden.html')).status, 200);

    const signIn = await server.api('POST', '/api/anmelden', { name: 'admin', passwort: 'correct-horse' });
    assert.equal(signIn.status, 200);
    const cookie = signIn.headers['set-cookie'][0];
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    adminCookie = cookie.split(';')[0];
    assert.equal((await server.api('GET', '/api/jobs', undefined, { Cookie: adminCookie })).status, 200);
  });

  await t.test('viewers cannot change anything', async () => {
    await server.api('POST', '/api/benutzer', { name: 'viewer', passwort: 'just-looking', rolle: 'betrachter' }, { Cookie: adminCookie });
    const signIn = await server.api('POST', '/api/anmelden', { name: 'viewer', passwort: 'just-looking' });
    const cookie = signIn.headers['set-cookie'][0].split(';')[0];
    assert.equal((await server.api('GET', '/api/jobs', undefined, { Cookie: cookie })).status, 200);
    const write = await server.api('POST', '/api/jobs', { name: 'nope' }, { Cookie: cookie });
    assert.equal(write.status, 403);
    const del = await server.api('DELETE', `/api/jobs/${jobId}`, undefined, { Cookie: cookie });
    assert.equal(del.status, 403);
  });

  await t.test('repeated failed sign-ins lock the account', async () => {
    for (let i = 1; i <= 5; i++) {
      const r = await server.api('POST', '/api/anmelden', { name: 'admin', passwort: `wrong-${i}` });
      assert.equal(r.status, 401, `attempt ${i}`);
    }
    const locked = await server.api('POST', '/api/anmelden', { name: 'admin', passwort: 'correct-horse' });
    assert.equal(locked.status, 429, 'even the correct password is refused while locked');
    assert.match(locked.json.error, /wait \d+ seconds/);
    const unknown = await server.api('POST', '/api/anmelden', { name: 'nobody', passwort: 'x' });
    assert.equal(unknown.status, 401, 'unknown users get the same answer as wrong passwords');
  });
});

test('the web interface escapes job data before inserting it as HTML', () => {
  // Static guard: user-controlled fields must not be interpolated into markup unescaped.
  // The browser test tools/xss-scan.py checks the rendered pages as well.
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const raw = [...src.matchAll(/\$\{\s*(?:job|j|l|entry|e)\.(name|jobName|category|notes|sourcePath|filePattern|file|message|targetUrl|archiveSubfolder|errorSubfolder)\s*\}/g)]
    .map((m) => m[0]);
  assert.deepEqual(raw, []);
  const signIn = fs.readFileSync(path.join(__dirname, '..', 'public', 'anmelden.html'), 'utf8');
  assert.ok(signIn.includes('escapeHtml(j.name)'));
});
