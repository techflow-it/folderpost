// Splits a batch scan into individual documents at QR codes.
//
// Method: the embedded page images are read from the PDF one after another
// and checked for QR codes. Every page with a code starts a new document;
// pages without a code belong to the previous one. A new PDF file is then
// built from the page images of each document.
//
// Limits: works for JPEG, CCITT Group 4, uncompressed and Flate-compressed
// scans (the normal case for office devices). JBIG2-, JPEG 2000- or CCITT
// Group 3-compressed pages cannot be read.

const fs = require('fs');
const zlib = require('zlib');
const { dekodiereG4 } = require('./ccitt');
const { L } = require('./i18n');

// ---------- Getting the page images from the PDF ----------

/** Reads width and height from the JPEG header (SOF marker). */
function jpegMasse(puffer) {
  let pos = 2;
  while (pos < puffer.length - 9) {
    if (puffer[pos] !== 0xFF) { pos += 1; continue; }
    const marke = puffer[pos + 1];
    // SOF0..SOF3 and SOF5..SOF15 contain the dimensions
    if (marke >= 0xC0 && marke <= 0xCF && marke !== 0xC4 && marke !== 0xC8 && marke !== 0xCC) {
      return { hoehe: puffer.readUInt16BE(pos + 5), breite: puffer.readUInt16BE(pos + 7) };
    }
    if (marke === 0xD8 || marke === 0x01 || (marke >= 0xD0 && marke <= 0xD7)) { pos += 2; continue; }
    const laenge = puffer.readUInt16BE(pos + 2);
    pos += 2 + laenge;
  }
  return null;
}

/** Reads a number from the image dictionary. */
function zahl(kopf, name, standard = null) {
  const m = new RegExp('/' + name + '\\s+(-?\\d+)').exec(kopf);
  return m ? Number(m[1]) : standard;
}

/**
 * Returns all embedded page images in document order.
 * Supports JPEG (DCTDecode), black-and-white scans (CCITTFaxDecode Group 4)
 * and uncompressed or Flate-compressed images.
 */
function seitenBilder(pdfPfad) {
  let daten;
  try { daten = fs.readFileSync(pdfPfad); } catch { return []; }

  const marker = Buffer.from('/Subtype', 'latin1');
  const bilder = [];
  let pos = 0;

  while (pos < daten.length && bilder.length < 500) {
    const idx = daten.indexOf(marker, pos);
    if (idx === -1) break;
    pos = idx + 8;

    const streamIdx = daten.indexOf(Buffer.from('stream', 'latin1'), idx);
    if (streamIdx === -1) continue;

    // Delimit the dictionary exactly: from the start of the object to the stream.
    // A fixed-size window would also read values of the neighbouring image; the
    // last "<<" would be the nested DecodeParms dictionary.
    const vorlauf = daten.slice(Math.max(0, streamIdx - 4000), streamIdx).toString('latin1');
    const objStart = vorlauf.lastIndexOf('obj');
    const kopf = objStart === -1 ? vorlauf : vorlauf.slice(objStart);
    if (!/\/Image/.test(kopf)) continue;
    let start = streamIdx + 6;
    if (daten[start] === 0x0D) start += 1;
    if (daten[start] === 0x0A) start += 1;

    const breite = zahl(kopf, 'Width');
    const hoehe = zahl(kopf, 'Height');
    const bpc = zahl(kopf, 'BitsPerComponent', 8);
    const grauRaum = /\/DeviceGray/.test(kopf);
    if (!breite || !hoehe) continue;

    // --- JPEG ---
    if (/\/DCTDecode/.test(kopf)) {
      if (!(daten[start] === 0xFF && daten[start + 1] === 0xD8)) continue;
      const ende = daten.indexOf(Buffer.from([0xFF, 0xD9]), start);
      if (ende === -1) continue;
      const jpeg = daten.slice(start, ende + 2);
      if (jpeg.length < 2000) continue;
      const masse = jpegMasse(jpeg) || { breite, hoehe };
      bilder.push({ art: 'jpeg', jpeg, ...masse, grau: grauRaum });
      continue;
    }

    // Determine the length of the stream. Note: /Length can be an indirect
    // reference ("/Length 6 0 R") — then it holds an object number, not the
    // length. In that case read up to "endstream".
    const laengeIndirekt = /\/Length\s+\d+\s+\d+\s+R/.test(kopf);
    const laengeAngabe = laengeIndirekt ? null : zahl(kopf, 'Length');
    let ende = laengeAngabe ? start + laengeAngabe : -1;
    if (!laengeAngabe || ende > daten.length) {
      const e = daten.indexOf(Buffer.from('endstream', 'latin1'), start);
      if (e === -1) continue;
      ende = e;
    }
    const roh = daten.slice(start, ende);

    // --- Black-and-white scan (CCITT Group 4) ---
    if (/\/CCITTFaxDecode/.test(kopf)) {
      const k = zahl(kopf, 'K', 0);
      if (k >= 0) continue; // Group 3 is not supported
      const schwarzIst1 = /\/BlackIs1\s+true/.test(kopf);
      const spalten = zahl(kopf, 'Columns', 1728) || breite;
      let bild = null;
      try { bild = dekodiereG4(roh, spalten, hoehe, { blackIs1: schwarzIst1 }); } catch { bild = null; }
      if (!bild) continue;
      bilder.push({ art: 'grau', grauDaten: bild.grau, breite: spalten, hoehe, grau: true });
      continue;
    }

    // --- Uncompressed or Flate ---
    if (/\/JBIG2Decode|\/JPXDecode/.test(kopf)) continue; // not supported
    let roh2 = roh;
    if (/\/FlateDecode/.test(kopf)) {
      try { roh2 = zlib.inflateSync(roh); } catch { continue; }
    } else if (/\/Filter/.test(kopf)) {
      continue; // other compression
    }

    const grauDaten = graustufenAusRoh(roh2, breite, hoehe, bpc, grauRaum);
    if (!grauDaten) continue;
    bilder.push({ art: 'grau', grauDaten, breite, hoehe, grau: true });
  }
  return bilder;
}

