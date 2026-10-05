// Verarbeitungsschritte, die zwischen "Datei gefunden" und "Senden" greifen.
// Aktuell: eingescannte PDFs mit QR-Code in eine JSON-Nachricht umwandeln.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { dekodiereJpeg } = require('./jpeg');
const { leseQr } = require('./qr');
const { seitenBilder } = require('./pdf-split');

// ---------- Werkzeug-Erkennung ----------

const IST_WINDOWS = process.platform === 'win32';
const EXE = IST_WINDOWS ? '.exe' : '';

// Durchsucht einen Ordner bis zu einer begrenzten Tiefe nach einer Datei.
// So ist es egal, wie das entpackte Archiv aufgebaut ist (bin, Library\bin,
// mingw64\bin, mit oder ohne Versionsordner).
function sucheRekursiv(wurzel, dateiname, maxTiefe = 4) {
  const gefunden = [];
  const lauf = (ordner, tiefe) => {
    if (tiefe > maxTiefe || gefunden.length > 20) return;
    let eintraege;
    try { eintraege = fs.readdirSync(ordner, { withFileTypes: true }); } catch { return; }
    // Erst Dateien im aktuellen Ordner prüfen
    eintraege.forEach((e) => {
      if (e.isFile() && e.name.toLowerCase() === dateiname.toLowerCase()) {
        gefunden.push(path.join(ordner, e.name));
      }
    });
    eintraege.forEach((e) => {
      if (e.isDirectory() && !e.name.startsWith('.')) lauf(path.join(ordner, e.name), tiefe + 1);
    });
  };
  lauf(wurzel, 0);
  return gefunden;
}

// Liest die von einer .exe benoetigten DLL-Namen aus der Datei heraus
// (einfache Zeichenkettensuche, ausreichend fuer eine Diagnose) und prueft,
// welche davon neben der .exe fehlen.
function pruefeBenoetigteDlls(exePfad) {
  const systemDlls = new Set([
    'kernel32.dll', 'user32.dll', 'gdi32.dll', 'msvcrt.dll', 'ole32.dll',
    'oleaut32.dll', 'advapi32.dll', 'shell32.dll', 'ws2_32.dll', 'shlwapi.dll',
    'comdlg32.dll', 'winmm.dll', 'crypt32.dll', 'version.dll', 'setupapi.dll',
    'avicap32.dll', 'msvfw32.dll', 'strmiids.dll',
  ]);
  let inhalt;
  try { inhalt = fs.readFileSync(exePfad).toString('latin1'); } catch { return null; }

  const namen = new Set();
  const treffer = inhalt.match(/[A-Za-z0-9_.+-]+\.dll/gi) || [];
  treffer.forEach((t) => {
    const n = t.toLowerCase();
    if (!systemDlls.has(n) && n.length < 60) namen.add(t);
  });

  const ordner = path.dirname(exePfad);
  const fehlend = [];
  const vorhanden = [];
  namen.forEach((n) => {
    const daneben = fs.existsSync(path.join(ordner, n));
    if (daneben) vorhanden.push(n); else fehlend.push(n);
  });
  return { benoetigt: Array.from(namen), vorhanden, fehlend };
}

// Liefert alle Pfade, die geprueft werden — fuer die Fehlersuche
function sammlePfadKandidaten(name, unterordner) {
  const wurzel = path.join(__dirname, 'runtime', unterordner);
  const datei = name + EXE;

  // Bevorzugte, bekannte Ablagen zuerst
  const kandidaten = [
    path.join(wurzel, 'bin', datei),
    path.join(wurzel, 'Library', 'bin', datei),
    path.join(wurzel, 'mingw64', 'bin', datei),
    path.join(wurzel, datei),
  ];

  // Danach alles, was sich im runtime-Ordner sonst noch findet
  sucheRekursiv(wurzel, datei).forEach((p) => {
    if (!kandidaten.includes(p)) kandidaten.push(p);
  });

  if (IST_WINDOWS) {
    const progDirs = [process.env['ProgramFiles'], process.env['ProgramFiles(x86)'], process.env['LOCALAPPDATA']].filter(Boolean);
    const produktOrdner = unterordner === 'zbar' ? ['ZBar', 'zbar'] : ['poppler', 'Poppler', 'poppler-windows'];
    progDirs.forEach((pd) => produktOrdner.forEach((po) => {
      kandidaten.push(path.join(pd, po, 'bin', datei));
      kandidaten.push(path.join(pd, po, 'Library', 'bin', datei));
      kandidaten.push(path.join(pd, po, 'mingw64', 'bin', datei));
      kandidaten.push(path.join(pd, po, datei));
    }));
  }
  return kandidaten;
}

function findeWerkzeug(name, unterordner) {
  const treffer = sammlePfadKandidaten(name, unterordner).find((p) => {
    try { return fs.existsSync(p); } catch { return false; }
  });
  return treffer || name; // sonst aus dem PATH
}

