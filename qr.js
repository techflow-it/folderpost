// QR-Code-Decoder in reinem JavaScript.
// Arbeitet auf einem Graustufenbild und braucht keine Fremdprogramme.

// ---------- Galois-Feld GF(256) für die Fehlerkorrektur ----------

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11D; // Generatorpolynom
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
})();

const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);
const gfDiv = (a, b) => (a === 0 ? 0 : EXP[(LOG[a] - LOG[b] + 255) % 255]);

// ---------- Polynomrechnung über GF(256) ----------

function polyAuswerten(poly, x) {
  let y = poly[0];
  for (let i = 1; i < poly.length; i += 1) y = gfMul(y, x) ^ poly[i];
  return y;
}

function polySkalieren(poly, x) {
  return poly.map((c) => gfMul(c, x));
}

function polyAddieren(a, b) {
  const r = new Array(Math.max(a.length, b.length)).fill(0);
  for (let i = 0; i < a.length; i += 1) r[i + r.length - a.length] = a[i];
  for (let i = 0; i < b.length; i += 1) r[i + r.length - b.length] ^= b[i];
  return r;
}

function polyMultiplizieren(a, b) {
  const r = new Array(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i += 1) {
    for (let j = 0; j < b.length; j += 1) r[i + j] ^= gfMul(a[i], b[j]);
  }
  return r;
}

// ---------- Reed-Solomon-Dekodierung ----------
// Nullstellen des Generatorpolynoms sind α^0 … α^(anzahlEc-1).

function berechneSyndrome(nachricht, anzahlEc) {
  const s = [0];
  for (let i = 0; i < anzahlEc; i += 1) s.push(polyAuswerten(nachricht, EXP[i]));
  return s;
}

// Berlekamp-Massey: bestimmt das Fehlerstellenpolynom
function findeFehlerOrtung(syndrome, anzahlEc) {
  let ortung = [1];
  let alt = [1];

  for (let i = 0; i < anzahlEc; i += 1) {
    const k = i + 1;
    let delta = syndrome[k];
    for (let j = 1; j < ortung.length; j += 1) {
      delta ^= gfMul(ortung[ortung.length - 1 - j], syndrome[k - j]);
    }
    alt = alt.concat([0]);

    if (delta !== 0) {
      if (alt.length > ortung.length) {
        const neu2 = polySkalieren(alt, delta);
        alt = polySkalieren(ortung, gfDiv(1, delta));
        ortung = neu2;
      }
      ortung = polyAddieren(ortung, polySkalieren(alt, delta));
    }
  }

  while (ortung.length && ortung[0] === 0) ortung.shift();
  return ortung;
}

// Chien-Suche: Nullstellen des Fehlerstellenpolynoms = Fehlerpositionen
function findeFehlerPositionen(ortung, laenge) {
  const anzahlFehler = ortung.length - 1;
  const positionen = [];
  for (let i = 0; i < laenge; i += 1) {
    if (polyAuswerten(ortung, EXP[(255 - i) % 255]) === 0) {
      positionen.push(laenge - 1 - i);
    }
  }
  return positionen.length === anzahlFehler ? positionen : null;
}

// Forney: berechnet die Fehlerwerte und korrigiert
function korrigiereFehler(nachricht, syndrome, positionen) {
  const werte = nachricht.slice();
  const koeffPos = positionen.map((p) => werte.length - 1 - p);

  // Fehlerstellenpolynom aus den gefundenen Positionen
  let ortung = [1];
  koeffPos.forEach((i) => {
    ortung = polyMultiplizieren(ortung, polyAddieren([1], [EXP[i % 255], 0]));
  });

  // Fehlerbewertungspolynom
  const synUmgekehrt = syndrome.slice().reverse();
  let bewerter = polyMultiplizieren(synUmgekehrt, ortung);
  // Es müssen (Grad + 1) Koeffizienten übrig bleiben, nicht nur der Grad
  bewerter = bewerter.slice(bewerter.length - ortung.length);
  bewerter.reverse();

  const X = koeffPos.map((k) => EXP[k % 255]);

  for (let i = 0; i < X.length; i += 1) {
    const xiInv = gfDiv(1, X[i]);

    // Ableitung des Fehlerstellenpolynoms an dieser Stelle
    let ableitung = 1;
    for (let j = 0; j < X.length; j += 1) {
      if (j === i) continue;
      ableitung = gfMul(ableitung, 1 ^ gfMul(xiInv, X[j]));
    }
    if (ableitung === 0) return null;

    let y = polyAuswerten(bewerter.slice().reverse(), xiInv);
    y = gfMul(X[i], y);

    werte[positionen[i]] ^= gfDiv(y, ableitung);
  }
  return werte;
}

