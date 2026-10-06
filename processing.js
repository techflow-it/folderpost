// Processing steps between "file found" and "send".
// Currently: convert scanned PDFs with a QR code into a JSON message.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { dekodiereJpeg } = require('./jpeg');
const { leseQr } = require('./qr');
const { seitenBilder } = require('./pdf-split');
const { L } = require('./i18n');

// ---------- Tool detection ----------

const IST_WINDOWS = process.platform === 'win32';
const EXE = IST_WINDOWS ? '.exe' : '';

// Searches a folder for a file up to a limited depth.
// This way it does not matter how the extracted archive is structured (bin, Library\bin,
// mingw64\bin, with or without a version folder).
function sucheRekursiv(wurzel, dateiname, maxTiefe = 4) {
  const gefunden = [];
  const lauf = (ordner, tiefe) => {
    if (tiefe > maxTiefe || gefunden.length > 20) return;
    let eintraege;
    try { eintraege = fs.readdirSync(ordner, { withFileTypes: true }); } catch { return; }
    // Check the files in the current folder first
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

// Reads the DLL names required by an .exe from the file
// (simple string search, sufficient for a diagnosis) and checks
// which of them are missing next to the .exe.
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

// Returns all paths that are checked — for troubleshooting
function sammlePfadKandidaten(name, unterordner) {
  const wurzel = path.join(__dirname, 'runtime', unterordner);
  const datei = name + EXE;

  // Preferred, known locations first
  const kandidaten = [
    path.join(wurzel, 'bin', datei),
    path.join(wurzel, 'Library', 'bin', datei),
    path.join(wurzel, 'mingw64', 'bin', datei),
    path.join(wurzel, datei),
  ];

  // Then everything else found in the runtime folder
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
  return treffer || name; // otherwise from the PATH
}

// Starts the program and reports in detail why it fails, if it does
function pruefeWerkzeugDetail(name, unterordner, args, cb) {
  const kandidaten = sammlePfadKandidaten(name, unterordner);
  const gefunden = kandidaten.filter((p) => { try { return fs.existsSync(p); } catch { return false; } });
  const pfad = gefunden[0] || name;
  const ausPfadVariable = gefunden.length === 0;

  execFile(pfad, args, { timeout: 10000 }, (err, stdout, stderr) => {
    // Exit code 1 is normal for --version/-v with some tools
    const ok = !err || err.code === 1;
    let grund = null;
    if (!ok) {
      if (err.code === 'ENOENT') {
        grund = ausPfadVariable
          ? L('Program found neither in the runtime folder nor via the PATH variable.')
          : L('The file exists at "{path}" but cannot be started (ENOENT).', { path: pfad });
      } else if (String(err.message).includes('0xc0000135') || String(err.message).includes('3221225781')) {
        grund = L('File found, but starting it failed — DLL files are missing in the same folder. Please copy the complete contents of the bin folder, not just the .exe.');
      } else {
        grund = L('Start failed: {error}', { error: err.message.split('\n')[0] });
      }
    }
    const dlls = (!ok && path.isAbsolute(pfad)) ? pruefeBenoetigteDlls(pfad) : null;
    if (dlls && dlls.fehlend.length && !grund) {
      grund = L('Program found but cannot be started. Missing libraries in the same folder: {list}', { list: dlls.fehlend.slice(0, 8).join(', ') });
    } else if (dlls && dlls.fehlend.length && grund) {
      grund += ' ' + L('Missing libraries: {list}', { list: dlls.fehlend.slice(0, 8).join(', ') });
    }
    cb({
      name,
      ok,
      pfad,
      dlls,
      quelle: ausPfadVariable ? L('PATH variable') : L('File found'),
      gefundeneDateien: gefunden,
      geprueftePfade: kandidaten,
      exitCode: err ? (err.code !== undefined ? String(err.code) : '?') : '0',
      ausgabe: ((stdout || '') + (stderr || '')).trim().split('\n').slice(0, 3).join(' | ').slice(0, 300),
      grund,
    });
  });
}

// ---------- Extracting the image directly from the PDF (without Poppler) ----------

/**
 * Scanned PDFs almost always contain the page as a ready-made JPEG.
 * It can be extracted without a renderer — this helps when Poppler does not
 * run on the target machine. Returns the path of a .jpg file.
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
    if (!/\/DCTDecode/.test(kopf)) continue; // JPEG only; anything else would need a decoder

    const streamIdx = daten.indexOf(Buffer.from('stream', 'latin1'), idx);
    if (streamIdx === -1) continue;
    let start = streamIdx + 6;
    if (daten[start] === 0x0D) start += 1;
    if (daten[start] === 0x0A) start += 1;

    // JPEG starts with FF D8 and ends with FF D9
    if (!(daten[start] === 0xFF && daten[start + 1] === 0xD8)) continue;
    const endIdx = daten.indexOf(Buffer.from([0xFF, 0xD9]), start);
    if (endIdx === -1) continue;

    const bild = daten.slice(start, endIdx + 2);
    if (bild.length < 1500) continue; // skip very small graphics (logos)

    const ziel = `${zielBasis}-b${gefunden.length + 1}.jpg`;
    try {
      fs.writeFileSync(ziel, bild);
      gefunden.push(ziel);
    } catch { /* continue */ }
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

// Checks whether the PDF has a text layer (searchable) or is a pure scan.
// Decides whether fields can be read from the content.
function analysiereText(pdfPfad) {
  let daten;
  try { daten = fs.readFileSync(pdfPfad); } catch { return null; }
  const zlib = require('zlib');

  const roh = daten.toString('latin1');
  const schriften = (roh.match(/\/Type\s*\/Font/g) || []).length;

  // Unpack the content streams and look for text operators
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

    // Apply the filter chain in order, e.g. [/ASCII85Decode /FlateDecode]
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
        unbekannt = true; break; // image compression or similar
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

// Counts which image types the PDF contains — for understandable error messages
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

// Tries several images one after another until a QR code is found
function leseQrAusBildern(bilder, eigenerBefehl, cb) {
  let letzteDiagnose = null;
  const naechstes = (i) => {
    if (i >= bilder.length) {
      if (bilder.length === 0) return cb(null, L('No usable image found in the PDF'), null, letzteDiagnose);
      // A start-up problem of the reader takes precedence over "nothing found"
      if (letzteDiagnose && letzteDiagnose.fehlt) {
        return cb(null, letzteDiagnose.hinweisText || L('The QR reader could not be started'), null, letzteDiagnose);
      }
      return cb(null, L('No QR code detected in {count} image(s)', { count: bilder.length }), null, letzteDiagnose);
    }
    leseQrCode(bilder[i], eigenerBefehl, (wert, hinweis, diagnose) => {
      if (diagnose) { letzteDiagnose = diagnose; letzteDiagnose.hinweisText = hinweis; }
      if (wert) return cb(wert, null, bilder[i], diagnose);
      // If the reader does not start at all, further images do not help
      if (diagnose && diagnose.fehlt) return cb(null, hinweis, null, diagnose);
      naechstes(i + 1);
    });
  };
  naechstes(0);
}

function renderSeiteExtern(seite, dpi, pdfPfad, tmpBasis, cb) {
  const versuche = [
    // The built-in reader can evaluate PGM and JPEG directly
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
  if (c === 0xC0000005 || code === 3221225477) return L('Access violation (0xC0000005) — the program crashes, usually an incomplete or mixed Poppler package.');
  if (c === 0xC0000135 || code === 3221225781) return L('Missing DLL (0xC0000135) — please copy the complete bin folder.');
  if (c === 0xC000007B || code === 3221225595) return L('Architecture conflict (0xC000007B) — 32-bit and 64-bit files mixed.');
  return L('Exit code {code}', { code });
}

// Checks whether the Poppler files are in the right place. What matters is that
// the data folder share\poppler keeps the right position relative to the .exe --
// in the archive it sits NEXT TO "Library", not inside it.
function pruefePopplerAblage() {
  const exe = findeWerkzeug('pdftoppm', 'poppler');
  if (!path.isAbsolute(exe)) return { relevant: false, hinweis: L('pdftoppm is used via the PATH variable.') };

  const binDir = path.dirname(exe);
  const dllAnzahl = (() => {
    try { return fs.readdirSync(binDir).filter((f) => f.toLowerCase().endsWith('.dll')).length; }
    catch { return 0; }
  })();

  // share\poppler can be one or two levels above bin
  const moeglicheDatenPfade = [
    path.join(binDir, '..', 'share', 'poppler'),
    path.join(binDir, '..', '..', 'share', 'poppler'),
    path.join(binDir, '..', '..', '..', 'share', 'poppler'),
  ];
  const datenPfad = moeglicheDatenPfade.find((p) => { try { return fs.existsSync(p); } catch { return false; } });

  const probleme = [];
  if (dllAnzahl === 0) {
    probleme.push(L('There is not a single DLL in the folder of pdftoppm.exe — apparently only the .exe was copied.'));
  }
  if (!datenPfad) {
    probleme.push(L('The data folder "share\\poppler" was not found. In the Poppler archive it is NEXT TO the "Library" folder — copy both together, otherwise pdftoppm crashes (0xC0000005).'));
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

// Creates a tiny valid PDF to really try out rendering
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

// Tries a real rendering run — detects crashes that a plain "-v" does not show
function pruefeRendern(cb) {
  const pdf = schreibeTestPdf();
  const ziel = path.join(os.tmpdir(), 'fp-test-' + crypto.randomBytes(4).toString('hex'));
  renderSeiteExtern(1, 72, pdf, ziel, (fehler, verwendet) => {
    try { fs.unlinkSync(pdf); } catch { /* ignore */ }
    try {
      const dir = path.dirname(ziel);
      const basis = path.basename(ziel);
      fs.readdirSync(dir).filter((f) => f.startsWith(basis)).forEach((f) => {
        try { fs.unlinkSync(path.join(dir, f)); } catch { /* ignore */ }
      });
    } catch { /* ignore */ }
    cb({ ok: !fehler, verwendet: verwendet || null, fehler: fehler || null });
  });
}

// Checks whether the installed zbarimg version supports QR codes at all.
// Old Windows builds (0.10) only support EAN/UPC, Code 128, Code 39 and I2/5.
function pruefeQrFaehigkeit(cb) {
  const zbar = findeWerkzeug('zbarimg', 'zbar');
  // Create a deliberately empty image: zbarimg then lists the symbologies
  const leer = path.join(os.tmpdir(), 'fp-qrtest-' + crypto.randomBytes(4).toString('hex') + '.pgm');
  try {
    // Small grey PGM without content — readable by zbarimg without extra libraries
    const breite = 64; const hoehe = 64;
    const kopf = Buffer.from(`P5\n${breite} ${hoehe}\n255\n`, 'latin1');
    fs.writeFileSync(leer, Buffer.concat([kopf, Buffer.alloc(breite * hoehe, 0xFF)]));
  } catch { return cb({ pruefbar: false }); }

  execFile(zbar, [leer], { timeout: 20000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
    try { fs.unlinkSync(leer); } catch { /* ignore */ }
    const text = `${stdout || ''} ${stderr || ''}`;
    if (err && err.code === 'ENOENT') return cb({ pruefbar: false, fehlt: true });
    if (!/supported symbologies/i.test(text)) return cb({ pruefbar: false, ausgabe: text.slice(0, 200) });
    const kannQr = /QR/i.test(text);
    const liste = (text.match(/currently supported symbologies are:([\s\S]{0,200})/i) || [])[1] || '';
    return cb({ pruefbar: true, kannQr, symbologien: liste.replace(/\s+/g, ' ').trim().slice(0, 180) });
  });
}

// Reports which tools are available for PDF processing
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

// ---------- Reading the QR code ----------

// Reads the QR code from an image file. The default is zbarimg; alternatively
// a custom command can be set in the settings
// (the placeholder {datei} is replaced by the image path).
/**
 * Reads the QR code from an image file.
 * Tries several call variants because zbarimg behaves differently depending
 * on the version (older releases do not know --raw and print
 * "QR-Code:VALUE" instead).
 */
// Removes the symbology prefix that zbarimg prints without --raw ("QR-Code:1234")
function ohnePraefix(text) {
  const zeile = String(text || '').split('\n')[0].trim();
  const m = zeile.match(/^([A-Za-z0-9-]+(?:\/[A-Za-z0-9-]+)?):(.*)$/);
  if (m && /^(QR-Code|EAN-13|EAN-8|UPC-A|UPC-E|ISBN-13|ISBN-10|CODE-128|CODE-93|CODE-39|I2\/5|DataBar|Codabar|PDF417)$/i.test(m[1])) {
    return m[2].trim();
  }
  return zeile;
}

// Built-in reader: needs no external programs. Works with JPEG.
function lesePgm(daten) {
  // Binary PGM (P5): the header consists of magic number, width, height, maximum value
  if (!(daten[0] === 0x50 && daten[1] === 0x35)) return null;
  let pos = 2;
  const zahlen = [];
  while (zahlen.length < 3 && pos < daten.length) {
    while (pos < daten.length && /\s/.test(String.fromCharCode(daten[pos]))) pos += 1;
    if (daten[pos] === 0x23) { // comment line
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
  pos += 1; // one separator after the maximum value
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
  // The built-in reader first — no external program needed
  if (!eigenerBefehl || !eigenerBefehl.trim()) {
    const intern = leseQrIntern(bildPfad);
    if (intern) return cb(intern, null, { quelle: L('built-in reader') });
  }
  if (eigenerBefehl && eigenerBefehl.trim()) {
    const teile = eigenerBefehl.trim().split(/\s+/).map((t) => t.replace('{datei}', bildPfad));
    return execFile(teile[0], teile.slice(1), { timeout: 30000, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
      const wert = ohnePraefix(stdout);
      if (err && !wert) return cb(null, L('Custom QR command failed: {error}', { error: (stderr || err.message).split('\n')[0] }), { befehl: teile.join(' ') });
      cb(wert || null, wert ? null : L('Custom QR command returned no value'), { befehl: teile.join(' ') });
    });
  }

  const zbar = findeWerkzeug('zbarimg', 'zbar');
  const varianten = [
    { args: ['--quiet', '--raw', bildPfad], name: '--quiet --raw' },
    { args: ['-q', bildPfad], name: '-q (with type prefix)' },
    { args: ['--quiet', '--raw', '-Sdisable', '-Sqrcode.enable', bildPfad], name: 'QR only' },
    { args: [bildPfad], name: 'no options' },
  ];
  const protokoll = [];
  let nichtStartbar = 0;

  const versuche = (i) => {
    if (i >= varianten.length) {
      if (nichtStartbar === varianten.length) {
        return cb(null, L('Optional external reader zbarimg not available (looked for "{path}"). Detection normally uses the built-in reader.', { path: zbar }), { zbar, protokoll, fehlt: true });
      }

      // On failure, zbarimg lists the supported symbologies.
      // If QR is missing, this version was built without QR support
      // (affects, among others, the old Windows installer 0.10).
      const alleMeldungen = protokoll.map((p) => `${p.fehler} ${p.ausgabe}`).join(' ');
      if (/supported symbologies/i.test(alleMeldungen) && !/QR/i.test(alleMeldungen)) {
        return cb(null,
          L('This ZBar version cannot read QR codes — it was built without QR support (the message only lists EAN/UPC, Code 128, Code 39 and Interleaved 2 of 5). Remedy: use a newer ZBar version, e.g. from the GitHub releases 0.23.90 to 0.23.92. The old SourceForge installer (0.10) is not suitable.'),
          { zbar, protokoll, ohneQrUnterstuetzung: true });
      }

      const meldungen = Array.from(new Set(protokoll.map((p) => p.fehler).filter(Boolean)));
      const codes = Array.from(new Set(protokoll.map((p) => p.exitCode)));
      const zusatz = meldungen.length
        ? ' ' + L('zbarimg reports: {message}', { message: meldungen.slice(0, 2).join(' | ').slice(0, 300) })
        : ' ' + L('zbarimg ran (exit {codes}) but returned no code.', { codes: codes.join('/') });
      return cb(null, L('No QR code detected.') + zusatz, { zbar, protokoll });
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

// ---------- Replacing placeholders in the metadata template ----------

const STANDARD_VORLAGE = JSON.stringify({
  name: '{filenameWithoutExt}',
  order_id: '{qrValue}',
  date: '{unixtime}',
}, null, 2);

/**
 * Adds the English names of the placeholders. The older names
 * ({qrWert}, {dateiname}, {gruppe:name} …) remain valid so that existing
 * templates keep working unchanged.
 */
function mitEnglischenNamen(werte) {
  const aus = { ...werte };
  const alias = {
    qrValue: 'qrWert', qrFound: 'qrGefunden', filename: 'dateiname', filenameWithoutExt: 'dateinameOhneEndung',
    unixtime: 'unixzeit', isotime: 'isozeit', sizeBytes: 'groesseBytes', fixedValue: 'festwert',
  };
  Object.entries(alias).forEach(([en, de]) => { if (de in werte) aus[en] = werte[de]; });
  Object.keys(werte).filter((k) => k.startsWith('gruppe:')).forEach((k) => { aus['group:' + k.slice(7)] = werte[k]; });
  return aus;
}

/**
 * Replaces placeholders in the template. Available are, among others,
 * {qrValue} {qrFound} {filename} {filenameWithoutExt}
 * {unixtime} {isotime} {sizeBytes} {jobName} {fixedValue}
 * and {group:name} from the file name expression (older German names are aliases).
 */
function fuelleVorlage(vorlage, werte) {
  let text = String(vorlage || STANDARD_VORLAGE);
  werte = mitEnglischenNamen(werte);

  // Write number fields without quotes if the template puts them
  // in quotes but the value is a plain number.
  Object.entries(werte).forEach(([schluessel, wert]) => {
    const platzhalter = new RegExp(`"\\{${schluessel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\}"|\\{${schluessel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\}`, 'g');
    text = text.replace(platzhalter, (treffer) => {
      const inAnfuehrung = treffer.startsWith('"');
      if (wert === null || wert === undefined) return inAnfuehrung ? 'null' : 'null';
      if (typeof wert === 'boolean') return String(wert);
      // Only write real JSON numbers without leading zeros unquoted.
      // "001" must stay text, otherwise the JSON would be invalid.
      const istZahl = typeof wert === 'number' || /^-?(0|[1-9]\d*)(\.\d+)?$/.test(String(wert));
      if (inAnfuehrung && istZahl) return String(wert);      // "123" -> 123
      if (inAnfuehrung) return JSON.stringify(String(wert)).slice(0);
      return istZahl ? String(wert) : JSON.stringify(String(wert));
    });
  });

  // Neutralise unused placeholders so that the JSON stays valid
  text = text.replace(/"\{[^}]+\}"/g, 'null').replace(/\{[a-zA-Z0-9_:.-]+\}/g, 'null');
  return text;
}

// Extracts named groups from the file name, e.g. ^(?<order>\d+)_
function gruppenAusDateiname(dateiname, ausdruck) {
  if (!ausdruck || !ausdruck.trim()) return {};
  try {
    const treffer = new RegExp(ausdruck).exec(dateiname);
    if (!treffer || !treffer.groups) return {};
    const raus = {};
    Object.entries(treffer.groups).forEach(([k, v]) => { raus['gruppe:' + k] = v === undefined ? null : v; });
    return raus;
  } catch {
    return {}; // an invalid expression must not stop the transfer
  }
}

// ---------- PDF → JSON ----------

/**
 * Converts a scanned PDF into a JSON message.
 * The result is the path of a temporary .json file that is then sent
 * via curl. The caller must clean it up afterwards.
 */
function pdfZuJson(job, pdfPfad, einstellungen, cb) {
  const tmpBasis = path.join(os.tmpdir(), 'fp-' + crypto.randomBytes(6).toString('hex'));
  const seite = Number(job.qrSeite) > 0 ? Number(job.qrSeite) : 1;
  const dpi = Number(job.qrDpi) > 0 ? Number(job.qrDpi) : 200;
  const aufraeumen = [];

  const fertig = (fehler, jsonPfad, info) => {
    aufraeumen.forEach((f) => { try { fs.unlinkSync(f); } catch { /* ignore */ } });
    // Also remove partial render output that is not in the list
    try {
      const dir = path.dirname(tmpBasis);
      const praefix = path.basename(tmpBasis);
      fs.readdirSync(dir)
        .filter((f) => f.startsWith(praefix) && !f.endsWith('.json'))
        .forEach((f) => { try { fs.unlinkSync(path.join(dir, f)); } catch { /* ignore */ } });
    } catch { /* ignore */ }
    cb(fehler, jsonPfad, info);
  };

  // Pre-check: has the PDF been written completely at all?
  // Scanners and copiers often create the file first and fill it afterwards.
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
    if (groesse === 0) return fertig(L('The file is still empty — it is probably still being written. Increase the settle time in the job.'), null, null);
  } catch (e) {
    return fertig(L('File not readable: {error}', { error: e.message }), null, null);
  }
  if (kopf.toString('latin1') !== '%PDF-') {
    return fertig(L('The file does not start with %PDF — not a valid PDF file or still incomplete.'), null, null);
  }
  if (!schwanz.toString('latin1').includes('%%EOF')) {
    return fertig(L('The PDF is incomplete (end marker %%EOF missing) — the file is probably still being written. Increase the settle time in the job (field "Minimum file age").'), null, null);
  }

// Module-wide render function (also usable for the self-check)
// Translates typical Windows exit codes into plain language
function deuteExitCode(code) {
  const c = Number(code) >>> 0;
  if (c === 0xC0000005 || code === 3221225477) {
    return L('Access violation (0xC0000005) — the program starts and then crashes. Usually an incomplete or mixed Poppler package: copy the complete bin folder of a single Poppler version, do not mix files from different versions.');
  }
  if (c === 0xC0000135 || code === 3221225781) {
    return L('Missing DLL (0xC0000135) — libraries are missing in the same folder. Please copy the complete contents of the bin folder, not just the .exe.');
  }
  if (c === 0xC000007B || code === 3221225595) {
    return L('Architecture conflict (0xC000007B) — 32-bit and 64-bit files mixed. Please use a consistent 64-bit version.');
  }
  return L('Exit code {code}', { code });
}

// Renders the page; falls back to pdftocairo automatically after a crash
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
      // On a crash or a missing program, try the next way
      naechster(i + 1, bisher ? `${bisher} — ${text}` : text);
    });
  };
  naechster(0, null);
}

  renderSeite(seite, dpi, pdfPfad, tmpBasis, (renderFehler, verwendet) => {
      // If both renderers fail, extract the embedded scan images directly
      // from the PDF and search them for a QR code one after another.
      if (renderFehler) {
        // Get all page images — JPEG as well as black-and-white scans (CCITT)
        const seiten = seitenBilder(pdfPfad);
        const bilder = [];
        seiten.slice(0, 12).forEach((seite, i) => {
          try {
            if (seite.art === 'jpeg') {
              const pfad = `${tmpBasis}-direkt-${i}.jpg`;
              fs.writeFileSync(pfad, seite.jpeg);
              bilder.push(pfad);
            } else {
              // Store greyscale as PGM — the built-in reader can read that directly
              const pfad = `${tmpBasis}-direkt-${i}.pgm`;
              fs.writeFileSync(pfad, Buffer.concat([
                Buffer.from(`P5\n${seite.breite} ${seite.hoehe}\n255\n`, 'latin1'),
                Buffer.from(seite.grauDaten),
              ]));
              bilder.push(pfad);
            }
          } catch { /* skip the page */ }
        });
        bilder.forEach((b) => aufraeumen.push(b));
        if (bilder.length === 0) {
          const arten = analysiereBilder(pdfPfad);
          const artText = arten
            ? ' ' + L('Found in the PDF: {images} image(s) — JPEG: {jpeg}, CCITT: {ccitt}, JBIG2: {jbig2}, JPEG 2000: {jpx}. JBIG2 and JPEG 2000 require a working renderer.', {
              images: arten.bilder, jpeg: arten.jpeg, ccitt: arten.ccitt, jbig2: arten.jbig2, jpx: arten.jpx,
            })
            : '';
          return fertig(L('The PDF could not be rendered. {error} — reading the images directly was not possible either.', { error: renderFehler }) + artText, null, null);
        }
        return leseQrAusBildern(bilder, einstellungen && einstellungen.qrBefehl, (wert, hinweis, benutztesBild, diagnose) => {
          verarbeiteQrErgebnis(
            benutztesBild || bilder[0],
            L('Read directly from {count} embedded image(s), Poppler skipped', { count: bilder.length }),
            wert,
            hinweis,
            diagnose,
          );
        });
      }

      // pdftoppm appends the page number; the number of digits varies
      const dir = path.dirname(tmpBasis);
      const praefix = path.basename(tmpBasis);
      let bild = null;
      try {
        const treffer = fs.readdirSync(dir).filter((f) => f.startsWith(praefix) && (f.endsWith('.pgm') || f.endsWith('.jpg') || f.endsWith('.png')));
        if (treffer.length > 0) bild = path.join(dir, treffer[0]);
      } catch { /* falls through to the error below */ }
      if (!bild) return fertig(L('Rendered page image not found'), null, null);
      aufraeumen.push(bild);
      weiterMitBild(bild, verwendet);
    });

    function weiterMitBild(bild, quelle) {
      leseQrCode(bild, einstellungen && einstellungen.qrBefehl, (wert, hinweis, diagnose) => {
        verarbeiteQrErgebnis(bild, quelle, wert, hinweis, diagnose);
      });
    }

    // In case the QR code was already found (or definitely not found)
    // while searching several images
    function weiterMitVorabErgebnis(bild, quelle, wert, hinweis) {
      verarbeiteQrErgebnis(bild, quelle, wert, hinweis, null);
    }

    function verarbeiteQrErgebnis(bild, quelle, qrValue, qrHinweis, diagnose) {
      (function () {
        // If no code is detected, store the checked image for visual inspection.
        // This is the only way to judge whether the right page arrived at all.
        let pruefBild = null;
        if (!qrValue && job.sourcePath) {
          try {
            const ordner = path.join(job.sourcePath, '_qr-check');
            fs.mkdirSync(ordner, { recursive: true });
            const name = path.basename(pdfPfad).replace(/\.[^.]+$/, '') + path.extname(bild);
            pruefBild = path.join(ordner, name);
            fs.copyFileSync(bild, pruefBild);
          } catch { pruefBild = null; }
        }
        let groesse = 0;
        try { groesse = fs.statSync(pdfPfad).size; } catch { /* ignore */ }

        const jetzt = new Date();
        const dateiname = path.basename(pdfPfad);
        const werte = {
          qrWert: qrValue || null,
          probennummer: qrValue || null,   // alias, older templates keep working
          qrGefunden: Boolean(qrValue),
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

        // Meaningful hint: image source, ZBar feedback, check image
        let hinweisText = qrHinweis || L('No readable QR code');
        if (!qrValue) {
          const teile = [hinweisText];
          teile.push(L('Image source: {source}', { source: quelle || L('unknown') }));
          if (diagnose && diagnose.protokoll && diagnose.protokoll.length) {
            const letzte = diagnose.protokoll[diagnose.protokoll.length - 1];
            teile.push(`zbarimg (${diagnose.zbar}) Exit ${letzte.exitCode}${letzte.fehler ? ': ' + letzte.fehler : ''}`);
          }
          if (diagnose && diagnose.befehl) teile.push(L('Command: {command}', { command: diagnose.befehl }));
          if (pruefBild) teile.push(L('Checked image stored for review: {path}', { path: pruefBild }));
          hinweisText = teile.join(' · ');
        }

        const info = {
          qrWert: qrValue || null,
          probennummer: qrValue || null,
          qrGefunden: Boolean(qrValue),
          qrHinweis: qrValue ? null : hinweisText,
          bildquelle: quelle || null,
        };

        // --- Variante A: multipart/form-data (PDF + Metadatenfeld) ---
        if (job.sendeFormat === 'multipart-metadata') {
          const metaText = fuelleVorlage(job.metadataVorlage, werte);
          const metaPfad = tmpBasis + '.meta.json';
          try {
            fs.writeFileSync(metaPfad, metaText, 'utf8');
          } catch (e) {
            return fertig(L('Metadata could not be written: {error}', { error: e.message }), null, null);
          }
          return fertig(null, { modus: 'multipart', pdfPfad, metaPfad }, { ...info, metadaten: metaText });
        }

        // --- Variant B: JSON body with embedded PDF (default) ---
        let pdfBase64 = '';
        try {
          pdfBase64 = fs.readFileSync(pdfPfad).toString('base64');
        } catch (e) {
          return fertig(L('The PDF could not be read: {error}', { error: e.message }), null, null);
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
          return fertig(L('JSON could not be written: {error}', { error: e.message }), null, null);
        }
        fertig(null, { modus: 'json', sendePfad: jsonPfad }, info);
      })();
    }
}

module.exports = { pdfZuJson, analysiereText, analysiereBilder, pruefeVerarbeitungsWerkzeuge, findeWerkzeug, fuelleVorlage, gruppenAusDateiname, mitEnglischenNamen, pruefePopplerAblage, pruefeBenoetigteDlls, STANDARD_VORLAGE };
