// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TechFlow IT
//
// Metadata template: placeholders, number handling, legacy names, regex groups.

const test = require('node:test');
const assert = require('node:assert/strict');

const { fuelleVorlage, gruppenAusDateiname } = require('../processing.js');

const values = {
  qrWert: '1234', qrGefunden: true, dateiname: 'scan_0001.pdf', dateinameOhneEndung: 'scan_0001',
  unixzeit: 1767225600, isozeit: '2026-01-01T00:00:00.000Z', groesseBytes: 2048, jobName: 'Scans', festwert: 'X-1',
};

test('fills English placeholders and keeps valid JSON', () => {
  const out = JSON.parse(fuelleVorlage('{"id":"{qrValue}","name":"{filenameWithoutExt}","ts":{unixtime},"fixed":"{fixedValue}","found":{qrFound}}', values));
  assert.deepEqual(out, { id: 1234, name: 'scan_0001', ts: 1767225600, fixed: 'X-1', found: true });
});

test('older German placeholder names still work', () => {
  const out = JSON.parse(fuelleVorlage('{"id":"{qrWert}","file":"{dateiname}","size":{groesseBytes}}', values));
  assert.deepEqual(out, { id: 1234, file: 'scan_0001.pdf', size: 2048 });
});

test('numbers with leading zeros stay text', () => {
  const out = JSON.parse(fuelleVorlage('{"seq":"{qrValue}"}', { ...values, qrWert: '001' }));
  assert.equal(out.seq, '001');
});

test('missing values and unknown placeholders become null', () => {
  const out = JSON.parse(fuelleVorlage('{"id":"{qrValue}","other":"{doesNotExist}","raw":{alsoMissing}}', { ...values, qrWert: null }));
  assert.deepEqual(out, { id: null, other: null, raw: null });
});

test('quotes and backslashes in values are escaped', () => {
  const out = JSON.parse(fuelleVorlage('{"name":"{jobName}"}', { ...values, jobName: 'A "quoted" \\ name' }));
  assert.equal(out.name, 'A "quoted" \\ name');
});

test('named groups from the file name are available as {group:name}', () => {
  const groups = gruppenAusDateiname('1234_001.pdf', '^(?<order>\\d+)_(?<seq>\\d+)');
  assert.deepEqual(groups, { 'gruppe:order': '1234', 'gruppe:seq': '001' });
  const out = JSON.parse(fuelleVorlage('{"order":"{group:order}","seq":"{group:seq}"}', { ...values, ...groups }));
  assert.deepEqual(out, { order: 1234, seq: '001' });
});

test('an invalid regular expression does not throw', () => {
  assert.deepEqual(gruppenAusDateiname('a.pdf', '(?<broken'), {});
});
