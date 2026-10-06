// Baseline JPEG decoder in plain JavaScript.
// Returns a greyscale image — that is all barcode detection needs.
// Supports sequential baseline JPEGs (SOF0/SOF1), colour and greyscale images.

const ZICKZACK = new Int32Array([
   0,  1,  8, 16,  9,  2,  3, 10,
  17, 24, 32, 25, 18, 11,  4,  5,
  12, 19, 26, 33, 40, 48, 41, 34,
  27, 20, 13,  6,  7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36,
  29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46,
  53, 60, 61, 54, 47, 55, 62, 63,
]);

function baueHuffmanTabelle(anzahlProLaenge, werte) {
  // Derive the codes from the length counters and put them into a lookup structure
  const tabelle = new Map();
  let code = 0;
  let k = 0;
  for (let laenge = 1; laenge <= 16; laenge += 1) {
    for (let i = 0; i < anzahlProLaenge[laenge - 1]; i += 1) {
      tabelle.set(`${laenge}:${code}`, werte[k]);
      code += 1;
      k += 1;
    }
    code <<= 1;
  }
  return tabelle;
}

class BitLeser {
  constructor(daten, pos) {
    this.daten = daten;
    this.pos = pos;
    this.puffer = 0;
    this.anzahl = 0;
  }

  bit() {
    if (this.anzahl === 0) {
      if (this.pos >= this.daten.length) return 0;
      let b = this.daten[this.pos];
      this.pos += 1;
      if (b === 0xFF) {
        const naechstes = this.daten[this.pos];
        if (naechstes === 0x00) {
          this.pos += 1; // stuffed byte
        } else if (naechstes >= 0xD0 && naechstes <= 0xD7) {
          this.pos += 1; // restart marker
          b = this.daten[this.pos];
          this.pos += 1;
        } else {
          return 0; // marker reached
        }
      }
      this.puffer = b;
      this.anzahl = 8;
    }
    this.anzahl -= 1;
    return (this.puffer >> this.anzahl) & 1;
  }

  bits(n) {
    let wert = 0;
    for (let i = 0; i < n; i += 1) wert = (wert << 1) | this.bit();
    return wert;
  }

  huffman(tabelle) {
    let code = 0;
    for (let laenge = 1; laenge <= 16; laenge += 1) {
      code = (code << 1) | this.bit();
      const treffer = tabelle.get(`${laenge}:${code}`);
      if (treffer !== undefined) return treffer;
    }
    return 0;
  }

  ausrichten() {
    this.anzahl = 0;
  }
}

// Signed number from n bits (JPEG encoding)
function erweitere(wert, n) {
  if (n === 0) return 0;
  return wert < (1 << (n - 1)) ? wert - (1 << n) + 1 : wert;
}

// Separable inverse cosine transform (floating point, fast enough)
const COS = (() => {
  const t = new Float32Array(64);
  for (let x = 0; x < 8; x += 1) {
    for (let u = 0; u < 8; u += 1) {
      t[x * 8 + u] = Math.cos(((2 * x + 1) * u * Math.PI) / 16) * (u === 0 ? Math.SQRT1_2 : 1);
    }
  }
  return t;
})();

function idct(block, ausgabe) {
  const zwischen = new Float32Array(64);
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      let summe = 0;
      for (let u = 0; u < 8; u += 1) summe += COS[x * 8 + u] * block[y * 8 + u];
      zwischen[y * 8 + x] = summe / 2;
    }
  }
  for (let x = 0; x < 8; x += 1) {
    for (let y = 0; y < 8; y += 1) {
      let summe = 0;
      for (let v = 0; v < 8; v += 1) summe += COS[y * 8 + v] * zwischen[v * 8 + x];
      let wert = Math.round(summe / 2) + 128;
      if (wert < 0) wert = 0; else if (wert > 255) wert = 255;
      ausgabe[y * 8 + x] = wert;
    }
  }
}