// Startet das Programm und meldet ausfuehrlich zurueck, warum es ggf. scheitert
function pruefeWerkzeugDetail(name, unterordner, args, cb) {
  const kandidaten = sammlePfadKandidaten(name, unterordner);
  const gefunden = kandidaten.filter((p) => { try { return fs.existsSync(p); } catch { return false; } });
  const pfad = gefunden[0] || name;
  const ausPfadVariable = gefunden.length === 0;

  execFile(pfad, args, { timeout: 10000 }, (err, stdout, stderr) => {
    // Exit-Code 1 ist bei --version/-v mancher Werkzeuge normal
    const ok = !err || err.code === 1;
    let grund = null;
    if (!ok) {
      if (err.code === 'ENOENT') {
        grund = ausPfadVariable
          ? `Programm weder im runtime-Ordner noch über die PATH-Variable gefunden.`
          : `Datei existiert unter "${pfad}", lässt sich aber nicht starten (ENOENT).`;
      } else if (String(err.message).includes('0xc0000135') || String(err.message).includes('3221225781')) {
        grund = `Datei gefunden, aber Start fehlgeschlagen — es fehlen zugehörige DLL-Dateien im selben Ordner. Bitte den kompletten Inhalt des bin-Ordners kopieren, nicht nur die .exe.`;
      } else {
        grund = `Start fehlgeschlagen: ${err.message.split('\n')[0]}`;
      }
    }
    const dlls = (!ok && path.isAbsolute(pfad)) ? pruefeBenoetigteDlls(pfad) : null;
    if (dlls && dlls.fehlend.length && !grund) {
      grund = `Programm gefunden, aber nicht startbar. Fehlende Bibliotheken im selben Ordner: ${dlls.fehlend.slice(0, 8).join(', ')}`;
    } else if (dlls && dlls.fehlend.length && grund) {
      grund += ` Fehlende Bibliotheken: ${dlls.fehlend.slice(0, 8).join(', ')}`;
    }
    cb({
      name,
      ok,
      pfad,
      dlls,
      quelle: ausPfadVariable ? 'PATH-Variable' : 'Datei gefunden',
      gefundeneDateien: gefunden,
      geprueftePfade: kandidaten,
      exitCode: err ? (err.code !== undefined ? String(err.code) : '?') : '0',
      ausgabe: ((stdout || '') + (stderr || '')).trim().split('\n').slice(0, 3).join(' | ').slice(0, 300),
      grund,
    });
  });
}

// ---------- Bild direkt aus dem PDF ziehen (ohne Poppler) ----------

/**
 * Eingescannte PDFs enthalten die Seite fast immer als fertiges JPEG.
 * Das laesst sich ohne Renderer herausloesen — hilft, wenn Poppler auf
 * dem Zielrechner nicht laeuft. Liefert den Pfad einer .jpg-Datei.
 */
function extrahiereAlleBilder(pdfPfad, zielBasis, maxAnzahl = 12) {
  let daten;
  try { daten = fs.readFileSync(pdfPfad); } catch { return []; }

  const marker = Buffer.from('/Subtype', 'latin1');
  const gefunden = [];
  let pos = 0;
  let durchlauf = 0;

  while (pos < daten.length && gefunden.length < maxAnzahl && durchlauf < 200) {
    const idx = daten.indexOf(marker, pos);
    if (idx === -1) break;
    pos = idx + 8;
    durchlauf += 1;

    const kopf = daten.slice(Math.max(0, idx - 600), Math.min(daten.length, idx + 600)).toString('latin1');
    if (!/\/Image/.test(kopf)) continue;
    if (!/\/DCTDecode/.test(kopf)) continue; // nur JPEG; anderes braeuchte einen Decoder

    const streamIdx = daten.indexOf(Buffer.from('stream', 'latin1'), idx);
    if (streamIdx === -1) continue;
    let start = streamIdx + 6;
    if (daten[start] === 0x0D) start += 1;
    if (daten[start] === 0x0A) start += 1;

    // JPEG beginnt mit FF D8 und endet mit FF D9
    if (!(daten[start] === 0xFF && daten[start + 1] === 0xD8)) continue;
    const endIdx = daten.indexOf(Buffer.from([0xFF, 0xD9]), start);
    if (endIdx === -1) continue;

    const bild = daten.slice(start, endIdx + 2);
    if (bild.length < 1500) continue; // sehr kleine Grafiken (Logos) ueberspringen

    const ziel = `${zielBasis}-b${gefunden.length + 1}.jpg`;
    try {
      fs.writeFileSync(ziel, bild);
      gefunden.push(ziel);
    } catch { /* weiter */ }
  }
  return gefunden;
}

function ascii85Dekodieren(puffer) {
  let text = puffer.toString('latin1').replace(/\s/g, '');
  if (text.startsWith('<~')) text = text.slice(2);
  const ende = text.indexOf('~>');
  if (ende !== -1) text = text.slice(0, ende);
  const aus = [];
  let gruppe = [];
  for (const zeichen of text) {
    if (zeichen === 'z' && gruppe.length === 0) { aus.push(0, 0, 0, 0); continue; }
    const wert = zeichen.charCodeAt(0) - 33;
    if (wert < 0 || wert > 84) return null;
    gruppe.push(wert);
    if (gruppe.length === 5) {
      let zahl = 0;
      for (const g of gruppe) zahl = zahl * 85 + g;
      aus.push((zahl >>> 24) & 255, (zahl >>> 16) & 255, (zahl >>> 8) & 255, zahl & 255);
      gruppe = [];
    }
  }
  if (gruppe.length > 1) {
    const fehlend = 5 - gruppe.length;
    for (let i = 0; i < fehlend; i += 1) gruppe.push(84);
    let zahl = 0;
    for (const g of gruppe) zahl = zahl * 85 + g;
    const bytes = [(zahl >>> 24) & 255, (zahl >>> 16) & 255, (zahl >>> 8) & 255, zahl & 255];
    for (let i = 0; i < 4 - fehlend; i += 1) aus.push(bytes[i]);
  }
  return Buffer.from(aus);
}

