// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TechFlow IT

// Delivery methods besides HTTP: network folder and e-mail.
// Both work without third-party libraries.

const fs = require('fs');
const path = require('path');
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');
const { L } = require('./i18n');

// ---------- Target folder ----------

/**
 * Stores the file in a target folder (local or network share).
 * Returns the same result format as the HTTP delivery.
 */
function zustellenOrdner(job, quellPfad, dateiName, cb) {
  const ziel = (job.zielOrdner || '').trim();
  if (!ziel) return cb({ ok: false, exitCode: 1, httpStatus: null, bodySnippet: '', errorText: L('No target folder specified') });

  try {
    fs.mkdirSync(ziel, { recursive: true });
  } catch (e) {
    return cb({ ok: false, exitCode: 1, httpStatus: null, bodySnippet: '', errorText: L('Cannot create the target folder: {error}', { error: e.message }) });
  }

  let zielDatei = path.join(ziel, dateiName);
  if (!job.ordnerUeberschreiben && fs.existsSync(zielDatei)) {
    // Do not overwrite an existing file; number the new one instead
    const endung = path.extname(dateiName);
    const stamm = path.basename(dateiName, endung);
    let n = 1;
    while (fs.existsSync(zielDatei) && n < 1000) {
      zielDatei = path.join(ziel, `${stamm}_${String(n).padStart(3, '0')}${endung}`);
      n += 1;
    }
  }

  // Write under a temporary name first, then rename — this way the
  // receiving side never sees a half-written file.
  const zwischen = zielDatei + '.teil';
  try {
    fs.copyFileSync(quellPfad, zwischen);
    fs.renameSync(zwischen, zielDatei);
  } catch (e) {
    try { fs.unlinkSync(zwischen); } catch { /* ignore */ }
    return cb({ ok: false, exitCode: 1, httpStatus: null, bodySnippet: '', errorText: L('Storing the file failed: {error}', { error: e.message }) });
  }

  cb({
    ok: true,
    exitCode: 0,
    httpStatus: 'ORDNER',
    bodySnippet: L('Stored as {path}', { path: zielDatei }),
    errorText: null,
  });
}

// ---------- E-mail ----------

function smtpZeile(sock, daten) {
  return new Promise((resolve, reject) => {
    let puffer = '';
    const aufSammeln = (teil) => {
      puffer += teil.toString('latin1');
      // A complete reply is recognised by the space after the code
      const zeilen = puffer.split(/\r?\n/).filter(Boolean);
      const letzte = zeilen[zeilen.length - 1];
      if (letzte && /^\d{3} /.test(letzte)) {
        sock.removeListener('data', aufSammeln);
        const code = Number(letzte.slice(0, 3));
        if (code >= 400) reject(new Error(letzte));
        else resolve(puffer);
      }
    };
    sock.on('data', aufSammeln);
    sock.once('error', reject);
    if (daten !== null) sock.write(daten);
  });
}

/**
 * Sends the file as an e-mail attachment via SMTP.
 * Supports STARTTLS (default) and unencrypted connections.
 */
/**
 * Builds the raw SMTP message text (headers + body).
 * Without an attachment this is a plain text mail, with an attachment a
 * two-part MIME message (text + file).
 */