/** Converts raw image data into a greyscale image. */
function graustufenAusRoh(roh, breite, hoehe, bpc, grauRaum) {
  const grau = new Uint8Array(breite * hoehe);
  if (bpc === 1) {
    const proZeile = Math.ceil(breite / 8);
    if (roh.length < proZeile * hoehe) return null;
    for (let y = 0; y < hoehe; y += 1) {
      for (let x = 0; x < breite; x += 1) {
        const bit = (roh[y * proZeile + (x >> 3)] >> (7 - (x & 7))) & 1;
        grau[y * breite + x] = bit ? 255 : 0;
      }
    }
    return grau;
  }
  if (bpc === 8) {
    const kanaele = grauRaum ? 1 : 3;
    if (roh.length < breite * hoehe * kanaele) return null;
    for (let i = 0; i < breite * hoehe; i += 1) {
      if (kanaele === 1) grau[i] = roh[i];
      else {
        const p = i * 3;
        grau[i] = Math.round(0.299 * roh[p] + 0.587 * roh[p + 1] + 0.114 * roh[p + 2]);
      }
    }
    return grau;
  }
  return null;
}

// ---------- Building a new PDF from page images ----------

function pdfAusBildern(bilder, dpi = 150) {
  const objekte = [];
  const hinzu = (inhalt) => { objekte.push(inhalt); return objekte.length; };

  // 1 = catalog, 2 = page tree — reserve the numbers in advance
  const katalogNr = 1;
  const baumNr = 2;
  objekte.push(null, null);

  const seitenNummern = [];
  bilder.forEach((bild) => {
    // points = pixels / dpi * 72
    const breitePt = Math.round((bild.breite / dpi) * 72);
    const hoehePt = Math.round((bild.hoehe / dpi) * 72);

    // JPEG is embedded unchanged, greyscale is stored compressed
    let bildNr;
    if (bild.art === 'jpeg') {
      bildNr = hinzu(Buffer.concat([
        Buffer.from(`<</Type/XObject/Subtype/Image/Width ${bild.breite}/Height ${bild.hoehe}`
          + `/ColorSpace/${bild.grau ? 'DeviceGray' : 'DeviceRGB'}/BitsPerComponent 8`
          + `/Filter/DCTDecode/Length ${bild.jpeg.length}>>\nstream\n`, 'latin1'),
        bild.jpeg,
        Buffer.from('\nendstream', 'latin1'),
      ]));
    } else {
      const gepackt = zlib.deflateSync(Buffer.from(bild.grauDaten), { level: 6 });
      bildNr = hinzu(Buffer.concat([
        Buffer.from(`<</Type/XObject/Subtype/Image/Width ${bild.breite}/Height ${bild.hoehe}`
          + `/ColorSpace/DeviceGray/BitsPerComponent 8`
          + `/Filter/FlateDecode/Length ${gepackt.length}>>\nstream\n`, 'latin1'),
        gepackt,
        Buffer.from('\nendstream', 'latin1'),
      ]));
    }

    const inhaltText = `q ${breitePt} 0 0 ${hoehePt} 0 0 cm /Bild Do Q`;
    const inhaltNr = hinzu(Buffer.from(
      `<</Length ${inhaltText.length}>>\nstream\n${inhaltText}\nendstream`, 'latin1'));

    const seitenNr = hinzu(Buffer.from(
      `<</Type/Page/Parent ${baumNr} 0 R/MediaBox[0 0 ${breitePt} ${hoehePt}]`
      + `/Resources<</XObject<</Bild ${bildNr} 0 R>>>>/Contents ${inhaltNr} 0 R>>`, 'latin1'));
    seitenNummern.push(seitenNr);
  });

  objekte[katalogNr - 1] = Buffer.from(`<</Type/Catalog/Pages ${baumNr} 0 R>>`, 'latin1');
  objekte[baumNr - 1] = Buffer.from(
    `<</Type/Pages/Kids[${seitenNummern.map((n) => `${n} 0 R`).join(' ')}]/Count ${seitenNummern.length}>>`, 'latin1');

  // Assemble with a cross-reference table
  const teile = [Buffer.from('%PDF-1.4\n', 'latin1')];
  let laenge = teile[0].length;
  const versaetze = [];

  objekte.forEach((inhalt, i) => {
    versaetze.push(laenge);
    const stueck = Buffer.concat([
      Buffer.from(`${i + 1} 0 obj\n`, 'latin1'),
      inhalt,
      Buffer.from('\nendobj\n', 'latin1'),
    ]);
    teile.push(stueck);
    laenge += stueck.length;
  });

  const xrefStelle = laenge;
  let xref = `xref\n0 ${objekte.length + 1}\n0000000000 65535 f \n`;
  versaetze.forEach((v) => { xref += `${String(v).padStart(10, '0')} 00000 n \n`; });
  xref += `trailer\n<</Size ${objekte.length + 1}/Root ${katalogNr} 0 R>>\nstartxref\n${xrefStelle}\n%%EOF`;
  teile.push(Buffer.from(xref, 'latin1'));

  return Buffer.concat(teile);
}