// Prueft, ob das PDF eine Textebene besitzt (durchsuchbar) oder ein reiner Scan ist.
// Entscheidend fuer die Frage, ob sich Felder aus dem Inhalt auslesen lassen.
function analysiereText(pdfPfad) {
  let daten;
  try { daten = fs.readFileSync(pdfPfad); } catch { return null; }
  const zlib = require('zlib');

  const roh = daten.toString('latin1');
  const schriften = (roh.match(/\/Type\s*\/Font/g) || []).length;

  // Inhaltsstroeme entpacken und nach Textoperatoren suchen
  let textZeichen = 0;
  let textBloecke = 0;
  let pos = 0;
  let untersucht = 0;
  while (untersucht < 30) {
    const si = roh.indexOf('stream', pos);
    if (si === -1) break;
    const ei = roh.indexOf('endstream', si);
    if (ei === -1) break;
    let start = si + 6;
    if (roh.charCodeAt(start) === 13) start += 1;
    if (roh.charCodeAt(start) === 10) start += 1;
    const kopf = roh.slice(Math.max(0, si - 400), si);
    const roher = daten.slice(start, ei);
    pos = ei + 9;
    untersucht += 1;
    if (/\/Subtype\s*\/Image/.test(kopf)) continue;

    // Filterkette der Reihe nach anwenden, z. B. [/ASCII85Decode /FlateDecode]
    const filterTeil = (kopf.match(/\/Filter\s*(\[[^\]]*\]|\/\w+)/) || [])[1] || '';
    const filter = (filterTeil.match(/\/\w+/g) || []).map((f) => f.slice(1));
    let puffer = roher;
    let unbekannt = false;
    for (const f of filter) {
      if (f === 'FlateDecode') {
        try { puffer = zlib.inflateSync(puffer); } catch { unbekannt = true; break; }
      } else if (f === 'ASCII85Decode') {
        puffer = ascii85Dekodieren(puffer);
        if (!puffer) { unbekannt = true; break; }
      } else if (f === 'ASCIIHexDecode') {
        const hex = puffer.toString('latin1').replace(/[^0-9A-Fa-f]/g, '');
        puffer = Buffer.from(hex, 'hex');
      } else {
        unbekannt = true; break; // Bildkompression o. Ä.
      }
    }
    if (unbekannt) continue;
    const inhalt = puffer.toString('latin1');
    const bloecke = inhalt.match(/BT[\s\S]*?ET/g) || [];
    textBloecke += bloecke.length;
    bloecke.forEach((b) => {
      (b.match(/\((?:\\.|[^\\()])*\)/g) || []).forEach((t) => { textZeichen += Math.max(0, t.length - 2); });
      (b.match(/<[0-9A-Fa-f\s]+>/g) || []).forEach((t) => { textZeichen += Math.floor(t.length / 4); });
    });
  }

  return {
    schriften,
    textBloecke,
    textZeichen,
    hatTextebene: textZeichen >= 20,
  };
}

// Zaehlt, welche Bildarten im PDF stecken — fuer verstaendliche Fehlermeldungen
function analysiereBilder(pdfPfad) {
  let daten;
  try { daten = fs.readFileSync(pdfPfad); } catch { return null; }
  const text = daten.toString('latin1');
  const zaehle = (muster) => (text.match(new RegExp(muster, 'g')) || []).length;
  return {
    bilder: zaehle('/Subtype\\s*/Image'),
    jpeg: zaehle('/DCTDecode'),
    ccitt: zaehle('/CCITTFaxDecode'),
    jbig2: zaehle('/JBIG2Decode'),
    flate: zaehle('/FlateDecode'),
    jpx: zaehle('/JPXDecode'),
  };
}

// Probiert mehrere Bilder nacheinander, bis ein QR-Code gefunden wird
function leseQrAusBildern(bilder, eigenerBefehl, cb) {
  let letzteDiagnose = null;
  const naechstes = (i) => {
    if (i >= bilder.length) {
      if (bilder.length === 0) return cb(null, 'Kein auswertbares Bild im PDF gefunden', null, letzteDiagnose);
      // Startproblem des Lesers hat Vorrang vor "nichts gefunden"
      if (letzteDiagnose && letzteDiagnose.fehlt) {
        return cb(null, letzteDiagnose.hinweisText || 'QR-Leser konnte nicht gestartet werden', null, letzteDiagnose);
      }
      return cb(null, `In ${bilder.length} Bild(ern) kein QR-Code erkannt`, null, letzteDiagnose);
    }
    leseQrCode(bilder[i], eigenerBefehl, (wert, hinweis, diagnose) => {
      if (diagnose) { letzteDiagnose = diagnose; letzteDiagnose.hinweisText = hinweis; }
      if (wert) return cb(wert, null, bilder[i], diagnose);
      // Startet der Leser gar nicht, bringen weitere Bilder nichts
      if (diagnose && diagnose.fehlt) return cb(null, hinweis, null, diagnose);
      naechstes(i + 1);
    });
  };
  naechstes(0);
}

function renderSeiteExtern(seite, dpi, pdfPfad, tmpBasis, cb) {
  const versuche = [
    // PGM und JPEG kann der eingebaute Leser direkt auswerten
    { name: 'pdftoppm', args: ['-gray', '-r', String(dpi), '-f', String(seite), '-l', String(seite), pdfPfad, tmpBasis] },
    { name: 'pdftocairo', args: ['-jpeg', '-gray', '-r', String(dpi), '-f', String(seite), '-l', String(seite), pdfPfad, tmpBasis] },
  ];
  const naechster = (i, bisher) => {
    if (i >= versuche.length) return cb(bisher);
    const v = versuche[i];
    execFile(findeWerkzeug(v.name, 'poppler'), v.args, { timeout: 60000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return cb(null, v.name);
      const details = (stderr || '').trim() || (stdout || '').trim();
      const text = details ? `${v.name}: ${details.split('\n').slice(0, 2).join(' | ')}` : `${v.name}: ${deuteExitCodeExtern(err.code)}`;
      naechster(i + 1, bisher ? `${bisher} — ${text}` : text);
    });
  };
  naechster(0, null);
}

function deuteExitCodeExtern(code) {
  const c = Number(code) >>> 0;
  if (c === 0xC0000005 || code === 3221225477) return 'Zugriffsverletzung (0xC0000005) — Programm stürzt ab, meist unvollständiges oder gemischtes Poppler-Paket.';
  if (c === 0xC0000135 || code === 3221225781) return 'Fehlende DLL (0xC0000135) — bitte kompletten bin-Ordner kopieren.';
  if (c === 0xC000007B || code === 3221225595) return 'Architektur-Konflikt (0xC000007B) — 32/64-Bit gemischt.';
  return `Exit-Code ${code}`;
}