function rsDekodiere(daten, anzahlEc) {
  const werte = Array.from(daten);
  const syndrome = berechneSyndrome(werte, anzahlEc);
  if (syndrome.every((s) => s === 0)) return werte; // fehlerfrei

  const ortung = findeFehlerOrtung(syndrome, anzahlEc);
  const anzahlFehler = ortung.length - 1;
  if (anzahlFehler * 2 > anzahlEc) return null; // zu viele Fehler

  const positionen = findeFehlerPositionen(ortung, werte.length);
  if (!positionen) return null;

  const korrigiert = korrigiereFehler(werte, syndrome, positionen);
  if (!korrigiert) return null;

  // Gegenprobe
  const pruefung = berechneSyndrome(korrigiert, anzahlEc);
  if (!pruefung.every((s) => s === 0)) return null;
  return korrigiert;
}

// ---------- Tabellen ----------

// Je Version und Fehlerkorrekturstufe: [EC-Codewörter je Block, Blöcke Gruppe1, Codewörter Gruppe1, Blöcke Gruppe2, Codewörter Gruppe2]
const EC_TABELLE = {
  1:  { L: [7,1,19,0,0],    M: [10,1,16,0,0],   Q: [13,1,13,0,0],   H: [17,1,9,0,0] },
  2:  { L: [10,1,34,0,0],   M: [16,1,28,0,0],   Q: [22,1,22,0,0],   H: [28,1,16,0,0] },
  3:  { L: [15,1,55,0,0],   M: [26,1,44,0,0],   Q: [18,2,17,0,0],   H: [22,2,13,0,0] },
  4:  { L: [20,1,80,0,0],   M: [18,2,32,0,0],   Q: [26,2,24,0,0],   H: [16,4,9,0,0] },
  5:  { L: [26,1,108,0,0],  M: [24,2,43,0,0],   Q: [18,2,15,2,16], H: [22,2,11,2,12] },
  6:  { L: [18,2,68,0,0],   M: [16,4,27,0,0],   Q: [24,4,19,0,0],   H: [28,4,15,0,0] },
  7:  { L: [20,2,78,0,0],   M: [18,4,31,0,0],   Q: [18,2,14,4,15], H: [26,4,13,1,14] },
  8:  { L: [24,2,97,0,0],   M: [22,2,38,2,39], Q: [22,4,18,2,19], H: [26,4,14,2,15] },
  9:  { L: [30,2,116,0,0],  M: [22,3,36,2,37], Q: [20,4,16,4,17], H: [24,4,12,4,13] },
  10: { L: [18,2,68,2,69], M: [26,4,43,1,44], Q: [24,6,19,2,20], H: [28,6,15,2,16] },
  11: { L: [20,4,81,0,0],   M: [30,1,50,4,51], Q: [28,4,22,4,23], H: [24,3,12,8,13] },
  12: { L: [24,2,92,2,93], M: [22,6,36,2,37], Q: [26,4,20,6,21], H: [28,7,14,4,15] },
  13: { L: [26,4,107,0,0],  M: [22,8,37,1,38], Q: [24,8,20,4,21], H: [22,12,11,4,12] },
  14: { L: [30,3,115,1,116], M: [24,4,40,5,41], Q: [20,11,16,5,17], H: [24,11,12,5,13] },
  15: { L: [22,5,87,1,88], M: [24,5,41,5,42], Q: [30,5,24,7,25], H: [24,11,12,7,13] },
  16: { L: [24,5,98,1,99], M: [28,7,45,3,46], Q: [24,15,19,2,20], H: [30,3,15,13,16] },
  17: { L: [28,1,107,5,108], M: [28,10,46,1,47], Q: [28,1,22,15,23], H: [28,2,14,17,15] },
  18: { L: [30,5,120,1,121], M: [26,9,43,4,44], Q: [28,17,22,1,23], H: [28,2,14,19,15] },
  19: { L: [28,3,113,4,114], M: [26,3,44,11,45], Q: [26,17,21,4,22], H: [26,9,13,16,14] },
  20: { L: [28,3,107,5,108], M: [26,3,41,13,42], Q: [30,15,24,5,25], H: [28,15,15,10,16] },
};

const ALPHANUMERISCH = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

// ---------- Bildvorbereitung ----------

function otsuSchwelle(grau) {
  const hist = new Int32Array(256);
  for (let i = 0; i < grau.length; i += 1) hist[grau[i]] += 1;
  const gesamt = grau.length;
  let summe = 0;
  for (let i = 0; i < 256; i += 1) summe += i * hist[i];
  let summeB = 0; let gewichtB = 0; let maxVar = -1; let schwelle = 128;
  for (let t = 0; t < 256; t += 1) {
    gewichtB += hist[t];
    if (gewichtB === 0) continue;
    const gewichtF = gesamt - gewichtB;
    if (gewichtF === 0) break;
    summeB += t * hist[t];
    const mB = summeB / gewichtB;
    const mF = (summe - summeB) / gewichtF;
    const varianz = gewichtB * gewichtF * (mB - mF) * (mB - mF);
    if (varianz > maxVar) { maxVar = varianz; schwelle = t; }
  }
  return schwelle;
}