// ---------- Splitting ----------

/**
 * Splits the PDF at pages with a QR code.
 * @param leseQrAusPuffer  function (bild) → detected value or null.
 *   bild.art is 'jpeg' (bild.jpeg = buffer) or 'grau'
 *   (bild.grauDaten, bild.breite, bild.hoehe)
 * @returns { ok, dokumente: [{ qrWert, seiten, seitenNummern, pdf }], seitenGesamt, meldung }
 */
function teileNachQr(pdfPfad, leseQrAusPuffer, optionen = {}) {
  const bilder = seitenBilder(pdfPfad);
  if (bilder.length === 0) {
    // Name the cause more precisely
    let hinweis = '';
    try {
      const text = fs.readFileSync(pdfPfad).toString('latin1');
      if (/\/JBIG2Decode/.test(text)) {
        hinweis = ' ' + L('The PDF uses JBIG2 compression, which cannot be evaluated. Remedy: switch the scanner to JPEG, TIFF/CCITT or uncompressed.');
      } else if (/\/JPXDecode/.test(text)) {
        hinweis = ' ' + L('The PDF uses JPEG 2000, which cannot be evaluated.');
      } else if (/\/CCITTFaxDecode/.test(text) && /\/K\s+0/.test(text)) {
        hinweis = ' ' + L('The PDF uses CCITT Group 3; Group 4 is supported.');
      } else if (!/\/Subtype\s*\/Image/.test(text)) {
        hinweis = ' ' + L('The PDF contains no page images — probably a digitally created PDF instead of a scan. Splitting at QR codes is not intended for that.');
      }
    } catch { /* ignore */ }
    return { ok: false, meldung: L('No usable page images found.') + hinweis };
  }

  // The reader gets the image object: either a JPEG buffer or ready greyscale data
  const codes = bilder.map((b) => {
    try { return leseQrAusPuffer(b) || null; } catch { return null; }
  });

  // If not a single page carries a code, splitting would be arbitrary
  if (codes.every((c) => !c)) {
    return { ok: false, meldung: L('No QR code was found on any of the {count} pages.', { count: bilder.length }), seitenGesamt: bilder.length };
  }

  const dokumente = [];
  let aktuell = null;
  codes.forEach((code, i) => {
    if (code || aktuell === null) {
      // New split point — or first page without a code (leading pages)
      aktuell = { qrWert: code, seiten: [], seitenNummern: [] };
      dokumente.push(aktuell);
    }
    aktuell.seiten.push(bilder[i]);
    aktuell.seitenNummern.push(i + 1);
  });

  // Leading pages without a code can be discarded on request
  const ergebnis = dokumente
    .filter((d) => (optionen.vorspannVerwerfen ? Boolean(d.qrWert) : true))
    .map((d) => ({
      qrWert: d.qrWert,
      seiten: d.seiten.length,
      seitenNummern: d.seitenNummern,
      pdf: pdfAusBildern(d.seiten, optionen.dpi || 150),
    }));

  return { ok: true, dokumente: ergebnis, seitenGesamt: bilder.length };
}

module.exports = { teileNachQr, seitenBilder, pdfAusBildern, jpegMasse };