// Prueft, ob die Poppler-Ablage stimmt. Entscheidend ist, dass der
// Datenordner share\poppler die richtige Lage zur .exe behaelt --
// im Archiv liegt er NEBEN "Library", nicht darin.
function pruefePopplerAblage() {
  const exe = findeWerkzeug('pdftoppm', 'poppler');
  if (!path.isAbsolute(exe)) return { relevant: false, hinweis: 'pdftoppm wird über die PATH-Variable genutzt.' };

  const binDir = path.dirname(exe);
  const dllAnzahl = (() => {
    try { return fs.readdirSync(binDir).filter((f) => f.toLowerCase().endsWith('.dll')).length; }
    catch { return 0; }
  })();

  // share\poppler kann eine oder zwei Ebenen ueber bin liegen
  const moeglicheDatenPfade = [
    path.join(binDir, '..', 'share', 'poppler'),
    path.join(binDir, '..', '..', 'share', 'poppler'),
    path.join(binDir, '..', '..', '..', 'share', 'poppler'),
  ];
  const datenPfad = moeglicheDatenPfade.find((p) => { try { return fs.existsSync(p); } catch { return false; } });

  const probleme = [];
  if (dllAnzahl === 0) {
    probleme.push('Im Ordner der pdftoppm.exe liegt keine einzige DLL — es wurde offenbar nur die .exe kopiert.');
  }
  if (!datenPfad) {
    probleme.push('Der Datenordner "share\\poppler" wurde nicht gefunden. Im Poppler-Archiv liegt er NEBEN dem Ordner "Library" — beide zusammen kopieren, sonst stürzt pdftoppm ab (0xC0000005).');
  }

  return {
    relevant: true,
    exe,
    binDir,
    dllAnzahl,
    datenPfad: datenPfad ? path.resolve(datenPfad) : null,
    probleme,
  };
}

// Erzeugt ein winziges gueltiges PDF, um das Rendern wirklich auszuprobieren
function schreibeTestPdf() {
  const inhalt = [
    '%PDF-1.4',
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj',
    'trailer<</Root 1 0 R>>',
    '%%EOF',
  ].join('\n');
  const pfad = path.join(os.tmpdir(), 'fp-test-' + crypto.randomBytes(4).toString('hex') + '.pdf');
  fs.writeFileSync(pfad, inhalt, 'latin1');
  return pfad;
}

// Probiert einen echten Rendervorgang — erkennt Abstuerze, die ein blosses "-v" nicht zeigt
function pruefeRendern(cb) {
  const pdf = schreibeTestPdf();
  const ziel = path.join(os.tmpdir(), 'fp-test-' + crypto.randomBytes(4).toString('hex'));
  renderSeiteExtern(1, 72, pdf, ziel, (fehler, verwendet) => {
    try { fs.unlinkSync(pdf); } catch { /* egal */ }
    try {
      const dir = path.dirname(ziel);
      const basis = path.basename(ziel);
      fs.readdirSync(dir).filter((f) => f.startsWith(basis)).forEach((f) => {
        try { fs.unlinkSync(path.join(dir, f)); } catch { /* egal */ }
      });
    } catch { /* egal */ }
    cb({ ok: !fehler, verwendet: verwendet || null, fehler: fehler || null });
  });
}

// Prueft, ob die vorhandene zbarimg-Version QR-Codes ueberhaupt beherrscht.
// Alte Windows-Builds (0.10) koennen nur EAN/UPC, Code 128, Code 39 und I2/5.
function pruefeQrFaehigkeit(cb) {
  const zbar = findeWerkzeug('zbarimg', 'zbar');
  // Ein absichtlich leeres Bild erzeugen: zbarimg listet dann die Symbologien auf
  const leer = path.join(os.tmpdir(), 'fp-qrtest-' + crypto.randomBytes(4).toString('hex') + '.pgm');
  try {
    // Kleines graues PGM ohne Inhalt — von zbarimg ohne Fremdbibliothek lesbar
    const breite = 64; const hoehe = 64;
    const kopf = Buffer.from(`P5\n${breite} ${hoehe}\n255\n`, 'latin1');
    fs.writeFileSync(leer, Buffer.concat([kopf, Buffer.alloc(breite * hoehe, 0xFF)]));
  } catch { return cb({ pruefbar: false }); }

  execFile(zbar, [leer], { timeout: 20000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
    try { fs.unlinkSync(leer); } catch { /* egal */ }
    const text = `${stdout || ''} ${stderr || ''}`;
    if (err && err.code === 'ENOENT') return cb({ pruefbar: false, fehlt: true });
    if (!/supported symbologies/i.test(text)) return cb({ pruefbar: false, ausgabe: text.slice(0, 200) });
    const kannQr = /QR/i.test(text);
    const liste = (text.match(/currently supported symbologies are:([\s\S]{0,200})/i) || [])[1] || '';
    return cb({ pruefbar: true, kannQr, symbologien: liste.replace(/\s+/g, ' ').trim().slice(0, 180) });
  });
}

// Meldet zurueck, welche Werkzeuge fuer die PDF-Verarbeitung bereitstehen
function pruefeVerarbeitungsWerkzeuge(cb) {
  pruefeWerkzeugDetail('pdftoppm', 'poppler', ['-v'], (p) => {
    pruefeWerkzeugDetail('pdftocairo', 'poppler', ['-v'], (pc) => {
      pruefeWerkzeugDetail('zbarimg', 'zbar', ['--version'], (z) => {
        pruefeRendern((rendertest) => {
          pruefeQrFaehigkeit((qrFaehigkeit) => {
            cb({ pdftoppm: p, pdftocairo: pc, zbarimg: z, rendertest, ablage: pruefePopplerAblage(), qrFaehigkeit });
          });
        });
      });
    });
  });
}

// ---------- QR-Code auslesen ----------