// true = dunkles Modul
function binarisiere(grau, breite, hoehe) {
  const schwelle = otsuSchwelle(grau);
  const bits = new Uint8Array(breite * hoehe);
  // "<=" statt "<": Bei reinen Schwarzweiß-Bildern (nur 0 und 255) liefert
  // Otsu die Schwelle 0 — mit "<" wäre dann kein einziges Pixel dunkel.
  for (let i = 0; i < bits.length; i += 1) bits[i] = grau[i] <= schwelle ? 1 : 0;
  return bits;
}

// ---------- Suchmuster finden ----------

function findeSuchmuster(bits, breite, hoehe) {
  const kandidaten = [];

  const passt = (z) => {
    const gesamt = z[0] + z[1] + z[2] + z[3] + z[4];
    if (gesamt < 7) return false;
    const einheit = gesamt / 7;
    const tol = einheit / 2;
    return Math.abs(z[0] - einheit) < tol
      && Math.abs(z[1] - einheit) < tol
      && Math.abs(z[2] - 3 * einheit) < 3 * tol
      && Math.abs(z[3] - einheit) < tol
      && Math.abs(z[4] - einheit) < tol;
  };

  // Senkrechte Gegenprobe: am gefundenen Mittelpunkt muss dasselbe
  // Verhaeltnis auch in der Spalte auftreten
  const senkrechtBestaetigt = (mx, my, einheit) => {
    const x = Math.round(mx);
    if (x < 0 || x >= breite) return false;
    const dunkel = (y) => (y >= 0 && y < hoehe && bits[y * breite + x] === 1);
    if (!dunkel(my)) return false;
    const z = [0, 0, 0, 0, 0];
    let y = my;
    while (dunkel(y)) { z[2] += 1; y -= 1; }
    while (y >= 0 && !dunkel(y)) { z[1] += 1; y -= 1; }
    while (y >= 0 && dunkel(y)) { z[0] += 1; y -= 1; }
    y = my + 1;
    while (dunkel(y)) { z[2] += 1; y += 1; }
    while (y < hoehe && !dunkel(y)) { z[3] += 1; y += 1; }
    while (y < hoehe && dunkel(y)) { z[4] += 1; y += 1; }
    if (!passt(z)) return false;
    const gesamt = z[0] + z[1] + z[2] + z[3] + z[4];
    return Math.abs(gesamt / 7 - einheit) < einheit * 0.7;
  };

  for (let y = 0; y < hoehe; y += 1) {
    const z = [0, 0, 0, 0, 0];
    let stand = 0; // 0..4, gerade = dunkel erwartet
    for (let x = 0; x < breite; x += 1) {
      const dunkel = bits[y * breite + x] === 1;
      const erwarteDunkel = stand % 2 === 0;

      if (dunkel === erwarteDunkel) {
        z[stand] += 1;
        continue;
      }

      if (stand < 4) {
        stand += 1;
        z[stand] = 1;
        continue;
      }

      // stand === 4 und Farbwechsel: Fenster auswerten
      if (passt(z)) {
        const einheit = (z[0] + z[1] + z[2] + z[3] + z[4]) / 7;
        const mitteX = x - z[4] - z[3] - z[2] / 2;
        if (senkrechtBestaetigt(mitteX, y, einheit)) {
          kandidaten.push({ x: mitteX, y, groesse: einheit });
        }
      }
      // Fenster um zwei Abschnitte verschieben
      z[0] = z[2]; z[1] = z[3]; z[2] = z[4]; z[3] = 1; z[4] = 0;
      stand = 3;
    }

    // Zeilenende
    if (stand === 4 && passt(z)) {
      const einheit = (z[0] + z[1] + z[2] + z[3] + z[4]) / 7;
      const mitteX = breite - z[4] - z[3] - z[2] / 2;
      if (senkrechtBestaetigt(mitteX, y, einheit)) {
        kandidaten.push({ x: mitteX, y, groesse: einheit });
      }
    }
  }

  // Treffer zu Zentren buendeln
  const zentren = [];
  for (const k of kandidaten) {
    let gefunden = false;
    for (const z of zentren) {
      if (Math.abs(z.x - k.x) < k.groesse * 2 && Math.abs(z.y - k.y) < k.groesse * 3) {
        z.summeX += k.x; z.summeY += k.y; z.summeG += k.groesse; z.n += 1;
        z.x = z.summeX / z.n; z.y = z.summeY / z.n; z.groesse = z.summeG / z.n;
        gefunden = true;
        break;
      }
    }
    if (!gefunden) {
      zentren.push({ x: k.x, y: k.y, groesse: k.groesse, summeX: k.x, summeY: k.y, summeG: k.groesse, n: 1 });
    }
  }
  // Mittelpunkte nachjustieren: Der aus den Zeilentreffern gemittelte Punkt
  // kann bei ungleichmäßig geschwärzten Scans um bis zu ein Modul daneben
  // liegen. Der dunkle Kern des Suchmusters (3×3 Module) lässt sich genauer
  // bestimmen — über den Schwerpunkt der zusammenhängenden dunklen Fläche.
  return zentren.filter((z) => z.n >= 2).map((z) => {
    const genau = kernSchwerpunkt(bits, breite, hoehe, z);
    return genau ? { ...z, x: genau.x, y: genau.y } : z;
  });
}

