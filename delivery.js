// Zustellwege neben HTTP: Netzwerkordner und E-Mail.
// Beide kommen ohne Fremdbibliotheken aus.

const fs = require('fs');
const path = require('path');
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');

// ---------- Zielordner ----------

/**
 * Legt die Datei in einem Zielordner ab (lokal oder Netzwerkfreigabe).
 * Liefert dasselbe Ergebnisformat wie die HTTP-Zustellung.
 */
function zustellenOrdner(job, quellPfad, dateiName, cb) {
  const ziel = (job.zielOrdner || '').trim();
  if (!ziel) return cb({ ok: false, exitCode: 1, httpStatus: null, bodySnippet: '', errorText: 'Kein Zielordner angegeben' });

  try {
    fs.mkdirSync(ziel, { recursive: true });
  } catch (e) {
    return cb({ ok: false, exitCode: 1, httpStatus: null, bodySnippet: '', errorText: `Zielordner nicht anlegbar: ${e.message}` });
  }

  let zielDatei = path.join(ziel, dateiName);
  if (!job.ordnerUeberschreiben && fs.existsSync(zielDatei)) {
    // Vorhandene Datei nicht überschreiben, sondern durchnummerieren
    const endung = path.extname(dateiName);
    const stamm = path.basename(dateiName, endung);
    let n = 1;
    while (fs.existsSync(zielDatei) && n < 1000) {
      zielDatei = path.join(ziel, `${stamm}_${String(n).padStart(3, '0')}${endung}`);
      n += 1;
    }
  }

  // Erst unter Zwischennamen schreiben, dann umbenennen — so sieht die
  // Gegenstelle nie eine halb geschriebene Datei.
  const zwischen = zielDatei + '.teil';
  try {
    fs.copyFileSync(quellPfad, zwischen);
    fs.renameSync(zwischen, zielDatei);
  } catch (e) {
    try { fs.unlinkSync(zwischen); } catch { /* egal */ }
    return cb({ ok: false, exitCode: 1, httpStatus: null, bodySnippet: '', errorText: `Ablegen fehlgeschlagen: ${e.message}` });
  }

  cb({
    ok: true,
    exitCode: 0,
    httpStatus: 'ORDNER',
    bodySnippet: `Abgelegt unter ${zielDatei}`,
    errorText: null,
  });
}

// ---------- E-Mail ----------

