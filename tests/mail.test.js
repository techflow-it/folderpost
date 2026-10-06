// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TechFlow IT
//
// E-mail delivery and notification mails against a local test SMTP server.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { startSmtpServer, tempDir } = require('./helpers.js');
const { zustellenEmail, sendeBenachrichtigungsMail } = require('../delivery.js');

// Decodes RFC 2047 encoded words (=?UTF-8?B?…?=) in a header line.
const decodeHeader = (line) => line.replace(/=\?UTF-8\?B\?([^?]+)\?=/gi, (m, b64) => Buffer.from(b64, 'base64').toString('utf8'));
const subjectOf = (data) => decodeHeader((data.match(/^Subject: (.*)$/m) || [])[1] || '');

test('sends a notification e-mail', async () => {
  const smtp = await startSmtpServer();
  try {
    const result = await new Promise((resolve) => sendeBenachrichtigungsMail({
      smtpHost: '127.0.0.1', smtpPort: smtp.port, smtpSicher: false,
      von: 'folderpost@example.org', an: 'ops@example.org, it@example.org',
    }, 'Folderpost: file moved to quarantine — Orders', 'Job: Orders\nFile: a.xml', resolve));
    assert.equal(result.ok, true, result.errorText);
    assert.equal(smtp.messages.length, 1);
    const msg = smtp.messages[0];
    assert.match(msg.from, /folderpost@example\.org/);
    assert.equal(msg.to.length, 2);
    assert.equal(subjectOf(msg.data), 'Folderpost: file moved to quarantine — Orders');
    assert.match(msg.data, /File: a\.xml/);
  } finally {
    await smtp.close();
  }
});

test('delivers a file as an e-mail attachment', async () => {
  const smtp = await startSmtpServer();
  const dir = tempDir();
  try {
    const file = path.join(dir, 'report.csv');
    fs.writeFileSync(file, 'id;value\n1;42\n');
    const result = await new Promise((resolve) => zustellenEmail({
      name: 'Daily report → Mail', smtpHost: '127.0.0.1', smtpPort: smtp.port, smtpSicher: false,
      mailVon: 'folderpost@example.org', mailAn: 'inbox@example.com', mailBetreff: 'New file: {filename}',
    }, file, 'report.csv', resolve));
    assert.equal(result.ok, true, result.errorText);
    const msg = smtp.messages[0];
    assert.equal(subjectOf(msg.data), 'New file: report.csv');
    assert.match(msg.data, /multipart\/mixed/);
    assert.match(msg.data, /filename="?report\.csv"?/);
    assert.ok(msg.data.includes(Buffer.from('id;value\n1;42\n').toString('base64')));
  } finally {
    await smtp.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('lines starting with a dot do not end the message early', async () => {
  const smtp = await startSmtpServer();
  try {
    const result = await new Promise((resolve) => sendeBenachrichtigungsMail({
      smtpHost: '127.0.0.1', smtpPort: smtp.port, smtpSicher: false, von: 'a@example.org', an: 'b@example.org',
    }, 'Dots', 'first\n.\nlast line', resolve));
    assert.equal(result.ok, true, result.errorText);
    assert.equal(smtp.messages.length, 1);
    assert.match(smtp.messages[0].data, /\r\n\.\.\r\nlast line/);
  } finally {
    await smtp.close();
  }
});

test('reports an error when the SMTP server is unreachable', async () => {
  const result = await new Promise((resolve) => sendeBenachrichtigungsMail({
    smtpHost: '127.0.0.1', smtpPort: 9, smtpSicher: false, von: 'a@example.org', an: 'b@example.org',
  }, 'x', 'y', resolve));
  assert.equal(result.ok, false);
});