// Liest den QR-Code aus einer Bilddatei. Standardweg ist zbarimg; alternativ
// laesst sich in den Einstellungen ein eigener Befehl hinterlegen
// (Platzhalter {datei} wird durch den Bildpfad ersetzt).
/**
 * Liest den QR-Code aus einer Bilddatei.
 * Probiert mehrere Aufrufvarianten, weil sich zbarimg je nach Version
 * unterschiedlich verhaelt (aeltere Ausgaben kennen --raw nicht und
 * schreiben stattdessen "QR-Code:WERT").
 */
// Entfernt das Symbologie-Praefix, das zbarimg ohne --raw ausgibt ("QR-Code:1234")
function ohnePraefix(text) {
  const zeile = String(text || '').split('\n')[0].trim();
  const m = zeile.match(/^([A-Za-z0-9-]+(?:\/[A-Za-z0-9-]+)?):(.*)$/);
  if (m && /^(QR-Code|EAN-13|EAN-8|UPC-A|UPC-E|ISBN-13|ISBN-10|CODE-128|CODE-93|CODE-39|I2\/5|DataBar|Codabar|PDF417)$/i.test(m[1])) {
    return m[2].trim();
  }
  return zeile;
}

// Eingebauter Leser: braucht keine Fremdprogramme. Funktioniert mit JPEG.
function lesePgm(daten) {
  // Binaeres PGM (P5): Kopf besteht aus Kennung, Breite, Hoehe, Maximalwert
  if (!(daten[0] === 0x50 && daten[1] === 0x35)) return null;
  let pos = 2;
  const zahlen = [];
  while (zahlen.length < 3 && pos < daten.length) {
    while (pos < daten.length && /\s/.test(String.fromCharCode(daten[pos]))) pos += 1;
    if (daten[pos] === 0x23) { // Kommentarzeile
      while (pos < daten.length && daten[pos] !== 0x0A) pos += 1;
      continue;
    }
    let zahl = '';
    while (pos < daten.length && /[0-9]/.test(String.fromCharCode(daten[pos]))) {
      zahl += String.fromCharCode(daten[pos]); pos += 1;
    }
    if (zahl === '') return null;
    zahlen.push(Number(zahl));
  }
  pos += 1; // ein Trennzeichen nach dem Maximalwert
  const [breite, hoehe, max] = zahlen;
  if (!breite || !hoehe || max > 255) return null;
  const grau = daten.slice(pos, pos + breite * hoehe);
  if (grau.length < breite * hoehe) return null;
  return { breite, hoehe, grau };
}

function leseQrIntern(bildPfad) {
  try {
    const daten = fs.readFileSync(bildPfad);
    let bild = null;
    if (/\.jpe?g$/i.test(bildPfad)) {
      bild = dekodiereJpeg(daten);
      if (bild.fehler) return null;
    } else if (/\.pgm$/i.test(bildPfad)) {
      bild = lesePgm(daten);
    }
    if (!bild) return null;
    return leseQr(bild.grau, bild.breite, bild.hoehe) || null;
  } catch {
    return null;
  }
}

function leseQrCode(bildPfad, eigenerBefehl, cb) {
  // Zuerst der eingebaute Leser — kein externes Programm nötig
  if (!eigenerBefehl || !eigenerBefehl.trim()) {
    const intern = leseQrIntern(bildPfad);
    if (intern) return cb(intern, null, { quelle: 'eingebauter Leser' });
  }
  if (eigenerBefehl && eigenerBefehl.trim()) {
    const teile = eigenerBefehl.trim().split(/\s+/).map((t) => t.replace('{datei}', bildPfad));
    return execFile(teile[0], teile.slice(1), { timeout: 30000, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
      const wert = ohnePraefix(stdout);
      if (err && !wert) return cb(null, `Eigener QR-Befehl fehlgeschlagen: ${(stderr || err.message).split('\n')[0]}`, { befehl: teile.join(' ') });
      cb(wert || null, wert ? null : 'Eigener QR-Befehl lieferte keinen Wert', { befehl: teile.join(' ') });
    });
  }

  const zbar = findeWerkzeug('zbarimg', 'zbar');
  const varianten = [
    { args: ['--quiet', '--raw', bildPfad], name: '--quiet --raw' },
    { args: ['-q', bildPfad], name: '-q (mit Typ-Präfix)' },
    { args: ['--quiet', '--raw', '-Sdisable', '-Sqrcode.enable', bildPfad], name: 'nur QR aktiviert' },
    { args: [bildPfad], name: 'ohne Optionen' },
  ];
  const protokoll = [];
  let nichtStartbar = 0;

  const versuche = (i) => {
    if (i >= varianten.length) {
      if (nichtStartbar === varianten.length) {
        return cb(null, `Optionaler externer Leser zbarimg nicht verfügbar (gesucht als "${zbar}"). Die Erkennung erfolgt normalerweise über den eingebauten Leser.`, { zbar, protokoll, fehlt: true });
      }

      // zbarimg listet bei Misserfolg die unterstuetzten Symbologien auf.
      // Fehlt QR darin, wurde diese Version ohne QR-Unterstuetzung gebaut
      // (betrifft u. a. den alten Windows-Installer 0.10).
      const alleMeldungen = protokoll.map((p) => `${p.fehler} ${p.ausgabe}`).join(' ');
      if (/supported symbologies/i.test(alleMeldungen) && !/QR/i.test(alleMeldungen)) {
        return cb(null,
          'Diese ZBar-Version kann keine QR-Codes lesen — sie wurde ohne QR-Unterstützung gebaut '
          + '(die Meldung listet nur EAN/UPC, Code 128, Code 39 und Interleaved 2 of 5). '
          + 'Abhilfe: neuere ZBar-Version verwenden, z. B. aus den GitHub-Releases 0.23.90 bis 0.23.92. '
          + 'Der alte SourceForge-Installer (0.10) ist dafür ungeeignet.',
          { zbar, protokoll, ohneQrUnterstuetzung: true });
      }

      const meldungen = Array.from(new Set(protokoll.map((p) => p.fehler).filter(Boolean)));
      const codes = Array.from(new Set(protokoll.map((p) => p.exitCode)));
      const zusatz = meldungen.length
        ? ` zbarimg meldet: ${meldungen.slice(0, 2).join(' | ').slice(0, 300)}`
        : ` zbarimg lief durch (Exit ${codes.join('/')}), gab aber keinen Code zurück.`;
      return cb(null, `Kein QR-Code erkannt.${zusatz}`, { zbar, protokoll });
    }
    const v = varianten[i];
    execFile(zbar, v.args, { timeout: 30000, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
      const rohAusgabe = (stdout || '').trim();
      const fehlerText = (stderr || '').trim();
      const startProblem = err && (err.code === 'ENOENT' || err.code === 'EACCES' || err.code === 'UNKNOWN');
      if (startProblem) nichtStartbar += 1;

      const wert = ohnePraefix(rohAusgabe);

      protokoll.push({
        variante: v.name,
        exitCode: err ? String(err.code) : '0',
        ausgabe: rohAusgabe.slice(0, 200),
        fehler: fehlerText.slice(0, 200),
      });

      if (wert) return cb(wert, null, { zbar, variante: v.name, protokoll });
      versuche(i + 1);
    });
  };
  versuche(0);
}