function baueSmtpNachricht({ von, empfaenger, betreff, text, anhang }) {
  const betreffZeile = `Subject: =?UTF-8?B?${Buffer.from(betreff, 'utf8').toString('base64')}?=`;
  if (!anhang) {
    return [
      `From: ${von}`,
      `To: ${empfaenger.join(', ')}`,
      betreffZeile,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      '',
      text,
      '',
    ].join('\r\n');
  }

  const grenze = 'grenze_' + crypto.randomBytes(12).toString('hex');
  const base64 = anhang.inhalt.toString('base64').replace(/(.{76})/g, '$1\r\n');
  return [
    `From: ${von}`,
    `To: ${empfaenger.join(', ')}`,
    betreffZeile,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${grenze}"`,
    '',
    `--${grenze}`,
    'Content-Type: text/plain; charset=UTF-8',
    '',
    text,
    '',
    `--${grenze}`,
    `Content-Type: application/octet-stream; name="${anhang.dateiName}"`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: attachment; filename="${anhang.dateiName}"`,
    '',
    base64,
    `--${grenze}--`,
    '',
  ].join('\r\n');
}

/**
 * Connects to the SMTP server, authenticates (if credentials are given)
 * and hands over the finished message. Used both for sending files
 * (target type e-mail) and for notifications — the two only differ in how
 * the message itself is built.
 */
function sendeUeberSmtp(cfg, nachricht, empfaenger, cb) {
  const host = (cfg.host || '').trim();
  const von = (cfg.von || '').trim() || cfg.benutzer;
  if (!host) return cb({ ok: false, exitCode: 1, httpStatus: null, bodySnippet: '', errorText: L('No SMTP server specified') });
  if (empfaenger.length === 0) return cb({ ok: false, exitCode: 1, httpStatus: null, bodySnippet: '', errorText: L('No recipient address specified') });

  const port = Number(cfg.port) || 587;
  const direktTls = port === 465;
  let sock = null;
  let erledigt = false;
  const fertig = (ergebnis) => {
    if (erledigt) return;
    erledigt = true;
    try { if (sock) sock.destroy(); } catch { /* ignore */ }
    cb(ergebnis);
  };

  const ablauf = setTimeout(() => {
    fertig({ ok: false, exitCode: 1, httpStatus: null, bodySnippet: '', errorText: L('Timeout while sending via SMTP') });
  }, (cfg.timeoutSec || 60) * 1000);

  const durchlauf = async (verbindung) => {
    try {
      sock = verbindung;
      await smtpZeile(sock, null); // greeting
      await smtpZeile(sock, `EHLO folderpost\r\n`);

      if (!direktTls && cfg.sicher !== false) {
        await smtpZeile(sock, 'STARTTLS\r\n');
        sock = tls.connect({ socket: sock, servername: host, rejectUnauthorized: false });
        await new Promise((r, j) => { sock.once('secureConnect', r); sock.once('error', j); });
        await smtpZeile(sock, `EHLO folderpost\r\n`);
      }

      if (cfg.benutzer) {
        await smtpZeile(sock, 'AUTH LOGIN\r\n');
        await smtpZeile(sock, Buffer.from(cfg.benutzer, 'utf8').toString('base64') + '\r\n');
        await smtpZeile(sock, Buffer.from(cfg.passwort || '', 'utf8').toString('base64') + '\r\n');
      }

      await smtpZeile(sock, `MAIL FROM:<${von}>\r\n`);
      for (const e of empfaenger) await smtpZeile(sock, `RCPT TO:<${e}>\r\n`);
      await smtpZeile(sock, 'DATA\r\n');
      // CRLF line endings and dot-stuffing (RFC 5321 4.5.2): a line starting with
      // "." would otherwise end the message early.
      const daten = nachricht.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
      const antwort = await smtpZeile(sock, daten + '\r\n.\r\n');
      try { sock.write('QUIT\r\n'); } catch { /* ignore */ }

      clearTimeout(ablauf);
      fertig({
        ok: true, exitCode: 0, httpStatus: 'MAIL',
        bodySnippet: L('Sent to {to} — {reply}', { to: empfaenger.join(', '), reply: String(antwort).trim().split('\n').pop() }),
        errorText: null,
      });
    } catch (e) {
      clearTimeout(ablauf);
      fertig({ ok: false, exitCode: 1, httpStatus: null, bodySnippet: '', errorText: L('SMTP error: {error}', { error: e.message }) });
    }
  };

  try {
    const verbindung = direktTls
      ? tls.connect({ host, port, servername: host, rejectUnauthorized: false })
      : net.connect({ host, port });
    verbindung.once('error', (e) => {
      clearTimeout(ablauf);
      fertig({ ok: false, exitCode: 1, httpStatus: null, bodySnippet: '', errorText: L('Connection to the SMTP server failed: {error}', { error: e.message }) });
    });
    verbindung.once(direktTls ? 'secureConnect' : 'connect', () => durchlauf(verbindung));
  } catch (e) {
    clearTimeout(ablauf);
    fertig({ ok: false, exitCode: 1, httpStatus: null, bodySnippet: '', errorText: e.message });
  }
}

function zustellenEmail(job, quellPfad, dateiName, cb) {
  const an = (job.mailAn || '').trim();
  if (!(job.smtpHost || '').trim()) return cb({ ok: false, exitCode: 1, httpStatus: null, bodySnippet: '', errorText: L('No SMTP server specified') });
  if (!an) return cb({ ok: false, exitCode: 1, httpStatus: null, bodySnippet: '', errorText: L('No recipient address specified') });

  let inhalt;
  try { inhalt = fs.readFileSync(quellPfad); } catch (e) {
    return cb({ ok: false, exitCode: 1, httpStatus: null, bodySnippet: '', errorText: L('File not readable: {error}', { error: e.message }) });
  }

  const empfaenger = an.split(/[;,]/).map((x) => x.trim()).filter(Boolean);
  // {filename} and {jobname}; {dateiname} remains valid as the older name
  const betreff = String(job.mailBetreff || 'New file: {filename}')
    .replace(/\{(dateiname|filename)\}/g, dateiName)
    .replace(/\{jobname\}/g, job.name || '');
  const von = (job.mailVon || '').trim() || job.smtpBenutzer;
  const nachricht = baueSmtpNachricht({
    von, empfaenger, betreff,
    text: [L('Transferred automatically by Folderpost.'), L('Job: {job}', { job: job.name }), L('File: {file}', { file: dateiName })].join('\r\n'),
    anhang: { inhalt, dateiName },
  });

  sendeUeberSmtp({
    host: job.smtpHost, port: job.smtpPort, sicher: job.smtpSicher,
    benutzer: job.smtpBenutzer, passwort: job.smtpPasswort, von, timeoutSec: job.timeoutSec || 60,
  }, nachricht, empfaenger, cb);
}

/**
 * Sends a simple text notification (no file attachment) —
 * used when a file is moved to quarantine.
 */
function sendeBenachrichtigungsMail(cfg, betreff, text, cb) {
  const an = (cfg.an || '').trim();
  const empfaenger = an.split(/[;,]/).map((x) => x.trim()).filter(Boolean);
  const von = (cfg.von || '').trim() || cfg.smtpBenutzer;
  const nachricht = baueSmtpNachricht({ von, empfaenger, betreff, text });
  sendeUeberSmtp({
    host: cfg.smtpHost, port: cfg.smtpPort, sicher: cfg.smtpSicher,
    benutzer: cfg.smtpBenutzer, passwort: cfg.smtpPasswort, von, timeoutSec: 30,
  }, nachricht, empfaenger, cb);
}

module.exports = { zustellenOrdner, zustellenEmail, sendeBenachrichtigungsMail };
