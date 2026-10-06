// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TechFlow IT
//
// Translation catalog: every text passed to t()/T()/L() has a German entry,
// and translations use the same {placeholders} as their English source.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const de = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/locales/de.json'), 'utf8'));
const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/locales/en.json'), 'utf8'));
const SOURCES = ['server.js', 'processing.js', 'delivery.js', 'update.js', 'pdf-split.js', 'public/app.js', 'public/anmelden.html'];

function literalKeys(file) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const keys = [];
  const re = /\b(?:t|T|L)\(\s*('(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`)/g;
  for (let m; (m = re.exec(src));) {
    const lit = m[1];
    if (lit.startsWith('`') && lit.includes('${')) continue;   // dynamic, checked elsewhere
    keys.push(vm.runInNewContext(lit));
  }
  return keys;
}

const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test('English catalog is empty (English is the source language)', () => {
  assert.deepEqual(en, {});
});

test('every translated text has a German entry', () => {
  const missing = [];
  for (const file of SOURCES) {
    for (const key of literalKeys(file)) if (!(key in de)) missing.push(`${file}: ${key}`);
  }
  assert.deepEqual(missing, []);
});

test('German entries use the same placeholders as the English text', () => {
  const wrong = Object.entries(de)
    .filter(([k, v]) => placeholders(k).join() !== placeholders(v).join())
    .map(([k]) => k);
  assert.deepEqual(wrong, []);
});

test('no German entry is empty or identical to an untranslated sentence', () => {
  const suspicious = Object.entries(de).filter(([k, v]) => !v.trim() || (v === k && /\b(the|and|with)\b/.test(k)));
  assert.deepEqual(suspicious, []);
});

test('the server-side t() falls back to English and fills placeholders', () => {
  const i18n = require('../i18n.js');
  assert.equal(i18n.t('de', 'Job not found'), de['Job not found']);
  assert.equal(i18n.t('fr', 'Job not found'), 'Job not found');
  assert.equal(i18n.t('en', 'File: {file}', { file: 'a.pdf' }), 'File: a.pdf');
  assert.equal(i18n.t('de', 'File: {file}', { file: 'a.pdf' }), 'Datei: a.pdf');
});