/**
 * Bestimmt den Schwerpunkt des dunklen Kerns eines Suchmusters.
 * Verfolgt die zusammenhängende dunkle Fläche um den Startpunkt; wird sie
 * unplausibel groß (mehr als der Kern), gilt die Justierung als gescheitert.
 */
function kernSchwerpunkt(bits, breite, hoehe, zentrum) {
  const sx = Math.round(zentrum.x);
  const sy = Math.round(zentrum.y);
  if (sx < 0 || sy < 0 || sx >= breite || sy >= hoehe) return null;
  if (!bits[sy * breite + sx]) return null;   // Startpunkt nicht dunkel

  const modul = zentrum.groesse || 3;
  const grenze = Math.ceil(modul * 5) ** 2;   // Kern ist 3×3 Module
  const gesehen = new Set();
  const stapel = [[sx, sy]];
  let summeX = 0;
  let summeY = 0;
  let anzahl = 0;

  while (stapel.length) {
    const [x, y] = stapel.pop();
    if (x < 0 || y < 0 || x >= breite || y >= hoehe) continue;
    const schluessel = y * breite + x;
    if (gesehen.has(schluessel)) continue;
    if (!bits[schluessel]) continue;
    gesehen.add(schluessel);
    summeX += x; summeY += y; anzahl += 1;
    if (anzahl > grenze) return null;         // Fläche zu groß — kein Kern
    stapel.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }

  if (anzahl < modul * modul * 2) return null; // zu klein
  return { x: summeX / anzahl, y: summeY / anzahl };
}

// Ordnet drei Zentren zu oben-links, oben-rechts, unten-links
function ordneZentren(z) {
  const abstand = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const kombis = [[0, 1, 2], [1, 0, 2], [2, 0, 1]];
  let best = null;
  for (const [e, a, b] of kombis) {
    const d = Math.abs(abstand(z[a], z[b]) - Math.hypot(abstand(z[e], z[a]), abstand(z[e], z[b])));
    if (best === null || d < best.d) best = { d, ecke: z[e], p1: z[a], p2: z[b] };
  }
  const { ecke, p1, p2 } = best;
  // In Bildkoordinaten wächst y nach unten. Für oben-links → oben-rechts → unten-links
  // ist das Kreuzprodukt positiv; dann ist p1 der Punkt oben rechts.
  const kreuz = (p1.x - ecke.x) * (p2.y - ecke.y) - (p1.y - ecke.y) * (p2.x - ecke.x);
  return kreuz > 0
    ? { obenLinks: ecke, obenRechts: p1, untenLinks: p2 }
    : { obenLinks: ecke, obenRechts: p2, untenLinks: p1 };
}

// ---------- Raster abtasten ----------

function schaetzeGroesse(ol, or_, ul) {
  const abstand = Math.hypot(or_.x - ol.x, or_.y - ol.y);
  const modul = (ol.groesse + or_.groesse + ul.groesse) / 3;
  const module = Math.round(abstand / modul) + 7;
  // Auf gueltige Groesse runden (4k+17)
  let n = Math.round((module - 17) / 4) * 4 + 17;
  if (n < 21) n = 21;
  if (n > 97) n = 97;
  return n;
}

