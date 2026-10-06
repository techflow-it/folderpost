// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TechFlow IT
//
// End-to-end tests against a running Folderpost in a temporary folder:
// file filter, folder delivery, batch splitting, retries and quarantine.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { startServer, startHttpTarget, tempDir, waitFor } = require('./helpers.js');

const exists = (p) => fs.existsSync(p);
const list = (p) => (exists(p) ? fs.readdirSync(p).sort() : []);

function folderJob(src, dst, extra = {}) {
  return {
    name: 'Invoices → Folder', sourcePath: src, filePattern: '*.xml', pollIntervalSec: 3600,
    zielTyp: 'ordner', zielOrdner: dst, onSuccess: 'archive', archiveSubfolder: '_sent', onError: 'keep', ...extra,
  };
}

test('server', async (t) => {
  const server = await startServer();
  const work = tempDir();
  t.after(async () => {
    await server.stop();
    fs.rmSync(work, { recursive: true, force: true });
  });

  await t.test('the file filter picks only matching files (case-insensitive)', async () => {
    const src = path.join(work, 'filter-src');
    const dst = path.join(work, 'filter-dst');
    fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, 'order-1.xml'), '<order id="1"/>');
    fs.writeFileSync(path.join(src, 'ORDER-2.XML'), '<order id="2"/>');
    fs.writeFileSync(path.join(src, 'notes.txt'), 'not for transfer');
    fs.writeFileSync(path.join(src, 'order-3.xml.tmp'), 'still being written');

    const created = await server.api('POST', '/api/jobs', folderJob(src, dst));
    assert.equal(created.status, 201);
    await server.api('POST', `/api/jobs/${created.json.id}/run-now`);

    await waitFor(() => list(dst).length === 2, { what: 'two delivered files' });
    assert.deepEqual(list(dst), ['ORDER-2.XML', 'order-1.xml']);
    assert.equal(fs.readFileSync(path.join(dst, 'order-1.xml'), 'utf8'), '<order id="1"/>');
    await waitFor(() => list(path.join(src, '_sent')).length === 2, { what: 'archived originals' });
    assert.deepEqual(list(src), ['_sent', 'notes.txt', 'order-3.xml.tmp']);
  });

  await t.test('folder delivery numbers files instead of overwriting', async () => {
    const src = path.join(work, 'num-src');
    const dst = path.join(work, 'num-dst');
    fs.mkdirSync(src);
    fs.mkdirSync(dst);
    fs.writeFileSync(path.join(dst, 'a.xml'), 'old');
    fs.writeFileSync(path.join(src, 'a.xml'), 'new');
    const created = await server.api('POST', '/api/jobs', folderJob(src, dst));
    await server.api('POST', `/api/jobs/${created.json.id}/run-now`);
    await waitFor(() => list(dst).length === 2, { what: 'numbered copy' });
    assert.equal(fs.readFileSync(path.join(dst, 'a.xml'), 'utf8'), 'old');
    const copy = list(dst).find((f) => f !== 'a.xml');
    assert.match(copy, /^a.*\.xml$/);
    assert.equal(fs.readFileSync(path.join(dst, copy), 'utf8'), 'new');
    assert.ok(!list(dst).some((f) => f.includes('.tmp') || f.startsWith('.')), 'no temporary files left behind');
  });

  await t.test('a batch scan is split into parts named after the QR codes', async () => {
    const src = path.join(work, 'batch-src');
    const dst = path.join(work, 'batch-dst');
    fs.mkdirSync(src);
    fs.copyFileSync(path.join(__dirname, 'fixtures', 'batch-jpeg.pdf'), path.join(src, 'scan_0001.pdf'));
    const created = await server.api('POST', '/api/jobs', folderJob(src, dst, {
      name: 'Scans → Document system', filePattern: '*.pdf', stapelTeilen: true,
    }));
    await server.api('POST', `/api/jobs/${created.json.id}/run-now`);
    await waitFor(() => list(dst).length === 3, { what: 'three parts' });
    assert.deepEqual(list(dst), ['scan_0001_01_A-1001.pdf', 'scan_0001_02_B-2002.pdf', 'scan_0001_03_C-3003.pdf']);
    for (const f of list(dst)) assert.equal(fs.readFileSync(path.join(dst, f)).subarray(0, 5).toString(), '%PDF-');
  });

  await t.test('failed transfers are retried and finally quarantined', async () => {
    const target = await startHttpTarget(500);
    try {
      const src = path.join(work, 'retry-src');
      fs.mkdirSync(src);
      fs.writeFileSync(path.join(src, 'order-9.xml'), '<order id="9"/>');
      const created = await server.api('POST', '/api/jobs', {
        name: 'Orders → Partner API', sourcePath: src, filePattern: '*.xml', pollIntervalSec: 1,
        targetUrl: target.url, method: 'POST', uploadMode: 'binary', onError: 'keep',
        maxVersuche: 2, wartezeitBasisSec: 1, timeoutSec: 10,
      });
      assert.equal(created.status, 201);

      await waitFor(() => exists(path.join(src, '_quarantine', 'order-9.xml')), { timeout: 30000, what: 'quarantine' });
      assert.equal(target.received.length, 2, 'exactly two attempts');
      assert.equal(target.received[0].body.toString(), '<order id="9"/>');
      assert.ok(!exists(path.join(src, 'order-9.xml')));

      const logs = await server.api('GET', '/api/logs?limit=50');
      const own = logs.json.filter((l) => l.jobId === created.json.id);
      assert.ok(own.some((l) => /quarantine/i.test(l.message)), 'quarantine is logged');
      await server.api('POST', `/api/jobs/${created.json.id}/toggle`);
    } finally {
      await target.close();
    }
  });

  await t.test('a successful HTTP transfer sends the file content', async () => {
    const target = await startHttpTarget(200);
    try {
      const src = path.join(work, 'http-src');
      fs.mkdirSync(src);
      fs.writeFileSync(path.join(src, 'order-7.xml'), '<order id="7"/>');
      const created = await server.api('POST', '/api/jobs', {
        name: 'Orders → API', sourcePath: src, filePattern: '*.xml', pollIntervalSec: 3600,
        targetUrl: target.url, method: 'PUT', uploadMode: 'binary', headers: ['Content-Type: application/xml'],
        onSuccess: 'archive', archiveSubfolder: '_sent',
      });
      await server.api('POST', `/api/jobs/${created.json.id}/run-now`);
      await waitFor(() => exists(path.join(src, '_sent', 'order-7.xml')), { what: 'archived after success' });
      assert.equal(target.received.length, 1);
      assert.equal(target.received[0].method, 'PUT');
      assert.equal(target.received[0].headers['content-type'], 'application/xml');
      assert.equal(target.received[0].body.toString(), '<order id="7"/>');
    } finally {
      await target.close();
    }
  });
});
