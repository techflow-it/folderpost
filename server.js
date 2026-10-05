// Folderpost — Backend
// Reine Node.js Bordmittel, keine externen npm-Pakete nötig.

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const crypto = require('crypto');
const os = require('os');
const verarbeitung = require('./processing');
const zustellung = require('./delivery');
const pdfteilen = require('./pdf-split');
const aktualisierung = require('./update');
const { dekodiereJpeg } = require('./jpeg');
const { leseQr } = require('./qr');

const VERSION = require('./package.json').version;

// Bauzeitpunkt: Änderungsdatum der server.js. So lassen sich zwei Pakete
// mit gleicher Versionsnummer trotzdem unterscheiden.
const BAUSTAND = (() => {
  try { return fs.statSync(__filename).mtime.toISOString(); } catch { return null; }
})();

// Vergleicht Versionsangaben wie "1.4.0" — Rückgabe >0, wenn a neuer als b
function versionVergleich(a, b) {
  const za = String(a).split('.').map((x) => parseInt(x, 10) || 0);
  const zb = String(b).split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(za.length, zb.length); i += 1) {
    const d = (za[i] || 0) - (zb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, 'config.json');
const LOG_PATH = path.join(ROOT, 'data', 'logs.jsonl');
const PUBLIC_DIR = path.join(ROOT, 'public');
const MAX_LOG_LINES_RETURNED = 500;

// ---------- Konfiguration ----------

function defaultSettings() {
  return {
    logRetentionDays: 90,
    dashboardAuth: { enabled: false, username: '', passwordHash: '', salt: '' },
    jobUebersichtImLogin: true,
    logoDatenUrl: '',      // Logo als Data-URL (klein halten)
    akzentFarbe: '',       // z. B. #D0764C — leer = Standard
    anzeigeName: '',       // eigener Anzeigename — leer = Projektname
    updatePruefUrl: '',
    neustartVerhalten: 'selbst',  // 'selbst' = neuen Vorgang starten, 'beenden' = nur beenden
    letzteUpdatePruefung: null, // Job-Namen und -Zustände schon vor der Anmeldung zeigen
    benutzer: [], // [{ id, name, anzeigename, salt, hash, verfahren, rolle }]
    benachrichtigung: {
      emailAktiv: false,
      smtpHost: '', smtpPort: 587, smtpSicher: true, smtpBenutzer: '', smtpPasswort: '',
      von: '', an: '',
      webhookAktiv: false,
      webhookUrl: '',
    },
  };
}

// ---------- Benutzer & Sitzungen ----------

const sitzungen = new Map(); // token -> { benutzerId, name, anzeigename, rolle, seit }

// Fehlversuche je Benutzername — nur im Arbeitsspeicher, nach Neustart leer
const anmeldeSperren = new Map();
const SITZUNG_DAUER = 12 * 60 * 60 * 1000;

// Passwörter werden mit PBKDF2 abgeleitet: Ein einfacher SHA-256 lässt sich
// milliardenfach pro Sekunde durchprobieren, 200.000 Runden bremsen das
// erheblich aus. Altbestände im alten Verfahren bleiben anmeldefähig und
// werden bei der nächsten Anmeldung still umgestellt.
const PBKDF2_RUNDEN = 200000;

function hashPasswort(passwort, salt) {
  return crypto.pbkdf2Sync(String(passwort), String(salt), PBKDF2_RUNDEN, 32, 'sha256').toString('hex');
}

function hashPasswortAlt(passwort, salt) {
  return crypto.createHash('sha256').update(salt + passwort).digest('hex');
}

// Vergleich ohne Laufzeitunterschied, damit sich Zeichen nicht erraten lassen
function gleichSicher(a, b) {
  const pa = Buffer.from(String(a));
  const pb = Buffer.from(String(b));
  if (pa.length !== pb.length) return false;
  return crypto.timingSafeEqual(pa, pb);
}

function benutzerListe() {
  return (config.settings && config.settings.benutzer) || [];
}

function zugriffsschutzAktiv() {
  return benutzerListe().length > 0;
}

function findeBenutzer(name) {
  const gesucht = String(name || '').trim().toLowerCase();
  return benutzerListe().find((b) => b.name.toLowerCase() === gesucht) || null;
}

function leseCookie(req, name) {
  const roh = req.headers.cookie || '';
  const treffer = roh.split(';').map((t) => t.trim()).find((t) => t.startsWith(name + '='));
  return treffer ? decodeURIComponent(treffer.slice(name.length + 1)) : null;
}

function aktuelleSitzung(req) {
  const token = leseCookie(req, 'sitzung');
  if (!token) return null;
  const s = sitzungen.get(token);
  if (!s) return null;
  if (Date.now() - s.seit > SITZUNG_DAUER) { sitzungen.delete(token); return null; }
  return { token, ...s };
}

// Ohne angelegte Benutzer ist die Anwendung offen — dann darf jeder alles.
// Sobald Benutzer existieren, entscheidet die Rolle.
function istVerwaltung(req) {
  if (!zugriffsschutzAktiv()) return true;
  const s = aktuelleSitzung(req);
  return Boolean(s && s.rolle === 'verwaltung');
}

// Betrachter dürfen ausschließlich lesen — jede verändernde Anfrage wird
// zentral abgewiesen, unabhängig vom einzelnen Endpunkt.
function istBetrachter(req) {
  if (!zugriffsschutzAktiv()) return false;
  const s = aktuelleSitzung(req);
  return Boolean(s && s.rolle === 'betrachter');
}

// Name für das Änderungsprotokoll
function benutzerName(req) {
  const s = aktuelleSitzung(req);
  if (s) return s.anzeigename || s.name;
  return zugriffsschutzAktiv() ? 'unbekannt' : 'ohne Anmeldung';
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    const initial = { port: 3000, globalPollIntervalSec: 5, jobs: [], settings: defaultSettings() };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(initial, null, 2));
    return initial;
  }
  const loaded = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  if (!loaded.settings) loaded.settings = defaultSettings();
  if (!loaded.settings.dashboardAuth) loaded.settings.dashboardAuth = defaultSettings().dashboardAuth;
  if (!loaded.settings.logRetentionDays) loaded.settings.logRetentionDays = 90;
  if (!loaded.settings.benachrichtigung) loaded.settings.benachrichtigung = defaultSettings().benachrichtigung;
  // Felder, die diese Fassung nicht kennt (z. B. aus älteren Versionen), werden
  // ignoriert und beim nächsten Speichern verworfen.
  const bekannt = new Set([...Object.keys(defaultSettings()), 'qrBefehl', 'language']);
  Object.keys(loaded.settings).forEach((k) => { if (!bekannt.has(k)) delete loaded.settings[k]; });
  return loaded;
}

const BACKUP_DIR = path.join(ROOT, 'data', 'config-backups');
const AUDIT_PATH = path.join(ROOT, 'data', 'aenderungen.jsonl');
const DEDUPE_PATH = path.join(ROOT, 'data', 'gesendete-dateien.json');
const MAX_BACKUPS = 10;

function backupConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return;
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(CONFIG_PATH, path.join(BACKUP_DIR, `config-${stamp}.json`));
    const files = fs.readdirSync(BACKUP_DIR).filter((f) => f.startsWith('config-')).sort();
    while (files.length > MAX_BACKUPS) {
      const oldest = files.shift();
      try { fs.unlinkSync(path.join(BACKUP_DIR, oldest)); } catch { /* egal */ }
    }
  } catch (err) {
    console.log('Konfigurations-Sicherung fehlgeschlagen:', err.message);
  }
}

function appendAudit(action, details) {
  try {
    fs.mkdirSync(path.dirname(AUDIT_PATH), { recursive: true });
    fs.appendFileSync(AUDIT_PATH, JSON.stringify({ ts: new Date().toISOString(), action, ...details }) + '\n');
  } catch { /* Protokollierung darf den Betrieb nicht stoppen */ }
}

// ---------- Benachrichtigung bei Störung ----------
// Wird eine Datei nach wiederholten Fehlversuchen in die Quarantäne verschoben,
// kann das per E-Mail und/oder Webhook gemeldet werden — konfiguriert unter
// den Einstellungen, nicht je Job, damit eine Stelle für alle Jobs reicht.

function sendeWebhook(urlStr, payload, cb) {
  let ziel;
  try { ziel = new URL(urlStr); } catch { return cb({ ok: false, fehler: 'Ungültige Webhook-URL' }); }
  const lib = ziel.protocol === 'http:' ? http : https;
  const body = JSON.stringify(payload);
  let erledigt = false;
  const fertig = (r) => { if (!erledigt) { erledigt = true; cb(r); } };
  try {
    const anfrage = lib.request({
      hostname: ziel.hostname,
      port: ziel.port || (ziel.protocol === 'http:' ? 80 : 443),
      path: ziel.pathname + ziel.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 10000,
      rejectUnauthorized: false,
    }, (res) => {
      res.on('data', () => {}); // Antwortinhalt wird nicht gebraucht
      res.on('end', () => {
        const ok = res.statusCode >= 200 && res.statusCode < 300;
        fertig({ ok, fehler: ok ? null : `HTTP ${res.statusCode}` });
      });
    });
    anfrage.on('timeout', () => { anfrage.destroy(); fertig({ ok: false, fehler: 'Zeitüberschreitung' }); });
    anfrage.on('error', (e) => fertig({ ok: false, fehler: e.message }));
    anfrage.write(body);
    anfrage.end();
  } catch (e) {
    fertig({ ok: false, fehler: e.message });
  }
}

// Schickt eine Testbenachrichtigung über alle aktivierten Kanäle und liefert
// das Ergebnis je Kanal zurück — genutzt vom „Test senden“-Knopf.
function sendeTestBenachrichtigung(cfg) {
  const ergebnisse = {};
  const wartend = [];
  if (cfg.emailAktiv) {
    wartend.push(new Promise((resolve) => {
      zustellung.sendeBenachrichtigungsMail(
        cfg, 'Folderpost: Testbenachrichtigung',
        'Dies ist eine Testbenachrichtigung von Folderpost.\nIst diese Mail angekommen, ist die Einrichtung in Ordnung.',
        (r) => { ergebnisse.email = r.ok ? { ok: true } : { ok: false, fehler: r.errorText }; resolve(); },
      );
    }));
  }
  if (cfg.webhookAktiv) {
    if (!cfg.webhookUrl) {
      ergebnisse.webhook = { ok: false, fehler: 'Keine Webhook-URL angegeben' };
    } else {
      wartend.push(new Promise((resolve) => {
        sendeWebhook(cfg.webhookUrl, {
          ereignis: 'test', meldung: 'Testbenachrichtigung von Folderpost', zeitpunkt: new Date().toISOString(),
        }, (r) => { ergebnisse.webhook = r; resolve(); });
      }));
    }
  }
  return Promise.all(wartend).then(() => ergebnisse);
}

// Tatsächliche Auslösung bei einer Störung (Datei in Quarantäne). Höchstens
// eine Benachrichtigung je Job innerhalb der Sperrfrist, damit ein Job mit
// vielen betroffenen Dateien nicht ebenso viele Meldungen auslöst.
const BENACHRICHTIGUNG_SPERRFRIST_MS = 15 * 60 * 1000;

function sendeStoerungsBenachrichtigung(job, rt, grund, dateiName) {
  const cfg = config.settings.benachrichtigung;
  if (!cfg || (!cfg.emailAktiv && !cfg.webhookAktiv)) return;

  const jetzt = Date.now();
  if (rt.letzteBenachrichtigungTs && jetzt - rt.letzteBenachrichtigungTs < BENACHRICHTIGUNG_SPERRFRIST_MS) return;
  rt.letzteBenachrichtigungTs = jetzt;

  const adresse = `http://${os.hostname()}:${config.port}`;
  const betreff = `Folderpost: Datei in Quarantäne — ${job.name}`;
  const text = [
    `Job: ${job.name}`,
    `Datei: ${dateiName}`,
    `Grund: ${grund}`,
    `Zeitpunkt: ${new Date().toLocaleString('de-DE')}`,
    '',
    `Folderpost (Adresse ggf. an das eigene Netz anpassen): ${adresse}`,
  ].join('\n');

  if (cfg.emailAktiv) {
    zustellung.sendeBenachrichtigungsMail(cfg, betreff, text, (r) => {
      if (!r.ok) console.log('Benachrichtigung per E-Mail fehlgeschlagen:', r.errorText);
    });
  }
  if (cfg.webhookAktiv && cfg.webhookUrl) {
    sendeWebhook(cfg.webhookUrl, {
      ereignis: 'quarantaene', job: job.name, jobId: job.id, datei: dateiName,
      grund, zeitpunkt: new Date().toISOString(), adresse,
    }, (r) => {
      if (!r.ok) console.log('Benachrichtigung per Webhook fehlgeschlagen:', r.fehler);
    });
  }
}

function readAudit(limit = 200) {
  if (!fs.existsSync(AUDIT_PATH)) return [];
  const lines = fs.readFileSync(AUDIT_PATH, 'utf8').split('\n').filter(Boolean);
  return lines.map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean).reverse().slice(0, limit);
}

// Register bereits gesendeter Dateien (Pruefsumme je Job) fuer die Duplikat-Erkennung
let dedupeStore = {};
function loadDedupe() {
  try { dedupeStore = JSON.parse(fs.readFileSync(DEDUPE_PATH, 'utf8')); } catch { dedupeStore = {}; }
}
function saveDedupe() {
  try {
    fs.mkdirSync(path.dirname(DEDUPE_PATH), { recursive: true });
    fs.writeFileSync(DEDUPE_PATH, JSON.stringify(dedupeStore));
  } catch { /* egal */ }
}
function fileHash(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}
function isDuplicate(jobId, hash) {
  return Boolean(dedupeStore[jobId] && dedupeStore[jobId][hash]);
}
function rememberHash(jobId, hash, fileName) {
  if (!dedupeStore[jobId]) dedupeStore[jobId] = {};
  dedupeStore[jobId][hash] = { file: fileName, ts: new Date().toISOString() };
  // Register begrenzen, damit die Datei nicht unbegrenzt waechst
  const entries = Object.entries(dedupeStore[jobId]);
  if (entries.length > 5000) {
    entries.sort((a, b) => new Date(a[1].ts) - new Date(b[1].ts));
    dedupeStore[jobId] = Object.fromEntries(entries.slice(entries.length - 5000));
  }
  saveDedupe();
}
loadDedupe();

function saveConfig(cfg) {
  backupConfig();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

let config = loadConfig();

// Laufzeitstatus pro Job (nicht persistiert)
const jobRuntime = {}; // id -> { lastRunTs, lastResult, running, nextDueTs }

function ensureRuntime(job) {
  if (!jobRuntime[job.id]) {
    jobRuntime[job.id] = { lastRunTs: null, lastResult: null, running: false, nextDueTs: Date.now(), consecutiveFailures: 0, waitingCount: 0, inArbeit: new Map(), versuche: new Map() };
  }
  return jobRuntime[job.id];
}

// ---------- Logging ----------

function appendLog(entry) {
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + '\n');
}

function readAllLogs() {
  if (!fs.existsSync(LOG_PATH)) return [];
  const lines = fs.readFileSync(LOG_PATH, 'utf8').split('\n').filter(Boolean);
  return lines.map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

function readLogs({ jobId, status, limit, q } = {}) {
  let entries = readAllLogs();
  if (jobId) entries = entries.filter((e) => e.jobId === jobId);
  if (status) entries = entries.filter((e) => e.status === status);
  if (q && q.trim()) {
    // Volltextsuche über die Felder, in denen ein Dateiname, eine
    // Auftragsnummer oder eine Antwort der Gegenstelle typischerweise steht.
    const gesucht = q.trim().toLowerCase();
    entries = entries.filter((e) => [
      e.jobName, e.file, e.message, e.qrWert, e.probennummer, e.targetUrl, e.httpStatus,
    ].some((feld) => feld !== undefined && feld !== null && String(feld).toLowerCase().includes(gesucht)));
  }
  entries.reverse(); // neueste zuerst
  const n = Math.min(limit || MAX_LOG_LINES_RETURNED, MAX_LOG_LINES_RETURNED);
  return entries.slice(0, n);
}

// ---------- Datei-Matching ----------

function globToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp('^' + escaped + '$', 'i');
}

function listMatchingFiles(sourcePath, pattern, options = {}) {
  let entries;
  try {
    entries = fs.readdirSync(sourcePath, { withFileTypes: true });
  } catch (err) {
    throw new Error(`Ordner nicht erreichbar: ${sourcePath} (${err.code || err.message})`);
  }
  const re = globToRegExp(pattern || '*');
  const minAgeMs = (options.minFileAgeSec || 0) * 1000;
  const maxBytes = (options.maxFileSizeMB || 0) * 1024 * 1024;
  const now = Date.now();

  const accepted = [];
  const tooYoung = [];
  const tooLarge = [];

  entries.filter((e) => e.isFile() && re.test(e.name)).forEach((e) => {
    const full = path.join(sourcePath, e.name);
    let stat;
    try { stat = fs.statSync(full); } catch { return; }

    // Die Datei wird moeglicherweise noch geschrieben: erst nach Ruhezeit senden
    if (minAgeMs > 0 && (now - stat.mtimeMs) < minAgeMs) { tooYoung.push(e.name); return; }
    if (maxBytes > 0 && stat.size > maxBytes) { tooLarge.push({ name: e.name, size: stat.size }); return; }
    accepted.push(full);
  });

  return { accepted, tooYoung, tooLarge };
}

// ---------- curl-Ausführung ----------