// ---------- Platzhalter in der Metadaten-Vorlage ersetzen ----------

const STANDARD_VORLAGE = JSON.stringify({
  name: '{dateinameOhneEndung}',
  order_id: '{qrWert}',
  date: '{unixzeit}',
}, null, 2);

/**
 * Ersetzt Platzhalter in der Vorlage. Verfuegbar sind u. a.
 * {probennummer} {qrGefunden} {dateiname} {dateinameOhneEndung}
 * {unixzeit} {isozeit} {groesseBytes} {jobName} {auftragsnummer}
 * sowie {gruppe:name} aus dem Dateinamen-Ausdruck.
 */
function fuelleVorlage(vorlage, werte) {
  let text = String(vorlage || STANDARD_VORLAGE);

  // Zahlenfelder ohne Anfuehrungszeichen ausgeben, wenn die Vorlage sie
  // in Anfuehrungszeichen setzt, der Wert aber eine reine Zahl ist.
  Object.entries(werte).forEach(([schluessel, wert]) => {
    const platzhalter = new RegExp(`"\\{${schluessel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\}"|\\{${schluessel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\}`, 'g');
    text = text.replace(platzhalter, (treffer) => {
      const inAnfuehrung = treffer.startsWith('"');
      if (wert === null || wert === undefined) return inAnfuehrung ? 'null' : 'null';
      if (typeof wert === 'boolean') return String(wert);
      // Nur echte JSON-Zahlen ohne führende Nullen unquoted ausgeben.
      // "001" muss Text bleiben, sonst entsteht ungültiges JSON.
      const istZahl = typeof wert === 'number' || /^-?(0|[1-9]\d*)(\.\d+)?$/.test(String(wert));
      if (inAnfuehrung && istZahl) return String(wert);      // "123" -> 123
      if (inAnfuehrung) return JSON.stringify(String(wert)).slice(0);
      return istZahl ? String(wert) : JSON.stringify(String(wert));
    });
  });

  // Nicht belegte Platzhalter neutralisieren, damit gueltiges JSON entsteht
  text = text.replace(/"\{[^}]+\}"/g, 'null').replace(/\{[a-zA-Z0-9_:.-]+\}/g, 'null');
  return text;
}

// Zieht benannte Gruppen aus dem Dateinamen, z. B. ^(?<auftrag>\d+)_
function gruppenAusDateiname(dateiname, ausdruck) {
  if (!ausdruck || !ausdruck.trim()) return {};
  try {
    const treffer = new RegExp(ausdruck).exec(dateiname);
    if (!treffer || !treffer.groups) return {};
    const raus = {};
    Object.entries(treffer.groups).forEach(([k, v]) => { raus['gruppe:' + k] = v === undefined ? null : v; });
    return raus;
  } catch {
    return {}; // ungueltiger Ausdruck soll die Uebertragung nicht stoppen
  }
}

// ---------- PDF → JSON ----------

/**
 * Wandelt ein eingescanntes PDF in eine JSON-Nachricht um.
 * Ergebnis ist der Pfad einer temporaeren .json-Datei, die anschliessend
 * per curl gesendet wird. Der Aufrufer muss sie danach aufraeumen.
 */