// Sucht das Ausrichtungsmuster (1:1:1) in der Naehe einer erwarteten Stelle
function findeAusrichtung(bits, breite, hoehe, erwartetX, erwartetY, modul) {
  const radius = Math.max(4, Math.round(modul * 4));
  const dunkel = (x, y) => (x >= 0 && y >= 0 && x < breite && y < hoehe && bits[y * breite + x] === 1);
  let besteX = null; let besteY = null; let besteAbw = Infinity;

  for (let dy = -radius; dy <= radius; dy += 1) {
    const y = Math.round(erwartetY + dy);
    if (y < 0 || y >= hoehe) continue;
    for (let dx = -radius; dx <= radius; dx += 1) {
      const x = Math.round(erwartetX + dx);
      if (!dunkel(x, y)) continue;

      // Waagerecht: dunkel-hell-dunkel-hell-dunkel um den Mittelpunkt
      let links = 0; let i = x;
      while (dunkel(i, y)) { links += 1; i -= 1; }
      let rechts = 0; i = x + 1;
      while (dunkel(i, y)) { rechts += 1; i += 1; }
      const kern = links + rechts;
      if (kern < 1 || kern > modul * 2.5) continue;

      let oben = 0; let j = y;
      while (dunkel(x, j)) { oben += 1; j -= 1; }
      let unten = 0; j = y + 1;
      while (dunkel(x, j)) { unten += 1; j += 1; }
      const kernV = oben + unten;
      if (Math.abs(kernV - kern) > modul) continue;

      const mx = x - links + kern / 2;
      const my = y - oben + kernV / 2;
      const abw = Math.hypot(mx - erwartetX, my - erwartetY);
      if (abw < besteAbw) { besteAbw = abw; besteX = mx; besteY = my; }
    }
  }
  return besteX === null ? null : { x: besteX, y: besteY };
}

// Projektive Abbildung aus vier Punktpaaren (Modulkoordinate → Bildkoordinate)
function baueHomografie(quelle, ziel) {
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i += 1) {
    const [u, v] = quelle[i];
    const [x, y] = ziel[i];
    A.push([u, v, 1, 0, 0, 0, -u * x, -v * x]); b.push(x);
    A.push([0, 0, 0, u, v, 1, -u * y, -v * y]); b.push(y);
  }
  // Gauss-Elimination
  const n = 8;
  for (let i = 0; i < n; i += 1) {
    let max = i;
    for (let k = i + 1; k < n; k += 1) if (Math.abs(A[k][i]) > Math.abs(A[max][i])) max = k;
    [A[i], A[max]] = [A[max], A[i]];
    [b[i], b[max]] = [b[max], b[i]];
    if (Math.abs(A[i][i]) < 1e-9) return null;
    for (let k = i + 1; k < n; k += 1) {
      const f = A[k][i] / A[i][i];
      for (let j = i; j < n; j += 1) A[k][j] -= f * A[i][j];
      b[k] -= f * b[i];
    }
  }
  const h = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i -= 1) {
    let summe = b[i];
    for (let j = i + 1; j < n; j += 1) summe -= A[i][j] * h[j];
    h[i] = summe / A[i][i];
  }
  return (u, v) => {
    const nenner = h[6] * u + h[7] * v + 1;
    return [(h[0] * u + h[1] * v + h[2]) / nenner, (h[3] * u + h[4] * v + h[5]) / nenner];
  };
}

function tasteAb(bits, breite, hoehe, ol, or_, ul, groesse, mitAusrichtung = true, eckeUR = null) {
  const modul = (ol.groesse + or_.groesse + ul.groesse) / 3;
  const version = (groesse - 17) / 4;

  // Vierte Ecke: bevorzugt über das Ausrichtungsmuster, sonst rechnerisch
  let abbildung = null;
  if (mitAusrichtung && version >= 2) {
    // Affine Näherung aus den drei Suchmustern:
    // Bildpunkt = OL + (u-3.5)/(n-7) * (OR-OL) + (v-3.5)/(n-7) * (UL-OL)
    const spanne = groesse - 7;
    const zielModul = groesse - 6.5; // Mitte des unteren rechten Ausrichtungsmusters
    const t = (zielModul - 3.5) / spanne;
    const erwX = ol.x + t * (or_.x - ol.x) + t * (ul.x - ol.x);
    const erwY = ol.y + t * (or_.y - ol.y) + t * (ul.y - ol.y);
    const treffer = findeAusrichtung(bits, breite, hoehe, erwX, erwY, modul);
    if (treffer) {
      abbildung = baueHomografie(
        [[3.5, 3.5], [groesse - 3.5, 3.5], [3.5, groesse - 3.5], [zielModul, zielModul]],
        [[ol.x, ol.y], [or_.x, or_.y], [ul.x, ul.y], [treffer.x, treffer.y]],
      );
    }
  }
  if (!abbildung) {
    // Vierte Ecke: entweder vorgegeben (Feinkorrektur) oder als Parallelogramm geschätzt
    const urX = eckeUR ? eckeUR.x : or_.x + ul.x - ol.x;
    const urY = eckeUR ? eckeUR.y : or_.y + ul.y - ol.y;
    abbildung = baueHomografie(
      [[3.5, 3.5], [groesse - 3.5, 3.5], [3.5, groesse - 3.5], [groesse - 3.5, groesse - 3.5]],
      [[ol.x, ol.y], [or_.x, or_.y], [ul.x, ul.y], [urX, urY]],
    );
  }
  if (!abbildung) return null;

  // Bei kleinen Modulen nicht mitteln — sonst fliessen Nachbarmodule ein
  const radius = modul >= 5 ? 1 : 0;

  const matrix = [];
  for (let y = 0; y < groesse; y += 1) {
    const zeile = [];
    for (let x = 0; x < groesse; x += 1) {
      const [px, py] = abbildung(x + 0.5, y + 0.5);
      const ix = Math.round(px);
      const iy = Math.round(py);
      if (ix < 0 || iy < 0 || ix >= breite || iy >= hoehe) { zeile.push(0); continue; }
      if (radius === 0) { zeile.push(bits[iy * breite + ix]); continue; }
      let summe = 0; let n = 0;
      for (let dy = -radius; dy <= radius; dy += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          const qx = ix + dx; const qy = iy + dy;
          if (qx < 0 || qy < 0 || qx >= breite || qy >= hoehe) continue;
          summe += bits[qy * breite + qx]; n += 1;
        }
      }
      zeile.push(summe / n >= 0.5 ? 1 : 0);
    }
    matrix.push(zeile);
  }
  return matrix;
}