function buildCurlArgs(job, filePath) {
  const args = ['-sS', '-o', '-', '-w', '\n__HTTP_STATUS__:%{http_code}', '-X', job.method || 'POST'];
  const headers = [...(job.headers || [])];
  // Bei der PDF-Verarbeitung wird JSON gesendet — passenden Content-Type ergaenzen,
  // sofern der Job nicht bereits selbst einen gesetzt hat
  if (job.processor === 'pdf-qr-json' && job.sendeFormat !== 'multipart-metadata'
      && !headers.some((h) => /^content-type:/i.test((h || '').trim()))) {
    headers.push('Content-Type: application/json; charset=utf-8');
  }
  headers.forEach((h) => { if (h && h.trim()) args.push('-H', h.trim()); });
  if (job.authType === 'basic' && job.authUser) {
    args.push('-u', `${job.authUser}:${job.authPassword || ''}`);
  }
  (job.curlExtraArgs || []).forEach((a) => { if (a && a.trim()) args.push(a.trim()); });

  // Sendung aus der PDF-Verarbeitung: PDF-Datei plus Metadatenfeld
  if (filePath && typeof filePath === 'object' && filePath.modus === 'multipart') {
    args.push('-F', `${job.dateiFeldName || 'file1'}=@${filePath.pdfPfad};type=application/pdf`);
    // "=<datei" liest den Feldwert aus der Datei — vermeidet Anfuehrungszeichen-Probleme
    args.push('-F', `${job.metadataFeldName || 'metadata1'}=<${filePath.metaPfad}`);
    args.push(job.targetUrl);
    return args;
  }
  if (filePath && typeof filePath === 'object') filePath = filePath.sendePfad;

  if (job.uploadMode === 'multipart') {
    const field = job.multipartField || 'file';
    args.push('-F', `${field}=@${filePath}`);
  } else {
    args.push('--data-binary', `@${filePath}`);
  }
  args.push(job.targetUrl);
  return args;
}

function runCurl(job, filePath, cb, targetOverride) {
  const effective = targetOverride ? { ...job, targetUrl: targetOverride } : job;

  if (job.dryRun) {
    // Testmodus: nichts senden, nur protokollieren, was passiert waere
    return cb({
      ok: true,
      exitCode: 0,
      httpStatus: 'TEST',
      bodySnippet: `Testmodus — es wurde NICHTS gesendet. Ziel wäre: ${effective.targetUrl}`,
      errorText: null,
      dryRun: true,
    });
  }

  const args = buildCurlArgs(effective, filePath);
  execFile('curl', args, { timeout: (job.timeoutSec || 30) * 1000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
    const marker = '__HTTP_STATUS__:';
    const idx = stdout.lastIndexOf(marker);
    let httpStatus = null;
    let body = stdout;
    if (idx !== -1) {
      httpStatus = stdout.slice(idx + marker.length).trim();
      body = stdout.slice(0, idx).replace(/\n$/, '');
    }
    const exitCode = err ? (err.code ?? 1) : 0;
    const ok = !err && httpStatus && httpStatus.startsWith('2');
    cb({
      ok: Boolean(ok),
      exitCode,
      httpStatus,
      bodySnippet: (body || '').slice(0, 8000),
      errorText: err ? (stderr || err.message) : (stderr || null),
    });
  });
}

// Sendet an Haupt- und Zusatzziele; Gesamtergebnis nur ok, wenn alle Ziele ok sind
function runCurlAllTargets(job, filePath, cb) {
  // Andere Zieltypen als HTTP werden direkt bedient
  if (job.zielTyp === 'ordner' || job.zielTyp === 'email') {
    const pfad = (filePath && typeof filePath === 'object')
      ? (filePath.modus === 'multipart' ? filePath.pdfPfad : filePath.sendePfad)
      : filePath;
    const name = path.basename(
      (filePath && typeof filePath === 'object' && filePath.modus === 'multipart') ? filePath.pdfPfad : pfad,
    );
    if (job.dryRun) {
      return cb({
        ok: true, exitCode: 0, httpStatus: 'TEST', dryRun: true, errorText: null,
        bodySnippet: `Testmodus — nichts gesendet. Ziel wäre: ${job.zielTyp === 'ordner' ? job.zielOrdner : job.mailAn}`,
      }, []);
    }
    const weiter = (r) => cb(r, [{ url: job.zielTyp === 'ordner' ? job.zielOrdner : job.mailAn, ...r }]);
    if (job.zielTyp === 'ordner') return zustellung.zustellenOrdner(job, pfad, name, weiter);
    return zustellung.zustellenEmail(job, pfad, name, weiter);
  }

  const targets = [job.targetUrl, ...(job.extraTargetUrls || [])].filter(Boolean);
  const results = [];
  let remaining = targets.length;
  if (remaining === 0) return cb({ ok: false, exitCode: 1, httpStatus: null, bodySnippet: '', errorText: 'Keine Ziel-URL konfiguriert' }, []);

  targets.forEach((url, index) => {
    runCurl(job, filePath, (r) => {
      results[index] = { url, ...r };
      remaining -= 1;
      if (remaining > 0) return;
      const allOk = results.every((x) => x.ok);
      const primary = results[0];
      const summary = targets.length > 1
        ? results.map((x) => `${x.url} → ${x.ok ? 'OK' : 'FEHLER'}${x.httpStatus ? ' (' + x.httpStatus + ')' : ''}`).join(' | ')
        : null;
      cb({
        ok: allOk,
        exitCode: primary.exitCode,
        httpStatus: primary.httpStatus,
        bodySnippet: summary ? summary + '\n' + (primary.bodySnippet || '') : primary.bodySnippet,
        errorText: allOk ? null : results.filter((x) => !x.ok).map((x) => `${x.url}: ${x.errorText || x.bodySnippet || 'Fehler'}`).join(' | '),
        dryRun: primary.dryRun,
      }, results);
    }, url);
  });
}

// ---------- Job-Verarbeitung ----------

function moveFile(filePath, sourcePath, subfolder) {
  const dir = path.join(sourcePath, subfolder);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, path.basename(filePath));
  fs.renameSync(filePath, target);
}

function processJob(job) {
  const rt = ensureRuntime(job);
  if (rt.running) return;
  rt.running = true;
  let scan;
  try {
    scan = listMatchingFiles(job.sourcePath, job.filePattern, {
      minFileAgeSec: job.minFileAgeSec,
      maxFileSizeMB: job.maxFileSizeMB,
    });
  } catch (err) {
    appendLog({
      ts: new Date().toISOString(), jobId: job.id, jobName: job.name, targetUrl: job.targetUrl,
      file: null, status: 'error', httpStatus: null,
      message: err.message,
    });
    rt.lastRunTs = Date.now();
    rt.lastResult = 'error';
    rt.consecutiveFailures += 1;
    if (rt.inArbeit) rt.inArbeit.clear();
    rt.running = false;
    return;
  }

  const files = scan.accepted;
  rt.waitingCount = scan.tooYoung.length;
  rt.wartendAufWiederholung = 0;

  // Zu grosse Dateien einmalig protokollieren, damit sie nicht stillschweigend liegen bleiben
  rt.reportedOversize = rt.reportedOversize || new Set();
  scan.tooLarge.forEach((f) => {
    if (rt.reportedOversize.has(f.name)) return;
    rt.reportedOversize.add(f.name);
    appendLog({
      ts: new Date().toISOString(), jobId: job.id, jobName: job.name, targetUrl: job.targetUrl,
      file: f.name, fileSize: f.size, status: 'error', httpStatus: null,
      message: `Übersprungen: Datei ist ${f.size >= 1024 * 1024 ? (f.size / 1024 / 1024).toFixed(1) + ' MB' : Math.round(f.size / 1024) + ' KB'} und überschreitet das Limit von ${job.maxFileSizeMB} MB.`,
    });
  });

  if (files.length === 0) {
    rt.lastRunTs = Date.now();
    rt.lastResult = rt.lastResult || 'idle';
    rt.running = false;
    return;
  }

  let remaining = files.length;
  files.forEach((filePath) => {
    let fileSize = null;
    try { fileSize = fs.statSync(filePath).size; } catch { /* Datei evtl. inzwischen weg */ }

    // Wiederholungsstrategie: nach Fehlschlägen erst nach Wartezeit erneut
    if (!rt.versuche) rt.versuche = new Map();
    const versuchStand = rt.versuche.get(filePath);
    if (versuchStand && Date.now() < versuchStand.naechsterVersuch) {
      rt.wartendAufWiederholung = (rt.wartendAufWiederholung || 0) + 1;
      remaining -= 1;
      if (remaining === 0) rt.running = false;
      return;
    }

    // Für die Anzeige merken, welche Datei gerade bearbeitet wird
    if (!rt.inArbeit) rt.inArbeit = new Map();
    rt.inArbeit.set(filePath, { name: path.basename(filePath), seit: Date.now(), groesse: fileSize });
    const fertigMitDatei = () => { if (rt.inArbeit) rt.inArbeit.delete(filePath); };

    // Duplikat-Erkennung: identischer Inhalt wurde fuer diesen Job schon uebertragen
    if (job.dedupe) {
      let hash = null;
      try { hash = fileHash(filePath); } catch { /* nicht lesbar, normal weiterverarbeiten */ }
      if (hash && isDuplicate(job.id, hash)) {
        const prev = dedupeStore[job.id][hash];
        appendLog({
          ts: new Date().toISOString(), jobId: job.id, jobName: job.name, targetUrl: job.targetUrl,
          file: path.basename(filePath), fileSize, status: 'error', httpStatus: null,
          message: `Übersprungen: inhaltsgleiche Datei wurde bereits übertragen (als "${prev.file}" am ${new Date(prev.ts).toLocaleString('de-DE')}).`,
        });
        try {
          if (job.onError === 'archive') moveFile(filePath, job.sourcePath, job.errorSubfolder || '_fehler');
        } catch { /* egal */ }
        rt.lastRunTs = Date.now();
        fertigMitDatei();
        remaining -= 1;
        if (remaining === 0) rt.running = false;
        return;
      }
      if (hash) rt.pendingHashes = Object.assign(rt.pendingHashes || {}, { [filePath]: hash });
    }

    // Optionale Vorverarbeitung: statt der Originaldatei wird das Ergebnis gesendet
    const sendeMit = (sendung, verarbeitungsInfo, aufraeumPfade) => {
      runCurlAllTargets(job, sendung, (result) => {
        (aufraeumPfade || []).forEach((f) => { try { fs.unlinkSync(f); } catch { /* egal */ } });
        verarbeiteErgebnis(result, verarbeitungsInfo);
      });
    };

    // Stapelscan zuerst in Einzeldokumente zerlegen.
    // Klappt das nicht (kein QR-Code, unbekannte Kompression), wird die Datei
    // unverändert übertragen statt sie liegen zu lassen.
    let aufteilenHinweis = null;
    if (job.stapelTeilen) {
      // Liest den QR-Code aus einem Seitenbild — JPEG oder bereits Graustufen
      const leser = (seite) => {
        if (seite.art === 'grau') return leseQr(seite.grauDaten, seite.breite, seite.hoehe);
        const bild = dekodiereJpeg(seite.jpeg);
        return bild.fehler ? null : leseQr(bild.grau, bild.breite, bild.hoehe);
      };
      let geteilt;
      try {
        geteilt = pdfteilen.teileNachQr(filePath, leser, { vorspannVerwerfen: job.vorspannVerwerfen });
      } catch (e) {
        geteilt = { ok: false, meldung: e.message };
      }

      if (!geteilt.ok) {
        // Kein Grund, die Datei liegen zu lassen: Sie wird als Ganzes gesendet.
        // Häufigster Fall — ein Dokument ohne Trenn-Codes im Stapelordner.
        rt.aufteilungUebersprungen = (rt.aufteilungUebersprungen || 0) + 1;
        aufteilenHinweis = `Ohne Aufteilung gesendet: ${geteilt.meldung}`;
      } else {

      // Teildokumente einzeln übertragen
      const stamm = path.basename(filePath, path.extname(filePath));
      const teilOrdner = path.join(os.tmpdir(), 'fp-teil-' + crypto.randomBytes(6).toString('hex'));
      fs.mkdirSync(teilOrdner, { recursive: true });
      const vergebeneNamen = new Set();
      const teilPfade = geteilt.dokumente.map((d, i) => {
        let name = baueTeilNamen(job, stamm, i + 1, geteilt.dokumente.length, d, filePath);
        // Liefert das Muster zweimal denselben Namen (z. B. nur {qrWert} bei
        // gleichem Code), wird durchnummeriert statt überschrieben.
        if (vergebeneNamen.has(name)) {
          const endung = path.extname(name);
          const basis = name.slice(0, -endung.length || undefined);
          let n = 2;
          while (vergebeneNamen.has(`${basis}-${n}${endung}`)) n += 1;
          name = `${basis}-${n}${endung}`;
        }
        vergebeneNamen.add(name);
        const voll = path.join(teilOrdner, name);
        fs.writeFileSync(voll, d.pdf);
        return { pfad: voll, name, qrWert: d.qrWert, seiten: d.seiten, groesse: d.pdf.length };
      });

      let offen = teilPfade.length;
      let fehlerAufgetreten = false;
      const aufraeumenTeile = () => {
        try { fs.rmSync(teilOrdner, { recursive: true, force: true }); } catch { /* egal */ }
      };

      teilPfade.forEach((teil) => {
        // Ohne Umwandlung wird das Teildokument unverändert gesendet
        const vorbereiten = (weiter) => {
          if (job.processor === 'pdf-qr-json') {
            return verarbeitung.pdfZuJson(job, teil.pfad, config.settings, weiter);
          }
          return weiter(null, teil.pfad, null);
        };

        vorbereiten((tFehler, tSendung, tInfo) => {
          const abschluss = (ergebnis) => {
            appendLog({
              ts: new Date().toISOString(), jobId: job.id, jobName: job.name,
              targetUrl: job.zielTyp === 'ordner' ? job.zielOrdner : job.zielTyp === 'email' ? `E-Mail an ${job.mailAn}` : job.targetUrl,
              file: teil.name, fileSize: teil.groesse,
              status: ergebnis.ok ? 'success' : 'error',
              httpStatus: ergebnis.httpStatus, exitCode: ergebnis.exitCode,
              qrWert: teil.qrWert, probennummer: teil.qrWert, qrGefunden: Boolean(teil.qrWert),
              gesendeteMetadaten: tInfo ? tInfo.metadaten : undefined,
              message: `Teil ${teil.name} aus „${path.basename(filePath)}" (${teil.seiten} Seite(n))`
                + (teil.qrWert ? ` · QR: ${teil.qrWert}` : ' · ohne QR-Wert')
                + (job.processor === 'pdf-qr-json' ? '' : ' · unverändert gesendet')
                + ' · ' + (ergebnis.ok ? ergebnis.bodySnippet : (ergebnis.errorText || 'Fehler')),
            });
            if (!ergebnis.ok) fehlerAufgetreten = true;
            offen -= 1;
            if (offen === 0) {
              aufraeumenTeile();
              rt.lastRunTs = Date.now();
              rt.lastResult = fehlerAufgetreten ? 'error' : 'success';
              rt.consecutiveFailures = fehlerAufgetreten ? rt.consecutiveFailures + 1 : 0;
              if (!fehlerAufgetreten) {
                try { if (job.onSuccess === 'archive') moveFile(filePath, job.sourcePath, job.archiveSubfolder || '_gesendet'); } catch { /* egal */ }
              } else {
                try { if (job.onError === 'archive') moveFile(filePath, job.sourcePath, job.errorSubfolder || '_fehler'); } catch { /* egal */ }
              }
              fertigMitDatei();
              remaining -= 1;
              if (remaining === 0) rt.running = false;
            }
          };

          if (tFehler) return abschluss({ ok: false, errorText: tFehler, httpStatus: null, exitCode: 1 });
          runCurlAllTargets(job, tSendung, (ergebnis) => {
            if (tSendung && typeof tSendung === 'object') {
              [tSendung.metaPfad, tSendung.sendePfad].forEach((f) => { if (f) { try { fs.unlinkSync(f); } catch { /* egal */ } } });
            }
            abschluss(ergebnis);
          });
        });
      });
      return;
      }
    }

    if (job.processor === 'pdf-qr-json') {
      verarbeitung.pdfZuJson(job, filePath, config.settings, (fehler, sendung, info) => {
        if (fehler) {
          appendLog({
            ts: new Date().toISOString(), jobId: job.id, jobName: job.name, targetUrl: job.targetUrl,
            file: path.basename(filePath), fileSize, status: 'error', httpStatus: null,
            message: `Verarbeitung fehlgeschlagen: ${fehler}`,
          });
          rt.lastRunTs = Date.now();
          rt.lastResult = 'error';
          rt.consecutiveFailures += 1;
          try { if (job.onError === 'archive') moveFile(filePath, job.sourcePath, job.errorSubfolder || '_fehler'); } catch { /* egal */ }
          fertigMitDatei();
          remaining -= 1;
          if (remaining === 0) rt.running = false;
          return;
        }
        const reste = sendung.modus === 'multipart' ? [sendung.metaPfad] : [sendung.sendePfad];
        sendeMit(sendung, info, reste);
      });
      return;
    }

    sendeMit(filePath, null, null);

    function verarbeiteErgebnis(result, verarbeitungsInfo) {
      const entry = {
        ts: new Date().toISOString(),
        jobId: job.id,
        jobName: job.name,
        targetUrl: job.zielTyp === 'ordner' ? job.zielOrdner
          : job.zielTyp === 'email' ? `E-Mail an ${job.mailAn}`
          : job.targetUrl,
        file: path.basename(filePath),
        fileSize,
        status: result.ok ? 'success' : 'error',
        httpStatus: result.httpStatus,
        exitCode: result.exitCode,
        dryRun: Boolean(result.dryRun),
        qrWert: verarbeitungsInfo ? verarbeitungsInfo.qrWert : undefined,
        probennummer: verarbeitungsInfo ? verarbeitungsInfo.qrWert : undefined,
        qrGefunden: verarbeitungsInfo ? verarbeitungsInfo.qrGefunden : undefined,
        gesendeteMetadaten: verarbeitungsInfo ? verarbeitungsInfo.metadaten : undefined,
        message: (aufteilenHinweis ? `⚠ ${aufteilenHinweis} ` : '')
          + (verarbeitungsInfo && !verarbeitungsInfo.qrGefunden ? `⚠ Ohne QR-Wert gesendet (${verarbeitungsInfo.qrHinweis}). ` : '')
          + (verarbeitungsInfo && verarbeitungsInfo.qrGefunden ? `QR: ${verarbeitungsInfo.qrWert} · ` : '')
          + (result.ok ? result.bodySnippet : (result.errorText || result.bodySnippet || 'Unbekannter Fehler')),
      };
      appendLog(entry);
      rt.lastRunTs = Date.now();
      rt.lastResult = entry.status;
      rt.consecutiveFailures = entry.status === 'success' ? 0 : rt.consecutiveFailures + 1;

      // Versuchszähler je Datei führen
      if (!rt.versuche) rt.versuche = new Map();
      if (result.ok) {
        rt.versuche.delete(filePath);
      } else {
        const bisher = rt.versuche.get(filePath) || { anzahl: 0 };
        const anzahl = bisher.anzahl + 1;
        const grenze = Number(job.maxVersuche) || 0;

        if (grenze > 0 && anzahl >= grenze) {
          // Endgültig gescheitert: aus dem Weg räumen, damit der Job weiterläuft
          rt.versuche.delete(filePath);
          try {
            moveFile(filePath, job.sourcePath, job.quarantaeneSubfolder || '_quarantaene');
            appendLog({
              ts: new Date().toISOString(), jobId: job.id, jobName: job.name, targetUrl: job.targetUrl,
              file: path.basename(filePath), fileSize, status: 'error', httpStatus: null,
              message: `In Quarantäne verschoben: ${anzahl} Versuche fehlgeschlagen. Ordner "${job.quarantaeneSubfolder || '_quarantaene'}". Nach Behebung der Ursache von dort zurückkopieren.`,
            });
            sendeStoerungsBenachrichtigung(job, rt, entry.message, path.basename(filePath));
          } catch (e) {
            appendLog({
              ts: new Date().toISOString(), jobId: job.id, jobName: job.name, targetUrl: job.targetUrl,
              file: path.basename(filePath), fileSize, status: 'error', httpStatus: null,
              message: `Quarantäne fehlgeschlagen: ${e.message}`,
            });
          }
        } else {
          // Wachsende Wartezeit: Basis × 2^(Versuche-1), gedeckelt auf eine Stunde
          const basis = (Number(job.wartezeitBasisSec) || 60) * 1000;
          const warten = Math.min(basis * Math.pow(2, anzahl - 1), 60 * 60 * 1000);
          rt.versuche.set(filePath, { anzahl, naechsterVersuch: Date.now() + warten, letzterFehler: entry.message });
        }
      }

      // Erfolgreich uebertragene Pruefsumme merken (nicht im Testmodus)
      if (result.ok && !result.dryRun && job.dedupe && rt.pendingHashes && rt.pendingHashes[filePath]) {
        rememberHash(job.id, rt.pendingHashes[filePath], path.basename(filePath));
        delete rt.pendingHashes[filePath];
      }

      try {
        if (result.dryRun) {
          // Im Testmodus bleibt die Datei liegen, damit der Ablauf wiederholbar ist
        } else if (result.ok && job.onSuccess === 'archive') {
          moveFile(filePath, job.sourcePath, job.archiveSubfolder || '_gesendet');
        } else if (!result.ok && job.onError === 'archive') {
          moveFile(filePath, job.sourcePath, job.errorSubfolder || '_fehler');
        }
      } catch (moveErr) {
        appendLog({
          ts: new Date().toISOString(), jobId: job.id, jobName: job.name, targetUrl: job.targetUrl,
          file: path.basename(filePath), status: 'error', httpStatus: null,
          message: `Übertragen, aber Verschieben fehlgeschlagen: ${moveErr.message}`,
        });
      }

      fertigMitDatei();
      remaining -= 1;
      if (remaining === 0) rt.running = false;
    }
  });
}