/**
 * Decodes a baseline JPEG into a greyscale image.
 * Returns { breite, hoehe, grau: Uint8Array } or { fehler: '...' }
 */
function dekodiereJpeg(daten) {
  let pos = 2; // skip FFD8
  if (!(daten[0] === 0xFF && daten[1] === 0xD8)) return { fehler: 'Not a JPEG file' };

  const quant = {};
  const huffDc = {};
  const huffAc = {};
  let rahmen = null;
  let neustartIntervall = 0;

  while (pos < daten.length) {
    if (daten[pos] !== 0xFF) { pos += 1; continue; }
    const marke = daten[pos + 1];
    pos += 2;
    if (marke === 0xD8 || marke === 0x01 || (marke >= 0xD0 && marke <= 0xD7)) continue;
    if (marke === 0xD9) break;

    const laenge = (daten[pos] << 8) | daten[pos + 1];
    const abschnittEnde = pos + laenge;
    let p = pos + 2;

    if (marke === 0xDB) { // quantization tables
      while (p < abschnittEnde) {
        const kennung = daten[p]; p += 1;
        const genauigkeit = kennung >> 4;
        const nr = kennung & 15;
        const tabelle = new Int32Array(64);
        for (let i = 0; i < 64; i += 1) {
          tabelle[ZICKZACK[i]] = genauigkeit ? ((daten[p] << 8) | daten[p + 1]) : daten[p];
          p += genauigkeit ? 2 : 1;
        }
        quant[nr] = tabelle;
      }
    } else if (marke === 0xC4) { // Huffman tables
      while (p < abschnittEnde) {
        const kennung = daten[p]; p += 1;
        const klasse = kennung >> 4;
        const nr = kennung & 15;
        const anzahl = [];
        let summe = 0;
        for (let i = 0; i < 16; i += 1) { anzahl.push(daten[p + i]); summe += daten[p + i]; }
        p += 16;
        const werte = [];
        for (let i = 0; i < summe; i += 1) werte.push(daten[p + i]);
        p += summe;
        const tabelle = baueHuffmanTabelle(anzahl, werte);
        if (klasse === 0) huffDc[nr] = tabelle; else huffAc[nr] = tabelle;
      }
    } else if (marke === 0xC0 || marke === 0xC1) { // baseline / extended sequential
      const hoehe = (daten[p + 1] << 8) | daten[p + 2];
      const breite = (daten[p + 3] << 8) | daten[p + 4];
      const anzahlKomponenten = daten[p + 5];
      p += 6;
      const komponenten = [];
      for (let i = 0; i < anzahlKomponenten; i += 1) {
        komponenten.push({
          id: daten[p],
          h: daten[p + 1] >> 4,
          v: daten[p + 1] & 15,
          quant: daten[p + 2],
        });
        p += 3;
      }
      rahmen = { breite, hoehe, komponenten };
    } else if (marke === 0xC2) {
      return { fehler: 'Progressive JPEG is not supported' };
    } else if (marke === 0xDD) {
      neustartIntervall = (daten[p] << 8) | daten[p + 1];
    } else if (marke === 0xDA) { // Start of image data
      if (!rahmen) return { fehler: 'JPEG without frame header' };
      const anzahlScan = daten[p]; p += 1;
      const scanKomponenten = [];
      for (let i = 0; i < anzahlScan; i += 1) {
        const id = daten[p];
        const tabellen = daten[p + 1];
        const komp = rahmen.komponenten.find((k) => k.id === id);
        scanKomponenten.push({ komp, dc: tabellen >> 4, ac: tabellen & 15 });
        p += 2;
      }
      p += 3; // Spectral selection, irrelevant for baseline

      return dekodiereBilddaten(daten, p, rahmen, scanKomponenten, quant, huffDc, huffAc, neustartIntervall);
    }

    pos = abschnittEnde;
  }
  return { fehler: 'No image data found in the JPEG' };
}