// ---------- Formatinformation ----------

const FORMAT_MASKE = 0x5412;

function dekodiereFormat(matrix, groesse) {
  const lies = (stellen) => {
    let wert = 0;
    for (const [y, x] of stellen) wert = (wert << 1) | matrix[y][x];
    return wert;
  };
  const kopie1 = [[8,0],[8,1],[8,2],[8,3],[8,4],[8,5],[8,7],[8,8],[7,8],[5,8],[4,8],[3,8],[2,8],[1,8],[0,8]];
  const n = groesse;
  const kopie2 = [[n-1,8],[n-2,8],[n-3,8],[n-4,8],[n-5,8],[n-6,8],[n-7,8],
                  [8,n-8],[8,n-7],[8,n-6],[8,n-5],[8,n-4],[8,n-3],[8,n-2],[8,n-1]];

  for (const stellen of [kopie1, kopie2]) {
    const roh = lies(stellen) ^ FORMAT_MASKE;
    // BCH(15,5): beste Übereinstimmung suchen
    let besteDistanz = 99; let bestesFormat = -1;
    for (let f = 0; f < 32; f += 1) {
      let code = f << 10;
      for (let i = 4; i >= 0; i -= 1) {
        if (code & (1 << (i + 10))) code ^= 0x537 << i;
      }
      const voll = (f << 10) | code;
      let distanz = 0;
      let d = voll ^ roh;
      while (d) { distanz += d & 1; d >>= 1; }
      if (distanz < besteDistanz) { besteDistanz = distanz; bestesFormat = f; }
    }
    if (besteDistanz <= 3) {
      const stufeBits = bestesFormat >> 3;
      const maske = bestesFormat & 7;
      const stufen = ['M', 'L', 'H', 'Q'];
      return { stufe: stufen[stufeBits], maske };
    }
  }
  return null;
}

const MASKEN = [
  (y, x) => (y + x) % 2 === 0,
  (y) => y % 2 === 0,
  (y, x) => x % 3 === 0,
  (y, x) => (y + x) % 3 === 0,
  (y, x) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
  (y, x) => ((y * x) % 2) + ((y * x) % 3) === 0,
  (y, x) => (((y * x) % 2) + ((y * x) % 3)) % 2 === 0,
  (y, x) => (((y + x) % 2) + ((y * x) % 3)) % 2 === 0,
];

// ---------- Funktionsbereiche markieren ----------

function baueFunktionskarte(groesse, version) {
  const karte = Array.from({ length: groesse }, () => new Uint8Array(groesse));
  const setze = (x, y, b, h) => {
    for (let dy = 0; dy < h; dy += 1) {
      for (let dx = 0; dx < b; dx += 1) {
        if (y + dy >= 0 && y + dy < groesse && x + dx >= 0 && x + dx < groesse) karte[y + dy][x + dx] = 1;
      }
    }
  };
  // Suchmuster samt Trennlinien und Formatbereich
  setze(0, 0, 9, 9);
  setze(groesse - 8, 0, 8, 9);
  setze(0, groesse - 8, 9, 8);
  // Taktspuren
  for (let i = 0; i < groesse; i += 1) { karte[6][i] = 1; karte[i][6] = 1; }
  // Ausrichtungsmuster
  const positionen = ausrichtungsPositionen(version);
  for (const py of positionen) {
    for (const px of positionen) {
      const nahSuchmuster = (px < 9 && py < 9) || (px > groesse - 10 && py < 9) || (px < 9 && py > groesse - 10);
      if (nahSuchmuster) continue;
      setze(px - 2, py - 2, 5, 5);
    }
  }
  // Versionsinformation ab Version 7
  if (version >= 7) {
    setze(groesse - 11, 0, 3, 6);
    setze(0, groesse - 11, 6, 3);
  }
  return karte;
}