function smtpZeile(sock, daten) {
  return new Promise((resolve, reject) => {
    let puffer = '';
    const aufSammeln = (teil) => {
      puffer += teil.toString('latin1');
      // Vollständige Antwort erkennt man am Leerzeichen nach dem Code
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
 * Versendet die Datei als E-Mail-Anhang über SMTP.
 * Unterstützt STARTTLS (Standard) und unverschlüsselte Verbindungen.
 */
/**
 * Baut den rohen SMTP-Nachrichtentext (Kopfzeilen + Rumpf) auf.
 * Ohne Anhang entsteht eine schlichte Text-Mail, mit Anhang eine
 * zweiteilige MIME-Nachricht (Text + Datei).
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
 * Verbindet sich mit dem SMTP-Server, meldet sich an (falls Zugangsdaten
 * angegeben sind) und übergibt die fertige Nachricht. Wird sowohl für den
 * Versand von Dateien (Zielart E-Mail) als auch für Benachrichtigungen
 * genutzt — beides unterscheidet sich nur im Aufbau der Nachricht selbst.
 */
function sendeUeberSmtp(cfg, nachricht, empfaenger, cb) {
  const host = (cfg.host || '').trim();
  const von = (cfg.von || '').trim() || cfg.benutzer;
  if (!host) return cb({ ok: false, exitCode: 1, httpStatus: null, bodySnippet: '', errorText: 'Kein SMTP-Server angegeben' });
  if (empfaenger.length === 0) return cb({ ok: false, exitCode: 1, httpStatus: null, bodySnippet: '', errorText: 'Keine Empfängeradresse angegeben' });

  const port = Number(cfg.port) || 587;
  const direktTls = port === 465;
  let sock = null;
  let erledigt = false;
  const fertig = (ergebnis) => {
    if (erledigt) return;
    erledigt = true;
    try { if (sock) sock.destroy(); } catch { /* egal */ }
    cb(ergebnis);
  };

  const ablauf = setTimeout(() => {
    fertig({ ok: false, exitCode: 1, httpStatus: null, bodySnippet: '', errorText: 'Zeitüberschreitung beim SMTP-Versand' });
  }, (cfg.timeoutSec || 60) * 1000);

  const durchlauf = async (verbindung) => {
    try {
      sock = verbindung;
      await smtpZeile(sock, null); // Begrüßung
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
      const antwort = await smtpZeile(sock, nachricht + '\r\n.\r\n');
      try { sock.write('QUIT\r\n'); } catch { /* egal */ }

      clearTimeout(ablauf);
      fertig({
        ok: true, exitCode: 0, httpStatus: 'MAIL',
        bodySnippet: `Gesendet an ${empfaenger.join(', ')} — ${String(antwort).trim().split('\n').pop()}`,
        errorText: null,
      });
    } catch (e) {
      clearTimeout(ablauf);
      fertig({ ok: false, exitCode: 1, httpStatus: null, bodySnippet: '', errorText: `SMTP-Fehler: ${e.message}` });
    }
  };

  try {
    const verbindung = direktTls
      ? tls.connect({ host, port, servername: host, rejectUnauthorized: false })
      : net.connect({ host, port });
    verbindung.once('error', (e) => {
      clearTimeout(ablauf);
      fertig({ ok: false, exitCode: 1, httpStatus: null, bodySnippet: '', errorText: `Verbindung zum SMTP-Server fehlgeschlagen: ${e.message}` });
    });
    verbindung.once(direktTls ? 'secureConnect' : 'connect', () => durchlauf(verbindung));
  } catch (e) {
    clearTimeout(ablauf);
    fertig({ ok: false, exitCode: 1, httpStatus: null, bodySnippet: '', errorText: e.message });
  }
}

function zustellenEmail(job, quellPfad, dateiName, cb) {
  const an = (job.mailAn || '').trim();
  if (!(job.smtpHost || '').trim()) return cb({ ok: false, exitCode: 1, httpStatus: null, bodySnippet: '', errorText: 'Kein SMTP-Server angegeben' });
  if (!an) return cb({ ok: false, exitCode: 1, httpStatus: null, bodySnippet: '', errorText: 'Keine Empfängeradresse angegeben' });

  let inhalt;
  try { inhalt = fs.readFileSync(quellPfad); } catch (e) {
    return cb({ ok: false, exitCode: 1, httpStatus: null, bodySnippet: '', errorText: `Datei nicht lesbar: ${e.message}` });
  }

  const empfaenger = an.split(/[;,]/).map((x) => x.trim()).filter(Boolean);
  const betreff = String(job.mailBetreff || 'Neue Datei: {dateiname}')
    .replace(/\{dateiname\}/g, dateiName)
    .replace(/\{jobname\}/g, job.name || '');
  const von = (job.mailVon || '').trim() || job.smtpBenutzer;
  const nachricht = baueSmtpNachricht({
    von, empfaenger, betreff,
    text: `Automatisch übertragen durch Folderpost.\r\nJob: ${job.name}\r\nDatei: ${dateiName}`,
    anhang: { inhalt, dateiName },
  });

  sendeUeberSmtp({
    host: job.smtpHost, port: job.smtpPort, sicher: job.smtpSicher,
    benutzer: job.smtpBenutzer, passwort: job.smtpPasswort, von, timeoutSec: job.timeoutSec || 60,
  }, nachricht, empfaenger, cb);
}

/**
 * Verschickt eine einfache Text-Benachrichtigung (kein Datei-Anhang) —
 * genutzt, wenn eine Datei in die Quarantäne wandert.
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