// ---------- Scanner-Loop ----------

function tick() {
  const now = Date.now();
  for (const job of config.jobs) {
    if (!job.active || job.archived) continue;
    const rt = ensureRuntime(job);
    if (now >= rt.nextDueTs) {
      rt.nextDueTs = now + (job.pollIntervalSec || 30) * 1000;
      if (isWithinSchedule(job, new Date(now))) {
        processJob(job);
      }
    }
  }
}
setInterval(tick, (config.globalPollIntervalSec || 5) * 1000);

// ---------- REST-API ----------

function sendJson(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = '';
    req.on('data', (c) => { chunks += c; if (chunks.length > 2 * 1024 * 1024) req.destroy(); });
    req.on('end', () => {
      if (!chunks) return resolve({});
      try { resolve(JSON.parse(chunks)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function lastSuccessByJob() {
  // Einmal ueber das Protokoll laufen und je Job den juengsten Erfolg merken
  const map = new Map();
  readAllLogs().forEach((l) => {
    if (l.status !== 'success' || !l.jobId) return;
    const prev = map.get(l.jobId);
    if (!prev || l.ts > prev.ts) map.set(l.jobId, { ts: l.ts, file: l.file });
  });
  return map;
}

// Prueft, ob zwei Dateimuster sich ueberschneiden koennen
function patternsOverlap(a, b) {
  const pa = (a || '*').toLowerCase();
  const pb = (b || '*').toLowerCase();
  if (pa === pb) return true;
  if (pa === '*' || pb === '*') return true;
  // Endungsvergleich bei einfachen Mustern der Form *.xyz
  const extA = pa.startsWith('*.') ? pa.slice(1) : null;
  const extB = pb.startsWith('*.') ? pb.slice(1) : null;
  if (extA && extB) return extA === extB;
  // Bei komplexeren Mustern konservativ von Ueberschneidung ausgehen,
  // wenn eines der Muster das andere als Teilstring enthaelt
  return pa.includes(pb.replace(/\*/g, '')) || pb.includes(pa.replace(/\*/g, ''));
}

function normalizePath(p) {
  return (p || '').replace(/[/\\]+$/, '').replace(/\\/g, '/').toLowerCase();
}

function findConfigWarnings() {
  const warnings = [];
  const aktive = config.jobs.filter((j) => !j.archived);

  // Wiederholt ohne QR-Wert übertragen? Das deutet auf ein Erkennungsproblem
  // (falsche Seite, unlesbarer Scan, PDF ohne eingebettetes JPEG).
  const letzteLogs = readLogs({ limit: 200 });
  aktive.filter((j) => j.processor === 'pdf-qr-json').forEach((job) => {
    const eigene = letzteLogs.filter((l) => l.jobId === job.id && l.qrGefunden !== undefined).slice(0, 10);
    if (eigene.length < 3) return;
    const ohne = eigene.filter((l) => l.qrGefunden === false).length;
    if (ohne === eigene.length) {
      warnings.push({
        severity: 'hoch',
        type: 'qr-nie-erkannt',
        jobs: [job.name],
        text: `Bei „${job.name}“ wurde in den letzten ${eigene.length} Übertragungen nie ein QR-Code erkannt. Die Dateien gehen ohne Zuordnungswert an die Schnittstelle. Über „⌕ gesendete Daten“ im Protokoll lässt sich prüfen, welches Bild ausgewertet wurde; das geprüfte Bild liegt im Unterordner _qr-pruefung.`,
      });
    } else if (ohne >= Math.ceil(eigene.length / 2)) {
      warnings.push({
        severity: 'mittel',
        type: 'qr-oft-nicht-erkannt',
        jobs: [job.name],
        text: `Bei „${job.name}“ blieb in ${ohne} von ${eigene.length} Übertragungen der QR-Code unerkannt. Häufige Ursachen: QR liegt nicht auf der eingestellten Seite (${job.qrSeite}) oder der Scan ist zu grob.`,
      });
    }
  });

  // 1) Zwei Jobs greifen auf denselben Ordner mit ueberlappendem Filter zu
  for (let i = 0; i < aktive.length; i += 1) {
    for (let k = i + 1; k < aktive.length; k += 1) {
      const a = aktive[i];
      const b = aktive[k];
      if (!a.sourcePath || !b.sourcePath) continue;
      if (normalizePath(a.sourcePath) !== normalizePath(b.sourcePath)) continue;
      if (!patternsOverlap(a.filePattern, b.filePattern)) continue;
      warnings.push({
        severity: 'hoch',
        type: 'ordner-kollision',
        jobs: [a.name, b.name],
        text: `„${a.name}“ und „${b.name}“ überwachen denselben Ordner mit überschneidendem Filter (${a.filePattern} / ${b.filePattern}). Beide greifen sich gegenseitig Dateien weg — welcher Job eine Datei erwischt, ist zufällig.`,
      });
    }
  }

  aktive.forEach((job) => {
    // 2) Archivordner liegt im ueberwachten Ordner UND der Filter wuerde ihn wieder erfassen
    if (job.onSuccess === 'archive' && job.filePattern === '*') {
      warnings.push({
        severity: 'mittel',
        type: 'filter-zu-weit',
        jobs: [job.name],
        text: `„${job.name}“ verwendet den Filter * — damit werden auch Dateien erfasst, die andere Programme gerade erst anlegen. Ein spezifischerer Filter (z. B. *.xml) ist meist sicherer.`,
      });
    }
    // 3) Archiv- und Fehlerordner identisch
    if ((job.archiveSubfolder || '_gesendet') === (job.errorSubfolder || '_fehler')) {
      warnings.push({
        severity: 'hoch',
        type: 'ordner-identisch',
        jobs: [job.name],
        text: `Bei „${job.name}“ sind Archiv- und Fehler-Unterordner identisch — erfolgreiche und fehlgeschlagene Dateien landen im selben Ordner und sind nicht mehr unterscheidbar.`,
      });
    }
    // 4) Kurzes Intervall ohne Ruhezeit
    if ((job.pollIntervalSec || 30) <= 10 && (job.minFileAgeSec || 0) === 0) {
      warnings.push({
        severity: 'mittel',
        type: 'keine-ruhezeit',
        jobs: [job.name],
        text: `„${job.name}“ scannt alle ${job.pollIntervalSec}s ohne Ruhezeit. Schreibt ein anderes Programm in den Ordner, können halb geschriebene Dateien übertragen werden.`,
      });
    }
    // 5) Dateien werden nicht verschoben und nicht auf Duplikate geprueft
    if (job.onSuccess === 'keep' && !job.dedupe) {
      warnings.push({
        severity: 'hoch',
        type: 'endlos-wiederholung',
        jobs: [job.name],
        text: `„${job.name}“ belässt Dateien nach Erfolg im Ordner und prüft nicht auf Duplikate — dieselbe Datei wird bei jedem Scan erneut übertragen.`,
      });
    }
    // 6) Testmodus laeuft dauerhaft
    if (job.dryRun && job.active) {
      warnings.push({
        severity: 'mittel',
        type: 'testmodus-aktiv',
        jobs: [job.name],
        text: `„${job.name}“ läuft im Testmodus — es wird nichts wirklich gesendet. Falls das produktiv laufen soll, Testmodus deaktivieren.`,
      });
    }
  });

  return warnings;
}

function jobPublicView(job, successMap) {
  const rt = ensureRuntime(job);
  // Passwörter verlassen den Server nicht — weder das der HTTP-Anmeldung
  // noch das des Mailservers.
  const { authPassword, smtpPasswort, ...safeJob } = job;
  const success = successMap ? successMap.get(job.id) : (lastSuccessByJob().get(job.id));
  return {
    ...safeJob,
    authPasswordSet: Boolean(authPassword),
    smtpPasswortGesetzt: Boolean(smtpPasswort),
    lastSuccess: success || null,
    runtime: {
      lastRunTs: rt.lastRunTs,
      lastResult: rt.lastResult,
      running: rt.running,
      nextDueTs: rt.nextDueTs,
      consecutiveFailures: rt.consecutiveFailures,
      waitingCount: rt.waitingCount || 0,
      wartendAufWiederholung: rt.wartendAufWiederholung || 0,
      wiederholungen: rt.versuche
        ? Array.from(rt.versuche.entries()).map(([pfad, v]) => ({
            name: path.basename(pfad), anzahl: v.anzahl,
            naechsterVersuch: v.naechsterVersuch, letzterFehler: v.letzterFehler,
          }))
        : [],
      inArbeit: rt.inArbeit
        ? Array.from(rt.inArbeit.values())
            .sort((a, b) => a.seit - b.seit)
            .map((d) => ({ name: d.name, seit: d.seit, groesse: d.groesse }))
        : [],
      withinSchedule: isWithinSchedule(job, new Date()),
    },
  };
}

function csvEscape(v) {
  const s = String(v ?? '');
  if (/[",;\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
function sendCsv(res, filename, rows) {
  const body = rows.map((r) => r.map(csvEscape).join(';')).join('\r\n');
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`,
  });
  res.end('\uFEFF' + body); // BOM fuer Excel-Kompatibilitaet mit Umlauten
}

/**
 * Baut den Dateinamen eines Teildokuments nach dem Muster des Jobs.
 * Platzhalter: {stamm} {nr} {anzahl} {qrWert} {seiten} {datum} {zeit} {endung}
 * Fehlt der QR-Wert, entfallen die zugehörigen Trennzeichen sauber.
 */
function baueTeilNamen(job, stamm, nummer, anzahl, dokument, quellPfad) {
  const muster = (job.teilNamensmuster || '{stamm}_{nr}_{qrWert}').trim() || '{stamm}_{nr}_{qrWert}';
  const jetzt = new Date();
  const zwei = (n) => String(n).padStart(2, '0');

  const werte = {
    stamm,
    nr: zwei(nummer),
    nummer: String(nummer),
    anzahl: String(anzahl),
    seiten: String(dokument.seiten),
    qrWert: dokument.qrWert ? String(dokument.qrWert).replace(/[\\/:*?"<>|]/g, '') : '',
    datum: `${jetzt.getFullYear()}${zwei(jetzt.getMonth() + 1)}${zwei(jetzt.getDate())}`,
    zeit: `${zwei(jetzt.getHours())}${zwei(jetzt.getMinutes())}${zwei(jetzt.getSeconds())}`,
    endung: path.extname(quellPfad).replace('.', '') || 'pdf',
  };

  let name = muster;
  Object.entries(werte).forEach(([k, v]) => {
    name = name.split('{' + k + '}').join(v);
  });

  // Unbekannte Platzhalter entfernen
  name = name.replace(/\{[a-zA-Z]+\}/g, '');
  // Doppelte oder hängende Trennzeichen aufräumen, falls ein Wert leer blieb
  name = name.replace(/[_\-. ]{2,}/g, (t) => t[0]).replace(/^[_\-. ]+|[_\-. ]+$/g, '');
  // Verbotene Zeichen abfangen
  name = name.replace(/[\\/:*?"<>|]/g, '');

  // Ohne QR-Wert kann ein knappes Muster einen nichtssagenden Namen ergeben
  // (etwa nur "03"). Dann den ursprünglichen Dateinamen voranstellen, damit
  // die Datei zuordenbar bleibt.
  const ohneEndung = name.replace(/\.[a-z0-9]+$/i, '');
  if (!dokument.qrWert && (!ohneEndung || ohneEndung.length < 4 || /^\d+$/.test(ohneEndung))) {
    name = `${stamm}_${zwei(nummer)}${ohneEndung && !/^\d+$/.test(ohneEndung) ? '_' + ohneEndung : ''}`;
  }
  if (!name) name = `${stamm}_${zwei(nummer)}`;
  if (!/\.[a-z0-9]+$/i.test(name)) name += '.pdf';
  return name;
}

function normalizeJob(body, existingId) {
  // Bisheriger Stand, damit Passwörter beim Bearbeiten erhalten bleiben
  const vorhanden = existingId ? config.jobs.find((j) => j.id === existingId) : null;
  return {
    id: existingId || body.id || 'j_' + crypto.randomBytes(6).toString('hex'),
    name: body.name || 'Neuer Job',
    category: (body.category || '').trim(),
    notes: (body.notes || '').slice(0, 2000),
    archived: body.archived || false,
    archivedAt: body.archivedAt || null,
    sortOrder: Number.isFinite(Number(body.sortOrder)) ? Number(body.sortOrder) : null,
    active: body.active !== undefined ? body.active : true,
    sourcePath: body.sourcePath || '',
    filePattern: body.filePattern || '*',
    minFileAgeSec: Number(body.minFileAgeSec) >= 0 ? Number(body.minFileAgeSec) : 0,
    maxFileSizeMB: Number(body.maxFileSizeMB) > 0 ? Number(body.maxFileSizeMB) : 0,
    pollIntervalSec: Number(body.pollIntervalSec) || 30,
    zielTyp: ['http', 'ordner', 'email'].includes(body.zielTyp) ? body.zielTyp : 'http',
    zielOrdner: (body.zielOrdner || '').trim(),
    ordnerUeberschreiben: body.ordnerUeberschreiben || false,
    smtpHost: (body.smtpHost || '').trim(),
    smtpPort: Number(body.smtpPort) > 0 ? Number(body.smtpPort) : 587,
    smtpSicher: body.smtpSicher !== false,
    smtpBenutzer: (body.smtpBenutzer || '').trim(),
    // Leeres Feld bedeutet „unverändert lassen", nicht „löschen"
    smtpPasswort: body.smtpPasswort !== undefined && body.smtpPasswort !== ''
      ? body.smtpPasswort
      : (vorhanden ? vorhanden.smtpPasswort || '' : ''),
    mailVon: (body.mailVon || '').trim(),
    mailAn: (body.mailAn || '').trim(),
    mailBetreff: body.mailBetreff !== undefined ? String(body.mailBetreff) : 'Neue Datei: {dateiname}',
    maxVersuche: Number(body.maxVersuche) >= 0 ? Number(body.maxVersuche) : 5,
    wartezeitBasisSec: Number(body.wartezeitBasisSec) > 0 ? Number(body.wartezeitBasisSec) : 60,
    quarantaeneSubfolder: (body.quarantaeneSubfolder || '_quarantaene').trim(),
    targetUrl: body.targetUrl || '',
    extraTargetUrls: Array.isArray(body.extraTargetUrls) ? body.extraTargetUrls.filter((u) => u && u.trim()).map((u) => u.trim()) : [],
    processor: body.processor === 'pdf-qr-json' ? 'pdf-qr-json' : 'none',
    stapelTeilen: body.stapelTeilen || false,
    vorspannVerwerfen: body.vorspannVerwerfen || false,
    teilNamensmuster: body.teilNamensmuster !== undefined
      ? String(body.teilNamensmuster)
      : '{stamm}_{nr}_{qrWert}',
    qrSeite: Number(body.qrSeite) > 0 ? Number(body.qrSeite) : 1,
    qrDpi: Number(body.qrDpi) > 0 ? Number(body.qrDpi) : 200,
    sendeFormat: body.sendeFormat === 'multipart-metadata' ? 'multipart-metadata' : 'json',
    dateiFeldName: (body.dateiFeldName || 'file1').trim(),
    metadataFeldName: (body.metadataFeldName || 'metadata1').trim(),
    metadataVorlage: body.metadataVorlage !== undefined ? String(body.metadataVorlage) : verarbeitung.STANDARD_VORLAGE,
    auftragsnummer: (body.auftragsnummer || '').trim(),
    dateinameRegex: (body.dateinameRegex || '').trim(),
    dryRun: body.dryRun || false,
    dedupe: body.dedupe || false,
    archiveRetentionDays: Number(body.archiveRetentionDays) > 0 ? Number(body.archiveRetentionDays) : 0,
    method: body.method || 'POST',
    headers: body.headers || [],
    authType: body.authType || 'none',
    authUser: body.authUser || '',
    authPassword: body.authPassword !== undefined && body.authPassword !== ''
      ? body.authPassword
      : (vorhanden ? vorhanden.authPassword || '' : ''),
    curlExtraArgs: body.curlExtraArgs || [],
    uploadMode: body.uploadMode || 'binary',
    multipartField: body.multipartField || 'file',
    onSuccess: body.onSuccess || 'archive',
    archiveSubfolder: body.archiveSubfolder || '_gesendet',
    onError: body.onError || 'keep',
    errorSubfolder: body.errorSubfolder || '_fehler',
    timeoutSec: Number(body.timeoutSec) || 30,
    scheduleEnabled: body.scheduleEnabled || false,
    activeDays: Array.isArray(body.activeDays) && body.activeDays.length > 0 ? body.activeDays : ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'],
    timeStart: body.timeStart || '00:00',
    timeEnd: body.timeEnd || '23:59',
  };
}

const WEEKDAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
function isWithinSchedule(job, now) {
  if (!job.scheduleEnabled) return true;
  const dayCode = WEEKDAY_CODES[now.getDay()];
  if (!(job.activeDays || []).includes(dayCode)) return false;
  const hhmm = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');
  const start = job.timeStart || '00:00';
  const end = job.timeEnd || '23:59';
  if (start <= end) return hhmm >= start && hhmm <= end;
  return hhmm >= start || hhmm <= end; // Zeitfenster über Mitternacht hinweg
}

const BETRACHTER_ERLAUBT = new Set(['/api/anmelden', '/api/abmelden']);

async function handleApi(req, res, urlObj) {
  const parts = urlObj.pathname.split('/').filter(Boolean); // ['api','jobs', ...]

  // Betrachter: nur lesende Anfragen zulassen
  if (req.method !== 'GET' && !BETRACHTER_ERLAUBT.has(urlObj.pathname) && istBetrachter(req)) {
    return sendJson(res, 403, { error: 'Die Rolle „Betrachter“ darf nur ansehen, aber nichts ändern.' });
  }

  if (parts[1] === 'status' && req.method === 'GET') {
    const logs = readLogs({ limit: 500 });
    const successCount = logs.filter((l) => l.status === 'success').length;
    const errorCount = logs.filter((l) => l.status === 'error').length;

    const now = new Date();
    let running = 0;
    let failing = 0;
    let paused = 0;
    let outsideSchedule = 0;
    let idle = 0;
    const categoryMap = new Map();

    const aktiveJobs = config.jobs.filter((j) => !j.archived);
    aktiveJobs.forEach((job) => {
      const rt = ensureRuntime(job);
      let state;
      if (!job.active) { state = 'paused'; paused += 1; }
      else if (rt.running) { state = 'running'; running += 1; }
      else if (rt.consecutiveFailures >= 3) { state = 'failing'; failing += 1; }
      else if (job.scheduleEnabled && !isWithinSchedule(job, now)) { state = 'outsideSchedule'; outsideSchedule += 1; }
      else { state = 'idle'; idle += 1; }

      const cat = (job.category || '').trim() || 'Ohne Kategorie';
      if (!categoryMap.has(cat)) categoryMap.set(cat, { name: cat, total: 0, active: 0, failing: 0, paused: 0 });
      const c = categoryMap.get(cat);
      c.total += 1;
      if (job.active) c.active += 1;
      if (state === 'failing') c.failing += 1;
      if (state === 'paused') c.paused += 1;
    });

    return sendJson(res, 200, {
      jobCount: aktiveJobs.length,
      archivedCount: config.jobs.length - aktiveJobs.length,
      activeJobCount: aktiveJobs.filter((j) => j.active).length,
      recentSuccessCount: successCount,
      recentErrorCount: errorCount,
      warningCount: findConfigWarnings().length,
      states: { running, failing, paused, outsideSchedule, idle },
      categories: Array.from(categoryMap.values()).sort((a, b) => a.name.localeCompare(b.name, 'de')),
    });
  }

  if (parts[1] === 'stats' && parts.length === 2 && req.method === 'GET') {
    const q = urlObj.searchParams;
    const rangeDays = Math.max(1, Number(q.get('days')) || 14);
    const allLogs = readAllLogs();
    const cutoff = Date.now() - rangeDays * 24 * 60 * 60 * 1000;
    const inRange = allLogs.filter((l) => new Date(l.ts).getTime() >= cutoff);

    const totals = { transfers: 0, success: 0, error: 0, bytes: 0 };
    const perJobMap = new Map();
    const perTargetMap = new Map();
    const perCategoryMap = new Map();
    const jobCategoryById = new Map(config.jobs.map((j) => [j.id, (j.category || '').trim() || 'Ohne Kategorie']));
    const zielText = (j) => (j.zielTyp === 'ordner' ? (j.zielOrdner || '').trim()
      : j.zielTyp === 'email' ? (j.mailAn ? 'E-Mail an ' + j.mailAn : '')
      : (j.targetUrl || '').trim());
    const jobUrlById = new Map(config.jobs.map((j) => [j.id, zielText(j)]));
    const jobUrlByName = new Map(config.jobs.map((j) => [j.name, zielText(j)]));

    // Aeltere Eintraege enthalten teils keine Ziel-URL. Reihenfolge der Rueckfaelle:
    // 1) URL im Eintrag  2) ueber Job-ID  3) ueber Job-Namen (Job neu angelegt)
    // 4) sprechende Kennzeichnung mit Job-Namen, statt alles in einen Topf "unbekannt" zu werfen.
    const targetKeyOf = (l) => {
      const raw = (l.targetUrl || '').trim()
        || jobUrlById.get(l.jobId)
        || jobUrlByName.get(l.jobName)
        || '';
      if (raw) return raw.replace(/\/+$/, '');
      return l.jobName ? `– keine URL protokolliert (${l.jobName}) –` : '– keine URL protokolliert –';
    };
    const perDayMap = new Map();

    for (const l of inRange) {
      totals.transfers += 1;
      if (l.status === 'success') totals.success += 1; else totals.error += 1;
      totals.bytes += l.fileSize || 0;

      const jobKey = l.jobId || 'unbekannt';
      if (!perJobMap.has(jobKey)) perJobMap.set(jobKey, { jobId: jobKey, jobName: l.jobName || 'Unbekannt', success: 0, error: 0, bytes: 0 });
      const jp = perJobMap.get(jobKey);
      if (l.status === 'success') jp.success += 1; else jp.error += 1;
      jp.bytes += l.fileSize || 0;

      const targetKey = targetKeyOf(l);
      if (!perTargetMap.has(targetKey)) perTargetMap.set(targetKey, { targetUrl: targetKey, jobNames: new Set(), success: 0, error: 0, bytes: 0 });
      const tp = perTargetMap.get(targetKey);
      if (l.jobName) tp.jobNames.add(l.jobName);
      if (l.status === 'success') tp.success += 1; else tp.error += 1;
      tp.bytes += l.fileSize || 0;

      const catKey = jobCategoryById.get(l.jobId) || 'Ohne Kategorie';
      if (!perCategoryMap.has(catKey)) perCategoryMap.set(catKey, { category: catKey, success: 0, error: 0, bytes: 0 });
      const cp = perCategoryMap.get(catKey);
      if (l.status === 'success') cp.success += 1; else cp.error += 1;
      cp.bytes += l.fileSize || 0;

      const dayKey = l.ts.slice(0, 10);
      if (!perDayMap.has(dayKey)) perDayMap.set(dayKey, { date: dayKey, success: 0, error: 0, bytes: 0, jobIds: new Set() });
      const dp = perDayMap.get(dayKey);
      if (l.jobId) dp.jobIds.add(l.jobId);
      if (l.status === 'success') dp.success += 1; else dp.error += 1;
      dp.bytes += l.fileSize || 0;
    }

    // Lückenlose Tagesreihe für den gewählten Zeitraum
    const perDay = [];
    for (let i = rangeDays - 1; i >= 0; i -= 1) {
      const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
      const key = d.toISOString().slice(0, 10);
      const entry = perDayMap.get(key);
      perDay.push(entry
        ? { date: entry.date, success: entry.success, error: entry.error, bytes: entry.bytes, jobs: entry.jobIds.size }
        : { date: key, success: 0, error: 0, bytes: 0, jobs: 0 });
    }

    // Gleich langer, unmittelbar davorliegender Zeitraum — als Vergleichswert
    // für die Trendpfeile bei den Kennzahlen. Nur die Summen werden gebraucht,
    // keine Aufschlüsselung nach Job/Ziel/Tag.
    const prevCutoffEnde = cutoff;
    const prevCutoffStart = cutoff - rangeDays * 24 * 60 * 60 * 1000;
    const previousTotals = { transfers: 0, success: 0, error: 0, bytes: 0 };
    for (const l of allLogs) {
      const t = new Date(l.ts).getTime();
      if (t < prevCutoffStart || t >= prevCutoffEnde) continue;
      previousTotals.transfers += 1;
      if (l.status === 'success') previousTotals.success += 1; else previousTotals.error += 1;
      previousTotals.bytes += l.fileSize || 0;
    }

    return sendJson(res, 200, {
      rangeDays,
      totals,
      previousTotals,
      perJob: Array.from(perJobMap.values()).sort((a, b) => (b.success + b.error) - (a.success + a.error)),
      perCategory: Array.from(perCategoryMap.values()).sort((a, b) => (b.success + b.error) - (a.success + a.error)),
      perTarget: Array.from(perTargetMap.values())
        .map((t) => ({ ...t, jobNames: Array.from(t.jobNames) }))
        .sort((a, b) => (b.success + b.error) - (a.success + a.error)),
      perDay,
    });
  }

  if (parts[1] === 'test-connection' && req.method === 'POST') {
    const body = await readBody(req);
    const existing = body.jobId ? config.jobs.find((j) => j.id === body.jobId) : null;
    const targetUrl = (body.targetUrl || '').trim();
    if (!targetUrl) return sendJson(res, 400, { error: 'Ziel-URL fehlt' });

    const testJob = {
      method: body.method || 'POST',
      headers: body.headers || [],
      authType: body.authType || 'none',
      authUser: body.authUser || (existing ? existing.authUser : ''),
      authPassword: body.authPassword ? body.authPassword : (existing ? existing.authPassword : ''),
      curlExtraArgs: body.curlExtraArgs || [],
      uploadMode: body.uploadMode || 'binary',
      multipartField: body.multipartField || 'file',
      targetUrl,
      timeoutSec: 15,
    };

    const tmpFile = path.join(require('os').tmpdir(), `fp-connection-test-${crypto.randomBytes(4).toString('hex')}.txt`);
    fs.writeFileSync(tmpFile, 'Testübertragung von Folderpost\n');
    runCurl(testJob, tmpFile, (result) => {
      try { fs.unlinkSync(tmpFile); } catch { /* egal */ }
      sendJson(res, 200, {
        ok: result.ok,
        httpStatus: result.httpStatus,
        message: result.ok ? (result.bodySnippet || 'Erfolgreich, keine Antwort im Body') : (result.errorText || result.bodySnippet || 'Unbekannter Fehler'),
      });
    });
    return;
  }

  if (parts[1] === 'logs' && parts[2] === 'export' && req.method === 'GET') {
    const q = urlObj.searchParams;
    const logs = readLogs({
      jobId: q.get('jobId') || undefined,
      status: q.get('status') || undefined,
      limit: q.get('limit') ? Number(q.get('limit')) : 2000,
      q: q.get('q') || undefined,
    });
    const rows = [['Zeitstempel', 'Job', 'Datei', 'Groesse (Bytes)', 'Status', 'HTTP-Status', 'Meldung']];
    logs.forEach((l) => rows.push([l.ts, l.jobName, l.file || '', l.fileSize ?? '', l.status, l.httpStatus || '', l.message || '']));
    return sendCsv(res, 'transfer-log.csv', rows);
  }

  if (parts[1] === 'stats' && parts[2] === 'export' && req.method === 'GET') {
    const q = urlObj.searchParams;
    const rangeDays = Math.max(1, Number(q.get('days')) || 14);
    const allLogs = readAllLogs();
    const cutoff = Date.now() - rangeDays * 24 * 60 * 60 * 1000;
    const inRange = allLogs.filter((l) => new Date(l.ts).getTime() >= cutoff);
    const perTargetMap = new Map();
    const jobUrlByIdCsv = new Map(config.jobs.map((j) => [j.id, (j.targetUrl || '').trim()]));
    const jobUrlByNameCsv = new Map(config.jobs.map((j) => [j.name, (j.targetUrl || '').trim()]));
    inRange.forEach((l) => {
      const raw = (l.targetUrl || '').trim() || jobUrlByIdCsv.get(l.jobId) || jobUrlByNameCsv.get(l.jobName) || '';
      const key = raw ? raw.replace(/\/+$/, '') : (l.jobName ? `– keine URL protokolliert (${l.jobName}) –` : '– keine URL protokolliert –');
      if (!perTargetMap.has(key)) perTargetMap.set(key, { targetUrl: key, jobNames: new Set(), success: 0, error: 0, bytes: 0 });
      const tp = perTargetMap.get(key);
      if (l.jobName) tp.jobNames.add(l.jobName);
      if (l.status === 'success') tp.success += 1; else tp.error += 1;
      tp.bytes += l.fileSize || 0;
    });
    const rows = [['Job', 'Schnittstelle', 'Erfolg', 'Fehler', 'Gesamt', 'Datenvolumen (Bytes)']];
    Array.from(perTargetMap.values()).forEach((t) => rows.push([Array.from(t.jobNames).join(', '), t.targetUrl, t.success, t.error, t.success + t.error, t.bytes]));
    return sendCsv(res, `statistics-${rangeDays}-days.csv`, rows);
  }

  if (parts[1] === 'config' && parts[2] === 'export' && req.method === 'GET') {
    const payload = {
      exportedAt: new Date().toISOString(),
      toolVersion: 1,
      jobs: config.jobs,
    };
    const body = JSON.stringify(payload, null, 2);
    const stamp = new Date().toISOString().slice(0, 10);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="folderpost-config-${stamp}.json"`,
    });
    return res.end(body);
  }

  if (parts[1] === 'config' && parts[2] === 'import' && req.method === 'POST') {
    if (!istVerwaltung(req)) return sendJson(res, 403, { error: 'Diese Aktion ist der Rolle „Verwaltung“ vorbehalten.' });
    const body = await readBody(req);
    const incomingJobs = Array.isArray(body.jobs) ? body.jobs : null;
    if (!incomingJobs) return sendJson(res, 400, { error: 'Ungültiges Format: "jobs"-Array fehlt' });

    if (body.replace) {
      config.jobs.forEach((j) => delete jobRuntime[j.id]);
      config.jobs = [];
    }

    let added = 0;
    let updated = 0;
    incomingJobs.forEach((incoming) => {
      const existingIndex = config.jobs.findIndex((j) => j.id === incoming.id);
      const normalized = normalizeJob(incoming, incoming.id);
      if (existingIndex !== -1) {
        config.jobs[existingIndex] = normalized;
        updated += 1;
      } else {
        config.jobs.push(normalized);
        added += 1;
      }
      delete jobRuntime[normalized.id]; // frischer Laufzeitstatus nach Import
    });
    saveConfig(config);
    return sendJson(res, 200, { ok: true, added, updated, total: config.jobs.length });
  }

  if (parts[1] === 'preview-files' && req.method === 'POST') {
    const body = await readBody(req);
    const sourcePath = (body.sourcePath || '').trim();
    if (!sourcePath) return sendJson(res, 400, { error: 'Quell-Ordner fehlt' });
    let scan;
    try {
      scan = listMatchingFiles(sourcePath, body.filePattern || '*', {
        minFileAgeSec: Number(body.minFileAgeSec) || 0,
        maxFileSizeMB: Number(body.maxFileSizeMB) || 0,
      });
    } catch (err) {
      return sendJson(res, 200, { ok: false, message: err.message });
    }
    const withSize = scan.accepted.slice(0, 25).map((p) => {
      let size = null;
      try { size = fs.statSync(p).size; } catch { /* egal */ }
      return { name: path.basename(p), size };
    });
    return sendJson(res, 200, {
      ok: true,
      total: scan.accepted.length,
      files: withSize,
      tooYoung: scan.tooYoung.length,
      tooLarge: scan.tooLarge.map((f) => ({ name: f.name, size: f.size })),
    });
  }

  // Probelauf für einen noch nicht gespeicherten Job-Entwurf
  if (parts[1] === 'namen-vorschau' && req.method === 'POST') {
    const body = await readBody(req);
    const entwurf = { teilNamensmuster: body.teilNamensmuster };
    const stamm = (body.beispielStamm || 'scan_20260901').replace(/\.[^.]+$/, '');
    const beispiele = [
      { qrWert: body.beispielQr || 'ORDER-1001', seiten: 2 },
      { qrWert: (body.beispielQr || 'ORDER-1001').replace(/(\d+)$/, (m) => String(Number(m) + 1)), seiten: 1 },
      { qrWert: null, seiten: 1 },
    ];
    const namen = beispiele.map((d, i) => baueTeilNamen(entwurf, stamm, i + 1, beispiele.length, d, 'x.pdf'));
    return sendJson(res, 200, { namen, muster: entwurf.teilNamensmuster || '{stamm}_{nr}_{qrWert}' });
  }

  if (parts[1] === 'entwurf-vorschau' && req.method === 'POST') {
    const body = await readBody(req);
    const entwurf = normalizeJob(body, 'entwurf');
    if (!entwurf.sourcePath) return sendJson(res, 400, { error: 'Quell-Ordner fehlt' });

    let scan;
    try {
      scan = listMatchingFiles(entwurf.sourcePath, entwurf.filePattern, {
        minFileAgeSec: 0, // für die Vorschau keine Ruhezeit abwarten
        maxFileSizeMB: entwurf.maxFileSizeMB,
      });
    } catch (err) {
      return sendJson(res, 200, { ok: false, meldung: err.message });
    }

    const gewuenscht = body.datei ? path.basename(body.datei) : null;
    const kandidaten = scan.accepted.slice();
    // Auch bereits verschobene Dateien zulassen, damit sich ein Job auch
    // nach dem ersten Lauf noch bequem prüfen lässt
    [entwurf.archiveSubfolder, entwurf.errorSubfolder].forEach((unter) => {
      try {
        const dir = path.join(entwurf.sourcePath, unter);
        fs.readdirSync(dir).forEach((f) => {
          const voll = path.join(dir, f);
          try { if (fs.statSync(voll).isFile()) kandidaten.push(voll); } catch { /* egal */ }
        });
      } catch { /* Ordner gibt es noch nicht */ }
    });

    const datei = gewuenscht
      ? kandidaten.find((k) => path.basename(k) === gewuenscht)
      : kandidaten[0];

    if (!datei) {
      return sendJson(res, 200, {
        ok: false,
        meldung: scan.accepted.length === 0 && kandidaten.length === 0
          ? `Im Ordner "${entwurf.sourcePath}" passt derzeit keine Datei auf den Filter "${entwurf.filePattern}".`
          : 'Die gewünschte Datei wurde nicht gefunden.',
        wartend: scan.tooYoung.length,
        zuGross: scan.tooLarge.length,
      });
    }

    const dateiName = path.basename(datei);
    const gemeinsam = {
      ok: true,
      datei: dateiName,
      quelle: datei,
      gefunden: kandidaten.length,
      wartend: scan.tooYoung.length,
      zuGross: scan.tooLarge.map((f) => f.name),
      zielUrl: entwurf.targetUrl,
      header: entwurf.headers || [],
    };

    if (entwurf.processor !== 'pdf-qr-json') {
      return sendJson(res, 200, {
        ...gemeinsam,
        modus: 'roh',
        hinweis: 'Ohne Verarbeitung wird die Datei unverändert gesendet.',
        curl: `curl -X ${entwurf.method || 'POST'} --data-binary @${dateiName} ${entwurf.targetUrl}`,
      });
    }

    return verarbeitung.pdfZuJson(entwurf, datei, config.settings, (fehler, sendung, info) => {
      if (fehler) return sendJson(res, 200, { ...gemeinsam, ok: false, meldung: fehler });
      const pfad = sendung.modus === 'multipart' ? sendung.metaPfad : sendung.sendePfad;
      let inhalt = '';
      try { inhalt = fs.readFileSync(pfad, 'utf8'); } catch { /* egal */ }
      [sendung.metaPfad, sendung.sendePfad].forEach((f) => { if (f) { try { fs.unlinkSync(f); } catch { /* egal */ } } });
      try {
        const tmp = require('os').tmpdir();
        const stamm = path.basename(pfad).split('.')[0];
        if (stamm.startsWith('fp-')) {
          fs.readdirSync(tmp).filter((f) => f.startsWith(stamm)).forEach((f) => {
            try { fs.unlinkSync(path.join(tmp, f)); } catch { /* egal */ }
          });
        }
      } catch { /* egal */ }

      let anzeige = inhalt;
      let istJson = true;
      let jsonFehler = null;
      try {
        const obj = JSON.parse(inhalt);
        if (obj.dateiInhaltBase64) obj.dateiInhaltBase64 = `«${obj.dateiInhaltBase64.length} Zeichen Base64»`;
        anzeige = JSON.stringify(obj, null, 2);
      } catch (e) { istJson = false; jsonFehler = e.message; }

      sendJson(res, 200, {
        ...gemeinsam,
        modus: sendung.modus,
        qrWert: info.qrWert,
        qrGefunden: info.qrGefunden,
        qrHinweis: info.qrHinweis,
        bildquelle: info.bildquelle,
        felder: { datei: entwurf.dateiFeldName || 'file1', metadaten: entwurf.metadataFeldName || 'metadata1' },
        inhalt: anzeige,
        istJson,
        jsonFehler,
      });
    });
  }

  if (parts[1] === 'sendevorschau' && parts[2] === 'download' && req.method === 'GET') {
    const q = urlObj.searchParams;
    const job = config.jobs.find((j) => j.id === q.get('jobId'));
    const fileName = path.basename(q.get('file') || '');
    const vollstaendig = q.get('voll') === '1';
    if (!job) return sendJson(res, 404, { error: 'Job nicht gefunden' });
    if (!fileName) return sendJson(res, 400, { error: 'Dateiname fehlt' });
    if (job.processor !== 'pdf-qr-json') return sendJson(res, 400, { error: 'Für diesen Job wird keine JSON erzeugt' });

    const kandidaten = [
      path.join(job.sourcePath, fileName),
      path.join(job.sourcePath, job.errorSubfolder || '_fehler', fileName),
      path.join(job.sourcePath, job.archiveSubfolder || '_gesendet', fileName),
    ];
    const gefunden = kandidaten.find((p2) => { try { return fs.statSync(p2).isFile(); } catch { return false; } });
    if (!gefunden) return sendJson(res, 404, { error: 'Datei nicht auffindbar' });

    return verarbeitung.pdfZuJson(job, gefunden, config.settings, (fehler, sendung, info) => {
      if (fehler) return sendJson(res, 500, { error: fehler });
      const pfad = sendung.modus === 'multipart' ? sendung.metaPfad : sendung.sendePfad;
      let inhalt = '';
      try { inhalt = fs.readFileSync(pfad, 'utf8'); } catch (e) { return sendJson(res, 500, { error: e.message }); }

      // Aufraeumen — es wird nichts gesendet
      [sendung.metaPfad, sendung.sendePfad].forEach((f) => { if (f) { try { fs.unlinkSync(f); } catch { /* egal */ } } });
      try {
        const tmp = require('os').tmpdir();
        const stamm = path.basename(pfad).split('.')[0];
        if (stamm.startsWith('fp-')) {
          fs.readdirSync(tmp).filter((f) => f.startsWith(stamm)).forEach((f) => {
            try { fs.unlinkSync(path.join(tmp, f)); } catch { /* egal */ }
          });
        }
      } catch { /* egal */ }

      // Ohne "voll" das eingebettete PDF kuerzen, damit die Datei handlich bleibt
      let ausgabe = inhalt;
      if (!vollstaendig && sendung.modus === 'json') {
        try {
          const obj = JSON.parse(inhalt);
          if (obj.dateiInhaltBase64) {
            obj.dateiInhaltBase64 = `«gekürzt: ${obj.dateiInhaltBase64.length} Zeichen Base64»`;
          }
          ausgabe = JSON.stringify(obj, null, 2);
        } catch { /* Rohinhalt behalten */ }
      } else {
        try { ausgabe = JSON.stringify(JSON.parse(inhalt), null, 2); } catch { /* Rohinhalt behalten */ }
      }

      const zielName = fileName.replace(/\.[^.]+$/, '') + (vollstaendig ? '-vollstaendig' : '') + '.json';
      const puffer = Buffer.from(ausgabe, 'utf8');
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${zielName.replace(/"/g, '')}"`,
        'Content-Length': puffer.length,
      });
      res.end(puffer);
    });
  }

  if (parts[1] === 'sendevorschau' && req.method === 'POST') {
    const body = await readBody(req);
    const job = config.jobs.find((j) => j.id === body.jobId);
    if (!job) return sendJson(res, 404, { error: 'Job nicht gefunden' });
    const fileName = path.basename(body.file || '');
    if (!fileName) return sendJson(res, 400, { error: 'Dateiname fehlt' });

    const kandidaten = [
      path.join(job.sourcePath, fileName),
      path.join(job.sourcePath, job.errorSubfolder || '_fehler', fileName),
      path.join(job.sourcePath, job.archiveSubfolder || '_gesendet', fileName),
    ];
    const gefunden = kandidaten.find((p2) => { try { return fs.statSync(p2).isFile(); } catch { return false; } });
    if (!gefunden) return sendJson(res, 404, { error: 'Datei nicht auffindbar (evtl. verschoben oder gelöscht)' });

    if (job.processor !== 'pdf-qr-json') {
      return sendJson(res, 200, {
        modus: 'roh',
        hinweis: 'Für diesen Job ist keine Verarbeitung eingestellt — die Datei wird unverändert gesendet.',
        curl: ['curl', '-X', job.method || 'POST', '--data-binary', `@${gefunden}`, job.targetUrl].join(' '),
      });
    }

    return verarbeitung.pdfZuJson(job, gefunden, config.settings, (fehler, sendung, info) => {
      if (fehler) return sendJson(res, 200, { fehler });
      let inhalt = null;
      let groesse = null;
      try {
        const pfad = sendung.modus === 'multipart' ? sendung.metaPfad : sendung.sendePfad;
        inhalt = fs.readFileSync(pfad, 'utf8');
        groesse = fs.statSync(pfad).size;
      } catch { /* egal */ }
      // Temporaerdateien wieder entfernen — hier wird nichts gesendet.
      // Auch die extrahierte Bilddatei, falls sie im Temp-Ordner liegt.
      [sendung.metaPfad, sendung.sendePfad].forEach((f) => { if (f) { try { fs.unlinkSync(f); } catch { /* egal */ } } });
      try {
        const tmp = require('os').tmpdir();
        const bezug = sendung.metaPfad || sendung.sendePfad || '';
        const stamm = path.basename(bezug).split('.')[0];
        if (stamm.startsWith('fp-')) {
          fs.readdirSync(tmp).filter((f) => f.startsWith(stamm)).forEach((f) => {
            try { fs.unlinkSync(path.join(tmp, f)); } catch { /* egal */ }
          });
        }
      } catch { /* egal */ }

      let gekuerzt = inhalt;
      let istJson = true;
      let jsonFehler = null;
      if (sendung.modus === 'json' && inhalt) {
        try {
          const obj = JSON.parse(inhalt);
          if (obj.dateiInhaltBase64) obj.dateiInhaltBase64 = `«${obj.dateiInhaltBase64.length} Zeichen Base64»`;
          gekuerzt = JSON.stringify(obj, null, 2);
        } catch (e) { istJson = false; jsonFehler = e.message; }
      } else if (inhalt) {
        try { JSON.parse(inhalt); } catch (e) { istJson = false; jsonFehler = e.message; }
      }

      const felder = {
        datei: job.dateiFeldName || 'file1',
        metadaten: job.metadataFeldName || 'metadata1',
      };
      const curl = sendung.modus === 'multipart'
        ? `curl -X ${job.method || 'POST'} -F "${felder.datei}=@${fileName};type=application/pdf" -F "${felder.metadaten}=<metadaten.json" ${job.targetUrl}`
        : `curl -X ${job.method || 'POST'} -H "Content-Type: application/json" --data-binary @nachricht.json ${job.targetUrl}`;

      const textInfo = verarbeitung.analysiereText(gefunden);
      const bildInfo = verarbeitung.analysiereBilder(gefunden);
      sendJson(res, 200, {
        modus: sendung.modus,
        datei: fileName,
        textebene: textInfo,
        bildarten: bildInfo,
        quelle: gefunden,
        qrWert: info.qrWert,
        qrGefunden: info.qrGefunden,
        qrHinweis: info.qrHinweis,
        bildquelle: info.bildquelle,
        felder,
        inhalt: gekuerzt,
        groesse,
        istJson,
        jsonFehler,
        curl,
        zielUrl: job.targetUrl,
        header: job.headers || [],
      });
    });
  }

  if (parts[1] === 'metadata-vorschau' && req.method === 'POST') {
    const body = await readBody(req);
    const jetzt = new Date();
    const dateiname = body.beispielDateiname || '1234_001.pdf';
    const werte = {
      qrWert: body.beispielQrWert || body.beispielProbennummer || '1234',
      probennummer: body.beispielQrWert || body.beispielProbennummer || '1234',
      qrGefunden: true,
      dateiname,
      dateinameOhneEndung: dateiname.replace(/\.[^.]+$/, ''),
      unixzeit: Math.floor(jetzt.getTime() / 1000),
      isozeit: jetzt.toISOString(),
      groesseBytes: 146990,
      jobName: body.name || 'Beispiel-Job',
      festwert: (body.auftragsnummer || '').trim() || null,
      auftragsnummer: (body.auftragsnummer || '').trim() || null,
      ...verarbeitung.gruppenAusDateiname(dateiname, body.dateinameRegex),
    };
    const text = verarbeitung.fuelleVorlage(body.metadataVorlage, werte);
    let gueltig = true;
    let fehler = null;
    try { JSON.parse(text); } catch (e) { gueltig = false; fehler = e.message; }
    return sendJson(res, 200, { text, gueltig, fehler, verfuegbareWerte: Object.keys(werte) });
  }

  if (parts[1] === 'pdf-werkzeuge' && req.method === 'GET') {
    return verarbeitung.pruefeVerarbeitungsWerkzeuge((w) => {
      sendJson(res, 200, { ...w, eigenerQrBefehl: (config.settings && config.settings.qrBefehl) || null, plattform: process.platform });
    });
  }

  // --- Öffentlich erreichbar: Kurzstatus für den Anmeldebildschirm ---
  if (parts[1] === 'oeffentlicher-status' && req.method === 'GET') {
    const aktiveJobs = config.jobs.filter((j) => !j.archived);
    const logs = readLogs({ limit: 400 });
    const grenze = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const jung = logs.filter((l) => new Date(l.ts).getTime() >= grenze);
    // Kurzübersicht je Job — nur wenn ausdrücklich freigegeben, denn sie ist
    // ohne Anmeldung sichtbar.
    const zeigeJobs = config.settings.jobUebersichtImLogin !== false;
    const jetzt = new Date();
    const jobUebersicht = !zeigeJobs ? null : aktiveJobs.map((job) => {
      const rt = ensureRuntime(job);
      let zustand;
      if (!job.active) zustand = 'pausiert';
      else if (rt.running) zustand = 'laeuft';
      else if ((rt.consecutiveFailures || 0) >= 3) zustand = 'fehlerhaft';
      else if (job.scheduleEnabled && !isWithinSchedule(job, jetzt)) zustand = 'ausserhalb';
      else if (rt.lastResult === 'error') zustand = 'letzterFehler';
      else zustand = 'bereit';
      const arbeit = rt.inArbeit ? Array.from(rt.inArbeit.values()).sort((a, b) => a.seit - b.seit) : [];
      return {
        name: job.name,
        kategorie: (job.category || '').trim() || null,
        zustand,
        fehlerFolge: rt.consecutiveFailures || 0,
        letzterLauf: rt.lastRunTs || null,
        aktuelleDatei: arbeit.length ? arbeit[0].name : null,
        weitereDateien: Math.max(0, arbeit.length - 1),
      };
    }).sort((a, b) => {
      const rang = { fehlerhaft: 0, letzterFehler: 1, laeuft: 2, ausserhalb: 3, bereit: 4, pausiert: 5 };
      return rang[a.zustand] - rang[b.zustand] || a.name.localeCompare(b.name, 'de');
    });

    return sendJson(res, 200, {
      anmeldungNoetig: zugriffsschutzAktiv(),
      jobsAktiv: aktiveJobs.filter((j) => j.active).length,
      jobsGesamt: aktiveJobs.length,
      erfolge7: jung.filter((l) => l.status === 'success').length,
      fehler7: jung.filter((l) => l.status === 'error').length,
      letzteUebertragung: logs.length ? logs[0].ts : null,
      jobs: jobUebersicht,
      anzeigeName: (config.settings.anzeigeName || '').trim() || null,
      logoDatenUrl: config.settings.logoDatenUrl || '',
      akzentFarbe: config.settings.akzentFarbe || '',
      version: VERSION,
      baustand: BAUSTAND,
    });
  }

  if (parts[1] === 'anmelden' && req.method === 'POST') {
    const body = await readBody(req);
    const kennung = String(body.name || '').toLowerCase().slice(0, 60);

    // Nach mehreren Fehlversuchen kurz sperren, damit Passwörter nicht
    // maschinell durchprobiert werden können.
    const sperre = anmeldeSperren.get(kennung);
    if (sperre && sperre.bis > Date.now()) {
      const sekunden = Math.ceil((sperre.bis - Date.now()) / 1000);
      return sendJson(res, 429, {
        error: `Zu viele Fehlversuche. Bitte ${sekunden} Sekunden warten.`,
      });
    }

    const benutzer = findeBenutzer(body.name);
    let stimmt = false;
    let umstellen = false;
    if (benutzer) {
      const eingabe = String(body.passwort || '');
      if (benutzer.verfahren === 'pbkdf2') {
        stimmt = gleichSicher(hashPasswort(eingabe, benutzer.salt), benutzer.hash);
      } else {
        // Altbestand im früheren Verfahren
        stimmt = gleichSicher(hashPasswortAlt(eingabe, benutzer.salt), benutzer.hash);
        umstellen = stimmt;
      }
    }

    if (!stimmt) {
      const stand = anmeldeSperren.get(kennung) || { fehlversuche: 0, bis: 0 };
      stand.fehlversuche += 1;
      if (stand.fehlversuche >= 5) {
        // Wartezeit wächst: 30s, 60s, 120s … höchstens 15 Minuten
        const warten = Math.min(30000 * Math.pow(2, stand.fehlversuche - 5), 900000);
        stand.bis = Date.now() + warten;
      }
      anmeldeSperren.set(kennung, stand);
      appendAudit('anmeldung.fehlgeschlagen', {
        benutzer: String(body.name || '').slice(0, 40), versuch: stand.fehlversuche,
      });
      return sendJson(res, 401, { error: 'Benutzername oder Passwort stimmt nicht.' });
    }

    anmeldeSperren.delete(kennung);

    // Still auf das stärkere Verfahren umstellen
    if (umstellen) {
      benutzer.hash = hashPasswort(String(body.passwort || ''), benutzer.salt);
      benutzer.verfahren = 'pbkdf2';
      saveConfig(config);
    }
    const token = crypto.randomBytes(24).toString('hex');
    sitzungen.set(token, {
      benutzerId: benutzer.id, name: benutzer.name,
      anzeigename: benutzer.anzeigename || benutzer.name,
      rolle: benutzer.rolle || 'benutzer', seit: Date.now(),
    });
    appendAudit('anmeldung', { benutzer: benutzer.anzeigename || benutzer.name });
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': `sitzung=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SITZUNG_DAUER / 1000}`,
    });
    return res.end(JSON.stringify({ ok: true, anzeigename: benutzer.anzeigename || benutzer.name, rolle: benutzer.rolle }));
  }

  if (parts[1] === 'abmelden' && req.method === 'POST') {
    const s2 = aktuelleSitzung(req);
    if (s2) { appendAudit('abmeldung', { benutzer: s2.anzeigename || s2.name }); sitzungen.delete(s2.token); }
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': 'sitzung=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0',
    });
    return res.end(JSON.stringify({ ok: true }));
  }

  if (parts[1] === 'ich' && req.method === 'GET') {
    const s2 = aktuelleSitzung(req);
    return sendJson(res, 200, {
      angemeldet: Boolean(s2),
      anzeigename: s2 ? (s2.anzeigename || s2.name) : null,
      rolle: s2 ? s2.rolle : null,
      schutzAktiv: zugriffsschutzAktiv(),
      darfVerwalten: istVerwaltung(req),
      darfAendern: !istBetrachter(req),
    });
  }

  // --- Benutzerverwaltung ---
  if (parts[1] === 'benutzer' && parts.length === 2 && req.method === 'GET') {
    return sendJson(res, 200, benutzerListe().map((b) => ({
      id: b.id, name: b.name, anzeigename: b.anzeigename || b.name, rolle: b.rolle || 'benutzer',
    })));
  }

  if (parts[1] === 'benutzer' && parts.length === 2 && req.method === 'POST') {
    if (!istVerwaltung(req)) return sendJson(res, 403, { error: 'Diese Aktion ist der Rolle „Verwaltung“ vorbehalten.' });
    const body = await readBody(req);
    const name = String(body.name || '').trim();
    if (!name) return sendJson(res, 400, { error: 'Benutzername fehlt' });
    if (!body.passwort || String(body.passwort).length < 4) return sendJson(res, 400, { error: 'Passwort muss mindestens 4 Zeichen haben' });
    if (findeBenutzer(name)) return sendJson(res, 400, { error: 'Benutzername ist bereits vergeben' });
    const salt = crypto.randomBytes(8).toString('hex');
    const neu = {
      id: 'u_' + crypto.randomBytes(5).toString('hex'),
      name,
      anzeigename: String(body.anzeigename || name).trim(),
      salt,
      hash: hashPasswort(body.passwort, salt),
      verfahren: 'pbkdf2',
      rolle: ['verwaltung', 'benutzer', 'betrachter'].includes(body.rolle) ? body.rolle : 'benutzer',
    };
    config.settings.benutzer = benutzerListe().concat([neu]);
    saveConfig(config);
    appendAudit('benutzer.anlegen', { benutzer: benutzerName(req), betroffen: neu.anzeigename });
    return sendJson(res, 201, { id: neu.id, name: neu.name, anzeigename: neu.anzeigename, rolle: neu.rolle });
  }

  if (parts[1] === 'benutzer' && parts[2] && req.method === 'DELETE') {
    if (!istVerwaltung(req)) return sendJson(res, 403, { error: 'Diese Aktion ist der Rolle „Verwaltung“ vorbehalten.' });
    const ziel = benutzerListe().find((b) => b.id === parts[2]);
    if (!ziel) return sendJson(res, 404, { error: 'Benutzer nicht gefunden' });
    config.settings.benutzer = benutzerListe().filter((b) => b.id !== parts[2]);
    // Laufende Sitzungen dieses Benutzers beenden
    for (const [tok, sit] of sitzungen) if (sit.benutzerId === ziel.id) sitzungen.delete(tok);
    saveConfig(config);
    appendAudit('benutzer.loeschen', { benutzer: benutzerName(req), betroffen: ziel.anzeigename || ziel.name });
    return sendJson(res, 200, { ok: true });
  }

  if (parts[1] === 'benutzer' && parts[2] && parts[3] === 'passwort' && req.method === 'POST') {
    if (!istVerwaltung(req)) return sendJson(res, 403, { error: 'Diese Aktion ist der Rolle „Verwaltung“ vorbehalten.' });
    const body = await readBody(req);
    const ziel = benutzerListe().find((b) => b.id === parts[2]);
    if (!ziel) return sendJson(res, 404, { error: 'Benutzer nicht gefunden' });
    if (!body.passwort || String(body.passwort).length < 4) return sendJson(res, 400, { error: 'Passwort muss mindestens 4 Zeichen haben' });
    ziel.salt = crypto.randomBytes(8).toString('hex');
    ziel.hash = hashPasswort(body.passwort, ziel.salt);
    ziel.verfahren = 'pbkdf2';
    saveConfig(config);
    appendAudit('benutzer.passwort', { benutzer: benutzerName(req), betroffen: ziel.anzeigename || ziel.name });
    return sendJson(res, 200, { ok: true });
  }

  // --- Programmstand ---
  if (parts[1] === 'info' && req.method === 'GET') {
    return sendJson(res, 200, { version: VERSION, baustand: BAUSTAND });
  }

  // --- Erscheinungsbild ---
  if (parts[1] === 'erscheinungsbild' && req.method === 'GET') {
    return sendJson(res, 200, {
      logoDatenUrl: config.settings.logoDatenUrl || '',
      akzentFarbe: config.settings.akzentFarbe || '',
      version: VERSION,
      baustand: BAUSTAND,
      anzeigeName: (config.settings.anzeigeName || '').trim(),
    });
  }

  if (parts[1] === 'erscheinungsbild' && req.method === 'PUT') {
    if (!istVerwaltung(req)) return sendJson(res, 403, { error: 'Diese Aktion ist der Rolle „Verwaltung“ vorbehalten.' });
    const body = await readBody(req);

    if (body.logoDatenUrl !== undefined) {
      const wert = String(body.logoDatenUrl || '');
      if (wert && !/^data:image\/(png|jpeg|svg\+xml|webp);base64,/.test(wert)) {
        return sendJson(res, 400, { error: 'Nur PNG, JPEG, SVG oder WebP werden unterstützt.' });
      }
      if (wert.length > 400000) {
        return sendJson(res, 400, { error: 'Das Logo ist zu groß (höchstens etwa 300 KB). Bitte kleiner speichern.' });
      }
      config.settings.logoDatenUrl = wert;
    }
    if (body.akzentFarbe !== undefined) {
      const f = String(body.akzentFarbe || '').trim();
      if (f && !/^#[0-9a-fA-F]{6}$/.test(f)) return sendJson(res, 400, { error: 'Farbe bitte als Hex-Wert angeben, z. B. #2E6BB8.' });
      config.settings.akzentFarbe = f;
    }
    if (body.anzeigeName !== undefined) config.settings.anzeigeName = String(body.anzeigeName || '').trim();

    saveConfig(config);
    appendAudit('erscheinungsbild.aendern', { benutzer: benutzerName(req) });
    return sendJson(res, 200, {
      logoDatenUrl: config.settings.logoDatenUrl || '',
      akzentFarbe: config.settings.akzentFarbe || '',
      version: VERSION,
      baustand: BAUSTAND,
      anzeigeName: (config.settings.anzeigeName || '').trim(),
    });
  }

  if (parts[1] === 'update' && parts[2] === 'betriebsart' && req.method === 'GET') {
    return sendJson(res, 200, erkenneBetriebsart());
  }

  // --- Aktualisierung durch Hochladen eines Pakets ---
  if (parts[1] === 'update' && parts[2] === 'einspielen' && req.method === 'POST') {
    if (!istVerwaltung(req)) return sendJson(res, 403, { error: 'Diese Aktion ist der Rolle „Verwaltung“ vorbehalten.' });

    // Rohdaten einlesen (ZIP)
    const stuecke = [];
    let groesse = 0;
    let zuGross = false;
    await new Promise((fertig) => {
      req.on('data', (c) => {
        groesse += c.length;
        if (groesse > 80 * 1024 * 1024) { zuGross = true; req.destroy(); return; }
        stuecke.push(c);
      });
      req.on('end', fertig);
      req.on('error', fertig);
    });
    if (zuGross) return sendJson(res, 400, { error: 'Das Paket ist größer als 80 MB.' });
    const paket = Buffer.concat(stuecke);
    if (paket.length < 100 || paket[0] !== 0x50 || paket[1] !== 0x4B) {
      return sendJson(res, 400, { error: 'Das ist keine ZIP-Datei.' });
    }

    try {
      const ergebnis = aktualisierung.spieleUpdateEin(paket, __dirname, (info) => {
        appendAudit('update.eingespielt', {
          benutzer: benutzerName(req),
          vonVersion: VERSION,
          aufVersion: info.neueVersion,
          dateien: info.dateien,
        });
      });
      const art = erkenneBetriebsart();
      sendJson(res, 200, {
        ...ergebnis,
        neustartVerhalten: art.eingestellt,
        hinweis: art.eingestellt === 'beenden'
          ? 'Die Anwendung beendet sich jetzt. Windows startet sie über die Aufgabe bzw. den Dienst neu — das kann bis zu einer Minute dauern.'
          : 'Die Anwendung startet gleich neu. Konfiguration, Protokolle und Benutzer bleiben erhalten.',
      });
      // Neustart erst nach der Antwort, damit die Oberfläche sie noch erhält
      setTimeout(() => {
        console.log('Aktualisierung eingespielt — Anwendung wird neu gestartet.');
        starteNeu();
      }, 800);
    } catch (e) {
      sendJson(res, 400, { error: e.message });
    }
    return undefined;
  }

  // --- Aktualisierung ---
  if (parts[1] === 'update' && parts[2] === 'pruefen' && req.method === 'POST') {
    if (!istVerwaltung(req)) return sendJson(res, 403, { error: 'Diese Aktion ist der Rolle „Verwaltung“ vorbehalten.' });
    const quelle = (config.settings.updatePruefUrl || '').trim();
    if (!quelle) {
      return sendJson(res, 200, {
        ok: false,
        aktuelleVersion: VERSION,
        meldung: 'Keine Prüf-Adresse hinterlegt. Unter Einstellungen eine URL eintragen, die eine Datei im Format {"version":"1.3.0","hinweis":"…","download":"https://…"} ausliefert.',
      });
    }
    const geladen = await new Promise((resolve) => {
      try {
        const modul = quelle.startsWith('https:') ? require('https') : require('http');
        const anfrage = modul.get(quelle, { timeout: 12000 }, (antwort) => {
          let text = '';
          antwort.on('data', (c) => { text += c; if (text.length > 200000) antwort.destroy(); });
          antwort.on('end', () => resolve({ ok: true, text, status: antwort.statusCode }));
        });
        anfrage.on('timeout', () => { anfrage.destroy(); resolve({ ok: false, fehler: 'Zeitüberschreitung' }); });
        anfrage.on('error', (e) => resolve({ ok: false, fehler: e.message }));
      } catch (e) { resolve({ ok: false, fehler: e.message }); }
    });

    config.settings.letzteUpdatePruefung = new Date().toISOString();
    saveConfig(config);

    if (!geladen.ok) return sendJson(res, 200, { ok: false, aktuelleVersion: VERSION, meldung: `Prüfung nicht möglich: ${geladen.fehler}` });
    let info;
    try { info = JSON.parse(geladen.text); } catch { return sendJson(res, 200, { ok: false, aktuelleVersion: VERSION, meldung: 'Antwort war kein gültiges JSON.' }); }

    const neuer = versionVergleich(String(info.version || ''), VERSION) > 0;
    return sendJson(res, 200, {
      ok: true,
      aktuelleVersion: VERSION,
      verfuegbareVersion: info.version || null,
      aktualisierungVerfuegbar: neuer,
      hinweis: info.hinweis || null,
      download: info.download || null,
      geprueftAm: config.settings.letzteUpdatePruefung,
    });
  }

  if (parts[1] === 'warteschlange' && req.method === 'GET') {
    const job = config.jobs.find((j) => j.id === urlObj.searchParams.get('jobId'));
    if (!job) return sendJson(res, 404, { error: 'Job nicht gefunden' });
    const rt = ensureRuntime(job);

    let scan;
    try {
      scan = listMatchingFiles(job.sourcePath, job.filePattern, {
        minFileAgeSec: job.minFileAgeSec, maxFileSizeMB: job.maxFileSizeMB,
      });
    } catch (err) {
      return sendJson(res, 200, { ok: false, meldung: err.message });
    }

    const info = (voll) => {
      let groesse = null; let geaendert = null;
      try { const st = fs.statSync(voll); groesse = st.size; geaendert = st.mtimeMs; } catch { /* egal */ }
      return { name: path.basename(voll), groesse, geaendert };
    };

    const wiederholung = new Map();
    if (rt.versuche) {
      for (const [pfad, v] of rt.versuche) wiederholung.set(path.basename(pfad), v);
    }

    const bereit = [];
    const wartetAufWiederholung = [];
    scan.accepted.forEach((voll) => {
      const eintrag = info(voll);
      const v = wiederholung.get(eintrag.name);
      if (v && Date.now() < v.naechsterVersuch) {
        wartetAufWiederholung.push({ ...eintrag, versuche: v.anzahl, naechsterVersuch: v.naechsterVersuch, letzterFehler: v.letzterFehler });
      } else {
        bereit.push({ ...eintrag, versuche: v ? v.anzahl : 0 });
      }
    });

    const ordnerInhalt = (unter) => {
      try {
        const dir = path.join(job.sourcePath, unter);
        return fs.readdirSync(dir)
          .filter((f) => { try { return fs.statSync(path.join(dir, f)).isFile(); } catch { return false; } })
          .map((f) => info(path.join(dir, f)))
          .sort((a, b) => (b.geaendert || 0) - (a.geaendert || 0));
      } catch { return []; }
    };

    return sendJson(res, 200, {
      ok: true,
      jobName: job.name,
      inArbeit: rt.inArbeit ? Array.from(rt.inArbeit.values()).map((d) => ({ name: d.name, seit: d.seit })) : [],
      bereit,
      wartetAufRuhezeit: scan.tooYoung.map((n) => ({ name: n })),
      wartetAufWiederholung,
      zuGross: scan.tooLarge.map((f) => ({ name: f.name, groesse: f.size })),
      quarantaene: ordnerInhalt(job.quarantaeneSubfolder || '_quarantaene'),
      fehlerordner: ordnerInhalt(job.errorSubfolder || '_fehler'),
      ruhezeitSek: job.minFileAgeSec || 0,
      maxVersuche: job.maxVersuche || 0,
    });
  }

  // --- Datei aus Quarantäne zurückholen ---
  if (parts[1] === 'quarantaene' && parts[2] === 'zurueck' && req.method === 'POST') {
    const body = await readBody(req);
    const job = config.jobs.find((j) => j.id === body.jobId);
    if (!job) return sendJson(res, 404, { error: 'Job nicht gefunden' });
    const name = path.basename(body.file || '');
    const quelle = path.join(job.sourcePath, job.quarantaeneSubfolder || '_quarantaene', name);
    const ziel = path.join(job.sourcePath, name);
    try {
      if (!fs.existsSync(quelle)) return sendJson(res, 404, { error: 'Datei nicht in der Quarantäne gefunden' });
      if (fs.existsSync(ziel)) return sendJson(res, 400, { error: 'Im Quell-Ordner liegt bereits eine Datei dieses Namens' });
      fs.renameSync(quelle, ziel);
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
    const rt = ensureRuntime(job);
    if (rt.versuche) rt.versuche.delete(ziel);
    appendAudit('quarantaene.zurueck', { benutzer: benutzerName(req), jobName: job.name, datei: name });
    return sendJson(res, 200, { ok: true });
  }

  if (parts[1] === 'selfcheck' && req.method === 'GET') {
    // Die QR-Auswertung läuft im Programm selbst — Poppler und ZBar sind
    // nur noch optionale Rückfallwege und deshalb kein Grund für eine Warnung.
    return sendJson(res, 200, runSelfCheck());
  }

  if (parts[1] === 'audit' && req.method === 'GET') {
    return sendJson(res, 200, readAudit(Number(urlObj.searchParams.get('limit')) || 200));
  }

  if (parts[1] === 'templates' && parts.length === 2 && req.method === 'GET') {
    return sendJson(res, 200, config.templates || []);
  }

  if (parts[1] === 'templates' && parts.length === 2 && req.method === 'POST') {
    const body = await readBody(req);
    if (!body.name) return sendJson(res, 400, { error: 'Name der Vorlage fehlt' });
    config.templates = config.templates || [];
    const { id: _i, name: _n, sortOrder: _s, ...settings } = normalizeJob(body.job || {});
    const tpl = { id: 't_' + crypto.randomBytes(5).toString('hex'), name: body.name.trim(), settings };
    config.templates.push(tpl);
    saveConfig(config);
    appendAudit('template.create', { benutzer: benutzerName(req), templateName: tpl.name });
    return sendJson(res, 201, tpl);
  }

  if (parts[1] === 'templates' && parts[2] && req.method === 'DELETE') {
    config.templates = (config.templates || []).filter((t) => t.id !== parts[2]);
    saveConfig(config);
    appendAudit('template.delete', { benutzer: benutzerName(req), templateId: parts[2] });
    return sendJson(res, 200, { ok: true });
  }

  if (parts[1] === 'backups' && parts.length === 2 && req.method === 'GET') {
    let files = [];
    try {
      files = fs.readdirSync(BACKUP_DIR)
        .filter((f) => f.startsWith('config-') && f.endsWith('.json'))
        .map((f) => {
          const full = path.join(BACKUP_DIR, f);
          let jobCount = null;
          let size = null;
          try {
            const st = fs.statSync(full);
            size = st.size;
            jobCount = (JSON.parse(fs.readFileSync(full, 'utf8')).jobs || []).length;
          } catch { /* beschaedigte Sicherung ueberspringen */ }
          return { file: f, size, jobCount, ts: f.replace('config-', '').replace('.json', '').replace(/-/g, (m, i) => (i > 9 ? ':' : '-')) };
        })
        .sort((a, b) => b.file.localeCompare(a.file));
    } catch { /* Ordner existiert noch nicht */ }
    return sendJson(res, 200, files);
  }

  if (parts[1] === 'backups' && parts[2] === 'restore' && req.method === 'POST') {
    if (!istVerwaltung(req)) return sendJson(res, 403, { error: 'Diese Aktion ist der Rolle „Verwaltung“ vorbehalten.' });
    const body = await readBody(req);
    const name = (body.file || '').replace(/[/\\]/g, '');
    if (!name.startsWith('config-') || !name.endsWith('.json')) return sendJson(res, 400, { error: 'Ungültiger Sicherungsname' });
    const full = path.join(BACKUP_DIR, name);
    if (!fs.existsSync(full)) return sendJson(res, 404, { error: 'Sicherung nicht gefunden' });

    let restored;
    try {
      restored = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch (err) {
      return sendJson(res, 400, { error: 'Sicherung ist beschädigt: ' + err.message });
    }
    if (!Array.isArray(restored.jobs)) return sendJson(res, 400, { error: 'Sicherung enthält keine Jobs' });

    // Aktuellen Stand vorher sichern, damit die Wiederherstellung selbst umkehrbar bleibt
    backupConfig();
    const vorher = config.jobs.length;
    config = restored;
    if (!config.settings) config.settings = defaultSettings();
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    Object.keys(jobRuntime).forEach((id) => delete jobRuntime[id]);
    appendAudit('config.restore', { benutzer: benutzerName(req), file: name, jobsVorher: vorher, jobsNachher: config.jobs.length });
    return sendJson(res, 200, { ok: true, jobCount: config.jobs.length });
  }

  if (parts[1] === 'download' && req.method === 'GET') {
    const q = urlObj.searchParams;
    const job = config.jobs.find((j) => j.id === q.get('jobId'));
    const fileName = path.basename(q.get('file') || '');
    if (!job) return sendJson(res, 404, { error: 'Job nicht gefunden' });
    if (!fileName) return sendJson(res, 400, { error: 'Dateiname fehlt' });

    // Datei kann noch im Quellordner liegen oder bereits verschoben worden sein
    const candidates = [
      path.join(job.sourcePath, fileName),
      path.join(job.sourcePath, job.errorSubfolder || '_fehler', fileName),
      path.join(job.sourcePath, job.archiveSubfolder || '_gesendet', fileName),
    ];
    const found = candidates.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
    if (!found) return sendJson(res, 404, { error: 'Datei nicht mehr auffindbar (evtl. gelöscht oder verschoben)' });

    const data = fs.readFileSync(found);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${fileName.replace(/"/g, '')}"`,
      'Content-Length': data.length,
    });
    return res.end(data);
  }

  if (parts[1] === 'jobs' && parts.length === 2 && req.method === 'GET') {
    const successMap = lastSuccessByJob();
    return sendJson(res, 200, config.jobs.map((j) => jobPublicView(j, successMap)));
  }

  if (parts[1] === 'jobs' && parts.length === 2 && req.method === 'POST') {
    const body = await readBody(req);
    const job = normalizeJob(body);
    config.jobs.push(job);
    saveConfig(config);
    ensureRuntime(job);
    appendAudit('job.create', { benutzer: benutzerName(req), jobId: job.id, jobName: job.name, targetUrl: job.targetUrl });
    return sendJson(res, 201, jobPublicView(job));
  }

  const jobId = parts[2];
  const job = jobId ? config.jobs.find((j) => j.id === jobId) : null;

  if (parts[1] === 'jobs' && jobId && parts.length === 3 && req.method === 'PUT') {
    if (!job) return sendJson(res, 404, { error: 'Job nicht gefunden' });
    const body = await readBody(req);
    // Leere Passwortfelder bedeuten „unverändert lassen", nicht „löschen".
    // Die Oberfläche sendet sie leer, weil der Server sie nie herausgibt.
    if (!body.authPassword) delete body.authPassword;
    if (!body.smtpPasswort) delete body.smtpPasswort;
    const vorher = { ...job };
    Object.assign(job, body, { id: job.id });
    saveConfig(config);
    const geaendert = Object.keys(body).filter((k) => k !== 'authPassword' && k !== 'smtpPasswort'
      && JSON.stringify(vorher[k]) !== JSON.stringify(job[k]));
    appendAudit('job.update', { benutzer: benutzerName(req), jobId: job.id, jobName: job.name, fields: geaendert });
    return sendJson(res, 200, jobPublicView(job));
  }

  if (parts[1] === 'jobs' && jobId && parts.length === 3 && req.method === 'DELETE') {
    if (!istVerwaltung(req)) return sendJson(res, 403, { error: 'Diese Aktion ist der Rolle „Verwaltung“ vorbehalten.' });
    if (!job) return sendJson(res, 404, { error: 'Job nicht gefunden' });
    const geloescht = job.name;
    config.jobs = config.jobs.filter((j) => j.id !== jobId);
    delete jobRuntime[jobId];
    saveConfig(config);
    appendAudit('job.delete', { benutzer: benutzerName(req), jobId, jobName: geloescht });
    return sendJson(res, 200, { ok: true });
  }

  if (parts[1] === 'jobs' && jobId && parts[3] === 'toggle' && req.method === 'POST') {
    if (!job) return sendJson(res, 404, { error: 'Job nicht gefunden' });
    job.active = !job.active;
    saveConfig(config);
    return sendJson(res, 200, jobPublicView(job));
  }

  if (parts[1] === 'jobs' && parts[2] === 'bulk' && req.method === 'POST') {
    const body = await readBody(req);
    const ids = Array.isArray(body.ids) ? body.ids : [];
    const targets = config.jobs.filter((j) => ids.includes(j.id));
    if (targets.length === 0) return sendJson(res, 400, { error: 'Keine gültigen Jobs ausgewählt' });

    let affected = 0;
    if (body.action === 'activate') {
      targets.forEach((j) => { j.active = true; affected += 1; });
    } else if (body.action === 'pause') {
      targets.forEach((j) => { j.active = false; affected += 1; });
    } else if (body.action === 'setCategory') {
      const cat = (body.category || '').trim();
      targets.forEach((j) => { j.category = cat; affected += 1; });
    } else if (body.action === 'delete') {
      if (!istVerwaltung(req)) return sendJson(res, 403, { error: 'Löschen ist der Rolle „Verwaltung“ vorbehalten.' });
      config.jobs = config.jobs.filter((j) => !ids.includes(j.id));
      ids.forEach((id) => delete jobRuntime[id]);
      affected = targets.length;
    } else {
      return sendJson(res, 400, { error: 'Unbekannte Sammelaktion' });
    }
    saveConfig(config);
    appendAudit('job.bulk', { benutzer: benutzerName(req), action: body.action, affected, category: body.category });
    return sendJson(res, 200, { ok: true, affected });
  }

  if (parts[1] === 'jobs' && parts[2] === 'reorder' && req.method === 'POST') {
    const body = await readBody(req);
    const order = Array.isArray(body.order) ? body.order : [];
    if (order.length === 0) return sendJson(res, 400, { error: 'Keine Reihenfolge übermittelt' });
    order.forEach((id, index) => {
      const j = config.jobs.find((x) => x.id === id);
      if (j) j.sortOrder = index;
    });
    // Jobs ohne Angabe hinten anstellen, damit die Sortierung stabil bleibt
    let next = order.length;
    config.jobs.forEach((j) => { if (j.sortOrder === null || j.sortOrder === undefined) { j.sortOrder = next; next += 1; } });
    saveConfig(config);
    return sendJson(res, 200, { ok: true });
  }

  if (parts[1] === 'categories' && parts.length === 2 && req.method === 'GET') {
    const names = Array.from(new Set(config.jobs.map((j) => (j.category || '').trim()).filter(Boolean)));
    return sendJson(res, 200, names.sort((a, b) => a.localeCompare(b, 'de')));
  }

  if (parts[1] === 'categories' && parts[2] === 'rename' && req.method === 'POST') {
    if (!istVerwaltung(req)) return sendJson(res, 403, { error: 'Diese Aktion ist der Rolle „Verwaltung“ vorbehalten.' });
    const body = await readBody(req);
    const from = (body.from || '').trim();
    const to = (body.to || '').trim();
    if (!from) return sendJson(res, 400, { error: 'Quell-Kategorie fehlt' });
    let affected = 0;
    config.jobs.forEach((j) => {
      if ((j.category || '').trim() === from) { j.category = to; affected += 1; }
    });
    saveConfig(config);
    appendAudit('category.rename', { benutzer: benutzerName(req), from, to, affected });
    // to leer = Kategorie entfernt; to bereits vorhanden = zusammengefuehrt
    return sendJson(res, 200, { ok: true, affected, merged: Boolean(to) && config.jobs.some((j) => (j.category || '').trim() === to) });
  }

  if (parts[1] === 'config-warnings' && req.method === 'GET') {
    return sendJson(res, 200, findConfigWarnings());
  }

  if (parts[1] === 'jobs' && jobId && parts[3] === 'archive' && req.method === 'POST') {
    if (!job) return sendJson(res, 404, { error: 'Job nicht gefunden' });
    const body = await readBody(req);
    const archivieren = body.archived !== false;
    job.archived = archivieren;
    job.archivedAt = archivieren ? new Date().toISOString() : null;
    if (archivieren) job.active = false; // archivierte Jobs laufen nicht weiter
    saveConfig(config);
    appendAudit(archivieren ? 'job.archive' : 'job.unarchive', { benutzer: benutzerName(req), jobId: job.id, jobName: job.name });
    return sendJson(res, 200, jobPublicView(job));
  }

  if (parts[1] === 'jobs' && jobId && parts[3] === 'run-now' && req.method === 'POST') {
    if (!job) return sendJson(res, 404, { error: 'Job nicht gefunden' });
    processJob(job);
    return sendJson(res, 202, { ok: true });
  }

  if (parts[1] === 'logs' && parts.length === 2 && req.method === 'GET') {
    const q = urlObj.searchParams;
    return sendJson(res, 200, readLogs({
      jobId: q.get('jobId') || undefined,
      status: q.get('status') || undefined,
      limit: q.get('limit') ? Number(q.get('limit')) : undefined,
      q: q.get('q') || undefined,
    }));
  }

  if (parts[1] === 'logs' && parts[2] === 'retry' && req.method === 'POST') {
    const body = await readBody(req);
    const job = config.jobs.find((j) => j.id === body.jobId);
    if (!job) return sendJson(res, 404, { error: 'Job nicht gefunden (evtl. inzwischen gelöscht)' });
    const fileName = body.file;
    if (!fileName) return sendJson(res, 400, { error: 'Dateiname fehlt' });

    const candidates = [
      path.join(job.sourcePath, fileName),
      path.join(job.sourcePath, job.errorSubfolder || '_fehler', fileName),
      path.join(job.sourcePath, job.archiveSubfolder || '_gesendet', fileName),
      path.join(job.sourcePath, job.quarantaeneSubfolder || '_quarantaene', fileName),
    ];
    const filePath = candidates.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
    if (!filePath) {
      return sendJson(res, 404, {
        error: `„${fileName}" ist weder im Quell-Ordner noch im Archiv, Fehler- oder Quarantäne-Ordner auffindbar. `
          + 'Möglicherweise wurde sie inzwischen aufgeräumt oder von Hand entfernt.',
      });
    }

    // Aus dem Archiv gesendet? Das gehört ins Protokoll, sonst wirkt es
    // später wie eine doppelte Übertragung ohne erkennbaren Grund.
    const ausArchiv = filePath.includes(path.sep + (job.archiveSubfolder || '_gesendet') + path.sep);

    let fileSize = null;
    try { fileSize = fs.statSync(filePath).size; } catch { /* egal */ }

    // Wiederholung muss denselben Weg gehen wie ein regulaerer Lauf,
    // sonst wuerde bei Verarbeitungs-Jobs die Rohdatei statt der Nachricht gesendet.
    let sendung = filePath;
    let verarbeitungsInfo = null;
    const aufraeumen = [];

    // Auch die Wiederholung sichtbar machen
    const rtRetry = ensureRuntime(job);
    if (!rtRetry.inArbeit) rtRetry.inArbeit = new Map();
    rtRetry.inArbeit.set(filePath, { name: fileName, seit: Date.now(), groesse: fileSize });
    const retryFertig = () => { if (rtRetry.inArbeit) rtRetry.inArbeit.delete(filePath); };
    if (job.processor === 'pdf-qr-json') {
      const vorbereitet = await new Promise((resolve) => {
        verarbeitung.pdfZuJson(job, filePath, config.settings, (fehler, s, info) => resolve({ fehler, s, info }));
      });
      if (vorbereitet.fehler) {
        appendLog({
          ts: new Date().toISOString(), jobId: job.id, jobName: job.name, targetUrl: job.targetUrl,
          file: fileName, fileSize, status: 'error', httpStatus: null,
          message: `Verarbeitung fehlgeschlagen: ${vorbereitet.fehler}`,
        });
        retryFertig();
        return sendJson(res, 200, { ok: false, httpStatus: null, message: vorbereitet.fehler });
      }
      sendung = vorbereitet.s;
      verarbeitungsInfo = vorbereitet.info;
      aufraeumen.push(sendung.modus === 'multipart' ? sendung.metaPfad : sendung.sendePfad);
    }

    const result = await new Promise((resolve) => runCurlAllTargets(job, sendung, resolve));
    retryFertig();
    aufraeumen.forEach((f) => { try { fs.unlinkSync(f); } catch { /* egal */ } });
    const entry = {
      ts: new Date().toISOString(), jobId: job.id, jobName: job.name, targetUrl: job.targetUrl,
      file: fileName, fileSize, status: result.ok ? 'success' : 'error', httpStatus: result.httpStatus,
      exitCode: result.exitCode,
      qrWert: verarbeitungsInfo ? verarbeitungsInfo.qrWert : undefined,
      probennummer: verarbeitungsInfo ? verarbeitungsInfo.qrWert : undefined,
      qrGefunden: verarbeitungsInfo ? verarbeitungsInfo.qrGefunden : undefined,
      gesendeteMetadaten: verarbeitungsInfo ? verarbeitungsInfo.metadaten : undefined,
      vonHand: true,
      ausArchiv,
      message: (ausArchiv
        ? '↻ Von Hand nochmals gesendet — die Datei war bereits übertragen. '
        : '↻ Von Hand erneut gesendet. ')
        + (verarbeitungsInfo && !verarbeitungsInfo.qrGefunden ? `⚠ Ohne QR-Wert gesendet (${verarbeitungsInfo.qrHinweis}). ` : '')
        + (verarbeitungsInfo && verarbeitungsInfo.qrGefunden ? `QR: ${verarbeitungsInfo.qrWert} · ` : '')
        + (result.ok ? result.bodySnippet : (result.errorText || result.bodySnippet || 'Unbekannter Fehler')),
    };
    appendLog(entry);
    appendAudit('uebertragung.wiederholt', {
      benutzer: benutzerName(req), jobName: job.name, datei: fileName,
      ausArchiv, ergebnis: entry.status,
    });
    const rt = ensureRuntime(job);
    rt.lastRunTs = Date.now();
    rt.lastResult = entry.status;
    rt.consecutiveFailures = entry.status === 'success' ? 0 : rt.consecutiveFailures + 1;
    try {
      if (result.ok && job.onSuccess === 'archive') moveFile(filePath, job.sourcePath, job.archiveSubfolder || '_gesendet');
      else if (!result.ok && job.onError === 'archive') moveFile(filePath, job.sourcePath, job.errorSubfolder || '_fehler');
    } catch { /* Verschieben fehlgeschlagen, Übertragungsergebnis bleibt gueltig */ }

    return sendJson(res, 200, { ok: result.ok, httpStatus: result.httpStatus, message: entry.message });
  }

  if (parts[1] === 'logs' && parts.length === 2 && req.method === 'DELETE') {
    if (!istVerwaltung(req)) return sendJson(res, 403, { error: 'Diese Aktion ist der Rolle „Verwaltung“ vorbehalten.' });
    fs.writeFileSync(LOG_PATH, '');
    config.jobs.forEach((job) => {
      const rt = ensureRuntime(job);
      rt.lastRunTs = null;
      rt.lastResult = null;
      rt.consecutiveFailures = 0;
      // rt.nextDueTs und rt.running bleiben unangetastet, damit der Scan-Zeitplan nicht gestört wird
    });
    return sendJson(res, 200, { ok: true });
  }

  if (parts[1] === 'settings' && parts.length === 2 && req.method === 'GET') {
    return sendJson(res, 200, {
      logRetentionDays: config.settings.logRetentionDays,
      jobUebersichtImLogin: config.settings.jobUebersichtImLogin !== false,
      updatePruefUrl: config.settings.updatePruefUrl || '',
      letzteUpdatePruefung: config.settings.letzteUpdatePruefung || null,
      neustartVerhalten: config.settings.neustartVerhalten || 'selbst',
      baustand: BAUSTAND,
      version: VERSION,
    });
  }

  if (parts[1] === 'settings' && parts.length === 2 && req.method === 'PUT') {
    if (!istVerwaltung(req)) return sendJson(res, 403, { error: 'Diese Aktion ist der Rolle „Verwaltung“ vorbehalten.' });
    const body = await readBody(req);
    if (body.neustartVerhalten !== undefined) {
      config.settings.neustartVerhalten = body.neustartVerhalten === 'beenden' ? 'beenden' : 'selbst';
    }
    if (body.updatePruefUrl !== undefined) {
      config.settings.updatePruefUrl = String(body.updatePruefUrl || '').trim();
    }
    if (body.jobUebersichtImLogin !== undefined) {
      config.settings.jobUebersichtImLogin = Boolean(body.jobUebersichtImLogin);
    }
    if (body.logRetentionDays !== undefined) {
      const days = Number(body.logRetentionDays);
      if (days && days > 0) config.settings.logRetentionDays = Math.round(days);
    }
    if (body.dashboardAuth) {
      const da = body.dashboardAuth;
      if (da.enabled === false) {
        config.settings.dashboardAuth = { enabled: false, username: '', passwordHash: '', salt: '' };
      } else if (da.enabled === true) {
        if (!da.username) return sendJson(res, 400, { error: 'Benutzername fehlt' });
        // Passwort nur aendern, wenn tatsaechlich eines mitgeschickt wurde (leer = unveraendert)
        if (da.password) {
          const salt = crypto.randomBytes(8).toString('hex');
          const passwordHash = crypto.createHash('sha256').update(salt + da.password).digest('hex');
          config.settings.dashboardAuth = { enabled: true, username: da.username, passwordHash, salt };
        } else if (config.settings.dashboardAuth.passwordHash) {
          config.settings.dashboardAuth.enabled = true;
          config.settings.dashboardAuth.username = da.username;
        } else {
          return sendJson(res, 400, { error: 'Bitte ein Passwort vergeben' });
        }
      }
    }
    saveConfig(config);
    return sendJson(res, 200, {
      logRetentionDays: config.settings.logRetentionDays,
      jobUebersichtImLogin: config.settings.jobUebersichtImLogin !== false,
      updatePruefUrl: config.settings.updatePruefUrl || '',
      letzteUpdatePruefung: config.settings.letzteUpdatePruefung || null,
      neustartVerhalten: config.settings.neustartVerhalten || 'selbst',
      baustand: BAUSTAND,
      version: VERSION,
    });
  }

  if (parts[1] === 'benachrichtigung' && parts.length === 2 && req.method === 'GET') {
    const b = config.settings.benachrichtigung || defaultSettings().benachrichtigung;
    const { smtpPasswort, ...oeffentlich } = b;
    return sendJson(res, 200, { ...oeffentlich, smtpPasswortGesetzt: Boolean(smtpPasswort) });
  }

  if (parts[1] === 'benachrichtigung' && parts.length === 2 && req.method === 'PUT') {
    if (!istVerwaltung(req)) return sendJson(res, 403, { error: 'Diese Aktion ist der Rolle „Verwaltung“ vorbehalten.' });
    const body = await readBody(req);
    const vorhanden = config.settings.benachrichtigung || defaultSettings().benachrichtigung;
    if (body.emailAktiv && !String(body.smtpHost || '').trim()) {
      return sendJson(res, 400, { error: 'Bitte einen SMTP-Server angeben.' });
    }
    if (body.emailAktiv && !String(body.an || '').trim()) {
      return sendJson(res, 400, { error: 'Bitte mindestens eine Empfängeradresse angeben.' });
    }
    if (body.webhookAktiv && !String(body.webhookUrl || '').trim()) {
      return sendJson(res, 400, { error: 'Bitte eine Webhook-URL angeben.' });
    }
    config.settings.benachrichtigung = {
      emailAktiv: Boolean(body.emailAktiv),
      smtpHost: String(body.smtpHost || '').trim(),
      smtpPort: Number(body.smtpPort) || 587,
      smtpSicher: body.smtpSicher !== false,
      smtpBenutzer: String(body.smtpBenutzer || '').trim(),
      // Leeres Feld = unverändert lassen, wie schon bei den Job-Zugangsdaten
      smtpPasswort: body.smtpPasswort !== undefined && body.smtpPasswort !== ''
        ? body.smtpPasswort
        : (vorhanden.smtpPasswort || ''),
      von: String(body.von || '').trim(),
      an: String(body.an || '').trim(),
      webhookAktiv: Boolean(body.webhookAktiv),
      webhookUrl: String(body.webhookUrl || '').trim(),
    };
    saveConfig(config);
    appendAudit('benachrichtigung.geaendert', { benutzer: benutzerName(req) });
    const { smtpPasswort, ...oeffentlich } = config.settings.benachrichtigung;
    return sendJson(res, 200, { ...oeffentlich, smtpPasswortGesetzt: Boolean(smtpPasswort) });
  }

  if (parts[1] === 'benachrichtigung' && parts[2] === 'test' && req.method === 'POST') {
    if (!istVerwaltung(req)) return sendJson(res, 403, { error: 'Diese Aktion ist der Rolle „Verwaltung“ vorbehalten.' });
    const cfg = config.settings.benachrichtigung || defaultSettings().benachrichtigung;
    if (!cfg.emailAktiv && !cfg.webhookAktiv) {
      return sendJson(res, 400, { error: 'Kein Kanal aktiviert — zuerst E-Mail oder Webhook einschalten und speichern.' });
    }
    const ergebnisse = await sendeTestBenachrichtigung(cfg);
    return sendJson(res, 200, ergebnisse);
  }

  sendJson(res, 404, { error: 'Unbekannter Endpunkt' });
}

// ---------- Static Files ----------

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8' };

function serveStatic(req, res, urlObj) {
  let filePath = urlObj.pathname === '/' ? '/index.html' : urlObj.pathname;
  filePath = path.join(PUBLIC_DIR, filePath);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// ---------- Server ----------

// ---------- Zugriffsschutz (optional) ----------

function isAuthorized(req) {
  const auth = config.settings.dashboardAuth;
  if (!auth.enabled) return true;
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  const [user, pass] = Buffer.from(header.slice(6), 'base64').toString().split(':');
  if (user !== auth.username) return false;
  const hash = crypto.createHash('sha256').update(auth.salt + (pass || '')).digest('hex');
  return hash === auth.passwordHash;
}

// ---------- Log-Aufbewahrung (automatische Rotation) ----------

function rotateLogsIfNeeded() {
  const days = config.settings.logRetentionDays || 90;
  const all = readAllLogs();
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const kept = all.filter((l) => new Date(l.ts).getTime() >= cutoff);
  if (kept.length !== all.length) {
    fs.writeFileSync(LOG_PATH, kept.map((l) => JSON.stringify(l)).join('\n') + (kept.length ? '\n' : ''));
    console.log(`Log-Rotation: ${all.length - kept.length} Einträge älter als ${days} Tage entfernt.`);
  }
}
rotateLogsIfNeeded();
setInterval(rotateLogsIfNeeded, 6 * 60 * 60 * 1000); // alle 6 Stunden pruefen

// ---------- Archiv-Aufräumung ----------

function cleanupArchives() {
  config.jobs.forEach((job) => {
    const days = job.archiveRetentionDays || 0;
    if (days <= 0) return;
    const dir = path.join(job.sourcePath, job.archiveSubfolder || '_gesendet');
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    let removed = 0;
    entries.filter((e) => e.isFile()).forEach((e) => {
      const full = path.join(dir, e.name);
      try {
        if (fs.statSync(full).mtimeMs < cutoff) { fs.unlinkSync(full); removed += 1; }
      } catch { /* egal */ }
    });
    if (removed > 0) {
      appendLog({
        ts: new Date().toISOString(), jobId: job.id, jobName: job.name, targetUrl: job.targetUrl,
        file: null, status: 'success', httpStatus: null,
        message: `Archiv aufgeräumt: ${removed} Datei(en) älter als ${days} Tage entfernt.`,
      });
    }
  });
}
setInterval(cleanupArchives, 6 * 60 * 60 * 1000);

// ---------- Selbstdiagnose beim Start ----------

function runSelfCheck() {
  const problems = [];
  config.jobs.forEach((job) => {
    if (!job.active || job.archived) return;
    try {
      const st = fs.statSync(job.sourcePath);
      if (!st.isDirectory()) problems.push({ jobId: job.id, jobName: job.name, problem: `Quell-Pfad ist kein Ordner: ${job.sourcePath}` });
    } catch (err) {
      problems.push({ jobId: job.id, jobName: job.name, problem: `Quell-Ordner nicht erreichbar: ${job.sourcePath} (${err.code || err.message})` });
    }
    // Je nach Zielart ist etwas anderes erforderlich
    if (job.zielTyp === 'ordner') {
      if (!job.zielOrdner) problems.push({ jobId: job.id, jobName: job.name, problem: 'Kein Zielordner konfiguriert' });
    } else if (job.zielTyp === 'email') {
      if (!job.smtpHost) problems.push({ jobId: job.id, jobName: job.name, problem: 'Kein SMTP-Server konfiguriert' });
      if (!job.mailAn) problems.push({ jobId: job.id, jobName: job.name, problem: 'Keine Empfängeradresse konfiguriert' });
    } else if (!job.targetUrl) {
      problems.push({ jobId: job.id, jobName: job.name, problem: 'Keine Ziel-URL konfiguriert' });
    }
  });
  lastSelfCheck = { ts: new Date().toISOString(), problems };
  if (problems.length > 0) {
    console.log(`Selbstdiagnose: ${problems.length} Problem(e) gefunden:`);
    problems.forEach((p) => console.log(`  - ${p.jobName}: ${p.problem}`));
  } else {
    console.log('Selbstdiagnose: alle aktiven Jobs in Ordnung.');
  }
  return lastSelfCheck;
}
let lastSelfCheck = { ts: null, problems: [] };

// Startet die Anwendung neu. Läuft sie unter einem Dienst oder start.bat,
// übernimmt der Aufrufer den Neustart; sonst starten wir uns selbst neu.
/**
 * Versucht zu erkennen, wie die Anwendung betrieben wird.
 * Ein angeschlossenes Konsolenfenster spricht für start.bat; fehlt es
 * unter Windows, läuft sie vermutlich als Aufgabe oder Dienst.
 */
function erkenneBetriebsart() {
  const mitKonsole = Boolean(process.stdout.isTTY);
  const windows = process.platform === 'win32';
  let vermutung;
  if (!windows) vermutung = mitKonsole ? 'konsole' : 'hintergrund';
  else vermutung = mitKonsole ? 'startbat' : 'aufgabe';

  const empfehlung = vermutung === 'startbat' || vermutung === 'konsole' ? 'selbst' : 'beenden';
  return {
    plattform: process.platform,
    mitKonsole,
    vermutung,
    empfehlung,
    eingestellt: (config.settings && config.settings.neustartVerhalten) || 'selbst',
    passt: ((config.settings && config.settings.neustartVerhalten) || 'selbst') === empfehlung,
  };
}

let neustartLaeuft = false;
function starteNeu() {
  const verhalten = (config.settings && config.settings.neustartVerhalten) || 'selbst';

  const nachfolgerStarten = () => {
    if (neustartLaeuft) return;   // nur einmal, auch wenn beide Auslöser greifen
    neustartLaeuft = true;

    // Läuft die Anwendung unter Aufgabenplanung oder als Dienst, darf sie
    // sich NICHT selbst neu starten — sonst kennt Windows den neuen Vorgang
    // nicht und beide könnten sich um den Port streiten.
    if (verhalten === 'beenden') {
      console.log('Anwendung wird beendet — der Neustart erfolgt durch Windows (Aufgabe bzw. Dienst).');
      setTimeout(() => process.exit(0), 300);
      return;
    }
    try {
      const { spawn } = require('child_process');
      const protokoll = path.join(__dirname, 'data', 'neustart.log');
      let ausgabe = 'ignore';
      try {
        fs.mkdirSync(path.dirname(protokoll), { recursive: true });
        ausgabe = fs.openSync(protokoll, 'a');
      } catch { /* ohne Protokoll weiter */ }

      const kind = spawn(process.argv[0], process.argv.slice(1), {
        cwd: __dirname,
        detached: true,
        stdio: ausgabe === 'ignore' ? 'ignore' : ['ignore', ausgabe, ausgabe],
        env: process.env,
      });
      kind.unref();
    } catch (e) {
      console.error('Neustart konnte nicht ausgelöst werden:', e.message);
    }
    setTimeout(() => process.exit(0), 300);
  };

  // Erst den Port freigeben, sonst scheitert der neue Vorgang beim Binden
  try {
    server.close(() => setTimeout(nachfolgerStarten, 400));
    // Falls noch Verbindungen offen sind, nicht ewig warten
    setTimeout(nachfolgerStarten, 2500);
  } catch {
    nachfolgerStarten();
  }
}

const OEFFENTLICH = new Set(['/api/oeffentlicher-status', '/api/anmelden', '/api/ich', '/api/abmelden']);

const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  const pfad = urlObj.pathname;
  const angemeldet = Boolean(aktuelleSitzung(req));
  const schutz = zugriffsschutzAktiv();

  // Anmeldeseite und alles, was sie zum Anzeigen braucht, sind immer erreichbar.
  // /sprache.js gehört dazu — sonst schlägt die Sprachumschaltung auf der
  // Anmeldeseite fehl: Der Browser bekäme statt des Skripts eine Weiterleitung
  // auf /anmelden.html zurück, was als JavaScript nicht ausführbar ist.
  const immerErlaubt = pfad === '/anmelden.html' || pfad === '/style.css'
    || pfad === '/favicon.ico' || pfad === '/sprache.js';

  if (schutz && !angemeldet && !immerErlaubt && !OEFFENTLICH.has(pfad)) {
    if (pfad.startsWith('/api/')) {
      return sendJson(res, 401, { error: 'Nicht angemeldet', anmeldungNoetig: true });
    }
    // Alle übrigen Seitenaufrufe auf den Anmeldebildschirm leiten
    res.writeHead(302, { Location: '/anmelden.html' });
    return res.end();
  }

  // Bereits angemeldet? Dann nicht auf der Anmeldeseite festhalten
  if (angemeldet && pfad === '/anmelden.html') {
    res.writeHead(302, { Location: '/' });
    return res.end();
  }

  if (pfad.startsWith('/api/')) {
    try {
      await handleApi(req, res, urlObj);
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
  } else {
    serveStatic(req, res, urlObj);
  }
});

const PORT = config.port || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Folderpost läuft auf http://0.0.0.0:${PORT}`);
  runSelfCheck();
  cleanupArchives();
});