function ausrichtungsPositionen(version) {
  if (version === 1) return [];
  const anzahl = Math.floor(version / 7) + 2;
  const letzte = version * 4 + 10;
  const erste = 6;
  if (anzahl === 2) return [erste, letzte];
  const schritt = Math.ceil((letzte - erste) / (anzahl - 1) / 2) * 2;
  const positionen = [erste];
  for (let i = anzahl - 1; i >= 1; i -= 1) positionen.push(letzte - (anzahl - 1 - i) * schritt);
  return positionen.sort((a, b) => a - b);
}

// ---------- Datenbits auslesen ----------

function leseCodewoerter(matrix, groesse, version, maske) {
  const karte = baueFunktionskarte(groesse, version);
  const maskeFn = MASKEN[maske];
  const bits = [];
  let aufwaerts = true;

  for (let rechts = groesse - 1; rechts >= 1; rechts -= 2) {
    if (rechts === 6) rechts -= 1; // Taktspur überspringen
    for (let i = 0; i < groesse; i += 1) {
      const y = aufwaerts ? groesse - 1 - i : i;
      for (let s = 0; s < 2; s += 1) {
        const x = rechts - s;
        if (karte[y][x]) continue;
        let bit = matrix[y][x];
        if (maskeFn(y, x)) bit ^= 1;
        bits.push(bit);
      }
    }
    aufwaerts = !aufwaerts;
  }

  const codewoerter = [];
  for (let i = 0; i + 7 < bits.length; i += 8) {
    let w = 0;
    for (let j = 0; j < 8; j += 1) w = (w << 1) | bits[i + j];
    codewoerter.push(w);
  }
  return codewoerter;
}

// ---------- Blöcke entflechten und korrigieren ----------

function entflechteUndKorrigiere(codewoerter, version, stufe) {
  const eintrag = EC_TABELLE[version];
  if (!eintrag || !eintrag[stufe]) return null;
  const [ecProBlock, bloecke1, laenge1, bloecke2, laenge2] = eintrag[stufe];

  const bloecke = [];
  for (let i = 0; i < bloecke1; i += 1) bloecke.push({ laenge: laenge1, daten: [] });
  for (let i = 0; i < bloecke2; i += 1) bloecke.push({ laenge: laenge2, daten: [] });

  // Datenteil spaltenweise verteilt
  let pos = 0;
  const maxLaenge = Math.max(laenge1, laenge2 || 0);
  for (let i = 0; i < maxLaenge; i += 1) {
    for (const b of bloecke) {
      if (i < b.laenge) { b.daten.push(codewoerter[pos]); pos += 1; }
    }
  }
  // Fehlerkorrekturteil ebenso
  const ecTeile = bloecke.map(() => []);
  for (let i = 0; i < ecProBlock; i += 1) {
    for (let b = 0; b < bloecke.length; b += 1) {
      ecTeile[b].push(codewoerter[pos]); pos += 1;
    }
  }

  const ergebnis = [];
  for (let b = 0; b < bloecke.length; b += 1) {
    const voll = bloecke[b].daten.concat(ecTeile[b]);
    const korrigiert = rsDekodiere(voll, ecProBlock);
    if (!korrigiert) return null;
    ergebnis.push(korrigiert.slice(0, bloecke[b].laenge));
  }
  return [].concat(...ergebnis);
}

// ---------- Nutzdaten auswerten ----------

function leseNutzdaten(daten, version) {
  let bitPos = 0;
  const lies = (n) => {
    let wert = 0;
    for (let i = 0; i < n; i += 1) {
      const byte = daten[bitPos >> 3];
      if (byte === undefined) return wert << (n - i - 1);
      const bit = (byte >> (7 - (bitPos & 7))) & 1;
      wert = (wert << 1) | bit;
      bitPos += 1;
    }
    return wert;
  };

  const zeichenAnzahlBits = (modus) => {
    if (version <= 9) return { 1: 10, 2: 9, 4: 8, 8: 8 }[modus];
    if (version <= 26) return { 1: 12, 2: 11, 4: 16, 8: 10 }[modus];
    return { 1: 14, 2: 13, 4: 16, 8: 12 }[modus];
  };

  let text = '';
  const bytes = [];
  for (let schutz = 0; schutz < 32; schutz += 1) {
    if (bitPos + 4 > daten.length * 8) break;
    const modus = lies(4);
    if (modus === 0) break; // Ende
    const anzahlBits = zeichenAnzahlBits(modus);
    if (!anzahlBits) break;
    const anzahl = lies(anzahlBits);

    if (modus === 4) { // Byte
      for (let i = 0; i < anzahl; i += 1) bytes.push(lies(8));
    } else if (modus === 2) { // Alphanumerisch
      let i = 0;
      while (i + 1 < anzahl) {
        const paar = lies(11);
        text += ALPHANUMERISCH[Math.floor(paar / 45)] + ALPHANUMERISCH[paar % 45];
        i += 2;
      }
      if (i < anzahl) text += ALPHANUMERISCH[lies(6)];
    } else if (modus === 1) { // Numerisch
      let i = 0;
      while (i + 2 < anzahl) { text += String(lies(10)).padStart(3, '0'); i += 3; }
      if (anzahl - i === 2) text += String(lies(7)).padStart(2, '0');
      else if (anzahl - i === 1) text += String(lies(4));
    } else {
      break; // ECI o. Ä. wird nicht unterstützt
    }
  }

  if (bytes.length) {
    // UTF-8 versuchen, sonst Latin-1
    const puffer = Buffer.from(bytes);
    const alsUtf8 = puffer.toString('utf8');
    text = alsUtf8.includes('\uFFFD') ? puffer.toString('latin1') : alsUtf8 + text;
  }
  return text;
}

