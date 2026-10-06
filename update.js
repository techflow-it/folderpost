// Update by uploading a ZIP package.
//
// Steps: check the package → back up the current state → replace the program
// files → keep configuration and data → restart.
// If anything fails, the old state stays untouched.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const os = require('os');
const crypto = require('crypto');
const i18n = require('./i18n');

// ---------- Reading ZIP files (built-in modules only) ----------

/**
 * Reads a ZIP archive via the central directory at the end of the file.
 * Supports "stored" (0) and "deflate" (8) — no packer uses anything else
 * for our files.
 */
function zipEintraege(puffer) {
  // End of Central Directory suchen (Signatur 0x06054b50), von hinten
  let eocd = -1;
  for (let i = puffer.length - 22; i >= 0 && i > puffer.length - 66000; i -= 1) {
    if (puffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error(i18n.L('Not a valid ZIP archive (directory not found).'));

  const anzahl = puffer.readUInt16LE(eocd + 10);
  let pos = puffer.readUInt32LE(eocd + 16);
  const eintraege = [];

  for (let i = 0; i < anzahl; i += 1) {
    if (puffer.readUInt32LE(pos) !== 0x02014b50) break;
    const methode = puffer.readUInt16LE(pos + 10);
    const gepackt = puffer.readUInt32LE(pos + 20);
    const roh = puffer.readUInt32LE(pos + 24);
    const nameLaenge = puffer.readUInt16LE(pos + 28);
    const extraLaenge = puffer.readUInt16LE(pos + 30);
    const kommentarLaenge = puffer.readUInt16LE(pos + 32);
    const lokalVersatz = puffer.readUInt32LE(pos + 42);
    const name = puffer.slice(pos + 46, pos + 46 + nameLaenge).toString('utf8');

    eintraege.push({ name, methode, gepackt, roh, lokalVersatz });
    pos += 46 + nameLaenge + extraLaenge + kommentarLaenge;
  }
  return eintraege;
}

function zipInhalt(puffer, eintrag) {
  const p = eintrag.lokalVersatz;
  if (puffer.readUInt32LE(p) !== 0x04034b50) throw new Error(i18n.L('Damaged entry: {name}', { name: eintrag.name }));
  const nameLaenge = puffer.readUInt16LE(p + 26);
  const extraLaenge = puffer.readUInt16LE(p + 28);
  const start = p + 30 + nameLaenge + extraLaenge;
  const daten = puffer.slice(start, start + eintrag.gepackt);

  if (eintrag.methode === 0) return daten;
  if (eintrag.methode === 8) return zlib.inflateRawSync(daten);
  throw new Error(i18n.L('Unsupported compression in {name}', { name: eintrag.name }));
}

// ---------- Update ----------

// These files and folders are kept during the exchange
const BEHALTEN = new Set(['config.json', 'data', 'runtime', 'node_modules']);

function istGefaehrlich(name) {
  // Reject paths outside the target folder
  return name.includes('..') || path.isAbsolute(name) || name.includes('\\..\\');
}

/**
 * Installs a package. Returns a summary.
 * @param paket   ZIP as a buffer
 * @param benutzer  name for the change log
 */
function spieleUpdateEin(paket, wurzel, protokolliere, T = i18n.L) {
  const eintraege = zipEintraege(paket);
  if (eintraege.length === 0) throw new Error(T('The package contains no files.'));

  // Detect a common root folder in the archive (e.g. "folderpost/")
  const dateien = eintraege.filter((e) => !e.name.endsWith('/'));
  if (dateien.length === 0) throw new Error(T('The package contains only folders.'));

  const ersteEbene = new Set(dateien.map((e) => e.name.split('/')[0]));
  const gemeinsamerOrdner = ersteEbene.size === 1 && dateien.every((e) => e.name.includes('/'))
    ? Array.from(ersteEbene)[0] + '/'
    : '';

  const relativ = (name) => (gemeinsamerOrdner && name.startsWith(gemeinsamerOrdner)
    ? name.slice(gemeinsamerOrdner.length)
    : name);

  // Check whether this is a package of this application at all
  const namen = dateien.map((e) => relativ(e.name));
  if (!namen.includes('server.js')) {
    throw new Error(T('The package contains no server.js — probably the wrong archive.'));
  }

  const gefaehrlich = namen.find((n) => istGefaehrlich(n));
  if (gefaehrlich) throw new Error(T('Invalid path in the package: {path}', { path: gefaehrlich }));

  // Read the version from the package's package.json
  let neueVersion = null;
  const pkgEintrag = dateien.find((e) => relativ(e.name) === 'package.json');
  if (pkgEintrag) {
    try { neueVersion = JSON.parse(zipInhalt(paket, pkgEintrag).toString('utf8')).version || null; }
    catch { /* continue without a version */ }
  }

  // --- Back up the current state ---
  const zeit = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const sicherung = path.join(wurzel, 'data', 'update-sicherungen', `stand-${zeit}`);
  fs.mkdirSync(sicherung, { recursive: true });

  const jetzigeDateien = [];
  const sammle = (ordner, praefix = '') => {
    for (const e of fs.readdirSync(ordner, { withFileTypes: true })) {
      if (BEHALTEN.has(e.name) && praefix === '') continue;
      const rel = praefix + e.name;
      if (e.isDirectory()) sammle(path.join(ordner, e.name), rel + '/');
      else jetzigeDateien.push(rel);
    }
  };
  sammle(wurzel);

  jetzigeDateien.forEach((rel) => {
    try {
      const ziel = path.join(sicherung, rel);
      fs.mkdirSync(path.dirname(ziel), { recursive: true });
      fs.copyFileSync(path.join(wurzel, rel), ziel);
    } catch { /* skip this file */ }
  });

  // --- Extract the new files completely first, then take them over ---
  const zwischen = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-update-'));
  let geschrieben = 0;
  try {
    dateien.forEach((e) => {
      const rel = relativ(e.name);
      if (!rel) return;
      // Never overwrite the configuration and data of the installation
      const ersterTeil = rel.split('/')[0];
      if (BEHALTEN.has(ersterTeil)) return;
      const ziel = path.join(zwischen, rel);
      fs.mkdirSync(path.dirname(ziel), { recursive: true });
      fs.writeFileSync(ziel, zipInhalt(paket, e));
      geschrieben += 1;
    });

    if (geschrieben === 0) throw new Error(T('The package contains no replaceable files.'));

    // Take over
    const uebernehmen = (ordner, praefix = '') => {
      for (const e of fs.readdirSync(ordner, { withFileTypes: true })) {
        const rel = praefix + e.name;
        const ziel = path.join(wurzel, rel);
        if (e.isDirectory()) {
          fs.mkdirSync(ziel, { recursive: true });
          uebernehmen(path.join(ordner, e.name), rel + '/');
        } else {
          fs.mkdirSync(path.dirname(ziel), { recursive: true });
          fs.copyFileSync(path.join(ordner, e.name), ziel);
        }
      }
    };
    uebernehmen(zwischen);
  } catch (e) {
    // On errors, restore the old state
    try {
      const zurueck = (ordner, praefix = '') => {
        for (const eintrag of fs.readdirSync(ordner, { withFileTypes: true })) {
          const rel = praefix + eintrag.name;
          if (eintrag.isDirectory()) zurueck(path.join(ordner, eintrag.name), rel + '/');
          else {
            fs.mkdirSync(path.dirname(path.join(wurzel, rel)), { recursive: true });
            fs.copyFileSync(path.join(ordner, rel === eintrag.name ? eintrag.name : rel), path.join(wurzel, rel));
          }
        }
      };
      zurueck(sicherung);
    } catch { /* the backup stays in place for emergencies */ }
    throw new Error(T('Installing failed, previous version restored: {error}', { error: e.message }));
  } finally {
    try { fs.rmSync(zwischen, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  // Thin out old backups — the last five are enough
  try {
    const ordner = path.join(wurzel, 'data', 'update-sicherungen');
    const alle = fs.readdirSync(ordner).filter((n) => n.startsWith('stand-')).sort();
    alle.slice(0, Math.max(0, alle.length - 5)).forEach((n) => {
      try { fs.rmSync(path.join(ordner, n), { recursive: true, force: true }); } catch { /* ignore */ }
    });
  } catch { /* ignore */ }

  if (typeof protokolliere === 'function') protokolliere({ neueVersion, dateien: geschrieben, sicherung });

  return {
    ok: true,
    neueVersion,
    ersetzteDateien: geschrieben,
    sicherung: path.basename(sicherung),
    hinweis: T('The application will restart shortly. Configuration, logs and users are kept.'),
  };
}

module.exports = { spieleUpdateEin, zipEintraege, zipInhalt };
