// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TechFlow IT
//
// Server-side translation. English is the source language of all texts;
// public/locales/<lang>.json maps an English text to its translation.
// The same catalogs are used by the browser (see public/i18n.js).
//
// Texts produced for a request (API errors, warnings, self-check, CSV exports)
// use the language of the request. Texts produced in the background
// (transfer log, notification e-mails and webhooks) use the language chosen in
// the settings. Log lines keep the language they were written in.

const fs = require('fs');
const path = require('path');

const SUPPORTED = ['en', 'de'];
const DEFAULT_LANGUAGE = 'en';
const LOCALES_DIR = path.join(__dirname, 'public', 'locales');

const catalogs = {};
SUPPORTED.forEach((lang) => {
  try {
    catalogs[lang] = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, `${lang}.json`), 'utf8'));
  } catch {
    catalogs[lang] = {};
  }
});

function normalize(lang) {
  const l = String(lang || '').toLowerCase().slice(0, 2);
  return SUPPORTED.includes(l) ? l : null;
}

/** Translates `text` into `lang` and fills {placeholders} from `params`. */
function t(lang, text, params) {
  const catalog = catalogs[normalize(lang) || DEFAULT_LANGUAGE] || {};
  let out = Object.prototype.hasOwnProperty.call(catalog, text) ? catalog[text] : text;
  if (params) {
    out = out.replace(/\{(\w+)\}/g, (match, key) => (
      Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match));
  }
  return out;
}

/** Locale for Intl date and number formatting. */
function locale(lang) {
  return normalize(lang) === 'de' ? 'de-DE' : 'en-GB';
}

/**
 * Language of an HTTP request: explicit header from the web interface,
 * then a ?lang= parameter (used by downloads), then Accept-Language.
 */
function requestLanguage(req) {
  const header = normalize(req.headers['x-language']);
  if (header) return header;
  try {
    const query = normalize(new URL(req.url, 'http://x').searchParams.get('lang'));
    if (query) return query;
  } catch { /* ignore malformed URLs */ }
  const accept = String(req.headers['accept-language'] || '').split(',')
    .map((part) => normalize(part.trim()))
    .find(Boolean);
  return accept || DEFAULT_LANGUAGE;
}

// Language for background texts — set from the settings by server.js.
let backgroundLanguage = DEFAULT_LANGUAGE;
function setBackgroundLanguage(lang) { backgroundLanguage = normalize(lang) || DEFAULT_LANGUAGE; }
function getBackgroundLanguage() { return backgroundLanguage; }

/** Translation in the background language (log entries, notifications). */
function L(text, params) { return t(backgroundLanguage, text, params); }

/** Returns a translation function bound to the language of a request. */
function forRequest(req) {
  const lang = requestLanguage(req);
  const tr = (text, params) => t(lang, text, params);
  tr.lang = lang;
  tr.locale = locale(lang);
  return tr;
}

module.exports = {
  SUPPORTED, DEFAULT_LANGUAGE, catalogs, t, L, locale, forRequest, requestLanguage,
  setBackgroundLanguage, getBackgroundLanguage, normalize,
};
