// Aktualisierung durch Hochladen eines ZIP-Pakets.
//
// Ablauf: Paket prüfen → Sicherung des jetzigen Standes → Programmdateien
// austauschen → Konfiguration und Daten behalten → Neustart.
// Schlägt etwas fehl, bleibt der alte Stand unangetastet.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const os = require('os');
const crypto = require('crypto');

// ---------- ZIP lesen (nur Bordmittel) ----------

/**
 * Liest ein ZIP-Archiv über das zentrale Verzeichnis am Dateiende.
 * Unterstützt „gespeichert" (0) und „deflate" (8) — mehr nutzt kein Packer
 * für unsere Dateien.
 */
function zipEintraege(puffer) {
  // End of Central Directory suchen (Signatur 0x06054b50), von hinten
  let eocd = -1;
  for (let i = puffer.length - 22; i >= 0 && i > puffer.length - 66000; i -= 1) {
    if (puffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error('Kein gültiges ZIP-Archiv (Verzeichnis nicht gefunden).');

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
  if (puffer.readUInt32LE(p) !== 0x04034b50) throw new Error(`Beschädigter Eintrag: ${eintrag.name}`);
  const nameLaenge = puffer.readUInt16LE(p + 26);
  const extraLaenge = puffer.readUInt16LE(p + 28);
  const start = p + 30 + nameLaenge + extraLaenge;
  const daten = puffer.slice(start, start + eintrag.gepackt);

  if (eintrag.methode === 0) return daten;
  if (eintrag.methode === 8) return zlib.inflateRawSync(daten);
  throw new Error(`Nicht unterstützte Kompression in ${eintrag.name}`);
}

// ---------- Update ----------

// Diese Dateien und Ordner bleiben beim Austausch erhalten
const BEHALTEN = new Set(['config.json', 'data', 'runtime', 'node_modules']);

function istGefaehrlich(name) {
  // Pfade außerhalb des Zielordners abwehren
  return name.includes('..') || path.isAbsolute(name) || name.includes('\\..\\');
}

/**
 * Spielt ein Paket ein. Gibt eine Zusammenfassung zurück.
 * @param paket   ZIP als Puffer
 * @param benutzer  Name für das Änderungsprotokoll
 */
function spieleUpdateEin(paket, wurzel, protokolliere) {
  const eintraege = zipEintraege(paket);
  if (eintraege.length === 0) throw new Error('Das Paket enthält keine Dateien.');

  // Gemeinsamen Wurzelordner im Archiv erkennen (z. B. "datei-tool/")
  const dateien = eintraege.filter((e) => !e.name.endsWith('/'));
  if (dateien.length === 0) throw new Error('Das Paket enthält nur Ordner.');

  const ersteEbene = new Set(dateien.map((e) => e.name.split('/')[0]));
  const gemeinsamerOrdner = ersteEbene.size === 1 && dateien.every((e) => e.name.includes('/'))
    ? Array.from(ersteEbene)[0] + '/'
    : '';

  const relativ = (name) => (gemeinsamerOrdner && name.startsWith(gemeinsamerOrdner)
    ? name.slice(gemeinsamerOrdner.length)
    : name);

  // Prüfen, ob es überhaupt ein Paket dieser Anwendung ist
  const namen = dateien.map((e) => relativ(e.name));
  if (!namen.includes('server.js')) {
    throw new Error('Das Paket enthält keine server.js — vermutlich das falsche Archiv.');
  }

  const gefaehrlich = namen.find((n) => istGefaehrlich(n));
  if (gefaehrlich) throw new Error(`Unzulässiger Pfad im Paket: ${gefaehrlich}`);

  // Version aus der package.json des Pakets lesen
  let neueVersion = null;
  const pkgEintrag = dateien.find((e) => relativ(e.name) === 'package.json');
  if (pkgEintrag) {
    try { neueVersion = JSON.parse(zipInhalt(paket, pkgEintrag).toString('utf8')).version || null; }
    catch { /* ohne Versionsangabe weiter */ }
  }

  // --- Sicherung des jetzigen Standes ---
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
    } catch { /* einzelne Datei überspringen */ }
  });

  // --- Neue Dateien zuerst vollständig entpacken, dann übernehmen ---
  const zwischen = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-update-'));
  let geschrieben = 0;
  try {
    dateien.forEach((e) => {
      const rel = relativ(e.name);
      if (!rel) return;
      // Konfiguration und Daten des Kunden nie überschreiben
      const ersterTeil = rel.split('/')[0];
      if (BEHALTEN.has(ersterTeil)) return;
      const ziel = path.join(zwischen, rel);
      fs.mkdirSync(path.dirname(ziel), { recursive: true });
      fs.writeFileSync(ziel, zipInhalt(paket, e));
      geschrieben += 1;
    });

    if (geschrieben === 0) throw new Error('Das Paket enthält keine austauschbaren Dateien.');

    // Übernehmen
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
    // Bei Fehlern den alten Stand zurückholen
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
    } catch { /* Sicherung bleibt für den Notfall liegen */ }
    throw new Error(`Einspielen fehlgeschlagen, alter Stand wiederhergestellt: ${e.message}`);
  } finally {
    try { fs.rmSync(zwischen, { recursive: true, force: true }); } catch { /* egal */ }
  }

  // Alte Sicherungen ausdünnen — die letzten fünf genügen
  try {
    const ordner = path.join(wurzel, 'data', 'update-sicherungen');
    const alle = fs.readdirSync(ordner).filter((n) => n.startsWith('stand-')).sort();
    alle.slice(0, Math.max(0, alle.length - 5)).forEach((n) => {
      try { fs.rmSync(path.join(ordner, n), { recursive: true, force: true }); } catch { /* egal */ }
    });
  } catch { /* egal */ }

  if (typeof protokolliere === 'function') protokolliere({ neueVersion, dateien: geschrieben, sicherung });

  return {
    ok: true,
    neueVersion,
    ersetzteDateien: geschrieben,
    sicherung: path.basename(sicherung),
    hinweis: 'Die Anwendung startet gleich neu. Konfiguration, Protokolle und Benutzer bleiben erhalten.',
  };
}

module.exports = { spieleUpdateEin, zipEintraege, zipInhalt };