// ---------- Gesamtablauf ----------

/**
 * Sucht einen QR-Code in einem Graustufenbild.
 * @returns {string|null} Inhalt oder null
 */
function leseQr(grau, breite, hoehe) {
  const bits = binarisiere(grau, breite, hoehe);
  const zentren = findeSuchmuster(bits, breite, hoehe);
  if (zentren.length < 3) return null;

  // Alle Dreierkombinationen der stärksten Kandidaten probieren
  const sortiert = zentren.sort((a, b) => b.n - a.n).slice(0, 6);
  for (let a = 0; a < sortiert.length; a += 1) {
    for (let b = a + 1; b < sortiert.length; b += 1) {
      for (let c = b + 1; c < sortiert.length; c += 1) {
        const ergebnis = versucheDrei(bits, breite, hoehe, [sortiert[a], sortiert[b], sortiert[c]]);
        if (ergebnis) return ergebnis;
      }
    }
  }
  return null;
}

function versucheDrei(bits, breite, hoehe, drei) {
  let geordnet;
  try { geordnet = ordneZentren(drei); } catch { return null; }
  const { obenLinks, obenRechts, untenLinks } = geordnet;

  const basis = schaetzeGroesse(obenLinks, obenRechts, untenLinks);
  // Benachbarte Größen mitprobieren, falls die Schätzung danebenlag
  for (const groesse of [basis, basis + 4, basis - 4]) {
    if (groesse < 21 || groesse > 97) continue;
    const version = (groesse - 17) / 4;
    if (!EC_TABELLE[version]) continue;

    const versuchen = (matrix) => {
      if (!matrix) return null;
      const format = dekodiereFormat(matrix, groesse);
      if (!format) return null;
      const codewoerter = leseCodewoerter(matrix, groesse, version, format.maske);
      const daten = entflechteUndKorrigiere(codewoerter, version, format.stufe);
      if (!daten) return null;
      const text = leseNutzdaten(daten, version);
      return text && text.length > 0 ? text : null;
    };

    // Mit und ohne Ausrichtungsmuster abtasten — je nach Scan ist mal das
    // eine, mal das andere genauer.
    for (const mitAusrichtung of [true, false]) {
      const treffer = versuchen(tasteAb(bits, breite, hoehe, obenLinks, obenRechts, untenLinks, groesse, mitAusrichtung));
      if (treffer) return treffer;
    }

    // Feinkorrektur: Gescannte Seiten sind oft leicht perspektivisch verzerrt.
    // Dann liegt die vierte Ecke nicht dort, wo ein Parallelogramm sie hätte.
    // Die Umgebung wird in kleinen Schritten abgesucht.
    const modul = (obenLinks.groesse + obenRechts.groesse + untenLinks.groesse) / 3;
    const basisX = obenRechts.x + untenLinks.x - obenLinks.x;
    const basisY = obenRechts.y + untenLinks.y - obenLinks.y;
    const schritt = modul / 3;
    for (let ring = 1; ring <= 6; ring += 1) {
      for (let dy = -ring; dy <= ring; dy += 1) {
        for (let dx = -ring; dx <= ring; dx += 1) {
          // Nur den äußeren Rand des jeweiligen Rings prüfen
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
          const treffer = versuchen(tasteAb(
            bits, breite, hoehe, obenLinks, obenRechts, untenLinks, groesse, false,
            { x: basisX + dx * schritt, y: basisY + dy * schritt },
          ));
          if (treffer) return treffer;
        }
      }
    }
  }
  return null;
}

module.exports = { leseQr, binarisiere, findeSuchmuster, ordneZentren, schaetzeGroesse, tasteAb, dekodiereFormat, leseCodewoerter, entflechteUndKorrigiere, leseNutzdaten };