function pdfZuJson(job, pdfPfad, einstellungen, cb) {
  const tmpBasis = path.join(os.tmpdir(), 'fp-' + crypto.randomBytes(6).toString('hex'));
  const seite = Number(job.qrSeite) > 0 ? Number(job.qrSeite) : 1;
  const dpi = Number(job.qrDpi) > 0 ? Number(job.qrDpi) : 200;
  const aufraeumen = [];

  const fertig = (fehler, jsonPfad, info) => {
    aufraeumen.forEach((f) => { try { fs.unlinkSync(f); } catch { /* egal */ } });
    // Auch angefangene Renderausgaben entfernen, die nicht in der Liste stehen
    try {
      const dir = path.dirname(tmpBasis);
      const praefix = path.basename(tmpBasis);
      fs.readdirSync(dir)
        .filter((f) => f.startsWith(praefix) && !f.endsWith('.json'))
        .forEach((f) => { try { fs.unlinkSync(path.join(dir, f)); } catch { /* egal */ } });
    } catch { /* egal */ }
    cb(fehler, jsonPfad, info);
  };

  // Vorprüfung: Ist das PDF überhaupt vollständig geschrieben?
  // Scanner und Kopierer legen die Datei oft an und füllen sie erst danach.
  let kopf = Buffer.alloc(0);
  let schwanz = Buffer.alloc(0);
  try {
    const fd = fs.openSync(pdfPfad, 'r');
    const groesse = fs.fstatSync(fd).size;
    kopf = Buffer.alloc(Math.min(5, groesse));
    fs.readSync(fd, kopf, 0, kopf.length, 0);
    const schwanzLaenge = Math.min(2048, groesse);
    schwanz = Buffer.alloc(schwanzLaenge);
    fs.readSync(fd, schwanz, 0, schwanzLaenge, Math.max(0, groesse - schwanzLaenge));
    fs.closeSync(fd);
    if (groesse === 0) return fertig('Datei ist noch leer — vermutlich wird sie gerade erst geschrieben. Ruhezeit im Job erhöhen.', null, null);
  } catch (e) {
    return fertig(`Datei nicht lesbar: ${e.message}`, null, null);
  }
  if (kopf.toString('latin1') !== '%PDF-') {
    return fertig('Datei beginnt nicht mit %PDF — keine gültige PDF-Datei oder noch unvollständig.', null, null);
  }
  if (!schwanz.toString('latin1').includes('%%EOF')) {
    return fertig('PDF ist unvollständig (Endmarkierung %%EOF fehlt) — die Datei wird vermutlich gerade noch geschrieben. Ruhezeit im Job erhöhen (Feld "Mindestalter der Datei").', null, null);
  }

// Modulweite Renderfunktion (auch fuer den Selbsttest nutzbar)
// Uebersetzt typische Windows-Abbruchcodes in verstaendlichen Klartext
function deuteExitCode(code) {
  const c = Number(code) >>> 0;
  if (c === 0xC0000005 || code === 3221225477) {
    return 'Zugriffsverletzung (0xC0000005) — das Programm startet, stürzt dann ab. Meist ein unvollständiges oder gemischtes Poppler-Paket: bitte den kompletten bin-Ordner einer einzigen Poppler-Version kopieren, keine Dateien aus verschiedenen Versionen mischen.';
  }
  if (c === 0xC0000135 || code === 3221225781) {
    return 'Fehlende DLL (0xC0000135) — es fehlen Bibliotheken im selben Ordner. Bitte den kompletten Inhalt des bin-Ordners kopieren, nicht nur die .exe.';
  }
  if (c === 0xC000007B || code === 3221225595) {
    return 'Architektur-Konflikt (0xC000007B) — 32-Bit- und 64-Bit-Dateien gemischt. Bitte eine durchgängige 64-Bit-Version verwenden.';
  }
  return `Exit-Code ${code}`;
}

// Rendert die Seite; faellt bei Absturz automatisch auf pdftocairo zurueck
function renderSeite(seite, dpi, pdfPfad, tmpBasis, cb) {
  const versuche = [
    { name: 'pdftoppm', args: ['-gray', '-r', String(dpi), '-f', String(seite), '-l', String(seite), pdfPfad, tmpBasis] },
    { name: 'pdftocairo', args: ['-jpeg', '-gray', '-r', String(dpi), '-f', String(seite), '-l', String(seite), pdfPfad, tmpBasis] },
  ];

  const naechster = (i, bisher) => {
    if (i >= versuche.length) return cb(bisher);
    const v = versuche[i];
    const exe = findeWerkzeug(v.name, 'poppler');
    execFile(exe, v.args, { timeout: 90000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return cb(null, v.name);
      const details = (stderr || '').trim() || (stdout || '').trim();
      const text = details
        ? `${v.name}: ${details.split('\n').slice(0, 2).join(' | ')}`
        : `${v.name}: ${deuteExitCode(err.code)}`;
      // Bei Absturz oder fehlendem Programm den naechsten Weg probieren
      naechster(i + 1, bisher ? `${bisher} — ${text}` : text);
    });
  };
  naechster(0, null);
}

  renderSeite(seite, dpi, pdfPfad, tmpBasis, (renderFehler, verwendet) => {
      // Scheitern beide Renderer, die eingebetteten Scan-Bilder direkt aus
      // dem PDF ziehen und der Reihe nach nach einem QR-Code absuchen.
      if (renderFehler) {
        // Alle Seitenbilder holen — JPEG wie auch Schwarzweiß-Scans (CCITT)
        const seiten = seitenBilder(pdfPfad);
        const bilder = [];
        seiten.slice(0, 12).forEach((seite, i) => {
          try {
            if (seite.art === 'jpeg') {
              const pfad = `${tmpBasis}-direkt-${i}.jpg`;
              fs.writeFileSync(pfad, seite.jpeg);
              bilder.push(pfad);
            } else {
              // Graustufen als PGM ablegen — der eingebaute Leser kann das direkt
              const pfad = `${tmpBasis}-direkt-${i}.pgm`;
              fs.writeFileSync(pfad, Buffer.concat([
                Buffer.from(`P5\n${seite.breite} ${seite.hoehe}\n255\n`, 'latin1'),
                Buffer.from(seite.grauDaten),
              ]));
              bilder.push(pfad);
            }
          } catch { /* Seite überspringen */ }
        });
        bilder.forEach((b) => aufraeumen.push(b));
        if (bilder.length === 0) {
          const arten = analysiereBilder(pdfPfad);
          const artText = arten
            ? ` Im PDF gefunden: ${arten.bilder} Bild(er) — JPEG: ${arten.jpeg}, CCITT: ${arten.ccitt}, JBIG2: ${arten.jbig2}, JPEG2000: ${arten.jpx}. Die Direktauslesung beherrscht nur JPEG; bei CCITT/JBIG2 wird ein funktionierender Renderer benötigt.`
            : '';
          return fertig(`PDF konnte nicht gerendert werden. ${renderFehler} — Auch das direkte Auslesen war nicht möglich.${artText}`, null, null);
        }
        return leseQrAusBildern(bilder, einstellungen && einstellungen.qrBefehl, (wert, hinweis, benutztesBild, diagnose) => {
          verarbeiteQrErgebnis(
            benutztesBild || bilder[0],
            `Direktauslesung aus ${bilder.length} eingebetteten Bild(ern), Poppler übersprungen`,
            wert,
            hinweis,
            diagnose,
          );
        });
      }

      // pdftoppm haengt die Seitennummer an, Stellenzahl variiert
      const dir = path.dirname(tmpBasis);
      const praefix = path.basename(tmpBasis);
      let bild = null;
      try {
        const treffer = fs.readdirSync(dir).filter((f) => f.startsWith(praefix) && (f.endsWith('.pgm') || f.endsWith('.jpg') || f.endsWith('.png')));
        if (treffer.length > 0) bild = path.join(dir, treffer[0]);
      } catch { /* faellt unten auf Fehler */ }
      if (!bild) return fertig('Gerendertes Seitenbild wurde nicht gefunden', null, null);
      aufraeumen.push(bild);
      weiterMitBild(bild, verwendet);
    });

    function weiterMitBild(bild, quelle) {
      leseQrCode(bild, einstellungen && einstellungen.qrBefehl, (wert, hinweis, diagnose) => {
        verarbeiteQrErgebnis(bild, quelle, wert, hinweis, diagnose);
      });
    }

    // Fuer den Fall, dass der QR-Code schon beim Durchsuchen mehrerer
    // Bilder gefunden (oder endgueltig nicht gefunden) wurde
    function weiterMitVorabErgebnis(bild, quelle, wert, hinweis) {
      verarbeiteQrErgebnis(bild, quelle, wert, hinweis, null);
    }

    function verarbeiteQrErgebnis(bild, quelle, probennummer, qrHinweis, diagnose) {
      (function () {
        // Wird kein Code erkannt, das gepruefte Bild zur Sichtkontrolle ablegen.
        // Nur so laesst sich beurteilen, ob ueberhaupt die richtige Seite ankam.
        let pruefBild = null;
        if (!probennummer && job.sourcePath) {
          try {
            const ordner = path.join(job.sourcePath, '_qr-pruefung');
            fs.mkdirSync(ordner, { recursive: true });
            const name = path.basename(pdfPfad).replace(/\.[^.]+$/, '') + path.extname(bild);
            pruefBild = path.join(ordner, name);
            fs.copyFileSync(bild, pruefBild);
          } catch { pruefBild = null; }
        }
        let groesse = 0;
        try { groesse = fs.statSync(pdfPfad).size; } catch { /* egal */ }

        const jetzt = new Date();
        const dateiname = path.basename(pdfPfad);
        const werte = {
          qrWert: probennummer || null,
          probennummer: probennummer || null,   // Alias, aeltere Vorlagen laufen weiter
          qrGefunden: Boolean(probennummer),
          dateiname,
          dateinameOhneEndung: dateiname.replace(/\.[^.]+$/, ''),
          unixzeit: Math.floor(jetzt.getTime() / 1000),
          isozeit: jetzt.toISOString(),
          groesseBytes: groesse,
          jobName: job.name,
          festwert: job.auftragsnummer || null,
          auftragsnummer: job.auftragsnummer || null,
          ...gruppenAusDateiname(dateiname, job.dateinameRegex),
        };

        // Aussagekraeftiger Hinweis: Bildquelle, ZBar-Rueckmeldung, Pruefbild
        let hinweisText = qrHinweis || 'Kein QR-Code lesbar';
        if (!probennummer) {
          const teile = [hinweisText];
          teile.push(`Bildquelle: ${quelle || 'unbekannt'}`);
          if (diagnose && diagnose.protokoll && diagnose.protokoll.length) {
            const letzte = diagnose.protokoll[diagnose.protokoll.length - 1];
            teile.push(`zbarimg (${diagnose.zbar}) Exit ${letzte.exitCode}${letzte.fehler ? ': ' + letzte.fehler : ''}`);
          }
          if (diagnose && diagnose.befehl) teile.push(`Befehl: ${diagnose.befehl}`);
          if (pruefBild) teile.push(`Geprüftes Bild zur Kontrolle abgelegt: ${pruefBild}`);
          hinweisText = teile.join(' · ');
        }

        const info = {
          qrWert: probennummer || null,
          probennummer: probennummer || null,
          qrGefunden: Boolean(probennummer),
          qrHinweis: probennummer ? null : hinweisText,
          bildquelle: quelle || null,
        };

        // --- Variante A: multipart/form-data (PDF + Metadatenfeld) ---
        if (job.sendeFormat === 'multipart-metadata') {
          const metaText = fuelleVorlage(job.metadataVorlage, werte);
          const metaPfad = tmpBasis + '.meta.json';
          try {
            fs.writeFileSync(metaPfad, metaText, 'utf8');
          } catch (e) {
            return fertig(`Metadaten konnten nicht geschrieben werden: ${e.message}`, null, null);
          }
          return fertig(null, { modus: 'multipart', pdfPfad, metaPfad }, { ...info, metadaten: metaText });
        }

        // --- Variante B: JSON-Rumpf mit eingebettetem PDF (Standard) ---
        let pdfBase64 = '';
        try {
          pdfBase64 = fs.readFileSync(pdfPfad).toString('base64');
        } catch (e) {
          return fertig(`PDF konnte nicht gelesen werden: ${e.message}`, null, null);
        }
        const nachricht = {
          qrWert: werte.qrWert,
          probennummer: werte.qrWert,
          qrGefunden: werte.qrGefunden,
          qrHinweis: info.qrHinweis,
          dateiname,
          groesseBytes: groesse,
          erfasstAm: werte.isozeit,
          jobName: job.name,
          dateiInhaltBase64: pdfBase64,
        };
        const jsonPfad = tmpBasis + '.json';
        try {
          fs.writeFileSync(jsonPfad, JSON.stringify(nachricht));
        } catch (e) {
          return fertig(`JSON konnte nicht geschrieben werden: ${e.message}`, null, null);
        }
        fertig(null, { modus: 'json', sendePfad: jsonPfad }, info);
      })();
    }
}

module.exports = { pdfZuJson, analysiereText, analysiereBilder, pruefeVerarbeitungsWerkzeuge, findeWerkzeug, fuelleVorlage, gruppenAusDateiname, pruefePopplerAblage, pruefeBenoetigteDlls, STANDARD_VORLAGE };