function dekodiereBilddaten(daten, start, rahmen, scanKomponenten, quant, huffDc, huffAc, neustartIntervall) {
  const { breite, hoehe, komponenten } = rahmen;
  if (!breite || !hoehe) return { fehler: 'Invalid image dimensions' };

  const maxH = Math.max(...komponenten.map((k) => k.h));
  const maxV = Math.max(...komponenten.map((k) => k.v));
  const mcuBreite = maxH * 8;
  const mcuHoehe = maxV * 8;
  const mcusX = Math.ceil(breite / mcuBreite);
  const mcusY = Math.ceil(hoehe / mcuHoehe);

  // Only the luminance component is needed
  const y = komponenten[0];
  const yBreite = mcusX * y.h * 8;
  const yHoehe = mcusY * y.v * 8;
  const flaeche = new Uint8Array(yBreite * yHoehe);

  const leser = new BitLeser(daten, start);
  const vorher = {};
  komponenten.forEach((k) => { vorher[k.id] = 0; });

  const block = new Int32Array(64);
  const pixel = new Uint8Array(64);
  let mcuZaehler = 0;

  for (let my = 0; my < mcusY; my += 1) {
    for (let mx = 0; mx < mcusX; mx += 1) {
      if (neustartIntervall && mcuZaehler > 0 && mcuZaehler % neustartIntervall === 0) {
        leser.ausrichten();
        // Skip restart marker
        while (leser.pos < daten.length - 1) {
          if (daten[leser.pos] === 0xFF && daten[leser.pos + 1] >= 0xD0 && daten[leser.pos + 1] <= 0xD7) {
            leser.pos += 2;
            break;
          }
          leser.pos += 1;
        }
        komponenten.forEach((k) => { vorher[k.id] = 0; });
      }
      mcuZaehler += 1;

      for (const sk of scanKomponenten) {
        const k = sk.komp;
        for (let by = 0; by < k.v; by += 1) {
          for (let bx = 0; bx < k.h; bx += 1) {
            block.fill(0);
            const q = quant[k.quant];
            if (!q) return { fehler: 'Fehlende Quantisierungstabelle' };

            // DC coefficient
            const t = leser.huffman(huffDc[sk.dc] || new Map());
            const diff = t === 0 ? 0 : erweitere(leser.bits(t), t);
            vorher[k.id] += diff;
            block[0] = vorher[k.id] * q[0];

            // AC coefficients
            let i = 1;
            while (i < 64) {
              const rs = leser.huffman(huffAc[sk.ac] || new Map());
              const r = rs >> 4;
              const groesse = rs & 15;
              if (groesse === 0) {
                if (r === 15) { i += 16; continue; }
                break;
              }
              i += r;
              if (i > 63) break;
              const stelle = ZICKZACK[i];
              block[stelle] = erweitere(leser.bits(groesse), groesse) * q[stelle];
              i += 1;
            }

            if (k === y) {
              idct(block, pixel);
              const zielX = (mx * k.h + bx) * 8;
              const zielY = (my * k.v + by) * 8;
              for (let py = 0; py < 8; py += 1) {
                const zeile = (zielY + py) * yBreite + zielX;
                for (let px = 0; px < 8; px += 1) flaeche[zeile + px] = pixel[py * 8 + px];
              }
            }
          }
        }
      }
    }
  }

  // Crop to the actual image size and upscale if necessary,
  // in case the luminance is subsampled (rare for scans)
  const grau = new Uint8Array(breite * hoehe);
  const skalaX = (y.h * 8 * mcusX) / (maxH * 8 * mcusX);
  const skalaY = (y.v * 8 * mcusY) / (maxV * 8 * mcusY);
  for (let py = 0; py < hoehe; py += 1) {
    const qy = Math.min(yHoehe - 1, Math.floor(py * skalaY));
    for (let px = 0; px < breite; px += 1) {
      const qx = Math.min(yBreite - 1, Math.floor(px * skalaX));
      grau[py * breite + px] = flaeche[qy * yBreite + qx];
    }
  }

  return { breite, hoehe, grau };
}

module.exports = { dekodiereJpeg };
