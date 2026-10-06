// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TechFlow IT
//
// Browser-side translation. English is the source language: the HTML and all
// texts in app.js are written in English. For German, the catalog served as
// /i18n-catalog.js (built from public/locales/de.json) maps each English text
// to its German translation.
//
// - t('Text with {name}', { name }) translates dynamic texts.
// - Static HTML is translated once on load: text nodes, placeholder/title/
//   aria-label attributes and elements marked with data-i18n-html (texts that
//   contain inline markup such as <code> are translated as a whole).
// - The language follows the browser unless the user picked one; the choice is
//   stored in localStorage ("language").

(function () {
  'use strict';

  const STORAGE_KEY = 'language';
  const SUPPORTED = ['en', 'de'];

  function stored() {
    try {
      const v = localStorage.getItem(STORAGE_KEY) || localStorage.getItem('sprache');
      return SUPPORTED.includes(v) ? v : null;
    } catch { return null; }
  }
  function fromBrowser() {
    const n = (navigator.languages && navigator.languages[0]) || navigator.language || '';
    return /^de\b/i.test(n) ? 'de' : 'en';
  }

  const lang = stored() || fromBrowser();
  const catalog = (window.I18N_CATALOGS && window.I18N_CATALOGS[lang]) || {};
  const locale = lang === 'de' ? 'de-DE' : (/^en\b/i.test(navigator.language || '') ? navigator.language : 'en-GB');

  function lookup(text) {
    return Object.prototype.hasOwnProperty.call(catalog, text) ? catalog[text] : null;
  }

  function t(text, params) {
    let out = lookup(text);
    if (out === null) out = text;
    if (params) {
      out = out.replace(/\{(\w+)\}/g, (match, key) => (
        Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match));
    }
    return out;
  }

  const SKIP = new Set(['SCRIPT', 'STYLE', 'CODE', 'PRE', 'TEXTAREA']);
  function skipped(node) {
    for (let el = node.parentElement; el; el = el.parentElement) {
      if (SKIP.has(el.tagName)) return true;
      if (el.hasAttribute('data-no-translate') || el.hasAttribute('data-i18n-html')) return true;
    }
    return false;
  }
  const norm = (s) => s.replace(/\s+/g, ' ').trim();

  function translateStatic(root) {
    if (lang === 'en') return;
    const base = root || document.body;

    base.querySelectorAll('[data-i18n-html]').forEach((el) => {
      const hit = lookup(norm(el.innerHTML));
      if (hit !== null) el.innerHTML = hit;
    });

    const walker = document.createTreeWalker(base, NodeFilter.SHOW_TEXT);
    const changes = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const key = norm(n.nodeValue);
      if (!key || skipped(n)) continue;
      const hit = lookup(key);
      if (hit !== null) {
        const lead = n.nodeValue.match(/^\s*/)[0];
        const trail = n.nodeValue.match(/\s*$/)[0];
        changes.push([n, lead + hit + trail]);
      }
    }
    changes.forEach(([node, value]) => { node.nodeValue = value; });

    base.querySelectorAll('[placeholder],[title],[aria-label]').forEach((el) => {
      ['placeholder', 'title', 'aria-label'].forEach((attr) => {
        const v = el.getAttribute(attr);
        if (!v) return;
        const hit = lookup(norm(v));
        if (hit !== null) el.setAttribute(attr, hit);
      });
    });
  }

  function setLanguage(next) {
    try { localStorage.setItem(STORAGE_KEY, SUPPORTED.includes(next) ? next : 'en'); } catch { /* ignore */ }
    window.location.reload();
  }

  document.documentElement.lang = lang;
  const title = lookup(norm(document.title));
  if (title !== null) document.title = title;
  translateStatic(document.body);

  const toggle = document.getElementById('btn-sprache');
  if (toggle) {
    toggle.textContent = lang === 'de' ? 'EN' : 'DE';
    toggle.addEventListener('click', () => setLanguage(lang === 'de' ? 'en' : 'de'));
  }

  window.I18n = { lang, locale, t, translateStatic, setLanguage };
  window.t = t;
}());
