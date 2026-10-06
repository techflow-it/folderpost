// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 TechFlow IT

// Texts are translated with t() from public/i18n.js (English is the source language).
const LOCALE = (window.I18n && window.I18n.locale) || 'en-GB';
const SPRACHE = (window.I18n && window.I18n.lang) || 'en';
// Marker for “no category” — must match NO_CATEGORY in server.js
const NO_CATEGORY = '__uncategorized__';
const kategorieName = (c) => (c === NO_CATEGORY ? t('Uncategorized') : c);

// ---------- DOM references ----------

const jobsList = document.getElementById('jobs-list');
const logStream = document.getElementById('log-stream');
const filterJob = document.getElementById('filter-job');
const filterStatus = document.getElementById('filter-status');
const logSearch = document.getElementById('log-search');
const jobSearch = document.getElementById('job-search');
const jobSort = document.getElementById('job-sort');
const toastStack = document.getElementById('toast-stack');

const modalBackdrop = document.getElementById('modal-backdrop');
const modalTitle = document.getElementById('modal-title');
const form = document.getElementById('job-form');
const uploadModeSelect = document.getElementById('f-uploadMode');
const multipartWrap = document.getElementById('wrap-multipartField');
const authTypeSelect = document.getElementById('f-authType');
const authFieldsWrap = document.getElementById('wrap-auth-fields');
const authPasswordInput = document.getElementById('f-authPassword');
const togglePasswordBtn = document.getElementById('btn-toggle-password');

const confirmBackdrop = document.getElementById('confirm-backdrop');
const confirmText = document.getElementById('confirm-text');
const confirmOk = document.getElementById('confirm-ok');
const confirmCancel = document.getElementById('confirm-cancel');

const drawerBackdrop = document.getElementById('drawer-backdrop');
const drawerTitle = document.getElementById('drawer-title');
const drawerMeta = document.getElementById('drawer-meta');
const drawerPulse = document.getElementById('drawer-pulse');
const drawerLog = document.getElementById('drawer-log');

let aktiverZeitraum = 14;

const transferBackdrop = document.getElementById('transfer-backdrop');
const importFileInput = document.getElementById('import-file-input');
const importReplaceCheckbox = document.getElementById('import-replace-checkbox');
const importResult = document.getElementById('import-result');

const scheduleEnabledCheckbox = document.getElementById('f-scheduleEnabled');
const scheduleFieldsWrap = document.getElementById('wrap-schedule-fields');

const settingsBackdrop = document.getElementById('settings-backdrop');

let jobsCache = [];
let logsCache = [];
let activeTab = 'uebersicht';
let pendingConfirmAction = null;
let activeCategory = '';
let groupByCategory = localStorage.getItem('groupByCategory') !== 'false';
let eingeklappteKategorien = new Set();
try { eingeklappteKategorien = new Set(JSON.parse(localStorage.getItem('eingeklappteKategorien') || '[]')); } catch { /* ignore */ }
let compactMode = localStorage.getItem('compactMode') === 'true';
let lastStatus = null;
let selectMode = false;
let selectedIds = new Set();
let draggedId = null;
let currentDetailJobId = null;
let showArchived = false;
let warningsDismissed = false;

// ---------- Helpers ----------

// Short, readable time span — the exact time is in the tooltip
function fmtRelativ(ts) {
  if (!ts) return '';
  const sek = Math.round((Date.now() - new Date(ts).getTime()) / 1000);
  if (sek < 10) return t('just now');
  if (sek < 60) return t('{n}s ago', { n: sek });
  if (sek < 3600) return t('{n} min ago', { n: Math.round(sek / 60) });
  if (sek < 86400) return t('{n} h ago', { n: Math.round(sek / 3600) });
  return t('{n} days ago', { n: Math.round(sek / 86400) });
}

function fmtTime(ts) {
  if (!ts) return '–';
  const d = new Date(ts);
  return d.toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function fmtDateTime(ts) {
  if (!ts) return '–';
  const d = new Date(ts);
  return d.toLocaleString(LOCALE, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function fmtDay(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString(LOCALE, { day: '2-digit', month: '2-digit' });
}
function fmtBytes(n) {
  if (!n || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function statusOf(job) {
  if (job.runtime.running) return 'running';
  if (job.runtime.lastResult === 'success') return 'success';
  if (job.runtime.lastResult === 'error') return 'error';
  return 'idle';
}

async function api(path, options) {
  const res = await fetch('/api' + path, { headers: { 'Content-Type': 'application/json', 'X-Language': SPRACHE }, ...options });
  if (res.status === 401) {
    const daten = await res.json().catch(() => ({}));
    if (daten.anmeldungNoetig) { window.location.href = '/anmelden.html'; }
    throw new Error(daten.error || t('Not signed in'));
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || t('Request failed'));
  }
  return res.status === 204 ? null : res.json();
}

function showToast(message, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  toastStack.appendChild(el);
  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 200);
  }, 3200);
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    showToast(t('Copied to clipboard'), 'success');
  } catch {
    showToast(t('Copying is not possible'), 'error');
  }
}

// ---------- Theme (light/dark) ----------

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('theme', theme);
}
(function initTheme() {
  const saved = localStorage.getItem('theme');
  const theme = saved || (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  applyTheme(theme);
})();
document.getElementById('btn-theme-toggle').addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme') || 'dark';
  applyTheme(current === 'dark' ? 'light' : 'dark');
});

// ---------- Tabs ----------

document.getElementById('tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (!btn) return;
  activeTab = btn.dataset.tab;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === btn));
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + activeTab));
  if (activeTab === 'statistik') loadStats();
});

// ---------- Loading ----------

async function loadJobs() {
  jobsCache = await api('/jobs');
  renderFilterOptions();
  renderJobs();
}

async function loadLogsAll() {
  logsCache = await api('/logs?limit=500');
  renderLogs();
  renderJobs(); // The pulse strips in job cards depend on the logs
}

async function loadStatus() {
  const s = await api('/status');
  lastStatus = s;
  document.getElementById('sum-jobs').textContent = s.jobCount;
  document.getElementById('sum-active').textContent = s.activeJobCount;
  renderStateBreakdown(s);
  renderCategoryBar(s);
}

function renderStateBreakdown(s) {
  const st = s.states || {};
  const chips = [];
  if (st.running) chips.push(`<span class="state-chip running"><i></i>${t('{n} running', { n: st.running })}</span>`);
  if (st.failing) chips.push(`<span class="state-chip failing"><i></i>${t('{n} failing', { n: st.failing })}</span>`);
  if (st.paused) chips.push(`<span class="state-chip paused"><i></i>${t('{n} paused', { n: st.paused })}</span>`);
  if (st.outsideSchedule) chips.push(`<span class="state-chip schedule"><i></i>${t('{n} outside time window', { n: st.outsideSchedule })}</span>`);
  document.getElementById('state-breakdown').innerHTML = chips.join('') || `<span class="state-chip idle"><i></i>${t('all normal')}</span>`;

  const cats = (s.categories || []).length;
  document.getElementById('active-breakdown').innerHTML = cats > 1
    ? `<span class="state-chip"><i></i>${t('{n} categories', { n: cats })}</span>`
    : '';
}

function renderCategoryBar(s) {
  const bar = document.getElementById('category-bar');
  const cats = s.categories || [];
  if (cats.length <= 1) { bar.innerHTML = ''; return; }

  const pills = [`<button class="category-pill ${activeCategory === '' ? 'active' : ''}" data-cat="">${t('All')} <span class="count">${s.jobCount}</span></button>`];
  cats.forEach((c) => {
    const warn = c.failing > 0 ? `<span class="warn">⚠ ${c.failing}</span>` : '';
    pills.push(`<button class="category-pill ${activeCategory === c.name ? 'active' : ''}" data-cat="${escapeHtml(c.name)}">${escapeHtml(kategorieName(c.name))} <span class="count">${c.total}</span>${warn}</button>`);
  });
  bar.innerHTML = pills.join('');
}

document.getElementById('category-bar').addEventListener('click', (e) => {
  const pill = e.target.closest('.category-pill');
  if (!pill) return;
  activeCategory = pill.dataset.cat;
  if (lastStatus) renderCategoryBar(lastStatus);
  renderJobs();
});

async function loadOverviewStats() {
  let stats;
  try {
    stats = await api('/stats?days=7');
  } catch {
    return;
  }
  document.getElementById('sum-success').textContent = stats.totals.success;
  document.getElementById('sum-error').textContent = stats.totals.error;
  renderSparklines(stats.perDay);
}

async function loadStats() {
  const days = aktiverZeitraum;
  let stats;
  try {
    stats = await api(`/stats?days=${days}`);
  } catch {
    return;
  }
  renderKpis(stats);
  renderTimelineChart(stats.perDay);
  renderPerJobChart(stats.perJob);
  renderPerCategoryCharts(stats.perCategory);
  renderTargetTable(stats.perTarget);
}

document.getElementById('stats-range-pills').addEventListener('click', (e) => {
  const btn = e.target.closest('.category-pill');
  if (!btn) return;
  aktiverZeitraum = Number(btn.dataset.range) || 14;
  document.querySelectorAll('#stats-range-pills .category-pill').forEach((p) => p.classList.toggle('active', p === btn));
  loadStats();
});

// ---------- Filling the filter dropdown ----------

function renderFilterOptions() {
  const current = filterJob.value;
  filterJob.innerHTML = `<option value="">${t('All jobs')}</option>` +
    jobsCache.map((j) => `<option value="${j.id}">${escapeHtml(j.name)}</option>`).join('');
  filterJob.value = current;
}

// ---------- Rendering jobs ----------

function volumenSparklineDaten(jobId, tage = 7) {
  const heute = new Date(); heute.setHours(0, 0, 0, 0);
  const werte = new Array(tage).fill(0);
  logsCache.forEach((l) => {
    if (l.jobId !== jobId) return;
    const t = new Date(l.ts); t.setHours(0, 0, 0, 0);
    const diffTage = Math.round((heute - t) / 86400000);
    if (diffTage >= 0 && diffTage < tage) werte[tage - 1 - diffTage] += (l.fileSize || 0);
  });
  return werte;
}
function sparklineSvg(werte) {
  if (!werte.some((w) => w > 0)) return '';
  const max = Math.max(...werte, 1);
  const breite = 56;
  const hoehe = 18;
  const n = werte.length;
  const punkte = werte.map((w, i) => {
    const x = n > 1 ? (i / (n - 1)) * breite : breite / 2;
    const y = hoehe - (w / max) * (hoehe - 3) - 1.5;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return `<svg class="job-sparkline" width="${breite}" height="${hoehe}" viewBox="0 0 ${breite} ${hoehe}" preserveAspectRatio="none" aria-hidden="true">`
    + `<polyline points="${punkte}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

function pulseForJob(jobId, limit = 24) {
  return logsCache.filter((l) => l.jobId === jobId).slice(0, limit).reverse();
}

function pulseBarsHtml(entries) {
  if (entries.length === 0) return '<span class="pulse-bar"></span>';
  return entries.map((e) => `<span class="pulse-bar ${e.status}" title="${fmtDateTime(e.ts)} · ${escapeHtml(e.file || '')}"></span>`).join('');
}
function renderPulseStrip(entries, extraClass = '') {
  return `<div class="pulse-strip ${extraClass}">${pulseBarsHtml(entries)}</div>`;
}

function zeigeSkelett() {
  const liste = document.getElementById('jobs-list');
  if (!liste || liste.children.length > 0) return;
  liste.innerHTML = '<div class="skelett"><div class="skelett-zeile"></div><div class="skelett-zeile"></div><div class="skelett-zeile"></div></div>';
}

let letzteJobSignatur = null;
// Remembers per job the timestamp of the last transfer seen, so that a
// card can light up briefly when something new actually arrives —
// not on every redraw for another reason (filter, sorting, ...).
let letzteAktivitaetJeJob = {};
let letzteLogSignatur = null;

function jobSignatur(liste) {
  return JSON.stringify(liste.map((j) => [
    j.id, j.name, j.category, j.active, j.archived, j.sortOrder,
    j.sourcePath, j.targetUrl, j.zielTyp, j.zielOrdner, j.mailAn,
    j.processor, j.stapelTeilen, j.dryRun, j.notes, j.filePattern, j.pollIntervalSec,
    j.runtime.lastResult, j.runtime.consecutiveFailures, j.runtime.waitingCount,
    j.runtime.lastSuccess ? j.runtime.lastSuccess.ts : null,
    (j.runtime.inArbeit || []).map((d) => d.name).join(','),
    // The pulse strip is built from the log. This used to read a server field
    // that does not exist — so the interface did not notice when log data
    // arrived, and the strip stayed empty.
    pulseForJob(j.id, 20).map((e) => (e.status === 'success' ? 'e' : 'f')).join(''),
    // Also needed for the sparkline — otherwise it does not update when only
    // older daily values (outside the last 20 entries) change.
    volumenSparklineDaten(j.id).join(','),
  ])) + '|' + [activeCategory, groupByCategory, compactMode, showArchived, selectMode,
    Array.from(selectedIds).sort().join(','), jobSort.value,
    Array.from(eingeklappteKategorien).sort().join(','),
    document.getElementById('job-search').value].join('|');
}

function renderJobs(erzwingen = false) {
  if (jobsCache.length === 0) {
    jobsList.innerHTML = `
      <div class="empty-state">
        <svg width="34" height="34" viewBox="0 0 24 24" fill="none"><path d="M4 7h16M4 12h16M4 17h10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
        <p class="empty-title">${t('No jobs yet')}</p>
        <p>${t('Create the first transfer job at the top right.')}</p>
      </div>`;
    return;
  }

  const search = jobSearch.value.trim().toLowerCase();
  let list = jobsCache.filter((j) => !search ||
    j.name.toLowerCase().includes(search) ||
    (j.category || '').toLowerCase().includes(search) ||
    j.sourcePath.toLowerCase().includes(search) ||
    j.targetUrl.toLowerCase().includes(search));

  list = list.filter((j) => Boolean(j.archived) === showArchived);

  if (activeCategory) {
    list = list.filter((j) => ((j.category || '').trim() || NO_CATEGORY) === activeCategory);
  }

  const statusRank = { error: 0, running: 1, idle: 2, success: 3 };
  const sortMode = jobSort.value;
  const sortFn = (a, b) => {
    if (sortMode === 'manual') return (a.sortOrder ?? 9999) - (b.sortOrder ?? 9999);
    if (sortMode === 'name') return a.name.localeCompare(b.name, LOCALE);
    // Jobs with a series of errors always on top — they need attention
    const dringend = (j) => ((j.runtime.consecutiveFailures || 0) >= 3 ? 0 : 1);
    if (dringend(a) !== dringend(b)) return dringend(a) - dringend(b);
    if (sortMode === 'recent') return (b.runtime.lastRunTs || 0) - (a.runtime.lastRunTs || 0);
    if (sortMode === 'status') return statusRank[statusOf(a)] - statusRank[statusOf(b)];
    return 0;
  };
  list = [...list].sort(sortFn);

  if (list.length === 0) {
    jobsList.innerHTML = showArchived
      ? `<div class="empty-state"><p class="empty-title">${t('The archive is empty')}</p><p>${t('Jobs that are no longer needed can be moved here via the ⋯ menu of a job card.')}</p></div>`
      : `<div class="empty-state"><p class="empty-title">${t('No matches')}</p><p>${t('Adjust the filter or search term.')}</p></div>`;
    return;
  }

  // Only rebuild if something has really changed — otherwise the list
  // flashes briefly on every refresh every four seconds.
  const signatur = jobSignatur(list);
  if (!erzwingen && signatur === letzteJobSignatur && jobsList.querySelector('.job-card')) {
    tickCountdowns();
    return;
  }
  letzteJobSignatur = signatur;

  jobsList.classList.toggle('compact', compactMode);

  if (groupByCategory && !activeCategory) {
    const groups = new Map();
    list.forEach((job) => {
      const cat = (job.category || '').trim() || NO_CATEGORY;
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat).push(job);
    });
    const sortedGroups = Array.from(groups.entries()).sort((a, b) => {
      if (a[0] === NO_CATEGORY) return 1;
      if (b[0] === NO_CATEGORY) return -1;
      return a[0].localeCompare(b[0], LOCALE);
    });
    jobsList.innerHTML = sortedGroups.map(([cat, jobs]) => {
      const failing = jobs.filter((j) => (j.runtime.consecutiveFailures || 0) >= 3).length;
      const warn = failing ? ` · <span style="color:var(--error)">${t('{n} failing', { n: failing })}</span>` : '';
      const eingeklappt = eingeklappteKategorien.has(cat);
      return `<div class="job-group-head" data-kategorie="${escapeHtml(cat)}" role="button" tabindex="0" aria-expanded="${!eingeklappt}">`
        + `<span class="grp-chevron${eingeklappt ? ' eingeklappt' : ''}" aria-hidden="true">▾</span>`
        + `${escapeHtml(kategorieName(cat))} <span class="grp-count">${jobs.length}${warn}</span></div>`
        + `<div class="job-group-body${eingeklappt ? ' eingeklappt' : ''}">`
        + jobs.map((job) => renderJobCard(job, false)).join('') + `</div>`;
    }).join('');
  } else {
    jobsList.innerHTML = list.map((job) => renderJobCard(job, true)).join('');
  }

  // Let cards with a newly arrived transfer light up briefly
  list.forEach((job) => {
    const neuester = logsCache.find((l) => l.jobId === job.id);
    const zeit = neuester ? neuester.ts : null;
    const vorher = letzteAktivitaetJeJob[job.id];
    if (zeit && vorher !== undefined && vorher !== zeit) {
      const karte = jobsList.querySelector(`.job-card[data-id="${job.id}"]`);
      if (karte) {
        karte.classList.add('frisch');
        setTimeout(() => karte.classList.remove('frisch'), 1600);
      }
    }
    letzteAktivitaetJeJob[job.id] = zeit;
  });

  tickCountdowns();
}

function lastSuccessHtml(job) {
  if (!job.lastSuccess) return `<span class="last-success never">${t('never transferred successfully')}</span>`;
  const alter = Date.now() - new Date(job.lastSuccess.ts).getTime();
  const tage = alter / 86400000;
  const stunden = alter / 3600000;
  let text;
  if (stunden < 1) text = t('a few minutes ago');
  else if (stunden < 24) text = t('{n} h ago', { n: Math.round(stunden) });
  else text = t('{n} day(s) ago', { n: Math.round(tage) });
  const klasse = tage > 2 ? 'stale' : '';
  return `<span class="last-success ${klasse}">${t('last success: {when} ({time})', { when: text, time: fmtDateTime(job.lastSuccess.ts) })}</span>`;
}

function zielBeschreibung(job) {
  if (job.zielTyp === 'ordner') return job.zielOrdner || t('(no target folder)');
  if (job.zielTyp === 'email') return t('E-mail to {to}', { to: job.mailAn || t('(no recipient)') });
  return job.targetUrl;
}

function normalisierePfad(p) {
  return (p || '').replace(/[/\\]+$/, '').replace(/\\/g, '/').toLowerCase();
}
function geteilteOrdnerJobs(job) {
  const eigener = normalisierePfad(job.sourcePath);
  if (!eigener) return [];
  return jobsCache.filter((j) => j.id !== job.id && !j.archived && normalisierePfad(j.sourcePath) === eigener).map((j) => j.name);
}

function renderJobCard(job, showCategoryTag) {
  const st = statusOf(job);
  const pulse = pulseForJob(job.id, 20);
  const failures = job.runtime.consecutiveFailures || 0;
  const failureBadge = failures >= 3 ? `<span class="failure-badge">⚠ ${t('{n}× failed in a row', { n: failures })}</span>` : '';
  const pausedBadge = !job.active ? `<span class="paused-badge">${t('Paused')}</span>` : '';
  const outsideScheduleBadge = job.active && job.scheduleEnabled && !job.runtime.withinSchedule ? `<span class="paused-badge">${t('Outside time window')}</span>` : '';
  const categoryTag = showCategoryTag && job.category ? `<span class="job-category-tag">${escapeHtml(job.category)}</span>` : '';
  const dryRunBadge = job.dryRun ? `<span class="dryrun-badge">${t('Test mode')}</span>` : '';
  const stapelBadge = job.stapelTeilen
    ? `<span class="umwandlung-badge" title="${t('Batch scans are split into single documents at the QR codes')}">✂ ${t('Batch')}</span>`
    : '';
  const umwandlungBadge = job.processor === 'pdf-qr-json'
    ? `<span class="umwandlung-badge" title="${job.sendeFormat === 'multipart-metadata' ? t('The PDF is evaluated and sent as a multipart form') : t('The PDF is evaluated and sent as JSON')}">⇄ ${t('Conversion')}</span>`
    : '';
  const archivedBadge = job.archived ? `<span class="archived-badge">${t('Archived')}</span>` : '';
  const noteHtml = job.notes ? `<div class="job-note">${escapeHtml(job.notes)}</div>` : '';
  const erfolg = lastSuccessHtml(job);
  const multiTargetNote = (job.extraTargetUrls || []).length > 0 ? ` <span style="color:var(--accent)">${t('+{n} target(s)', { n: job.extraTargetUrls.length })}</span>` : '';
  const nextScan = job.active && job.runtime.nextDueTs ? `<span class="next-scan" data-due="${job.runtime.nextDueTs}"><span>${t('next scan')}</span> …</span>` : '';
  const waitingNote = job.runtime.waitingCount > 0 ? ` · <span style="color:var(--warning)">${t('{n} waiting for settle time', { n: job.runtime.waitingCount })}</span>` : '';

  // Which file is running right now — the most meaningful hint during a transfer
  const inArbeit = job.runtime.inArbeit || [];
  const arbeitZeile = inArbeit.length === 0 ? '' : `
      <div class="in-arbeit">
        <span class="arbeit-spinner"></span>
        <span class="arbeit-text">
          ${escapeHtml(inArbeit[0].name)}
          ${inArbeit.length > 1 ? `<span class="arbeit-weitere">${t('and {n} more', { n: inArbeit.length - 1 })}</span>` : ''}
        </span>
        <span class="arbeit-dauer" data-seit="${inArbeit[0].seit}">…</span>
      </div>`;
  const isSorting = jobSort.value === 'manual';
  const selectBox = selectMode ? `<input type="checkbox" class="job-select" data-select="${job.id}" ${selectedIds.has(job.id) ? 'checked' : ''}>` : '';
  const dragHandle = isSorting ? `<span class="drag-handle" title="${t('Drag to sort')}"><svg width="12" height="12" viewBox="0 0 12 12" fill="none"><circle cx="4" cy="2.5" r="1" fill="currentColor"/><circle cx="8" cy="2.5" r="1" fill="currentColor"/><circle cx="4" cy="6" r="1" fill="currentColor"/><circle cx="8" cy="6" r="1" fill="currentColor"/><circle cx="4" cy="9.5" r="1" fill="currentColor"/><circle cx="8" cy="9.5" r="1" fill="currentColor"/></svg></span>` : '';
  return `
    <div class="job-card ${job.active ? '' : 'inactive'} ${job.archived ? 'archived' : ''} status-${st} ${(job.runtime.consecutiveFailures || 0) >= 3 ? 'dringend' : ''} ${selectedIds.has(job.id) ? 'selected' : ''}" data-id="${job.id}" ${isSorting ? 'draggable="true"' : ''}>
      <div class="job-top">
        ${selectBox}${dragHandle}
        <span class="status-dot ${st}"></span>
        <span class="job-name">${escapeHtml(job.name)}</span>
        ${categoryTag}${umwandlungBadge}${stapelBadge}${dryRunBadge}${archivedBadge}${pausedBadge}${outsideScheduleBadge}
        <span class="job-time" title="${job.runtime.lastRunTs ? escapeHtml(fmtDateTime(job.runtime.lastRunTs)) : ''}">${job.runtime.lastRunTs ? fmtRelativ(job.runtime.lastRunTs) : t('never run')}</span>
      </div>
      <p class="job-meta pfad-zeile" data-no-translate title=""${escapeHtml(job.sourcePath)} → ${escapeHtml(zielBeschreibung(job))}">
        <span class="pfad">${escapeHtml(job.sourcePath)}</span>
        <span class="job-arrow">→</span>
        <span class="pfad">${escapeHtml(zielBeschreibung(job))}</span>${multiTargetNote}${failureBadge}
      </p>
      ${geteilteOrdnerJobs(job).length ? `<p class="job-meta job-shared-folder"><span>${t('Shares the folder with')}</span>: <span data-no-translate>${geteilteOrdnerJobs(job).map(escapeHtml).join(', ')}</span></p>` : ''}
      <p class="job-meta"><span>${t('Filter')}</span>: <span data-no-translate>${escapeHtml(job.filePattern)}</span> · <span>${t('every')}</span> ${job.pollIntervalSec}s${waitingNote} ${nextScan}</p>
      <p class="job-meta">${erfolg}</p>
      ${arbeitZeile}
      ${noteHtml}
      <div class="pulse-row" title="${t('Data volume of the last 7 days')}">
        ${renderPulseStrip(pulse)}
        ${sparklineSvg(volumenSparklineDaten(job.id))}
      </div>
      <div class="job-actions">
        <button class="btn" data-action="run">${t('Run now')}</button>
        <button class="btn" data-action="toggle">${job.active ? t('Pause') : t('Activate')}</button>
        <button class="btn" data-action="edit">${t('Edit')}</button>
        <div class="overflow-wrap">
          <button class="btn" data-action="menu" aria-label="${t('More actions')}">⋯</button>
          <div class="overflow-menu hidden" data-card-menu>
            <button class="menu-item" data-action="warteschlange"><span class="check"></span>${t('Queue …')}</button>
            <button class="menu-item" data-action="duplicate"><span class="check"></span>${t('Duplicate')}</button>
            ${job.archived
              ? `<button class="menu-item" data-action="unarchive"><span class="check"></span>${t('Restore from archive')}</button>`
                + (darfVerwalten ? `<button class="menu-item" data-action="delete"><span class="check"></span>${t('Delete permanently')}</button>` : '')
              : `<button class="menu-item" data-action="archive"><span class="check"></span>${t('Move to archive')}</button>`}
          </div>
        </div>
      </div>
    </div>`;
}

function tickCountdowns() {

  document.querySelectorAll('.arbeit-dauer[data-seit]').forEach((el) => {
    const s = Math.max(0, Math.round((Date.now() - Number(el.dataset.seit)) / 1000));
    el.textContent = s < 60 ? t('for {s}s', { s }) : t('for {time} min', { time: `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` });
  });
  document.querySelectorAll('.next-scan[data-due]').forEach((el) => {
    const due = Number(el.dataset.due);
    const remaining = Math.round((due - Date.now()) / 1000);
    if (remaining <= 0) { el.innerHTML = `<span>${t('next scan')}</span> …`; }
    else { el.innerHTML = `<span>${t('next scan in')}</span> ${remaining}s`; }
  });
}
setInterval(tickCountdowns, 1000);

jobSearch.addEventListener('input', renderJobs);
jobSort.addEventListener('change', renderJobs);

const btnGrouping = document.getElementById('btn-toggle-grouping');
const btnDensity = document.getElementById('btn-toggle-density');
const viewMenu = document.getElementById('view-menu');
function syncViewToggles() {
  btnGrouping.classList.toggle('checked', groupByCategory);
  btnDensity.classList.toggle('checked', compactMode);
}
document.getElementById('btn-view-menu').addEventListener('click', (e) => {
  e.stopPropagation();
  viewMenu.classList.toggle('hidden');
});
btnGrouping.addEventListener('click', () => {
  groupByCategory = !groupByCategory;
  localStorage.setItem('groupByCategory', String(groupByCategory));
  syncViewToggles();
  renderJobs();
});
btnDensity.addEventListener('click', () => {
  compactMode = !compactMode;
  localStorage.setItem('compactMode', String(compactMode));
  syncViewToggles();
  renderJobs();
});

// Close menus as soon as the user clicks elsewhere
document.addEventListener('click', (e) => {
  if (!e.target.closest('#view-menu') && !e.target.closest('#btn-view-menu')) viewMenu.classList.add('hidden');
  if (!e.target.closest('[data-card-menu]') && !e.target.closest('[data-action="menu"]')) {
    document.querySelectorAll('[data-card-menu]').forEach((m) => m.classList.add('hidden'));
  }
});
syncViewToggles();

// ---------- Multi-select & bulk actions ----------

const bulkBar = document.getElementById('bulk-bar');
const btnSelectMode = document.getElementById('btn-toggle-select');

function syncBulkBar() {
  btnSelectMode.classList.toggle('toggled', selectMode);
  bulkBar.classList.toggle('hidden', !selectMode);
  document.getElementById('bulk-count').textContent = t('{n} selected', { n: selectedIds.size });
}

btnSelectMode.addEventListener('click', () => {
  selectMode = !selectMode;
  if (!selectMode) selectedIds.clear();
  syncBulkBar();
  renderJobs();
});

document.getElementById('bulk-clear').addEventListener('click', () => {
  selectedIds.clear();
  syncBulkBar();
  renderJobs();
});

jobsList.addEventListener('click', (e) => {
  const kopf = e.target.closest('.job-group-head');
  if (!kopf) return;
  const cat = kopf.dataset.kategorie;
  const eingeklappt = eingeklappteKategorien.has(cat);
  if (eingeklappt) eingeklappteKategorien.delete(cat); else eingeklappteKategorien.add(cat);
  localStorage.setItem('eingeklappteKategorien', JSON.stringify([...eingeklappteKategorien]));
  kopf.setAttribute('aria-expanded', String(eingeklappt));
  kopf.querySelector('.grp-chevron').classList.toggle('eingeklappt', !eingeklappt);
  const koerper = kopf.nextElementSibling;
  if (koerper && koerper.classList.contains('job-group-body')) koerper.classList.toggle('eingeklappt', !eingeklappt);
});
jobsList.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const kopf = e.target.closest('.job-group-head');
  if (!kopf) return;
  e.preventDefault();
  kopf.click();
});

jobsList.addEventListener('change', (e) => {
  const cb = e.target.closest('.job-select[data-select]');
  if (!cb) return;
  if (cb.checked) selectedIds.add(cb.dataset.select); else selectedIds.delete(cb.dataset.select);
  syncBulkBar();
  const card = cb.closest('.job-card');
  if (card) card.classList.toggle('selected', cb.checked);
});

bulkBar.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-bulk]');
  if (!btn) return;
  const action = btn.dataset.bulk;
  const ids = Array.from(selectedIds);
  if (ids.length === 0) { showToast(t('No jobs selected'), 'error'); return; }

  if (action === 'setCategory') {
    const cat = prompt(t('Set the category for {n} job(s) (empty = remove the assignment):', { n: ids.length }), '');
    if (cat === null) return;
    try {
      const r = await api('/jobs/bulk', { method: 'POST', body: JSON.stringify({ ids, action: 'setCategory', category: cat }) });
      showToast(t('Category set for {n} job(s)', { n: r.affected }), 'success');
      selectedIds.clear(); syncBulkBar();
      await loadJobs(); await loadStatus();
    } catch (err) { showToast(err.message, 'error'); }
    return;
  }

  if (action === 'delete') {
    askConfirm(
      t('{n} job(s) will be deleted permanently. Files that were already transferred are not affected.', { n: ids.length }),
      t('Delete'),
      async () => {
        const r = await api('/jobs/bulk', { method: 'POST', body: JSON.stringify({ ids, action: 'delete' }) });
        showToast(t('{n} job(s) deleted', { n: r.affected }), 'success');
        selectedIds.clear(); syncBulkBar();
        await loadJobs(); await loadStatus();
      });
    return;
  }

  try {
    const r = await api('/jobs/bulk', { method: 'POST', body: JSON.stringify({ ids, action }) });
    showToast(action === 'activate' ? t('{n} job(s) activated', { n: r.affected }) : t('{n} job(s) paused', { n: r.affected }), 'success');
    await loadJobs(); await loadStatus();
  } catch (err) { showToast(err.message, 'error'); }
});

// ---------- Drag & drop (custom order) ----------

jobsList.addEventListener('dragstart', (e) => {
  const card = e.target.closest('.job-card[draggable="true"]');
  if (!card) return;
  draggedId = card.dataset.id;
  card.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
});

jobsList.addEventListener('dragover', (e) => {
  if (!draggedId) return;
  e.preventDefault();
  const card = e.target.closest('.job-card');
  document.querySelectorAll('.job-card.drop-target').forEach((c) => c.classList.remove('drop-target'));
  if (card && card.dataset.id !== draggedId) card.classList.add('drop-target');
});

jobsList.addEventListener('drop', async (e) => {
  e.preventDefault();
  const target = e.target.closest('.job-card');
  document.querySelectorAll('.job-card.drop-target').forEach((c) => c.classList.remove('drop-target'));
  if (!draggedId || !target || target.dataset.id === draggedId) { draggedId = null; return; }

  const order = Array.from(jobsList.querySelectorAll('.job-card')).map((c) => c.dataset.id);
  const from = order.indexOf(draggedId);
  const to = order.indexOf(target.dataset.id);
  order.splice(to, 0, order.splice(from, 1)[0]);
  draggedId = null;

  try {
    await api('/jobs/reorder', { method: 'POST', body: JSON.stringify({ order }) });
    await loadJobs();
  } catch (err) { showToast(err.message, 'error'); }
});

jobsList.addEventListener('dragend', () => {
  document.querySelectorAll('.job-card.dragging').forEach((c) => c.classList.remove('dragging'));
  document.querySelectorAll('.job-card.drop-target').forEach((c) => c.classList.remove('drop-target'));
  draggedId = null;
});

// ---------- Rendering the log stream ----------

function renderLogEntry(l) {
  const full = l.message || '';
  const isLong = full.length > 160;
  const shortText = full.slice(0, 160);
  // Sending again is also possible for successful transfers —
  // but shown discreetly there and with a confirmation, so that
  // nothing ends up at the receiving side twice by accident.
  const warErfolg = l.status === 'success';
  const retryBtn = l.file && l.jobId
    ? `<button class="retry-btn${warErfolg ? ' erneut-erfolg' : ''}" data-retry-job="${l.jobId}" data-retry-file="${escapeHtml(l.file)}" data-retry-erfolg="${warErfolg ? '1' : ''}" title="${warErfolg ? t('Send this already transferred file again') : t('Resend this file')}">↻ ${warErfolg ? t('send again') : t('resend')}</button>`
    : '';
  const downloadBtn = l.file && l.jobId
    ? `<a class="retry-btn download-btn" href="/api/download?jobId=${encodeURIComponent(l.jobId)}&file=${encodeURIComponent(l.file)}" title="${t('Download file')}">↓ ${t('download')}</a>`
    : '';
  // Only for entries that come from a conversion — otherwise the
  // button is everywhere and causes more clutter than it helps.
  const ausUmwandlung = l.qrGefunden !== undefined || l.gesendeteMetadaten !== undefined;
  const pruefBtn = ausUmwandlung && l.file && l.jobId
    ? `<button class="retry-btn" data-pruef-job="${l.jobId}" data-pruef-file="${escapeHtml(l.file)}" title="${t('Shows which data is sent for this file')}">⌕ ${t('sent data')}</button>`
    : '';
  return `
    <div class="log-entry">
      <span class="dot ${l.status}"></span>
      <span class="log-time">${fmtTime(l.ts)}</span>
      <span class="log-main">
        <span class="file">${escapeHtml(l.file || t('(folder error)'))}</span> · <span class="job">${escapeHtml(l.jobName)}</span>
        <span class="msg" data-full="${escapeHtml(full)}" data-short="${escapeHtml(shortText)}">${escapeHtml(shortText)}${isLong ? `<span class="expand-hint">${t('show more')}</span>` : ''}</span>
        ${retryBtn}${downloadBtn}${pruefBtn}
      </span>
      <span class="log-status ${l.status}">${l.httpStatus ? 'HTTP ' + l.httpStatus : (l.status === 'error' ? t('Error') : '')}</span>
    </div>`;
}

async function handleRetryClick(e) {
  const btn = e.target.closest('.retry-btn[data-retry-file]');
  if (!btn) return;
  const jobId = btn.dataset.retryJob;
  const file = btn.dataset.retryFile;
  const warErfolg = btn.dataset.retryErfolg === '1';
  const beschriftung = btn.textContent;

  const senden = async () => {
    btn.disabled = true;
    btn.textContent = t('sending …');
    try {
      const result = await api('/logs/retry', { method: 'POST', body: JSON.stringify({ jobId, file }) });
      showToast(
        result.ok ? t('“{file}” resent', { file }) : t('Retry failed: {error}', { error: result.message }),
        result.ok ? 'success' : 'error',
      );
    } catch (err) {
      showToast(err.message, 'error');
    }
    btn.disabled = false;
    btn.textContent = beschriftung;
    await loadLogsAll();
    if (drawerBackdrop.classList.contains('open')) {
      const current = jobsCache.find((j) => j.id === jobId);
      if (current) openDrawer(current);
    }
  };

  // Ask for successful transfers: the receiving side then
  // gets the file a second time.
  if (warErfolg) {
    const job = jobsCache.find((j) => j.id === jobId);
    askConfirm(
      t('“{file}” was already transferred successfully. If you send it again, the receiving side gets the file a second time — this can create duplicate records there.', { file })
      + (job && job.dedupe ? ' ' + t('Note: duplicate detection is active for this job; it does not apply to manual sending.') : ''),
      t('Send again'),
      senden,
      t('Send the file again?'),
    );
    return;
  }
  await senden();
}

// While a search is active, the log shows matches from the server instead of
// the continuously updated last 500 entries — this way the search also finds
// older transfers, not only the ones loaded most recently.
let logSucheAktiv = false;
let logSucheLaeuft = 0;

function renderLogs() {
  if (logSucheAktiv) return; // live updating is paused while searching
  let logs = logsCache;
  if (filterJob.value) logs = logs.filter((l) => l.jobId === filterJob.value);
  if (filterStatus.value) logs = logs.filter((l) => l.status === filterStatus.value);

  if (logs.length === 0) {
    letzteLogSignatur = 'leer';
    logStream.innerHTML = `<div class="empty-state"><p>${t('No entries yet.')}</p></div>`;
    return;
  }
  // Here too: only rebuild on an actual change
  const logSig = JSON.stringify(logs.slice(0, 200).map((l) => [l.ts, l.file, l.status, l.httpStatus, l.jobId]));
  if (logSig === letzteLogSignatur && logStream.querySelector('.log-entry')) return;
  letzteLogSignatur = logSig;

  logStream.innerHTML = logs.slice(0, 200).map(renderLogEntry).join('');
}

async function fuehreLogSucheAus() {
  const begriff = logSearch.value.trim();
  if (!begriff) {
    logSucheAktiv = false;
    letzteLogSignatur = null; // forces a clean rebuild of the live view
    renderLogs();
    return;
  }
  logSucheAktiv = true;
  const laufNr = (logSucheLaeuft += 1);
  const params = new URLSearchParams({ q: begriff, limit: '200' });
  if (filterJob.value) params.set('jobId', filterJob.value);
  if (filterStatus.value) params.set('status', filterStatus.value);
  let treffer;
  try {
    treffer = await api('/logs?' + params.toString());
  } catch {
    return; // e.g. briefly not signed in — the next input tries again
  }
  if (laufNr !== logSucheLaeuft) return; // searched again in the meantime — discard this result
  logStream.innerHTML = `<p class="log-such-status">${t('{n} matches for “{term}”', { n: treffer.length, term: escapeHtml(begriff) })}</p>`
    + (treffer.length === 0
      ? `<div class="empty-state"><p>${t('No matches — try another search term.')}</p></div>`
      : treffer.map(renderLogEntry).join(''));
}

let logSucheTimer = null;
logSearch.addEventListener('input', () => {
  clearTimeout(logSucheTimer);
  logSucheTimer = setTimeout(fuehreLogSucheAus, 300);
});

logStream.addEventListener('click', (e) => {
  if (e.target.closest('.retry-btn')) { handleRetryClick(e); return; }
  const msg = e.target.closest('.msg[data-full]');
  if (!msg) return;
  const expanded = msg.classList.toggle('expanded');
  msg.innerHTML = expanded
    ? escapeHtml(msg.dataset.full) + `<span class="expand-hint">${t('show less')}</span>`
    : escapeHtml(msg.dataset.short) + (msg.dataset.full.length > 160 ? `<span class="expand-hint">${t('show more')}</span>` : '');
});

filterJob.addEventListener('change', () => (logSucheAktiv ? fuehreLogSucheAus() : renderLogs()));
filterStatus.addEventListener('change', () => (logSucheAktiv ? fuehreLogSucheAus() : renderLogs()));

document.getElementById('btn-export-logs').addEventListener('click', () => {
  const params = new URLSearchParams();
  if (filterJob.value) params.set('jobId', filterJob.value);
  if (filterStatus.value) params.set('status', filterStatus.value);
  if (logSucheAktiv && logSearch.value.trim()) params.set('q', logSearch.value.trim());
  params.set('lang', SPRACHE);
  window.open('/api/logs/export?' + params.toString(), '_blank');
});

document.getElementById('btn-export-stats').addEventListener('click', () => {
  window.open(`/api/stats/export?days=${aktiverZeitraum}&lang=${SPRACHE}`, '_blank');
});

document.getElementById('btn-reset-stats').addEventListener('click', () => {
  askConfirm(
    t('The entire transfer log will be deleted irrevocably — including the statistics history, activity strips and error counters on the job cards. Jobs and their settings are kept.'),
    t('Reset'),
    async () => {
      await api('/logs', { method: 'DELETE' });
      showToast(t('Log and statistics reset'), 'success');
      await zeigeSkelett();
refreshAll();
    });
});

// ---------- Sparklines (success/error trend) ----------

function renderSparklines(perDay) {
  drawSparkline('spark-success', perDay.map((d) => d.success), 'var(--success)');
  drawSparkline('spark-error', perDay.map((d) => d.error), 'var(--error)');
}
function drawSparkline(id, values, color) {
  const svg = document.getElementById(id);
  if (!svg) return;
  const max = Math.max(1, ...values);
  const w = 100; const h = 26;
  const step = values.length > 1 ? w / (values.length - 1) : w;
  const points = values.map((v, i) => `${(i * step).toFixed(1)},${(h - (v / max) * (h - 3) - 1.5).toFixed(1)}`).join(' ');
  svg.innerHTML = `<polyline points="${points}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`;
}

// ---------- Job actions (cards) ----------

jobsList.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  const card = e.target.closest('.job-card');
  if (!card) return;
  const id = card.dataset.id;
  const job = jobsCache.find((j) => j.id === id);

  if (!btn) { openDrawer(job); return; }
  const action = btn.dataset.action;

  if (action === 'menu') {
    const menu = btn.parentElement.querySelector('[data-card-menu]');
    const wasHidden = menu.classList.contains('hidden');
    document.querySelectorAll('[data-card-menu]').forEach((m) => m.classList.add('hidden'));
    menu.classList.toggle('hidden', !wasHidden);
    return;
  }
  document.querySelectorAll('[data-card-menu]').forEach((m) => m.classList.add('hidden'));

  try {
    if (action === 'run') {
      await api(`/jobs/${id}/run-now`, { method: 'POST' });
      showToast(t('“{job}” is running …', { job: job.name }), 'info');
    } else if (action === 'toggle') {
      await api(`/jobs/${id}/toggle`, { method: 'POST' });
      showToast(job.active ? t('“{job}” paused', { job: job.name }) : t('“{job}” activated', { job: job.name }), 'info');
    } else if (action === 'edit') {
      openModal(job);
    } else if (action === 'warteschlange') {
      zeigeWarteschlange(job.id, job.name);
    } else if (action === 'duplicate') {
      const { id: _oldId, runtime: _rt, authPasswordSet: _aps, ...jobData } = job;
      const copy = await api('/jobs', { method: 'POST', body: JSON.stringify({ ...jobData, name: job.name + ' ' + t('(copy)') }) });
      showToast(job.authPasswordSet ? t('“{job}” duplicated — please enter the password again', { job: job.name }) : t('“{job}” duplicated', { job: job.name }), 'success');
      await loadJobs();
      openModal(jobsCache.find((j) => j.id === copy.id));
    } else if (action === 'archive') {
      await api(`/jobs/${job.id}/archive`, { method: 'POST', body: JSON.stringify({ archived: true }) });
      showToast(t('“{job}” moved to the archive', { job: job.name }), 'info');
      await loadJobs(); await loadStatus();
    } else if (action === 'unarchive') {
      await api(`/jobs/${job.id}/archive`, { method: 'POST', body: JSON.stringify({ archived: false }) });
      showToast(t('“{job}” restored from the archive — still paused', { job: job.name }), 'success');
      await loadJobs(); await loadStatus();
    } else if (action === 'delete') {
      askConfirm(
        t('Job “{job}” will be deleted permanently. Files that were already transferred are not affected.', { job: job.name }),
        t('Delete'),
        async () => {
          await api(`/jobs/${job.id}`, { method: 'DELETE' });
          showToast(t('“{job}” deleted', { job: job.name }), 'success');
          await loadJobs();
        });
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
  if (!['delete', 'duplicate', 'archive', 'unarchive'].includes(action)) await loadJobs();
});

function askConfirm(text, okLabel, action, titel) {
  confirmText.textContent = text;
  confirmOk.textContent = okLabel;
  // Heading that matches the action — otherwise every prompt would say
  // “Really delete?”, even when nothing is deleted.
  const kopf = document.getElementById('confirm-title');
  if (kopf) kopf.textContent = titel || `${okLabel}?`;
  // Only real delete operations in the warning colour
  const loeschend = /löschen|entfernen|zurücksetzen|delete|remove|reset/i.test(okLabel);
  confirmOk.classList.toggle('btn-danger', loeschend);
  confirmOk.classList.toggle('btn-primary', !loeschend);
  pendingConfirmAction = action;
  confirmBackdrop.classList.add('open');
}
function closeConfirm() {
  confirmBackdrop.classList.remove('open');
  pendingConfirmAction = null;
  confirmOk.textContent = t('Delete');
  confirmOk.classList.add('btn-danger');
  confirmOk.classList.remove('btn-primary');
  const kopf = document.getElementById('confirm-title');
  if (kopf) kopf.textContent = t('Really delete?');
}

confirmCancel.addEventListener('click', closeConfirm);
confirmBackdrop.addEventListener('click', (e) => { if (e.target === confirmBackdrop) closeConfirm(); });
confirmOk.addEventListener('click', async () => {
  if (!pendingConfirmAction) return;
  try {
    await pendingConfirmAction();
  } catch (err) {
    showToast(err.message, 'error');
  }
  closeConfirm();
});

// ---------- Drawer (job details) ----------

// Combines the most important signals of a job into a single state
// — more practical than looking up three separate values.
function berechneJobHealth(job) {
  if (!job.active) return { klasse: 'pausiert', text: 'Paused' };
  const failures = job.runtime.consecutiveFailures || 0;
  if (failures >= 3) return { klasse: 'kritisch', text: 'Critical' };

  const letzterErfolg = job.lastSuccess ? new Date(job.lastSuccess.ts).getTime() : null;
  // Overdue from ten times the scan interval, but at least 24 hours —
  // so that rarely running jobs are not permanently flagged as critical by mistake.
  const schwelle = Math.max((job.pollIntervalSec || 60) * 10 * 1000, 24 * 60 * 60 * 1000);
  if (letzterErfolg === null) return { klasse: 'beobachten', text: 'No transfer yet' };
  if (Date.now() - letzterErfolg > schwelle) return { klasse: 'beobachten', text: 'No transfer for a while' };
  if (failures > 0) return { klasse: 'beobachten', text: 'Keep an eye on it' };
  return { klasse: 'gut', text: 'Good' };
}

function copyRow(label, value) {
  return `<div class="drawer-meta-row"><span class="k">${label}</span><span class="v">${escapeHtml(value)}<button type="button" class="copy-btn" data-copy="${escapeHtml(value)}" title="${t('Copy')}" aria-label="${t('Copy {what}', { what: label })}"><svg width="13" height="13" viewBox="0 0 13 13" fill="none"><rect x="4.5" y="4.5" width="7" height="7" rx="1.2" stroke="currentColor" stroke-width="1.1"/><path d="M2.5 8.5v-6A1 1 0 0 1 3.5 1.5h6" stroke="currentColor" stroke-width="1.1"/></svg></button></span></div>`;
}

const STATUS_TEXT = { running: 'running', success: 'success', error: 'error', idle: 'idle' };
const WOCHENTAG = { MO: 'Mon', TU: 'Tue', WE: 'Wed', TH: 'Thu', FR: 'Fri', SA: 'Sat', SU: 'Sun' };

function detailMetaHtml(job) {
  const st = statusOf(job);
  const health = berechneJobHealth(job);
  return `
    <div class="health-badge health-${health.klasse}"><span>${t(health.text)}</span></div>
    <div class="drawer-meta-row"><span class="k">${t('Status')}</span><span class="v">${job.active ? t(STATUS_TEXT[st] || st) : t('paused')}</span></div>
    ${(job.runtime.inArbeit || []).length ? `<div class="drawer-meta-row"><span class="k">${t('In progress')}</span><span class="v" style="color:var(--accent);text-align:right">${job.runtime.inArbeit.map((d) => escapeHtml(d.name)).join('<br>')}</span></div>` : ''}
    <div class="drawer-meta-row"><span class="k">${t('Category')}</span><span class="v">${escapeHtml(job.category || t('– none –'))}</span></div>
    <div class="drawer-meta-row"><span class="k">${t('Last success')}</span><span class="v">${job.lastSuccess ? fmtDateTime(job.lastSuccess.ts) + ' (' + escapeHtml(job.lastSuccess.file || '') + ')' : t('– never –')}</span></div>
    ${job.archived ? `<div class="drawer-meta-row"><span class="k">${t('Archived')}</span><span class="v">${t('since {time}', { time: fmtDateTime(job.archivedAt) })}</span></div>` : ''}
    ${job.notes ? `<div class="drawer-meta-row" style="flex-direction:column;align-items:flex-start;gap:5px"><span class="k">${t('Note')}</span><span class="v" style="text-align:left;font-family:var(--font-sans);white-space:pre-wrap;justify-content:flex-start">${escapeHtml(job.notes)}</span></div>` : ''}
    ${copyRow(t('Source folder'), job.sourcePath)}
    <div class="drawer-meta-row"><span class="k">${t('File filter')}</span><span class="v">${escapeHtml(job.filePattern)}</span></div>
    ${copyRow(t('Target URL'), job.targetUrl)}
    <div class="drawer-meta-row"><span class="k">${t('Method')}</span><span class="v">${job.method}</span></div>
    <div class="drawer-meta-row"><span class="k">${t('Authentication')}</span><span class="v">${job.authType === 'basic' ? `Basic Auth (${escapeHtml(job.authUser || '–')})` : t('None')}</span></div>
    <div class="drawer-meta-row"><span class="k">${t('Scan interval')}</span><span class="v">${job.pollIntervalSec}s</span></div>
    ${job.processor === 'pdf-qr-json' ? `<div class="drawer-meta-row"><span class="k">${t('Processing')}</span><span class="v">${t('PDF → JSON (QR on page {page}, {dpi} dpi)', { page: job.qrSeite, dpi: job.qrDpi })}</span></div>` : ''}
    ${job.dryRun ? `<div class="drawer-meta-row"><span class="k">${t('Test mode')}</span><span class="v" style="color:var(--warning)">${t('active — nothing is sent')}</span></div>` : ''}
    ${job.dedupe ? `<div class="drawer-meta-row"><span class="k">${t('Duplicates')}</span><span class="v">${t('are rejected')}</span></div>` : ''}
    ${(job.extraTargetUrls || []).length ? `<div class="drawer-meta-row"><span class="k">${t('Additional targets')}</span><span class="v">${job.extraTargetUrls.map(escapeHtml).join('<br>')}</span></div>` : ''}
    ${job.archiveRetentionDays > 0 ? `<div class="drawer-meta-row"><span class="k">${t('Clean up archive')}</span><span class="v">${t('after {n} days', { n: job.archiveRetentionDays })}</span></div>` : ''}
    ${job.minFileAgeSec > 0 ? `<div class="drawer-meta-row"><span class="k">${t('Settle time')}</span><span class="v">${t('{n}s unchanged', { n: job.minFileAgeSec })}</span></div>` : ''}
    ${job.maxFileSizeMB > 0 ? `<div class="drawer-meta-row"><span class="k">${t('Max. file size')}</span><span class="v">${job.maxFileSizeMB} MB</span></div>` : ''}
    ${job.scheduleEnabled ? `<div class="drawer-meta-row"><span class="k">${t('Time window')}</span><span class="v">${(job.activeDays || []).map((d) => t(WOCHENTAG[d] || d)).join(' ')} · ${job.timeStart}–${job.timeEnd}</span></div>` : ''}
    <div class="drawer-meta-row"><span class="k">${t('On success')}</span><span class="v">${job.onSuccess === 'archive' ? '→ ' + job.archiveSubfolder : t('Leave file')}</span></div>
    <div class="drawer-meta-row"><span class="k">${t('On error')}</span><span class="v">${job.onError === 'archive' ? '→ ' + job.errorSubfolder : t('Leave file')}</span></div>
    ${job.runtime.consecutiveFailures >= 3 ? `<div class="drawer-meta-row"><span class="k">${t('Error streak')}</span><span class="v" style="color:var(--error)">${t('{n}× in a row', { n: job.runtime.consecutiveFailures })}</span></div>` : ''}
  `;
}

// Fetches the history for exactly this job from the server — regardless
// of how many other jobs logged recently. logsCache is capped at the last
// 500 entries across all jobs; with many active jobs (especially shortly
// after a restart, when all run at the same time) the entries of a quieter
// job can drop out of it even though they are still in the log itself —
// in the detail view that looked as if the transfers had disappeared.
async function ladeJobVerlauf(jobId, limit = 100) {
  try { return await api(`/logs?jobId=${jobId}&limit=${limit}`); } catch { return []; }
}

function detailBodyHtml(job, jobLogs, pulse) {
  return `
    <div class="drawer-section">${detailMetaHtml(job)}</div>
    <div class="drawer-section">
      <p class="drawer-section-title">${t('Activity (recent runs)')}</p>
      <div class="pulse-strip pulse-strip-lg">${pulseBarsHtml(pulse)}</div>
    </div>
    <div class="drawer-section">
      <p class="drawer-section-title">${t('History')}</p>
      <div class="log-stream">${jobLogs.length === 0 ? `<div class="empty-state"><p>${t('No transfers yet.')}</p></div>` : jobLogs.map(renderLogEntry).join('')}</div>
    </div>`;
}

function useDockedDetail() {
  return window.matchMedia('(min-width: 1500px)').matches;
}

async function openDrawer(job) {
  currentDetailJobId = job.id;
  const jobLogs = await ladeJobVerlauf(job.id, 100);
  if (currentDetailJobId !== job.id) return; // another job was opened in the meantime — discard this result
  const pulse = jobLogs.slice(0, 60).reverse();
  if (useDockedDetail()) {
    document.querySelector('#tab-uebersicht .layout').classList.add('with-detail');
    document.getElementById('detail-column-title').textContent = job.name;
    document.getElementById('detail-column-body').innerHTML = detailBodyHtml(job, jobLogs, pulse);
    drawerBackdrop.classList.remove('open');
    return;
  }
  drawerTitle.textContent = job.name;
  drawerMeta.innerHTML = detailMetaHtml(job);
  drawerPulse.innerHTML = pulseBarsHtml(pulse);
  drawerLog.innerHTML = jobLogs.length === 0 ? `<div class="empty-state"><p>${t('No transfers yet.')}</p></div>` : jobLogs.map(renderLogEntry).join('');
  drawerBackdrop.classList.add('open');
}

function closeDetail() {
  currentDetailJobId = null;
  drawerBackdrop.classList.remove('open');
  document.querySelector('#tab-uebersicht .layout').classList.remove('with-detail');
}

document.getElementById('detail-column-close').addEventListener('click', closeDetail);
document.getElementById('detail-column').addEventListener('click', (e) => {
  const copyBtn = e.target.closest('.copy-btn[data-copy]');
  if (copyBtn) { copyToClipboard(copyBtn.dataset.copy); return; }
  if (e.target.closest('.retry-btn')) { handleRetryClick(e); return; }
  const msg = e.target.closest('.msg[data-full]');
  if (!msg) return;
  const expanded = msg.classList.toggle('expanded');
  msg.innerHTML = expanded
    ? escapeHtml(msg.dataset.full) + `<span class="expand-hint">${t('show less')}</span>`
    : escapeHtml(msg.dataset.short) + (msg.dataset.full.length > 160 ? `<span class="expand-hint">${t('show more')}</span>` : '');
});

document.getElementById('drawer-close').addEventListener('click', closeDetail);
drawerBackdrop.addEventListener('click', (e) => { if (e.target === drawerBackdrop) drawerBackdrop.classList.remove('open'); });
drawerMeta.addEventListener('click', (e) => {
  const btn = e.target.closest('.copy-btn[data-copy]');
  if (btn) copyToClipboard(btn.dataset.copy);
});
drawerLog.addEventListener('click', (e) => {
  if (e.target.closest('.retry-btn')) { handleRetryClick(e); return; }
  const msg = e.target.closest('.msg[data-full]');
  if (!msg) return;
  const expanded = msg.classList.toggle('expanded');
  msg.innerHTML = expanded
    ? escapeHtml(msg.dataset.full) + `<span class="expand-hint">${t('show less')}</span>`
    : escapeHtml(msg.dataset.short) + (msg.dataset.full.length > 160 ? `<span class="expand-hint">${t('show more')}</span>` : '');
});

// ---------- Job form (create/edit) ----------

function openModal(job) {
  form.reset();
  document.getElementById('f-id').value = job ? job.id : '';
  modalTitle.textContent = job ? t('Edit job') : t('New job');
  document.getElementById('f-name').value = job ? job.name : '';
  document.getElementById('f-category').value = job ? (job.category || '') : '';
  const existingCats = Array.from(new Set(jobsCache.map((j) => (j.category || '').trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b, LOCALE));
  document.getElementById('category-suggestions').innerHTML = existingCats.map((c) => `<option value="${escapeHtml(c)}">`).join('');
  document.getElementById('f-sourcePath').value = job ? job.sourcePath : '';
  document.getElementById('f-filePattern').value = job ? job.filePattern : '*';
  document.getElementById('f-pollIntervalSec').value = job ? job.pollIntervalSec : 30;
  document.getElementById('f-minFileAgeSec').value = job ? (job.minFileAgeSec || 0) : 0;
  document.getElementById('f-maxFileSizeMB').value = job ? (job.maxFileSizeMB || 0) : 0;
  document.getElementById('preview-result').textContent = '';
  document.getElementById('preview-result').className = '';
  document.getElementById('preview-list').classList.add('hidden');
  document.getElementById('f-targetUrl').value = job ? job.targetUrl : '';
  document.getElementById('f-zielTyp').value = job ? (job.zielTyp || 'http') : 'http';
  document.getElementById('f-zielOrdner').value = job ? (job.zielOrdner || '') : '';
  document.getElementById('f-ordnerUeberschreiben').checked = job ? Boolean(job.ordnerUeberschreiben) : false;
  document.getElementById('f-smtpHost').value = job ? (job.smtpHost || '') : '';
  document.getElementById('f-smtpPort').value = job ? (job.smtpPort || 587) : 587;
  document.getElementById('f-smtpBenutzer').value = job ? (job.smtpBenutzer || '') : '';
  document.getElementById('f-smtpPasswort').value = '';
  document.getElementById('f-mailVon').value = job ? (job.mailVon || '') : '';
  document.getElementById('f-mailAn').value = job ? (job.mailAn || '') : '';
  document.getElementById('f-mailBetreff').value = job ? (job.mailBetreff || 'New file: {filename}') : 'New file: {filename}';
  document.getElementById('f-smtpSicher').checked = job ? job.smtpSicher !== false : true;
  document.getElementById('f-maxVersuche').value = job ? (job.maxVersuche !== undefined ? job.maxVersuche : 5) : 5;
  document.getElementById('f-wartezeitBasisSec').value = job ? (job.wartezeitBasisSec || 60) : 60;
  document.getElementById('f-quarantaeneSubfolder').value = job ? (job.quarantaeneSubfolder || '_quarantine') : '_quarantine';
  toggleZielTyp();
  document.getElementById('f-method').value = job ? job.method : 'POST';
  document.getElementById('f-uploadMode').value = job ? job.uploadMode : 'binary';
  document.getElementById('f-multipartField').value = job ? job.multipartField : 'file';
  document.getElementById('f-headers').value = job ? (job.headers || []).join('\n') : '';
  document.getElementById('f-authType').value = job ? (job.authType || 'none') : 'none';
  document.getElementById('f-authUser').value = job ? (job.authUser || '') : '';
  document.getElementById('f-authPassword').value = '';
  document.getElementById('hint-password-set').classList.toggle('hidden', !(job && job.authPasswordSet));
  authPasswordInput.type = 'password';
  document.getElementById('f-curlExtraArgs').value = job ? (job.curlExtraArgs || []).join('\n') : '';
  document.getElementById('f-onSuccess').value = job ? job.onSuccess : 'archive';
  document.getElementById('f-archiveSubfolder').value = job ? job.archiveSubfolder : '_sent';
  document.getElementById('f-archiveRetentionDays').value = job ? (job.archiveRetentionDays || 0) : 0;
  document.getElementById('f-extraTargetUrls').value = job ? (job.extraTargetUrls || []).join('\n') : '';
  document.getElementById('f-notes').value = job ? (job.notes || '') : '';
  document.getElementById('f-processor').value = job ? (job.processor || 'none') : 'none';
  document.getElementById('f-qrSeite').value = job ? (job.qrSeite || 1) : 1;
  document.getElementById('f-qrDpi').value = job ? (job.qrDpi || 200) : 200;
  document.getElementById('f-stapelTeilen').checked = job ? Boolean(job.stapelTeilen) : false;
  document.getElementById('f-vorspannVerwerfen').checked = job ? Boolean(job.vorspannVerwerfen) : false;
  document.getElementById('f-teilNamensmuster').value = job
    ? (job.teilNamensmuster !== undefined ? job.teilNamensmuster : '{stem}_{no}_{qrValue}')
    : '{stem}_{no}_{qrValue}';
  document.getElementById('namen-vorschau').textContent = '';
  toggleStapel();
  document.getElementById('f-sendeFormat').value = job ? (job.sendeFormat || 'json') : 'json';
  document.getElementById('f-dateiFeldName').value = job ? (job.dateiFeldName || 'file1') : 'file1';
  document.getElementById('f-metadataFeldName').value = job ? (job.metadataFeldName || 'metadata1') : 'metadata1';
  document.getElementById('f-metadataVorlage').value = job && job.metadataVorlage !== undefined
    ? job.metadataVorlage
    : '{\n  "name": "{filenameWithoutExt}",\n  "order_id": "{qrValue}",\n  "date": "{unixtime}"\n}';
  document.getElementById('f-auftragsnummer').value = job ? (job.auftragsnummer || '') : '';
  document.getElementById('f-dateinameRegex').value = job ? (job.dateinameRegex || '') : '';
  document.getElementById('metadata-preview').classList.add('hidden');
  document.getElementById('metadata-preview-result').textContent = '';
  toggleSendeFormatFelder();
  toggleProcessorFields();
  document.getElementById('f-dryRun').checked = job ? Boolean(job.dryRun) : false;
  document.getElementById('f-dedupe').checked = job ? Boolean(job.dedupe) : false;
  document.getElementById('template-row').classList.toggle('hidden', Boolean(job));
  if (!job) loadTemplatesIntoSelect();
  document.getElementById('f-onError').value = job ? job.onError : 'keep';
  document.getElementById('f-errorSubfolder').value = job ? job.errorSubfolder : '_error';
  document.getElementById('test-connection-result').textContent = '';
  document.getElementById('test-connection-result').className = '';

  scheduleEnabledCheckbox.checked = job ? Boolean(job.scheduleEnabled) : false;
  const activeDays = job && job.activeDays ? job.activeDays : ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
  document.querySelectorAll('#weekday-picker input[type="checkbox"]').forEach((cb) => { cb.checked = activeDays.includes(cb.value); });
  document.getElementById('f-timeStart').value = job ? (job.timeStart || '00:00') : '00:00';
  document.getElementById('f-timeEnd').value = job ? (job.timeEnd || '23:59') : '23:59';
  toggleScheduleFields();

  toggleMultipartField();
  toggleAuthFields();
  aktualisiereFormularAbschnitte(job);
  modalBackdrop.classList.add('open');
  // Only after showing it can we tell which fields are visible
  setTimeout(nimmVersteckteFelderAus, 0);
  // Capture the initial state for the unsaved-changes check —
  // a little later than the line above so that its effect is already included
  setTimeout(() => { jobFormSnapshot = serialisiereFormular(form); }, 20);
}
function closeModal() { modalBackdrop.classList.remove('open'); }

// ---------- Unsaved changes in the job form ----------
// Generic over all form fields — unlike the settings, openModal() fills the
// form completely and synchronously, without loading in the background,
// so a single snapshot after opening is enough.
function serialisiereFormular(formEl) {
  const werte = {};
  formEl.querySelectorAll('input, select, textarea').forEach((el, i) => {
    const key = el.id || (el.name ? 'name:' + el.name : 'anon:' + i + ':' + el.value);
    werte[key] = (el.type === 'checkbox' || el.type === 'radio') ? el.checked : el.value;
  });
  return werte;
}
let jobFormSnapshot = null;
function jobFormularGeaendert() {
  if (!jobFormSnapshot) return false;
  const jetzt = serialisiereFormular(form);
  const keys = new Set([...Object.keys(jobFormSnapshot), ...Object.keys(jetzt)]);
  return [...keys].some((k) => jobFormSnapshot[k] !== jetzt[k]);
}
function schliesseJobFormular() {
  if (jobFormularGeaendert()) {
    askConfirm(
      t('This job has unsaved changes. They will be lost when you close it.'),
      t('Discard anyway'),
      async () => closeModal(),
    );
    return;
  }
  closeModal();
}
function toggleScheduleFields() { scheduleFieldsWrap.classList.toggle('hidden', !scheduleEnabledCheckbox.checked); }
scheduleEnabledCheckbox.addEventListener('change', toggleScheduleFields);
function toggleMultipartField() { multipartWrap.classList.toggle('hidden', uploadModeSelect.value !== 'multipart'); }
function toggleStapel() {
  const an = document.getElementById('f-stapelTeilen').checked;
  document.getElementById('wrap-vorspann').classList.toggle('hidden', !an);
  document.getElementById('wrap-namensmuster').classList.toggle('hidden', !an);
}
document.getElementById('f-stapelTeilen').addEventListener('change', () => { toggleStapel(); nimmVersteckteFelderAus(); });

function toggleZielTyp() {
  const typ = document.getElementById('f-zielTyp').value;
  document.getElementById('wrap-ziel-http').classList.toggle('hidden', typ !== 'http');
  document.getElementById('wrap-ziel-ordner').classList.toggle('hidden', typ !== 'ordner');
  document.getElementById('wrap-ziel-email').classList.toggle('hidden', typ !== 'email');
  // Transfer details (headers, auth, curl) only apply to HTTP
  const uebertragung = document.getElementById('sec-uebertragung');
  if (uebertragung) uebertragung.classList.toggle('hidden', typ !== 'http');
  const url = document.getElementById('f-targetUrl');
  if (url) url.required = typ === 'http';
}
document.getElementById('f-zielTyp').addEventListener('change', () => { toggleZielTyp(); nimmVersteckteFelderAus(); });

function toggleSendeFormatFelder() {
  const mp = document.getElementById('f-sendeFormat').value === 'multipart-metadata';
  document.getElementById('wrap-multipart-fields').classList.toggle('hidden', !mp);
}
document.getElementById('f-sendeFormat').addEventListener('change', () => { toggleSendeFormatFelder(); nimmVersteckteFelderAus(); });

function toggleProcessorFields() {
  const aktiv = document.getElementById('f-processor').value === 'pdf-qr-json';
  document.getElementById('wrap-processor-fields').classList.toggle('hidden', !aktiv);
}
document.getElementById('f-processor').addEventListener('change', () => { toggleProcessorFields(); nimmVersteckteFelderAus(); });

function toggleAuthFields() { authFieldsWrap.classList.toggle('hidden', authTypeSelect.value !== 'basic'); }
uploadModeSelect.addEventListener('change', toggleMultipartField);
authTypeSelect.addEventListener('change', toggleAuthFields);
togglePasswordBtn.addEventListener('click', () => {
  authPasswordInput.type = authPasswordInput.type === 'password' ? 'text' : 'password';
});

document.getElementById('btn-new-job').addEventListener('click', () => openModal(null));
document.getElementById('modal-close').addEventListener('click', schliesseJobFormular);
document.getElementById('btn-cancel').addEventListener('click', closeModal);
modalBackdrop.addEventListener('click', (e) => { if (e.target === modalBackdrop) schliesseJobFormular(); });

document.getElementById('btn-test-connection').addEventListener('click', async () => {
  const resultEl = document.getElementById('test-connection-result');
  const payload = {
    jobId: document.getElementById('f-id').value || undefined,
    targetUrl: document.getElementById('f-targetUrl').value.trim(),
    zielTyp: document.getElementById('f-zielTyp').value,
    zielOrdner: document.getElementById('f-zielOrdner').value.trim(),
    ordnerUeberschreiben: document.getElementById('f-ordnerUeberschreiben').checked,
    smtpHost: document.getElementById('f-smtpHost').value.trim(),
    smtpPort: Number(document.getElementById('f-smtpPort').value) || 587,
    smtpBenutzer: document.getElementById('f-smtpBenutzer').value.trim(),
    smtpPasswort: document.getElementById('f-smtpPasswort').value,
    smtpSicher: document.getElementById('f-smtpSicher').checked,
    mailVon: document.getElementById('f-mailVon').value.trim(),
    mailAn: document.getElementById('f-mailAn').value.trim(),
    mailBetreff: document.getElementById('f-mailBetreff').value,
    maxVersuche: Number(document.getElementById('f-maxVersuche').value),
    wartezeitBasisSec: Number(document.getElementById('f-wartezeitBasisSec').value) || 60,
    quarantaeneSubfolder: document.getElementById('f-quarantaeneSubfolder').value.trim() || '_quarantine',
    method: document.getElementById('f-method').value,
    uploadMode: document.getElementById('f-uploadMode').value,
    multipartField: document.getElementById('f-multipartField').value.trim() || 'file',
    headers: document.getElementById('f-headers').value.split('\n').map((s) => s.trim()).filter(Boolean),
    authType: document.getElementById('f-authType').value,
    authUser: document.getElementById('f-authUser').value.trim(),
    authPassword: document.getElementById('f-authPassword').value,
    curlExtraArgs: document.getElementById('f-curlExtraArgs').value.split('\n').map((s) => s.trim()).filter(Boolean),
  };
  resultEl.className = 'pending';
  resultEl.textContent = t('Testing …');
  try {
    const result = await api('/test-connection', { method: 'POST', body: JSON.stringify(payload) });
    resultEl.className = result.ok ? 'ok' : 'error';
    resultEl.textContent = result.ok
      ? '✓ ' + t('Successful (HTTP {status})', { status: result.httpStatus })
      : `✗ ${result.httpStatus ? 'HTTP ' + result.httpStatus + ' — ' : ''}${result.message}`;
  } catch (err) {
    resultEl.className = 'error';
    resultEl.textContent = '✗ ' + err.message;
  }
});

// Hidden fields must not block saving: the browser cannot show them
// and then silently aborts. They are therefore excluded from the
// required-field check beforehand.
function nimmVersteckteFelderAus() {
  const sichtbar = (el) => Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  form.querySelectorAll('input, select, textarea').forEach((el) => {
    if (!sichtbar(el)) {
      if (!el.dataset.pruefungAus) {
        el.dataset.pruefungAus = '1';
        el.dataset.altRequired = el.required ? '1' : '';
        el.required = false;
        el.setAttribute('novalidate-hilfe', '');
        // Also defuse number fields without a matching step
        if (el.type === 'number' && !el.checkValidity()) {
          el.dataset.altStep = el.getAttribute('step') || '';
          el.setAttribute('step', 'any');
        }
      }
    } else if (el.dataset.pruefungAus) {
      el.required = el.dataset.altRequired === '1';
      if (el.dataset.altStep !== undefined) {
        if (el.dataset.altStep) el.setAttribute('step', el.dataset.altStep);
        delete el.dataset.altStep;
      }
      delete el.dataset.pruefungAus;
      delete el.dataset.altRequired;
      el.removeAttribute('novalidate-hilfe');
    }
  });
}

// Check on submit and report a problem in plain words,
// instead of letting the click fizzle out without effect.
form.addEventListener('invalid', (e) => {
  const el = e.target;
  const sichtbar = Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  if (!sichtbar) {
    showToast(t('Field “{field}” prevents saving: {message}', { field: el.id, message: el.validationMessage }), 'error');
  }
}, true);

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = document.getElementById('f-id').value;
  const payload = {
    name: document.getElementById('f-name').value.trim(),
    category: document.getElementById('f-category').value.trim(),
    sourcePath: document.getElementById('f-sourcePath').value.trim(),
    filePattern: document.getElementById('f-filePattern').value.trim() || '*',
    pollIntervalSec: Number(document.getElementById('f-pollIntervalSec').value) || 30,
    minFileAgeSec: Number(document.getElementById('f-minFileAgeSec').value) || 0,
    maxFileSizeMB: Number(document.getElementById('f-maxFileSizeMB').value) || 0,
    targetUrl: document.getElementById('f-targetUrl').value.trim(),
    zielTyp: document.getElementById('f-zielTyp').value,
    zielOrdner: document.getElementById('f-zielOrdner').value.trim(),
    ordnerUeberschreiben: document.getElementById('f-ordnerUeberschreiben').checked,
    smtpHost: document.getElementById('f-smtpHost').value.trim(),
    smtpPort: Number(document.getElementById('f-smtpPort').value) || 587,
    smtpBenutzer: document.getElementById('f-smtpBenutzer').value.trim(),
    smtpPasswort: document.getElementById('f-smtpPasswort').value,
    smtpSicher: document.getElementById('f-smtpSicher').checked,
    mailVon: document.getElementById('f-mailVon').value.trim(),
    mailAn: document.getElementById('f-mailAn').value.trim(),
    mailBetreff: document.getElementById('f-mailBetreff').value,
    maxVersuche: Number(document.getElementById('f-maxVersuche').value),
    wartezeitBasisSec: Number(document.getElementById('f-wartezeitBasisSec').value) || 60,
    quarantaeneSubfolder: document.getElementById('f-quarantaeneSubfolder').value.trim() || '_quarantine',
    method: document.getElementById('f-method').value,
    uploadMode: document.getElementById('f-uploadMode').value,
    multipartField: document.getElementById('f-multipartField').value.trim() || 'file',
    headers: document.getElementById('f-headers').value.split('\n').map((s) => s.trim()).filter(Boolean),
    authType: document.getElementById('f-authType').value,
    authUser: document.getElementById('f-authUser').value.trim(),
    authPassword: document.getElementById('f-authPassword').value,
    curlExtraArgs: document.getElementById('f-curlExtraArgs').value.split('\n').map((s) => s.trim()).filter(Boolean),
    onSuccess: document.getElementById('f-onSuccess').value,
    archiveSubfolder: document.getElementById('f-archiveSubfolder').value.trim() || '_sent',
    archiveRetentionDays: Number(document.getElementById('f-archiveRetentionDays').value) || 0,
    extraTargetUrls: document.getElementById('f-extraTargetUrls').value.split('\n').map((x) => x.trim()).filter(Boolean),
    notes: document.getElementById('f-notes').value,
    processor: document.getElementById('f-processor').value,
    qrSeite: Number(document.getElementById('f-qrSeite').value) || 1,
    qrDpi: Number(document.getElementById('f-qrDpi').value) || 200,
    sendeFormat: document.getElementById('f-sendeFormat').value,
    stapelTeilen: document.getElementById('f-stapelTeilen').checked,
    vorspannVerwerfen: document.getElementById('f-vorspannVerwerfen').checked,
    teilNamensmuster: document.getElementById('f-teilNamensmuster').value,
    dateiFeldName: document.getElementById('f-dateiFeldName').value.trim() || 'file1',
    metadataFeldName: document.getElementById('f-metadataFeldName').value.trim() || 'metadata1',
    metadataVorlage: document.getElementById('f-metadataVorlage').value,
    auftragsnummer: document.getElementById('f-auftragsnummer').value.trim(),
    dateinameRegex: document.getElementById('f-dateinameRegex').value.trim(),
    dryRun: document.getElementById('f-dryRun').checked,
    dedupe: document.getElementById('f-dedupe').checked,
    onError: document.getElementById('f-onError').value,
    errorSubfolder: document.getElementById('f-errorSubfolder').value.trim() || '_error',
    scheduleEnabled: scheduleEnabledCheckbox.checked,
    activeDays: Array.from(document.querySelectorAll('#weekday-picker input[type="checkbox"]:checked')).map((cb) => cb.value),
    timeStart: document.getElementById('f-timeStart').value || '00:00',
    timeEnd: document.getElementById('f-timeEnd').value || '23:59',
  };
  try {
    if (id) {
      await api(`/jobs/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
      showToast(t('“{job}” saved', { job: payload.name }), 'success');
    } else {
      await api('/jobs', { method: 'POST', body: JSON.stringify(payload) });
      showToast(t('“{job}” created', { job: payload.name }), 'success');
    }
    closeModal();
    await loadJobs();
  } catch (err) {
    showToast(err.message, 'error');
  }
});

// ---------- Statistics: charts ----------

// Trend arrow for a key figure compared with the immediately preceding
// period of the same length. “richtung” defines whether an increase counts as
// good or bad (for transfers/data volume more is neither good nor bad,
// hence “neutral” — only coloured for success rate and errors).
function trendHtml(jetzt, vorher, richtung) {
  if (vorher === null || vorher === undefined) return '';
  const hinweis = t('compared with the previous period');
  if (vorher === 0) {
    if (jetzt === 0) return '';
    const klasseNeu = richtung === 'hoeherSchlecht' ? 'schlecht' : richtung === 'hoeherGut' ? 'gut' : 'neutral';
    return `<span class="trend-${klasseNeu}" title="${hinweis}">▲ ${t('new')}</span>`;
  }
  const diff = Math.round(((jetzt - vorher) / vorher) * 100);
  if (diff === 0) return `<span class="trend-neutral" title="${hinweis}">± 0 %</span>`;
  const pfeil = diff > 0 ? '▲' : '▼';
  let klasse = 'neutral';
  if (richtung === 'hoeherGut') klasse = diff > 0 ? 'gut' : 'schlecht';
  else if (richtung === 'hoeherSchlecht') klasse = diff > 0 ? 'schlecht' : 'gut';
  return `<span class="trend-${klasse}" title="${hinweis}">${pfeil} ${Math.abs(diff)} %</span>`;
}

function renderKpis(stats) {
  document.getElementById('kpi-transfers').textContent = stats.totals.transfers;
  document.getElementById('kpi-volume').textContent = fmtBytes(stats.totals.bytes);
  document.getElementById('kpi-errors').textContent = stats.totals.error;
  const rate = stats.totals.transfers > 0 ? Math.round((stats.totals.success / stats.totals.transfers) * 100) : null;
  document.getElementById('kpi-rate').textContent = rate === null ? '–' : rate + ' %';

  const vor = stats.previousTotals;
  document.getElementById('kpi-transfers-trend').innerHTML = vor ? trendHtml(stats.totals.transfers, vor.transfers, 'neutral') : '';
  document.getElementById('kpi-volume-trend').innerHTML = vor ? trendHtml(stats.totals.bytes, vor.bytes, 'neutral') : '';
  document.getElementById('kpi-errors-trend').innerHTML = vor ? trendHtml(stats.totals.error, vor.error, 'hoeherSchlecht') : '';

  const hinweis = t('compared with the previous period');
  const vorherRate = vor && vor.transfers > 0 ? Math.round((vor.success / vor.transfers) * 100) : null;
  let rateTrend = '';
  if (rate !== null && vorherRate !== null) {
    const diffPunkte = rate - vorherRate;
    rateTrend = diffPunkte === 0
      ? `<span class="trend-neutral" title="${hinweis}">± 0 ${t('pts')}</span>`
      : `<span class="trend-${diffPunkte > 0 ? 'gut' : 'schlecht'}" title="${hinweis}">${diffPunkte > 0 ? '▲' : '▼'} ${Math.abs(diffPunkte)} ${t('pts')}</span>`;
  }
  document.getElementById('kpi-rate-trend').innerHTML = rateTrend;
}

function renderTimelineChart(perDay) {
  const el = document.getElementById('chart-timeline');
  if (!perDay || perDay.every((d) => d.success === 0 && d.error === 0)) {
    el.innerHTML = `<p class="chart-empty">${t('No transfers in the selected period yet.')}</p>`;
    return;
  }

  const w = 640; const h = 250;
  const padL = 34; const padR = 10; const padT = 18; const padB = 34;
  const innerW = w - padL - padR; const innerH = h - padT - padB;
  const rawMax = Math.max(1, ...perDay.map((d) => d.success + d.error));
  // Round the axis up to a round value so that the labels stay readable
  const step10 = Math.pow(10, Math.floor(Math.log10(rawMax)));
  const max = Math.ceil(rawMax / step10) * step10;

  const n = perDay.length;
  const slot = innerW / n;
  const barW = Math.max(4, Math.min(34, slot * 0.62));
  const totalDays = perDay.filter((d) => d.success + d.error > 0).length;
  const showValues = n <= 31;

  // Y axis: grid lines with numbers
  let grid = '';
  const ticks = 4;
  for (let t = 0; t <= ticks; t += 1) {
    const value = Math.round((max / ticks) * t);
    const y = padT + innerH - (value / max) * innerH;
    grid += `<line class="chart-gridline" x1="${padL}" y1="${y.toFixed(1)}" x2="${w - padR}" y2="${y.toFixed(1)}" ${t === 0 ? '' : 'opacity="0.45"'}/>`;
    grid += `<text class="chart-axis-label" x="${padL - 7}" y="${(y + 3.5).toFixed(1)}" text-anchor="end">${value}</text>`;
  }

  const labelEvery = Math.ceil(n / 12);
  let bars = '';
  let labels = '';

  perDay.forEach((d, i) => {
    const total = d.success + d.error;
    const x = padL + i * slot + (slot - barW) / 2;
    const baseY = padT + innerH;

    if (total === 0) {
      // Keep zero days visible so that the time axis stays readable as a series
      bars += `<rect x="${x.toFixed(1)}" y="${(baseY - 2).toFixed(1)}" width="${barW.toFixed(1)}" height="2" rx="1" fill="var(--border-strong)"><title>${t('{day}: no transfers', { day: fmtDay(d.date) })}</title></rect>`;
    } else {
      const successH = (d.success / max) * innerH;
      const errorH = (d.error / max) * innerH;
      const yError = baseY - errorH;
      const ySuccess = yError - successH;
      const tip = t('{day}: {total} transfer(s) — {ok} successful, {err} failed', { day: fmtDay(d.date), total, ok: d.success, err: d.error })
        + (d.jobs ? ' · ' + t('{n} job(s)', { n: d.jobs }) : '') + ` · ${fmtBytes(d.bytes)}`;

      if (d.error > 0) bars += `<rect class="chart-bar-error" x="${x.toFixed(1)}" y="${yError.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(1.5, errorH).toFixed(1)}" rx="1.5"><title>${tip}</title></rect>`;
      if (d.success > 0) bars += `<rect class="chart-bar-success" x="${x.toFixed(1)}" y="${ySuccess.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(1.5, successH).toFixed(1)}" rx="1.5"><title>${tip}</title></rect>`;

      if (showValues) {
        const topY = baseY - ((total / max) * innerH);
        bars += `<text class="chart-value-label" x="${(x + barW / 2).toFixed(1)}" y="${(topY - 5).toFixed(1)}" text-anchor="middle">${total}</text>`;
      }
    }

    if (i % labelEvery === 0 || i === n - 1) {
      labels += `<text class="chart-axis-label" x="${(x + barW / 2).toFixed(1)}" y="${h - 12}" text-anchor="middle">${fmtDay(d.date)}</text>`;
    }
  });

  const gesamt = perDay.reduce((s, d) => s + d.success + d.error, 0);
  const fehler = perDay.reduce((s, d) => s + d.error, 0);
  const maxJobs = Math.max(0, ...perDay.map((d) => d.jobs || 0));

  el.innerHTML = `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet">${grid}${bars}${labels}</svg>
    <div class="chart-footer">
      <span class="chart-legend-item"><i style="background:var(--success)"></i>${t('Success')}</span>
      <span class="chart-legend-item"><i style="background:var(--error)"></i>${t('Errors')}</span>
      <span class="chart-summary">${t('{total} transfers on {days} day(s)', { total: gesamt, days: totalDays })}${fehler ? ` · <span style="color:var(--error)">${t('{n} errors', { n: fehler })}</span>` : ''}${maxJobs ? ' · ' + t('up to {n} job(s)/day', { n: maxJobs }) : ''}</span>
    </div>`;
}

function renderPerJobChart(perJob) {
  const el = document.getElementById('chart-perjob');
  if (!perJob || perJob.length === 0) {
    el.innerHTML = `<p class="chart-empty">${t('No transfers in the selected period yet.')}</p>`;
    return;
  }
  const top = perJob.slice(0, 8);
  const max = Math.max(1, ...top.map((j) => j.success + j.error));
  el.innerHTML = top.map((j) => {
    const total = j.success + j.error;
    const successPct = (j.success / max) * 100;
    const errorPct = (j.error / max) * 100;
    const tip = t('{name}: {total} transfer(s) — {ok} successful, {err} failed', { name: j.jobName, total, ok: j.success, err: j.error }) + ` · ${fmtBytes(j.bytes)}`;
    return `
    <div class="job-bar-row" title="${escapeHtml(tip)}">
      <span class="job-bar-label" title="${escapeHtml(j.jobName)}">${escapeHtml(j.jobName)}</span>
      <span class="job-bar-track">
        <span class="job-bar-seg success" style="width:${successPct.toFixed(1)}%"></span>
        <span class="job-bar-seg error" style="width:${errorPct.toFixed(1)}%"></span>
      </span>
      <span class="job-bar-total">${total}</span>
    </div>`;
  }).join('');
}

function renderPerCategoryCharts(perCategory) {
  const elCount = document.getElementById('chart-percategory');
  const elVolume = document.getElementById('chart-catvolume');
  if (!perCategory || perCategory.length === 0) {
    elCount.innerHTML = `<p class="chart-empty">${t('No transfers in the selected period yet.')}</p>`;
    elVolume.innerHTML = `<p class="chart-empty">${t('No transfers in the selected period yet.')}</p>`;
    return;
  }
  const maxCount = Math.max(1, ...perCategory.map((c) => c.success + c.error));
  elCount.innerHTML = perCategory.map((c) => {
    const total = c.success + c.error;
    const tip = t('{name}: {total} transfer(s) — {ok} successful, {err} failed', { name: kategorieName(c.category), total, ok: c.success, err: c.error }) + ` · ${fmtBytes(c.bytes)}`;
    return `
    <div class="job-bar-row" title="${escapeHtml(tip)}">
      <span class="job-bar-label" title="${escapeHtml(kategorieName(c.category))}">${escapeHtml(kategorieName(c.category))}</span>
      <span class="job-bar-track">
        <span class="job-bar-seg success" style="width:${((c.success / maxCount) * 100).toFixed(1)}%"></span>
        <span class="job-bar-seg error" style="width:${((c.error / maxCount) * 100).toFixed(1)}%"></span>
      </span>
      <span class="job-bar-total">${total}</span>
    </div>`;
  }).join('');

  const byVolume = [...perCategory].sort((a, b) => b.bytes - a.bytes);
  const maxBytes = Math.max(1, ...byVolume.map((c) => c.bytes));
  elVolume.innerHTML = byVolume.map((c) => `
    <div class="job-bar-row">
      <span class="job-bar-label" title="${escapeHtml(kategorieName(c.category))}">${escapeHtml(kategorieName(c.category))}</span>
      <span class="job-bar-track">
        <span class="job-bar-seg" style="width:${((c.bytes / maxBytes) * 100).toFixed(1)}%;background:var(--accent)"></span>
      </span>
      <span class="job-bar-total" style="width:58px">${fmtBytes(c.bytes)}</span>
    </div>`).join('');
}

function renderTargetTable(perTarget) {
  const el = document.getElementById('target-table');
  if (!perTarget || perTarget.length === 0) {
    el.innerHTML = `<p class="chart-empty">${t('No transfers in the selected period yet.')}</p>`;
    return;
  }
  el.innerHTML = `
    <table>
      <thead><tr><th>${t('Job')}</th><th>${t('API endpoint')}</th><th>${t('Success')}</th><th>${t('Errors')}</th><th>${t('Total')}</th><th>${t('Data volume')}</th></tr></thead>
      <tbody>
        ${perTarget.map((t) => `
          <tr>
            <td class="job-name-cell">${escapeHtml((t.jobNames || []).join(', ') || '–')}</td>
            <td class="url" title="${escapeHtml(t.targetUrl)}">${escapeHtml(t.targetUrl)}</td>
            <td class="success">${t.success}</td>
            <td class="error">${t.error}</td>
            <td>${t.success + t.error}</td>
            <td>${fmtBytes(t.bytes)}</td>
          </tr>`).join('')}
      </tbody>
    </table>`;
}

// ---------- Polling ----------

async function refreshAll() {
  await loadJobs();
  await loadLogsAll();
  await loadStatus();
  await loadOverviewStats();
  await loadSelfCheck();
  await loadConfigWarnings();
  if (activeTab === 'statistik') await loadStats();
}
refreshAll();
setInterval(refreshAll, 4000);

// ---------- Export / Import ----------

function openTransferModal() {
  importResult.textContent = '';
  importResult.className = '';
  importFileInput.value = '';
  importReplaceCheckbox.checked = false;
  transferBackdrop.classList.add('open');
}
function closeTransferModal() { transferBackdrop.classList.remove('open'); }

document.getElementById('btn-open-transfer').addEventListener('click', openTransferModal);
document.getElementById('transfer-close').addEventListener('click', closeTransferModal);
document.getElementById('transfer-close-2').addEventListener('click', closeTransferModal);
transferBackdrop.addEventListener('click', (e) => { if (e.target === transferBackdrop) closeTransferModal(); });

document.getElementById('btn-do-export').addEventListener('click', () => {
  window.open('/api/config/export', '_blank');
  showToast(t('Export started — the file is being downloaded'), 'success');
});

document.getElementById('btn-do-import').addEventListener('click', () => {
  const file = importFileInput.files[0];
  if (!file) {
    importResult.className = 'error';
    importResult.textContent = t('Please choose a JSON file first.');
    return;
  }
  const reader = new FileReader();
  reader.onload = async () => {
    let parsed;
    try {
      parsed = JSON.parse(reader.result);
    } catch {
      importResult.className = 'error';
      importResult.textContent = t('The file is not valid JSON.');
      return;
    }
    if (!Array.isArray(parsed.jobs)) {
      importResult.className = 'error';
      importResult.textContent = t('The file contains no "jobs" array — wrong file?');
      return;
    }
    try {
      const result = await api('/config/import', {
        method: 'POST',
        body: JSON.stringify({ jobs: parsed.jobs, replace: importReplaceCheckbox.checked }),
      });
      importResult.className = 'ok';
      importResult.textContent = t('Import successful: {added} new, {updated} updated ({total} jobs in total).', { added: result.added, updated: result.updated, total: result.total });
      showToast(t('Configuration imported'), 'success');
      await loadJobs();
      await loadLogsAll();
    } catch (err) {
      importResult.className = 'error';
      importResult.textContent = t('Import failed: {error}', { error: err.message });
    }
  };
  reader.readAsText(file);
});

// ---------- Settings ----------

// Tabs inside the settings — purely visual switching; none of the forms
// below is changed or reloaded by it.
// Watched input fields per tab — only real inputs, no plain display or
// status texts. Used only to warn before switching if something was
// typed here but not saved yet.
const settingsBeobachteteFelder = {
  allg: ['marke-name-eingabe', 'marke-farbe-hex', 'settings-retention-days', 'settings-language'],
  zugriff: ['neu-benutzer-name', 'neu-benutzer-anzeige', 'neu-benutzer-passwort', 'einst-joboverview'],
  benachr: ['benachr-email-aktiv', 'benachr-smtpHost', 'benachr-smtpPort', 'benachr-smtpBenutzer',
    'benachr-smtpPasswort', 'benachr-von', 'benachr-an', 'benachr-smtpSicher',
    'benachr-webhook-aktiv', 'benachr-webhook-url'],
  system: ['update-url', 'neustart-verhalten'],
};
let settingsSnapshot = {};

function settingsFeldWert(id) {
  const el = document.getElementById(id);
  if (!el) return null;
  return el.type === 'checkbox' ? el.checked : el.value;
}
function erfasseSettingsSnapshot(spanel) {
  settingsSnapshot[spanel] = (settingsBeobachteteFelder[spanel] || []).map(settingsFeldWert);
}
function erfasseAlleSettingsSnapshots() {
  Object.keys(settingsBeobachteteFelder).forEach(erfasseSettingsSnapshot);
}
function settingsReiterGeaendert(spanel) {
  const vorher = settingsSnapshot[spanel];
  if (!vorher) return false;
  return (settingsBeobachteteFelder[spanel] || []).some((id, i) => settingsFeldWert(id) !== vorher[i]);
}
// Called after every successful save so that the state saved now no longer
// counts as “unsaved” — regardless of the tab it was saved in, since a change
// always only affects its own tab.
function markiereSettingsGespeichert() { erfasseAlleSettingsSnapshots(); }

function wendeReiterwechselAn(ziel) {
  document.querySelectorAll('#settings-tabs .settings-tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.spanel === ziel);
  });
  document.querySelectorAll('#settings-backdrop .settings-panel').forEach((p) => {
    p.classList.toggle('active', p.dataset.spanel === ziel);
  });
}
function wechsleSettingsReiter(ziel) {
  const aktuell = document.querySelector('#settings-tabs .settings-tab.active');
  const von = aktuell ? aktuell.dataset.spanel : null;
  if (von && von !== ziel && settingsReiterGeaendert(von)) {
    askConfirm(
      t('This tab has unsaved changes. They will be lost when you switch.'),
      t('Switch anyway'),
      async () => wendeReiterwechselAn(ziel),
    );
    return;
  }
  wendeReiterwechselAn(ziel);
}
document.getElementById('settings-tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.settings-tab');
  if (!btn) return;
  wechsleSettingsReiter(btn.dataset.spanel);
});

async function openSettingsModal() {
  settingsBackdrop.classList.add('open');
  settingsSnapshot = {}; // prevents a tab-switch check from still seeing the state of the last session
  wechsleSettingsReiter('allg'); // always open on the first tab
  document.getElementById('settings-result').textContent = '';
  document.getElementById('settings-result').className = '';
  try {
    const s = await api('/settings');
    document.getElementById('settings-retention-days').value = s.logRetentionDays;
    document.getElementById('settings-language').value = s.language || 'en';
    document.getElementById('einst-joboverview').checked = s.jobUebersichtImLogin !== false;
    ladeBenutzer();
    ladeUpdateStand(s);
    ladeBetriebsart();
    ladeErscheinungsbild();
    ladeBenachrichtigung();
  } catch (err) {
    showToast(err.message, 'error');
  }
  loadBackups();
  // Only capture the initial state once the values loaded above have
  // most likely arrived — otherwise the loading itself would wrongly
  // count as a “change”.
  setTimeout(erfasseAlleSettingsSnapshots, 700);
}
function closeSettingsModal() { settingsBackdrop.classList.remove('open'); }

document.getElementById('btn-open-settings').addEventListener('click', openSettingsModal);
document.getElementById('settings-close').addEventListener('click', closeSettingsModal);
settingsBackdrop.addEventListener('click', (e) => { if (e.target === settingsBackdrop) closeSettingsModal(); });





document.getElementById('btn-save-retention').addEventListener('click', async () => {
  const days = Number(document.getElementById('settings-retention-days').value);
  const resultEl = document.getElementById('settings-result');
  if (!days || days < 1) {
    resultEl.className = 'error';
    resultEl.textContent = t('Please enter a valid number of days.');
    return;
  }
  try {
    await api('/settings', { method: 'PUT', body: JSON.stringify({ logRetentionDays: days }) });
    resultEl.className = 'ok';
    resultEl.textContent = t('Retention period set to {n} days.', { n: days });
    showToast(t('Retention period saved'), 'success');
    markiereSettingsGespeichert();
  } catch (err) {
    resultEl.className = 'error';
    resultEl.textContent = err.message;
  }
});

document.getElementById('btn-save-language').addEventListener('click', async () => {
  const language = document.getElementById('settings-language').value;
  const resultEl = document.getElementById('settings-result');
  try {
    await api('/settings', { method: 'PUT', body: JSON.stringify({ language }) });
    resultEl.className = 'ok';
    resultEl.textContent = t('Logs and notifications are now written in {language}.', { language: language === 'de' ? 'Deutsch' : 'English' });
    showToast(t('Language saved'), 'success');
    markiereSettingsGespeichert();
  } catch (err) {
    resultEl.className = 'error';
    resultEl.textContent = err.message;
  }
});

// ---------- Manage categories ----------

const categoriesBackdrop = document.getElementById('categories-backdrop');

async function openCategoriesModal() {
  categoriesBackdrop.classList.add('open');
  const resultEl = document.getElementById('categories-result');
  resultEl.textContent = '';
  resultEl.className = '';
  const listEl = document.getElementById('categories-list');
  const cats = (lastStatus && lastStatus.categories ? lastStatus.categories : []).filter((c) => c.name !== NO_CATEGORY);
  if (cats.length === 0) {
    listEl.innerHTML = `<p class="chart-empty">${t('No categories assigned yet.')}</p>`;
    return;
  }
  listEl.innerHTML = cats.map((c) => `
    <div class="category-row" data-original="${escapeHtml(c.name)}">
      <input type="text" value="${escapeHtml(c.name)}">
      <span class="cat-count">${c.total}</span>
      <button type="button" class="btn" data-cat-save>${t('Save')}</button>
    </div>`).join('');
}
function closeCategoriesModal() { categoriesBackdrop.classList.remove('open'); }

document.getElementById('btn-manage-categories').addEventListener('click', openCategoriesModal);
document.getElementById('categories-close').addEventListener('click', closeCategoriesModal);
categoriesBackdrop.addEventListener('click', (e) => { if (e.target === categoriesBackdrop) closeCategoriesModal(); });

document.getElementById('categories-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-cat-save]');
  if (!btn) return;
  const row = btn.closest('.category-row');
  const from = row.dataset.original;
  const to = row.querySelector('input').value.trim();
  const resultEl = document.getElementById('categories-result');
  if (from === to) { resultEl.className = ''; resultEl.textContent = t('No change.'); return; }
  try {
    const r = await api('/categories/rename', { method: 'POST', body: JSON.stringify({ from, to }) });
    resultEl.className = 'ok';
    resultEl.textContent = to
      ? t('{n} job(s) moved from “{from}” to “{to}”.', { n: r.affected, from, to })
      : t('Category assignment removed for {n} job(s).', { n: r.affected });
    showToast(t('Category updated'), 'success');
    await loadJobs();
    await loadStatus();
    await openCategoriesModal();
    document.getElementById('categories-result').className = 'ok';
    document.getElementById('categories-result').textContent = resultEl.textContent;
  } catch (err) {
    resultEl.className = 'error';
    resultEl.textContent = err.message;
  }
});

// ---------- File preview in the job form ----------

document.getElementById('btn-preview-files').addEventListener('click', async () => {
  const resultEl = document.getElementById('preview-result');
  const listEl = document.getElementById('preview-list');
  const sourcePath = document.getElementById('f-sourcePath').value.trim();
  if (!sourcePath) {
    resultEl.className = 'error';
    resultEl.textContent = t('Please enter the source folder first.');
    listEl.classList.add('hidden');
    return;
  }
  resultEl.className = '';
  resultEl.textContent = t('Checking …');
  try {
    const r = await api('/preview-files', {
      method: 'POST',
      body: JSON.stringify({
        sourcePath,
        filePattern: document.getElementById('f-filePattern').value.trim() || '*',
        minFileAgeSec: Number(document.getElementById('f-minFileAgeSec').value) || 0,
        maxFileSizeMB: Number(document.getElementById('f-maxFileSizeMB').value) || 0,
      }),
    });
    if (!r.ok) {
      resultEl.className = 'error';
      resultEl.textContent = r.message;
      listEl.classList.add('hidden');
      return;
    }
    resultEl.className = r.total > 0 ? 'ok' : '';
    resultEl.textContent = r.total === 0
      ? t('No matching file found — check the filter.')
      : t('{n} file(s) would be sent.', { n: r.total });

    const rows = r.files.map((f) => `<div class="pv-row"><span>${escapeHtml(f.name)}</span><span class="pv-size">${f.size === null ? '' : fmtBytes(f.size)}</span></div>`);
    if (r.total > r.files.length) rows.push(`<span class="pv-note">${t('… and {n} more', { n: r.total - r.files.length })}</span>`);
    if (r.tooYoung > 0) rows.push(`<span class="pv-note">${t('{n} file(s) still waiting for the settle time', { n: r.tooYoung })}</span>`);
    r.tooLarge.forEach((f) => rows.push(`<div class="pv-row pv-skip"><span>${escapeHtml(f.name)}</span><span class="pv-size">${fmtBytes(f.size)} — ${t('too large')}</span></div>`));

    listEl.innerHTML = rows.join('') || `<span class="pv-note">${t('Nothing to show.')}</span>`;
    listEl.classList.remove('hidden');
  } catch (err) {
    resultEl.className = 'error';
    resultEl.textContent = err.message;
    listEl.classList.add('hidden');
  }
});

// ---------- Command palette (Ctrl+K) ----------

const paletteBackdrop = document.getElementById('palette-backdrop');
const paletteInput = document.getElementById('palette-input');
const paletteList = document.getElementById('palette-list');
let paletteAuswahl = 0;
let paletteEintraege = [];

function paletteAktionen() {
  const liste = [
    { typ: 'aktion', label: t('New job'), ausfuehren: () => openModal(null) },
    { typ: 'aktion', label: t('Open statistics'), ausfuehren: () => document.querySelector('.tab[data-tab="statistik"]').click() },
    { typ: 'aktion', label: t('Open overview'), ausfuehren: () => document.querySelector('.tab[data-tab="uebersicht"]').click() },
    { typ: 'aktion', label: t('Open settings'), ausfuehren: () => openSettingsModal() },
    { typ: 'aktion', label: t('Toggle light/dark'), ausfuehren: () => document.getElementById('btn-theme-toggle').click() },
    { typ: 'aktion', label: t('Export configuration'), ausfuehren: () => window.open('/api/config/export', '_blank') },
  ];
  // Jump directly to a settings tab
  [['allg', 'General'], ['zugriff', 'Users & access'], ['benachr', 'Notifications'], ['system', 'System & maintenance']]
    .forEach(([spanel, name]) => liste.push({
      typ: 'aktion', label: `${t('Settings')}: ${t(name)}`,
      ausfuehren: () => { openSettingsModal().then(() => wechsleSettingsReiter(spanel)); },
    }));
  return liste;
}

function paletteJobs() {
  return jobsCache.filter((j) => !j.archived).map((j) => ({
    typ: 'job', label: j.name, hinweis: j.category || '',
    ausfuehren: () => openDrawer(j),
  }));
}

function filterePalette(begriff) {
  const alle = [...paletteJobs(), ...paletteAktionen()];
  const b = begriff.trim().toLowerCase();
  if (!b) return alle.slice(0, 8);
  return alle.filter((e) => e.label.toLowerCase().includes(b)).slice(0, 20);
}

function renderPalette() {
  paletteEintraege = filterePalette(paletteInput.value);
  if (paletteAuswahl >= paletteEintraege.length) paletteAuswahl = Math.max(0, paletteEintraege.length - 1);
  paletteList.innerHTML = paletteEintraege.length === 0
    ? `<div class="empty-state"><p>${t('No matches')}</p></div>`
    : paletteEintraege.map((e, i) => `
      <div class="palette-item${i === paletteAuswahl ? ' aktiv' : ''}" data-index="${i}">
        <span class="palette-typ">${e.typ === 'job' ? '⏵' : '⌘'}</span>
        <span class="palette-label">${escapeHtml(e.label)}</span>
        ${e.hinweis ? `<span class="palette-hinweis">${escapeHtml(e.hinweis)}</span>` : ''}
      </div>`).join('');
}

function oeffnePalette() {
  paletteBackdrop.classList.add('open');
  paletteInput.value = '';
  paletteAuswahl = 0;
  renderPalette();
  setTimeout(() => paletteInput.focus(), 10);
}
function schliessePalette() { paletteBackdrop.classList.remove('open'); }

document.getElementById('btn-open-palette').addEventListener('click', oeffnePalette);
paletteInput.addEventListener('input', () => { paletteAuswahl = 0; renderPalette(); });
paletteList.addEventListener('mousemove', (e) => {
  const item = e.target.closest('.palette-item');
  if (!item) return;
  const idx = Number(item.dataset.index);
  if (idx !== paletteAuswahl) { paletteAuswahl = idx; renderPalette(); }
});
paletteList.addEventListener('click', (e) => {
  const item = e.target.closest('.palette-item');
  if (!item) return;
  const eintrag = paletteEintraege[Number(item.dataset.index)];
  if (eintrag) { schliessePalette(); eintrag.ausfuehren(); }
});
paletteBackdrop.addEventListener('click', (e) => { if (e.target === paletteBackdrop) schliessePalette(); });
paletteInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') {
    e.preventDefault(); paletteAuswahl = Math.min(paletteAuswahl + 1, paletteEintraege.length - 1); renderPalette();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault(); paletteAuswahl = Math.max(paletteAuswahl - 1, 0); renderPalette();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const eintrag = paletteEintraege[paletteAuswahl];
    if (eintrag) { schliessePalette(); eintrag.ausfuehren(); }
  }
  // Escape is handled centrally in the global keyboard handler below
});

// ---------- Keyboard shortcuts ----------

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    if (paletteBackdrop.classList.contains('open')) schliessePalette(); else oeffnePalette();
    return;
  }

  const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);

  if (e.key === 'Escape') {
    const open = document.querySelector('.modal-backdrop.open');
    if (open === modalBackdrop) { schliesseJobFormular(); return; }
    if (open) { open.classList.remove('open'); return; }
    if (drawerBackdrop.classList.contains('open') || currentDetailJobId) { closeDetail(); return; }
    document.querySelectorAll('.overflow-menu').forEach((m) => m.classList.add('hidden'));
    return;
  }

  if (inField) return;

  if (e.key === '/') {
    e.preventDefault();
    document.querySelector('.tab[data-tab="uebersicht"]').click();
    jobSearch.focus();
    jobSearch.select();
  } else if (e.key === 'n') {
    e.preventDefault();
    openModal(null);
  }
});

// ---------- Templates ----------

let templatesCache = [];

async function loadTemplatesIntoSelect() {
  const sel = document.getElementById('template-select');
  try {
    templatesCache = await api('/templates');
  } catch { return; }
  sel.innerHTML = `<option value="">${t('Apply template …')}</option>` +
    templatesCache.map((t) => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('');
  sel.value = '';
}

document.getElementById('template-select').addEventListener('change', (e) => {
  const tpl = templatesCache.find((t) => t.id === e.target.value);
  if (!tpl) return;
  const s = tpl.settings;
  const setVal = (id, v) => { const el = document.getElementById(id); if (el && v !== undefined) el.value = v; };
  setVal('f-filePattern', s.filePattern);
  setVal('f-pollIntervalSec', s.pollIntervalSec);
  setVal('f-minFileAgeSec', s.minFileAgeSec);
  setVal('f-maxFileSizeMB', s.maxFileSizeMB);
  setVal('f-targetUrl', s.targetUrl);
  setVal('f-method', s.method);
  setVal('f-uploadMode', s.uploadMode);
  setVal('f-multipartField', s.multipartField);
  setVal('f-headers', (s.headers || []).join('\n'));
  setVal('f-curlExtraArgs', (s.curlExtraArgs || []).join('\n'));
  setVal('f-extraTargetUrls', (s.extraTargetUrls || []).join('\n'));
  setVal('f-authType', s.authType);
  setVal('f-authUser', s.authUser);
  setVal('f-onSuccess', s.onSuccess);
  setVal('f-archiveSubfolder', s.archiveSubfolder);
  setVal('f-onError', s.onError);
  setVal('f-errorSubfolder', s.errorSubfolder);
  setVal('f-archiveRetentionDays', s.archiveRetentionDays);
  setVal('f-category', s.category);
  document.getElementById('f-dryRun').checked = Boolean(s.dryRun);
  document.getElementById('f-dedupe').checked = Boolean(s.dedupe);
  toggleMultipartField();
  toggleAuthFields();
  showToast(t('Template “{name}” applied', { name: tpl.name }), 'success');
});

document.getElementById('btn-save-template').addEventListener('click', async () => {
  const name = prompt(t('Template name:'), document.getElementById('f-name').value.trim() || t('New template'));
  if (!name) return;
  const job = {
    filePattern: document.getElementById('f-filePattern').value.trim() || '*',
    pollIntervalSec: Number(document.getElementById('f-pollIntervalSec').value) || 30,
    minFileAgeSec: Number(document.getElementById('f-minFileAgeSec').value) || 0,
    maxFileSizeMB: Number(document.getElementById('f-maxFileSizeMB').value) || 0,
    targetUrl: document.getElementById('f-targetUrl').value.trim(),
    zielTyp: document.getElementById('f-zielTyp').value,
    zielOrdner: document.getElementById('f-zielOrdner').value.trim(),
    ordnerUeberschreiben: document.getElementById('f-ordnerUeberschreiben').checked,
    smtpHost: document.getElementById('f-smtpHost').value.trim(),
    smtpPort: Number(document.getElementById('f-smtpPort').value) || 587,
    smtpBenutzer: document.getElementById('f-smtpBenutzer').value.trim(),
    smtpPasswort: document.getElementById('f-smtpPasswort').value,
    smtpSicher: document.getElementById('f-smtpSicher').checked,
    mailVon: document.getElementById('f-mailVon').value.trim(),
    mailAn: document.getElementById('f-mailAn').value.trim(),
    mailBetreff: document.getElementById('f-mailBetreff').value,
    maxVersuche: Number(document.getElementById('f-maxVersuche').value),
    wartezeitBasisSec: Number(document.getElementById('f-wartezeitBasisSec').value) || 60,
    quarantaeneSubfolder: document.getElementById('f-quarantaeneSubfolder').value.trim() || '_quarantine',
    method: document.getElementById('f-method').value,
    uploadMode: document.getElementById('f-uploadMode').value,
    multipartField: document.getElementById('f-multipartField').value.trim(),
    headers: document.getElementById('f-headers').value.split('\n').map((x) => x.trim()).filter(Boolean),
    curlExtraArgs: document.getElementById('f-curlExtraArgs').value.split('\n').map((x) => x.trim()).filter(Boolean),
    extraTargetUrls: document.getElementById('f-extraTargetUrls').value.split('\n').map((x) => x.trim()).filter(Boolean),
    authType: document.getElementById('f-authType').value,
    authUser: document.getElementById('f-authUser').value.trim(),
    onSuccess: document.getElementById('f-onSuccess').value,
    archiveSubfolder: document.getElementById('f-archiveSubfolder').value.trim(),
    onError: document.getElementById('f-onError').value,
    errorSubfolder: document.getElementById('f-errorSubfolder').value.trim(),
    archiveRetentionDays: Number(document.getElementById('f-archiveRetentionDays').value) || 0,
    category: document.getElementById('f-category').value.trim(),
    notes: document.getElementById('f-notes').value,
    processor: document.getElementById('f-processor').value,
    qrSeite: Number(document.getElementById('f-qrSeite').value) || 1,
    qrDpi: Number(document.getElementById('f-qrDpi').value) || 200,
    sendeFormat: document.getElementById('f-sendeFormat').value,
    stapelTeilen: document.getElementById('f-stapelTeilen').checked,
    vorspannVerwerfen: document.getElementById('f-vorspannVerwerfen').checked,
    teilNamensmuster: document.getElementById('f-teilNamensmuster').value,
    dateiFeldName: document.getElementById('f-dateiFeldName').value.trim() || 'file1',
    metadataFeldName: document.getElementById('f-metadataFeldName').value.trim() || 'metadata1',
    metadataVorlage: document.getElementById('f-metadataVorlage').value,
    auftragsnummer: document.getElementById('f-auftragsnummer').value.trim(),
    dateinameRegex: document.getElementById('f-dateinameRegex').value.trim(),
    dryRun: document.getElementById('f-dryRun').checked,
    dedupe: document.getElementById('f-dedupe').checked,
  };
  try {
    await api('/templates', { method: 'POST', body: JSON.stringify({ name, job }) });
    showToast(t('Template “{name}” saved', { name }), 'success');
    await loadTemplatesIntoSelect();
  } catch (err) { showToast(err.message, 'error'); }
});

// ---------- Self-check banner ----------

let selfcheckDismissed = false;

async function loadSelfCheck() {
  if (selfcheckDismissed) return;
  const el = document.getElementById('selfcheck-banner');
  let sc;
  try { sc = await api('/selfcheck'); } catch { return; }
  if (!sc.problems || sc.problems.length === 0) { el.classList.add('hidden'); return; }
  // Collapsible like the configuration hints — the open state is kept
  const warOffen = el.open;
  el.innerHTML = `<summary>
      <strong>${sc.problems.length === 1 ? t('1 job with problems') : t('{n} jobs with problems', { n: sc.problems.length })}</strong>
      <span class="banner-aktion">${t('show')}</span>
    </summary>
    <ul>${sc.problems.map((p) => `<li><strong>${escapeHtml(p.jobName)}</strong> — ${escapeHtml(p.problem)}</li>`).join('')}</ul>
    <button class="btn btn-ghost dismiss" style="margin-top:8px">${t('Hide')}</button>`;
  el.open = warOffen;
  el.classList.remove('hidden');
}
document.getElementById('selfcheck-banner').addEventListener('click', (e) => {
  if (e.target.closest('.dismiss')) {
    selfcheckDismissed = true;
    document.getElementById('selfcheck-banner').classList.add('hidden');
  }
});

// ---------- Change log ----------

const auditBackdrop = document.getElementById('audit-backdrop');

document.getElementById('btn-show-audit').addEventListener('click', async () => {
  auditBackdrop.classList.add('open');
  const listEl = document.getElementById('audit-list');
  listEl.innerHTML = `<p class="chart-empty">${t('Loading …')}</p>`;
  let entries;
  try { entries = await api('/audit'); } catch (err) { listEl.innerHTML = `<p class="chart-empty">${escapeHtml(err.message)}</p>`; return; }
  if (entries.length === 0) { listEl.innerHTML = `<p class="chart-empty">${t('No changes logged yet.')}</p>`; return; }

  const beschreibung = (a) => {
    if (a.action === 'anmeldung') return t('<strong>{user}</strong> signed in', { user: escapeHtml(a.benutzer || '') });
    if (a.action === 'abmeldung') return t('<strong>{user}</strong> signed out', { user: escapeHtml(a.benutzer || '') });
    if (a.action === 'anmeldung.fehlgeschlagen') return t('Failed sign-in for “{user}”', { user: escapeHtml(a.benutzer || '') });
    if (a.action === 'benutzer.anlegen') return t('User “{user}” created', { user: escapeHtml(a.betroffen || '') });
    if (a.action === 'benutzer.loeschen') return t('User “{user}” removed', { user: escapeHtml(a.betroffen || '') });
    if (a.action === 'benutzer.passwort') return t('Password of “{user}” changed', { user: escapeHtml(a.betroffen || '') });
    if (a.action === 'job.create') return t('Job “{job}” created', { job: escapeHtml(a.jobName) });
    if (a.action === 'job.update') return t('Job “{job}” changed', { job: escapeHtml(a.jobName) }) + (a.fields && a.fields.length ? ` <span class="fields">(${a.fields.map(escapeHtml).join(', ')})</span>` : '');
    if (a.action === 'job.delete') return t('Job “{job}” deleted', { job: escapeHtml(a.jobName) });
    if (a.action === 'job.bulk') return t('Bulk action “{action}” on {n} job(s)', { action: escapeHtml(a.action2 || a.actionName || a.actionType || a.action), n: a.affected });
    if (a.action === 'category.rename') return t('Category “{from}” → “{to}” ({n} job(s))', { from: escapeHtml(a.from), to: escapeHtml(a.to || t('– removed –')), n: a.affected });
    if (a.action === 'template.create') return t('Template “{name}” saved', { name: escapeHtml(a.templateName) });
    if (a.action === 'template.delete') return t('Template deleted');
    return escapeHtml(a.action);
  };
  const typ = (a) => {
    if (a.action.includes('create') || a.action.includes('anlegen') || a.action === 'anmeldung') return 'create';
    if (a.action.includes('delete') || a.action.includes('loeschen') || a.action.includes('fehlgeschlagen')) return 'delete';
    return 'update';
  };

  listEl.innerHTML = entries.map((a) => `
    <div class="audit-row">
      <span class="audit-time">${fmtDateTime(a.ts)}</span>
      <span class="audit-action ${typ(a)}">${escapeHtml(a.action.split('.')[1] || a.action)}</span>
      <span class="audit-text">${beschreibung(a)}${a.benutzer && !['anmeldung', 'abmeldung'].includes(a.action) ? ` <span class="audit-user">· ${escapeHtml(a.benutzer)}</span>` : ''}</span>
    </div>`).join('');
});
document.getElementById('audit-close').addEventListener('click', () => auditBackdrop.classList.remove('open'));
auditBackdrop.addEventListener('click', (e) => { if (e.target === auditBackdrop) auditBackdrop.classList.remove('open'); });

// ---------- Configuration backups ----------

function fmtBackupTime(fileName) {
  // File name: config-2026-08-26T12-30-45-123Z.json
  const raw = fileName.replace('config-', '').replace('.json', '');
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/);
  if (!m) return fileName;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
  return d.toLocaleString(LOCALE, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

async function loadBackups() {
  const el = document.getElementById('backup-list');
  let list;
  try { list = await api('/backups'); } catch (err) { el.innerHTML = `<p class="chart-empty">${escapeHtml(err.message)}</p>`; return; }
  if (list.length === 0) {
    el.innerHTML = `<p class="chart-empty">${t('No backups yet.')}</p>`;
    return;
  }
  el.innerHTML = list.map((bk, i) => `
    <div class="backup-row">
      <span class="backup-when">${fmtBackupTime(bk.file)}${i === 0 ? ` <span style="color:var(--text-faint)">${t('(latest)')}</span>` : ''}</span>
      <span class="backup-meta">${bk.jobCount === null ? t('damaged') : t('{n} job(s)', { n: bk.jobCount })}</span>
      <button type="button" class="btn" data-restore="${escapeHtml(bk.file)}" ${bk.jobCount === null ? 'disabled' : ''}>${t('Restore')}</button>
    </div>`).join('');
}

document.getElementById('backup-list').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-restore]');
  if (!btn) return;
  const file = btn.dataset.restore;
  askConfirm(
    t('The configuration will be reset to the state of {time}. All jobs created or changed since then will be lost. The current state is backed up automatically first.', { time: fmtBackupTime(file) }),
    t('Restore'),
    async () => {
      const r = await api('/backups/restore', { method: 'POST', body: JSON.stringify({ file }) });
      showToast(t('Restored — {n} job(s) active', { n: r.jobCount }), 'success');
      await loadJobs();
      await loadStatus();
      await loadBackups();
    });
});

// ---------- Configuration warnings ----------

async function loadConfigWarnings() {
  if (warningsDismissed) return;
  const el = document.getElementById('warning-banner');
  let list;
  try { list = await api('/config-warnings'); } catch { return; }
  if (!list || list.length === 0) { el.classList.add('hidden'); return; }
  const hoch = list.filter((w) => w.severity === 'hoch').length;
  const warOffen = el.open;
  el.innerHTML = `<summary><strong>${list.length === 1 ? t('1 configuration notice') : t('{n} configuration notices', { n: list.length })}</strong>${hoch ? `<span class="sev hoch" style="margin-left:8px">${t('{n} critical', { n: hoch })}</span>` : ''}<span class="banner-aktion">${t('show')}</span></summary>
    <ul>${list.map((w) => `<li><span class="sev ${w.severity}">${w.severity === 'hoch' ? t('high') : t('medium')}</span>${escapeHtml(w.text)}</li>`).join('')}</ul>
    <button class="btn btn-ghost dismiss" style="margin-top:8px">${t('Hide notices')}</button>`;
  el.open = warOffen; // keep the state across refreshes
  el.classList.remove('hidden');
}
document.getElementById('warning-banner').addEventListener('click', (e) => {
  if (e.target.closest('.dismiss')) {
    warningsDismissed = true;
    document.getElementById('warning-banner').classList.add('hidden');
  }
});

// ---------- Archive view ----------

const btnArchive = document.getElementById('btn-toggle-archive');
const btnArchivZurueck = document.getElementById('btn-archiv-zurueck');

function setzeArchivAnsicht(an) {
  letzteJobSignatur = null;
  showArchived = an;
  btnArchive.classList.toggle('checked', an);
  btnArchive.textContent = an ? '✓ ' + t('Showing archive') : t('Show archive');
  btnArchivZurueck.classList.toggle('hidden', !an);
  document.querySelector('.jobs-panel .panel-head h2').textContent = an ? t('Archive') : t('Jobs');
  selectedIds.clear();
  syncBulkBar();
  renderJobs();
}

btnArchive.addEventListener('click', () => {
  setzeArchivAnsicht(!showArchived);
  document.getElementById('view-menu').classList.add('hidden');
});
btnArchivZurueck.addEventListener('click', () => setzeArchivAnsicht(false));

// ---------- Tool overview for PDF processing ----------

document.getElementById('btn-check-tools').addEventListener('click', async () => {
  const el = document.getElementById('tools-result');
  el.innerHTML = `<p class="chart-empty">${t('Checking …')}</p>`;
  let w;
  try { w = await api('/pdf-werkzeuge'); } catch (err) { el.innerHTML = `<p class="chart-empty">${escapeHtml(err.message)}</p>`; return; }

  const qf = w.qrFaehigkeit || {};

  // The built-in reader is the normal case — first and prominent
  const eingebaut = `
    <div class="tool-row ok">
      <div class="kopf"><span>${t('Built-in QR reader')}</span><span class="status">${t('active')}</span></div>
      <div class="zeile">${t('Evaluates scanned PDFs without additional programs — own JPEG and QR decoder with error correction.')}</div>
      ${w.eigenerQrBefehl ? `<div class="zeile">${t('A custom QR command is configured and takes precedence: {command}', { command: escapeHtml(w.eigenerQrBefehl) })}</div>` : ''}
    </div>`;

  const optional = (d, zweck) => `
    <div class="tool-row">
      <div class="kopf">
        <span>${escapeHtml(d.name)}</span>
        <span class="status" style="color:var(--text-faint)">${d.ok ? t('optional — available') : t('optional — not available')}</span>
      </div>
      <div class="zeile">${escapeHtml(zweck)}</div>
      ${d.ok ? `<div class="zeile">${t('Path: {path}', { path: escapeHtml(d.pfad) })}</div>` : ''}
    </div>`;

  el.innerHTML = eingebaut
    + `<p style="font-size:11.5px;color:var(--text-faint);margin:12px 0 8px">${t('The following programs are <strong>not required</strong>. They only serve as a fallback if a PDF cannot be evaluated directly — for example JBIG2-compressed black-and-white scans.')}</p>`
    + optional(w.pdftoppm, t('Renders PDF pages as images'))
    + optional(w.pdftocairo, t('Second rendering path'))
    + optional(w.zbarimg, t('External barcode reader'))
    + (qf.pruefbar && !qf.kannQr
        ? `<div class="tool-row"><div class="zeile" style="color:var(--text-dim)">${t('The installed zbarimg cannot read QR codes. The built-in reader is used for detection anyway.')}</div></div>`
        : '');
});

// ---------- Preview of the metadata template ----------

document.getElementById('btn-preview-metadata').addEventListener('click', async () => {
  const statusEl = document.getElementById('metadata-preview-result');
  const ausgabeEl = document.getElementById('metadata-preview');
  statusEl.className = '';
  statusEl.textContent = t('Generating …');
  try {
    const r = await api('/metadata-vorschau', {
      method: 'POST',
      body: JSON.stringify({
        metadataVorlage: document.getElementById('f-metadataVorlage').value,
        auftragsnummer: document.getElementById('f-auftragsnummer').value.trim(),
        dateinameRegex: document.getElementById('f-dateinameRegex').value.trim(),
        beispielDateiname: '1234_001.pdf',
        beispielQrWert: '1234',
        name: document.getElementById('f-name').value.trim(),
      }),
    });
    statusEl.className = r.gueltig ? 'ok' : 'error';
    statusEl.textContent = r.gueltig ? '✓ ' + t('valid JSON') : '✗ ' + t('invalid JSON: {error}', { error: r.fehler });
    ausgabeEl.textContent = r.text;
    ausgabeEl.classList.remove('hidden');
  } catch (err) {
    statusEl.className = 'error';
    statusEl.textContent = err.message;
  }
});

// ---------- Form sections: only expand deviations automatically ----------

function aktualisiereFormularAbschnitte(job) {
  const wert = (id) => (document.getElementById(id) || {}).value;
  const abweichungen = {
    'sec-dateiauswahl': () => Number(wert('f-minFileAgeSec')) > 0 || Number(wert('f-maxFileSizeMB')) > 0,
    'sec-uebertragung': () => wert('f-method') !== 'POST'
      || wert('f-uploadMode') !== 'binary'
      || (wert('f-headers') || '').trim() !== ''
      || wert('f-authType') !== 'none'
      || (wert('f-curlExtraArgs') || '').trim() !== '',
    'sec-nachher': () => wert('f-onSuccess') !== 'archive'
      || wert('f-onError') !== 'keep'
      || (wert('f-archiveSubfolder') || '_sent') !== '_sent'
      || (wert('f-errorSubfolder') || '_error') !== '_error'
      || Number(wert('f-archiveRetentionDays')) > 0,
    'sec-zeitfenster': () => document.getElementById('f-scheduleEnabled').checked,
    'sec-extras': () => (wert('f-extraTargetUrls') || '').trim() !== '' || (wert('f-notes') || '').trim() !== '',
  };

  Object.entries(abweichungen).forEach(([id, pruefe]) => {
    const el = document.getElementById(id);
    if (!el) return;
    let abweichend = false;
    try { abweichend = Boolean(pruefe()); } catch { abweichend = false; }
    el.classList.toggle('geaendert', abweichend);
    // Expand when editing so that values that are set are not overlooked.
    // For new jobs everything stays collapsed so that the form starts lean.
    el.open = Boolean(job) && abweichend;
  });
}

// ---------- Inspect sent data ----------

const sendeBackdrop = document.getElementById('sende-backdrop');

async function zeigeSendevorschau(jobId, file) {
  sendeBackdrop.classList.add('open');
  const el = document.getElementById('sende-inhalt');
  el.innerHTML = `<p class="chart-empty">${t('Determining — the file is processed but NOT sent …')}</p>`;
  let r;
  try {
    r = await api('/sendevorschau', { method: 'POST', body: JSON.stringify({ jobId, file }) });
  } catch (err) {
    el.innerHTML = `<p class="chart-empty">${escapeHtml(err.message)}</p>`;
    return;
  }
  if (r.fehler) {
    el.innerHTML = `<div class="tool-row fehlt"><div class="kopf"><span>${t('Processing failed')}</span></div><div class="grund">${escapeHtml(r.fehler)}</div></div>`;
    return;
  }
  if (r.modus === 'roh') {
    el.innerHTML = `<p style="font-size:12.5px;color:var(--text-dim)">${escapeHtml(r.hinweis)}</p>
      <pre class="preview-list" style="white-space:pre-wrap">${escapeHtml(r.curl)}</pre>`;
    return;
  }

  el.innerHTML = `
    <div class="tool-row ${r.qrGefunden ? 'ok' : 'fehlt'}" style="margin-bottom:12px">
      <div class="kopf"><span>${t('QR code')}</span><span class="status">${r.qrGefunden ? t('detected') : t('not detected')}</span></div>
      <div class="zeile">${t('Value: {value}', { value: r.qrWert === null ? t('– none –') : escapeHtml(String(r.qrWert)) })}</div>
      <div class="zeile">${t('Image source: {source}', { source: escapeHtml(r.bildquelle || '–') })}</div>
      ${r.qrHinweis ? `<div class="grund">${escapeHtml(r.qrHinweis)}</div>` : ''}
    </div>

    <div class="tool-row" style="margin-bottom:12px">
      <div class="kopf"><span>${t('PDF structure')}</span><span class="status" style="color:var(--text-faint)">${r.textebene && r.textebene.hatTextebene ? t('with text layer') : t('pure scan')}</span></div>
      <div class="zeile">${r.textebene ? t('Text characters: {chars} · Fonts: {fonts}', { chars: r.textebene.textZeichen, fonts: r.textebene.schriften }) : ''}</div>
      <div class="zeile">${r.bildarten ? t('Images: {n} (JPEG {jpeg}, CCITT {ccitt}, JBIG2 {jbig2})', { n: r.bildarten.bilder, jpeg: r.bildarten.jpeg, ccitt: r.bildarten.ccitt, jbig2: r.bildarten.jbig2 }) : ''}</div>
      <div class="zeile" style="color:var(--text-faint)">${r.textebene && r.textebene.hatTextebene
        ? t('Fields could in principle be read from the text.')
        : t('Without a text layer, only the QR code and the file name are available as sources.')}</div>
    </div>

    <p class="drawer-section-title" style="margin:0 0 6px">${t('Transfer type')}</p>
    <div class="zeile" style="font-family:var(--font-mono);font-size:11.5px;color:var(--text-dim);margin-bottom:12px">
      ${r.modus === 'multipart'
        ? 'multipart/form-data · ' + t('Fields: <strong>{file}</strong> (PDF) and <strong>{meta}</strong> (JSON)', { file: escapeHtml(r.felder.datei), meta: escapeHtml(r.felder.metadaten) })
        : t('JSON body with embedded PDF')}
      <br>${t('Target: {target}', { target: escapeHtml(r.zielUrl) })}
      ${r.header && r.header.length ? '<br>Header: ' + r.header.map(escapeHtml).join(' · ') : ''}
    </div>

    <p class="drawer-section-title" style="margin:0 0 6px">
      ${t('Field content')} <span style="font-weight:400;color:var(--text-faint)">(${t('{n} bytes', { n: r.groesse })})</span>
      ${r.istJson ? `<span style="color:var(--success)">· ${t('valid JSON')}</span>` : `<span style="color:var(--error)">· ${t('NOT valid JSON: {error}', { error: escapeHtml(r.jsonFehler || '') })}</span>`}
    </p>
    <pre class="preview-list" style="white-space:pre-wrap;max-height:260px">${escapeHtml(r.inhalt || '')}</pre>

    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">
      <a class="btn" href="/api/sendevorschau/download?jobId=${encodeURIComponent(jobId)}&file=${encodeURIComponent(file)}&lang=${SPRACHE}" style="text-decoration:none">↓ ${t('Download JSON')}</a>
      ${r.modus === 'json' ? `<a class="btn btn-ghost" href="/api/sendevorschau/download?jobId=${encodeURIComponent(jobId)}&file=${encodeURIComponent(file)}&voll=1&lang=${SPRACHE}" style="text-decoration:none">↓ ${t('incl. embedded PDF')}</a>` : ''}
    </div>

    <p class="drawer-section-title" style="margin:14px 0 6px">${t('Equivalent curl call')}</p>
    <pre class="preview-list" style="white-space:pre-wrap">${escapeHtml(r.curl)}</pre>
    <p style="font-size:11.5px;color:var(--text-faint);margin-top:8px">${t('Note: for this view the file was processed again, but nothing was sent.')}</p>`;
}

document.getElementById('sende-close').addEventListener('click', () => sendeBackdrop.classList.remove('open'));
sendeBackdrop.addEventListener('click', (e) => { if (e.target === sendeBackdrop) sendeBackdrop.classList.remove('open'); });

[logStream, drawerLog, document.getElementById('detail-column')].forEach((el) => {
  if (!el) return;
  el.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-pruef-file]');
    if (!btn) return;
    e.stopPropagation();
    zeigeSendevorschau(btn.dataset.pruefJob, btn.dataset.pruefFile);
  });
});

// ---------- Users & sign-in ----------

async function ladeBenutzer() {
  const el = document.getElementById('benutzer-liste');
  if (!el) return;
  let liste;
  try { liste = await api('/benutzer'); } catch (err) { el.innerHTML = `<p class="chart-empty">${escapeHtml(err.message)}</p>`; return; }
  if (liste.length === 0) {
    el.innerHTML = `<p class="chart-empty">${t('No user created yet — the application can be used without signing in.')}</p>`;
    return;
  }
  el.innerHTML = liste.map((b) => `
    <div class="benutzer-zeile">
      <span class="benutzer-kopf">
        <strong>${escapeHtml(b.anzeigename)}</strong>
        <span class="benutzer-kennung">${escapeHtml(b.name)}</span>
      </span>
      <span class="benutzer-rolle">${t({ verwaltung: 'Administrator', betrachter: 'Viewer', benutzer: 'User' }[b.rolle] || 'User')}</span>
      <button class="btn" data-pw="${b.id}" data-name="${escapeHtml(b.anzeigename)}">${t('Change password')}</button>
      <button class="btn btn-ghost" data-del="${b.id}" data-name="${escapeHtml(b.anzeigename)}">${t('Remove')}</button>
    </div>`).join('');
}

document.getElementById('benutzer-liste').addEventListener('click', async (e) => {
  const pw = e.target.closest('button[data-pw]');
  const del = e.target.closest('button[data-del]');
  const ergebnis = document.getElementById('benutzer-ergebnis');

  if (pw) {
    const neu = prompt(t('New password for “{user}” (at least 4 characters):', { user: pw.dataset.name }));
    if (!neu) return;
    try {
      await api(`/benutzer/${pw.dataset.pw}/passwort`, { method: 'POST', body: JSON.stringify({ passwort: neu }) });
      ergebnis.className = 'ok';
      ergebnis.textContent = t('Password for “{user}” changed.', { user: pw.dataset.name });
      showToast(t('Password changed'), 'success');
    } catch (err) { ergebnis.className = 'error'; ergebnis.textContent = err.message; }
    return;
  }

  if (del) {
    askConfirm(
      t('User “{user}” will be removed and their active sessions will be ended.', { user: del.dataset.name }),
      t('Remove'),
      async () => {
        await api(`/benutzer/${del.dataset.del}`, { method: 'DELETE' });
        showToast(t('“{user}” removed', { user: del.dataset.name }), 'success');
        await ladeBenutzer();
        await ladeAnmeldestatus();
      });
  }
});

document.getElementById('btn-benutzer-anlegen').addEventListener('click', async () => {
  const ergebnis = document.getElementById('benutzer-ergebnis');
  const name = document.getElementById('neu-benutzer-name').value.trim();
  const anzeigename = document.getElementById('neu-benutzer-anzeige').value.trim();
  const passwort = document.getElementById('neu-benutzer-passwort').value;
  const rolle = document.getElementById('neu-benutzer-rolle').value;
  try {
    await api('/benutzer', { method: 'POST', body: JSON.stringify({ name, anzeigename, passwort, rolle }) });
    ergebnis.className = 'ok';
    ergebnis.textContent = t('User “{user}” created.', { user: anzeigename || name });
    ['neu-benutzer-name', 'neu-benutzer-anzeige', 'neu-benutzer-passwort'].forEach((id) => { document.getElementById(id).value = ''; });
    showToast(t('User created'), 'success');
    await ladeBenutzer();
    await ladeAnmeldestatus();
    markiereSettingsGespeichert();
  } catch (err) {
    ergebnis.className = 'error';
    ergebnis.textContent = err.message;
  }
});

async function ladeAnmeldestatus() {
  let ich;
  try { ich = await api('/ich'); } catch { return; }
  darfVerwalten = ich.darfVerwalten !== false;
  darfAendern = ich.darfAendern !== false;
  wendeRolleAn();
  const anzeige = document.getElementById('benutzer-anzeige');
  if (ich.angemeldet) {
    document.getElementById('benutzer-name').textContent = ich.anzeigename;
    anzeige.classList.remove('hidden');
  } else {
    anzeige.classList.add('hidden');
  }
}

document.getElementById('btn-abmelden').addEventListener('click', async () => {
  try { await api('/abmelden', { method: 'POST' }); } catch { /* ignore */ }
  window.location.href = '/anmelden.html';
});

ladeAnmeldestatus();
zeigeStandardKopf();
ladeKopf();

// ---------- Trial run in the job form ----------

function entwurfAusFormular() {
  return {
    name: document.getElementById('f-name').value.trim() || t('Draft'),
    sourcePath: document.getElementById('f-sourcePath').value.trim(),
    filePattern: document.getElementById('f-filePattern').value.trim() || '*',
    maxFileSizeMB: Number(document.getElementById('f-maxFileSizeMB').value) || 0,
    targetUrl: document.getElementById('f-targetUrl').value.trim(),
    zielTyp: document.getElementById('f-zielTyp').value,
    zielOrdner: document.getElementById('f-zielOrdner').value.trim(),
    ordnerUeberschreiben: document.getElementById('f-ordnerUeberschreiben').checked,
    smtpHost: document.getElementById('f-smtpHost').value.trim(),
    smtpPort: Number(document.getElementById('f-smtpPort').value) || 587,
    smtpBenutzer: document.getElementById('f-smtpBenutzer').value.trim(),
    smtpPasswort: document.getElementById('f-smtpPasswort').value,
    smtpSicher: document.getElementById('f-smtpSicher').checked,
    mailVon: document.getElementById('f-mailVon').value.trim(),
    mailAn: document.getElementById('f-mailAn').value.trim(),
    mailBetreff: document.getElementById('f-mailBetreff').value,
    maxVersuche: Number(document.getElementById('f-maxVersuche').value),
    wartezeitBasisSec: Number(document.getElementById('f-wartezeitBasisSec').value) || 60,
    quarantaeneSubfolder: document.getElementById('f-quarantaeneSubfolder').value.trim() || '_quarantine',
    method: document.getElementById('f-method').value,
    headers: document.getElementById('f-headers').value.split('\n').map((x) => x.trim()).filter(Boolean),
    processor: document.getElementById('f-processor').value,
    qrSeite: Number(document.getElementById('f-qrSeite').value) || 1,
    qrDpi: Number(document.getElementById('f-qrDpi').value) || 200,
    sendeFormat: document.getElementById('f-sendeFormat').value,
    stapelTeilen: document.getElementById('f-stapelTeilen').checked,
    vorspannVerwerfen: document.getElementById('f-vorspannVerwerfen').checked,
    teilNamensmuster: document.getElementById('f-teilNamensmuster').value,
    dateiFeldName: document.getElementById('f-dateiFeldName').value.trim() || 'file1',
    metadataFeldName: document.getElementById('f-metadataFeldName').value.trim() || 'metadata1',
    metadataVorlage: document.getElementById('f-metadataVorlage').value,
    auftragsnummer: document.getElementById('f-auftragsnummer').value.trim(),
    dateinameRegex: document.getElementById('f-dateinameRegex').value.trim(),
    archiveSubfolder: document.getElementById('f-archiveSubfolder').value.trim() || '_sent',
    errorSubfolder: document.getElementById('f-errorSubfolder').value.trim() || '_error',
  };
}

document.getElementById('btn-probelauf').addEventListener('click', async () => {
  const status = document.getElementById('probelauf-status');
  const ergebnis = document.getElementById('probelauf-ergebnis');
  const entwurf = entwurfAusFormular();

  if (!entwurf.sourcePath) {
    status.className = 'error';
    status.textContent = t('Please enter the source folder first.');
    return;
  }
  status.className = 'pending';
  status.textContent = t('Test run in progress …');
  ergebnis.classList.add('hidden');

  let r;
  try {
    r = await api('/entwurf-vorschau', { method: 'POST', body: JSON.stringify(entwurf) });
  } catch (err) {
    status.className = 'error';
    status.textContent = err.message;
    return;
  }

  if (!r.ok) {
    status.className = 'error';
    status.textContent = r.meldung || t('Test run not possible.');
    ergebnis.classList.add('hidden');
    return;
  }

  status.className = 'ok';
  status.textContent = '✓ ' + t('checked with “{file}”', { file: r.datei });

  const teile = [];
  teile.push(`<div class="probe-zeile">${t('Files found: <strong>{n}</strong>', { n: r.gefunden })}${r.wartend ? ' · ' + t('{n} waiting for settle time', { n: r.wartend }) : ''}${r.zuGross && r.zuGross.length ? ' · ' + t('{n} too large', { n: r.zuGross.length }) : ''}</div>`);

  if (r.modus === 'roh') {
    teile.push(`<div class="probe-zeile">${escapeHtml(r.hinweis)}</div>`);
    teile.push(`<pre>${escapeHtml(r.curl)}</pre>`);
  } else {
    teile.push(`<div class="probe-zeile">${t('QR code')}: <strong style="color:${r.qrGefunden ? 'var(--success)' : 'var(--error)'}">${r.qrGefunden ? escapeHtml(String(r.qrWert)) : t('not detected')}</strong>${r.bildquelle ? ' · ' + t('Source: {source}', { source: escapeHtml(r.bildquelle) }) : ''}</div>`);
    if (!r.qrGefunden && r.qrHinweis) teile.push(`<div class="probe-zeile" style="color:var(--error)">${escapeHtml(r.qrHinweis)}</div>`);
    if (r.modus === 'multipart') {
      teile.push(`<div class="probe-zeile">${t('Fields: <strong>{file}</strong> (PDF) and <strong>{meta}</strong> (JSON)', { file: escapeHtml(r.felder.datei), meta: escapeHtml(r.felder.metadaten) })}</div>`);
    }
    teile.push(`<div class="probe-zeile">${r.istJson ? `<span style="color:var(--success)">${t('valid JSON')}</span>` : `<span style="color:var(--error)">${t('invalid JSON: {error}', { error: escapeHtml(r.jsonFehler || '') })}</span>`}</div>`);
    teile.push(`<pre>${escapeHtml(r.inhalt || '')}</pre>`);
  }
  ergebnis.innerHTML = teile.join('');
  ergebnis.classList.remove('hidden');
});

// ---------- Applying roles in the interface ----------

let darfVerwalten = true;
let darfAendern = true;

function wendeRolleAn() {
  // Viewers may not change anything — hide all controls for that
  document.body.classList.toggle('nur-lesen', !darfAendern);
  const neuerJob = document.getElementById('btn-new-job');
  if (neuerJob) { neuerJob.disabled = !darfAendern; if (!darfAendern) neuerJob.title = t('Viewers cannot create jobs'); }
  const auswahl = document.getElementById('btn-toggle-select');
  if (auswahl) auswahl.disabled = !darfAendern;

  // Buttons that only administrators may use
  const sperren = [
    ['btn-open-settings', t('Settings are reserved for administrators')],
    ['btn-reset-stats', t('Resetting the log is reserved for administrators')],
  ];
  sperren.forEach(([id, titel]) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.disabled = !darfVerwalten;
    if (!darfVerwalten) el.title = titel;
  });

  const transfer = document.getElementById('btn-open-transfer');
  if (transfer) {
    transfer.disabled = !darfVerwalten;
    if (!darfVerwalten) transfer.title = t('Export and import are reserved for administrators');
  }
  document.body.classList.toggle('nur-benutzer', !darfVerwalten);
}

document.getElementById('btn-save-joboverview').addEventListener('click', async () => {
  const an = document.getElementById('einst-joboverview').checked;
  const ergebnis = document.getElementById('settings-result');
  try {
    await api('/settings', { method: 'PUT', body: JSON.stringify({ jobUebersichtImLogin: an }) });
    ergebnis.className = 'ok';
    ergebnis.textContent = an
      ? t('The job overview now appears on the sign-in screen.')
      : t('Job overview hidden on the sign-in screen.');
    showToast(t('Setting saved'), 'success');
    markiereSettingsGespeichert();
  } catch (err) {
    ergebnis.className = 'error';
    ergebnis.textContent = err.message;
  }
});

// ---------- Queue ----------

const warteBackdrop = document.getElementById('warte-backdrop');

async function zeigeWarteschlange(jobId, jobName) {
  warteBackdrop.classList.add('open');
  document.getElementById('warte-titel').textContent = `${t('Queue')} · ${jobName}`;
  document.getElementById('warte-titel').dataset.jobName = jobName;
  const el = document.getElementById('warte-inhalt');
  el.innerHTML = `<p class="chart-empty">${t('Loading …')}</p>`;

  let w;
  try { w = await api('/warteschlange?jobId=' + encodeURIComponent(jobId)); }
  catch (err) { el.innerHTML = `<p class="chart-empty">${escapeHtml(err.message)}</p>`; return; }

  if (!w.ok) {
    el.innerHTML = `<div class="tool-row fehlt"><div class="grund">${escapeHtml(w.meldung || t('Not available'))}</div></div>`;
    return;
  }

  const dateiZeile = (d, zusatz = '') => `
    <div class="warte-datei">
      <span class="warte-name" title="${escapeHtml(d.name)}">${escapeHtml(d.name)}</span>
      <span class="warte-groesse">${d.groesse === null || d.groesse === undefined ? '' : fmtBytes(d.groesse)}</span>
      ${zusatz}
    </div>`;

  const gruppe = (titel, liste, farbe, aufbau) => {
    if (!liste || liste.length === 0) return '';
    return `<div class="warte-gruppe">
      <p class="warte-titel"><span class="warte-punkt" style="background:${farbe}"></span>${titel} <span class="warte-zahl">${liste.length}</span></p>
      ${liste.slice(0, 40).map(aufbau).join('')}
      ${liste.length > 40 ? `<p class="warte-mehr">${t('… and {n} more', { n: liste.length - 40 })}</p>` : ''}
    </div>`;
  };

  const teile = [];
  teile.push(gruppe(t('Being transferred'), w.inArbeit, 'var(--accent)',
    (d) => dateiZeile(d, `<span class="warte-lage">${t('for {s}s', { s: Math.round((Date.now() - d.seit) / 1000) })}</span>`)));
  teile.push(gruppe(t('Ready for transfer'), w.bereit, 'var(--success)',
    (d) => dateiZeile(d, d.versuche ? `<span class="warte-lage">${t('{n} attempt(s)', { n: d.versuche })}</span>` : '')));
  teile.push(gruppe(t('Waiting for settle time ({s}s)', { s: w.ruhezeitSek }), w.wartetAufRuhezeit, 'var(--warning)',
    (d) => dateiZeile(d)));
  teile.push(gruppe(t('Waiting for retry'), w.wartetAufWiederholung, 'var(--warning)',
    (d) => dateiZeile(d, `<span class="warte-lage">${t('Attempt {n}', { n: d.versuche + (w.maxVersuche ? '/' + w.maxVersuche : '') })} · ${t('in {s}s', { s: Math.max(0, Math.round((d.naechsterVersuch - Date.now()) / 1000)) })}</span>`)));
  teile.push(gruppe(t('Skipped — too large'), w.zuGross, 'var(--error)', (d) => dateiZeile(d)));
  teile.push(gruppe(t('In the error folder'), w.fehlerordner, 'var(--error)', (d) => dateiZeile(d)));
  teile.push(gruppe(t('In quarantine'), w.quarantaene, 'var(--error)',
    (d) => dateiZeile(d, `<button class="btn" data-quar="${escapeHtml(d.name)}" data-job="${jobId}">${t('Restore')}</button>`)));

  const leer = teile.every((x) => x === '');
  el.innerHTML = leer
    ? `<p class="chart-empty">${t('Nothing pending — the source folder is empty.')}</p>`
    : teile.join('');
}

document.getElementById('warte-close').addEventListener('click', () => warteBackdrop.classList.remove('open'));
warteBackdrop.addEventListener('click', (e) => { if (e.target === warteBackdrop) warteBackdrop.classList.remove('open'); });
document.getElementById('warte-inhalt').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-quar]');
  if (!btn) return;
  try {
    await api('/quarantaene/zurueck', { method: 'POST', body: JSON.stringify({ jobId: btn.dataset.job, file: btn.dataset.quar }) });
    showToast(t('“{file}” restored — it will be retried on the next run', { file: btn.dataset.quar }), 'success');
    zeigeWarteschlange(btn.dataset.job, document.getElementById('warte-titel').dataset.jobName || '');
  } catch (err) { showToast(err.message, 'error'); }
});

// ---------- Header: name and version number ----------

function zeigeStandardKopf() {
  const name = document.getElementById('brand-name');
  const sub = document.getElementById('brand-sub');
  if (!name || !sub) return;
  name.textContent = 'Folderpost';
  sub.innerHTML = `${t('Folder')} <span class="arrow">→</span> curl <span class="arrow">→</span> ${t('API')}`;
}

async function ladeKopf() {
  try {
    const info = await api('/info');
    const el = document.getElementById('versions-nummer');
    if (el && info.version) {
      el.textContent = 'v' + info.version;
      el.title = t('Installed version {v}', { v: info.version })
        + (info.baustand ? ' · ' + t('package of {time}', { time: new Date(info.baustand).toLocaleString(LOCALE) }) : '');
    }
  } catch { /* not available without signing in */ }
}

// Shows an available update at the version number
function markiereAktualisierung(verfuegbar, neueVersion) {
  const el = document.getElementById('versions-nummer');
  if (el) {
    el.classList.toggle('aktualisierung', Boolean(verfuegbar));
    if (verfuegbar) el.title = t('New version {v} available — install it in the settings', { v: neueVersion });
  }
  const reiter = document.querySelector('.settings-tab[data-spanel="system"]');
  if (reiter) {
    reiter.classList.toggle('reiter-aktualisierung', Boolean(verfuegbar));
    if (verfuegbar) reiter.title = t('New version {v} available', { v: neueVersion });
  }
}

// ---------- Updates ----------

async function ladeUpdateStand(s) {
  const el = document.getElementById('update-stand');
  document.getElementById('update-url').value = (s && s.updatePruefUrl) || '';
  el.innerHTML = `
    <div class="tool-row">
      <div class="kopf"><span>${t('Installed version')}</span><span class="status" style="color:var(--text-faint)">${escapeHtml((s && s.version) || '')}</span></div>
      <div class="zeile">${s && s.baustand ? t('Package of {time}', { time: fmtDateTime(s.baustand) }) : ''}</div>
      <div class="zeile">${s && s.letzteUpdatePruefung ? t('Last checked: {time}', { time: fmtDateTime(s.letzteUpdatePruefung) }) : t('Never checked for updates')}</div>
    </div>`;
}

document.getElementById('btn-update-url').addEventListener('click', async () => {
  const erg = document.getElementById('update-ergebnis');
  try {
    await api('/settings', { method: 'PUT', body: JSON.stringify({ updatePruefUrl: document.getElementById('update-url').value.trim() }) });
    erg.className = 'ok';
    erg.textContent = t('Check URL saved.');
    markiereSettingsGespeichert();
  } catch (err) { erg.className = 'error'; erg.textContent = err.message; }
});

document.getElementById('btn-update-pruefen').addEventListener('click', async () => {
  const erg = document.getElementById('update-ergebnis');
  erg.className = '';
  erg.textContent = t('Checking …');
  try {
    const r = await api('/update/pruefen', { method: 'POST' });
    if (!r.ok) { erg.className = 'error'; erg.textContent = r.meldung; return; }
    markiereAktualisierung(r.aktualisierungVerfuegbar, r.verfuegbareVersion);
    if (r.aktualisierungVerfuegbar) {
      erg.className = 'ok';
      erg.innerHTML = t('New version <strong>{v}</strong> available (installed: {installed}).', { v: escapeHtml(r.verfuegbareVersion), installed: escapeHtml(r.aktuelleVersion) })
        + (r.hinweis ? `<br>${escapeHtml(r.hinweis)}` : '')
        + (r.download ? `<br><a href="${escapeHtml(r.download)}" target="_blank" rel="noopener">${t('Go to download')}</a>` : '')
        + `<br><span style="color:var(--text-faint)">${t('Export the configuration before installing — it can be imported again afterwards.')}</span>`;
    } else {
      erg.className = 'ok';
      erg.textContent = t('The installed version {v} is up to date.', { v: r.aktuelleVersion });
    }
    const s = await api('/settings');
    ladeUpdateStand(s);
    ladeBetriebsart();
  } catch (err) { erg.className = 'error'; erg.textContent = err.message; }
});

// ---------- Appearance ----------

let logoZwischenspeicher = null; // null = unchanged, '' = remove

function wendeErscheinungsbildAn(e) {
  // Set the accent colour globally
  if (e.akzentFarbe) {
    document.documentElement.style.setProperty('--accent', e.akzentFarbe);
    document.documentElement.style.setProperty('--accent-dim', e.akzentFarbe + '26');
  } else {
    document.documentElement.style.removeProperty('--accent');
    document.documentElement.style.removeProperty('--accent-dim');
  }

  // Logo in the header
  const marke = document.querySelector('.brand-mark');
  if (marke) {
    marke.classList.toggle('hat-logo', Boolean(e.logoDatenUrl));
    const altesBild = marke.querySelector('img');
    if (altesBild) altesBild.remove();
    if (e.logoDatenUrl) {
      const bild = document.createElement('img');
      bild.src = e.logoDatenUrl;
      bild.alt = '';
      marke.appendChild(bild);
    }
  }

  // A custom display name replaces the project name in the header
  if (e.anzeigeName) {
    const name = document.getElementById('brand-name');
    const sub = document.getElementById('brand-sub');
    if (name) name.textContent = e.anzeigeName;
    if (sub) sub.textContent = 'Folderpost';
  } else {
    zeigeStandardKopf();
  }
}

function aktualisiereMarkenVorschau() {
  const name = document.getElementById('marke-name-eingabe').value.trim();
  document.getElementById('marken-name').textContent = name || 'Folderpost';
  const farbe = document.getElementById('marke-farbe-hex').value.trim();
  const logo = document.getElementById('marken-logo');
  if (/^#[0-9a-fA-F]{6}$/.test(farbe)) {
    logo.style.background = farbe + '26';
    logo.style.setProperty('--accent', farbe);
  }
}

async function ladeErscheinungsbild() {
  let e;
  try { e = await api('/erscheinungsbild'); } catch { return; }
  if (!document.getElementById('marke-name-eingabe')) { wendeErscheinungsbildAn(e); return; }
  logoZwischenspeicher = null;
  document.getElementById('marke-name-eingabe').value = e.anzeigeName || '';
  document.getElementById('marke-farbe').value = e.akzentFarbe || '#D0764C';
  document.getElementById('marke-farbe-hex').value = e.akzentFarbe || '';

  const logo = document.getElementById('marken-logo');
  logo.classList.toggle('hat-bild', Boolean(e.logoDatenUrl));
  logo.innerHTML = e.logoDatenUrl ? `<img src="${e.logoDatenUrl}" alt="">` : '';
  document.getElementById('marken-name').textContent = e.anzeigeName || 'Folderpost';
  wendeErscheinungsbildAn(e);
}

['marke-name-eingabe', 'marke-farbe-hex'].forEach((id) => {
  document.getElementById(id).addEventListener('input', aktualisiereMarkenVorschau);
});
document.getElementById('marke-farbe').addEventListener('input', (ev) => {
  document.getElementById('marke-farbe-hex').value = ev.target.value;
  aktualisiereMarkenVorschau();
});

// ---------- Notification on failures ----------

async function ladeBenachrichtigung() {
  let b;
  try { b = await api('/benachrichtigung'); } catch { return; }
  document.getElementById('benachr-email-aktiv').checked = Boolean(b.emailAktiv);
  document.getElementById('benachr-smtpHost').value = b.smtpHost || '';
  document.getElementById('benachr-smtpPort').value = b.smtpPort || 587;
  document.getElementById('benachr-smtpSicher').checked = b.smtpSicher !== false;
  document.getElementById('benachr-smtpBenutzer').value = b.smtpBenutzer || '';
  document.getElementById('benachr-smtpPasswort').value = '';
  document.getElementById('benachr-smtpPasswort').placeholder = b.smtpPasswortGesetzt ? '••••••••' : '';
  document.getElementById('benachr-von').value = b.von || '';
  document.getElementById('benachr-an').value = b.an || '';
  document.getElementById('benachr-webhook-aktiv').checked = Boolean(b.webhookAktiv);
  document.getElementById('benachr-webhook-url').value = b.webhookUrl || '';
  document.getElementById('wrap-benachr-email').classList.toggle('hidden', !b.emailAktiv);
  document.getElementById('wrap-benachr-webhook').classList.toggle('hidden', !b.webhookAktiv);
  const reiter = document.querySelector('.settings-tab[data-spanel="benachr"]');
  if (reiter) reiter.classList.toggle('reiter-aktiv', Boolean(b.emailAktiv || b.webhookAktiv));
}

document.getElementById('benachr-email-aktiv').addEventListener('change', (e) => {
  document.getElementById('wrap-benachr-email').classList.toggle('hidden', !e.target.checked);
});
document.getElementById('benachr-webhook-aktiv').addEventListener('change', (e) => {
  document.getElementById('wrap-benachr-webhook').classList.toggle('hidden', !e.target.checked);
});

function sammleBenachrichtigungsFelder() {
  return {
    emailAktiv: document.getElementById('benachr-email-aktiv').checked,
    smtpHost: document.getElementById('benachr-smtpHost').value.trim(),
    smtpPort: Number(document.getElementById('benachr-smtpPort').value) || 587,
    smtpSicher: document.getElementById('benachr-smtpSicher').checked,
    smtpBenutzer: document.getElementById('benachr-smtpBenutzer').value.trim(),
    smtpPasswort: document.getElementById('benachr-smtpPasswort').value, // empty = unchanged
    von: document.getElementById('benachr-von').value.trim(),
    an: document.getElementById('benachr-an').value.trim(),
    webhookAktiv: document.getElementById('benachr-webhook-aktiv').checked,
    webhookUrl: document.getElementById('benachr-webhook-url').value.trim(),
  };
}

document.getElementById('btn-save-benachrichtigung').addEventListener('click', async () => {
  const resultEl = document.getElementById('benachrichtigung-ergebnis');
  try {
    await api('/benachrichtigung', { method: 'PUT', body: JSON.stringify(sammleBenachrichtigungsFelder()) });
    resultEl.className = 'ok';
    resultEl.textContent = t('Saved.');
    showToast(t('Notification settings saved'), 'success');
    ladeBenachrichtigung();
    markiereSettingsGespeichert();
  } catch (err) {
    resultEl.className = 'error';
    resultEl.textContent = err.message;
  }
});

document.getElementById('btn-test-benachrichtigung').addEventListener('click', async () => {
  const resultEl = document.getElementById('benachrichtigung-ergebnis');
  resultEl.className = '';
  resultEl.textContent = t('Sending test notification …');
  try {
    // Save first so that the test uses the values just entered
    await api('/benachrichtigung', { method: 'PUT', body: JSON.stringify(sammleBenachrichtigungsFelder()) });
    const r = await api('/benachrichtigung/test', { method: 'POST' });
    const teile = [];
    if (r.email) teile.push(t('E-mail') + ': ' + (r.email.ok ? t('sent') : t('failed') + ' — ' + r.email.fehler));
    if (r.webhook) teile.push('Webhook: ' + (r.webhook.ok ? t('sent') : t('failed') + ' — ' + r.webhook.fehler));
    const alleOk = Object.values(r).every((x) => x.ok);
    resultEl.className = alleOk ? 'ok' : 'error';
    resultEl.textContent = teile.join(' · ') || t('No channel enabled.');
    ladeBenachrichtigung();
    markiereSettingsGespeichert();
  } catch (err) {
    resultEl.className = 'error';
    resultEl.textContent = err.message;
  }
});

document.getElementById('marke-logo-datei').addEventListener('change', (ev) => {
  const datei = ev.target.files && ev.target.files[0];
  const erg = document.getElementById('marke-ergebnis');
  if (!datei) return;
  if (datei.size > 300 * 1024) {
    erg.className = 'error';
    erg.textContent = t('The file is {size} — please use at most about 300 KB.', { size: fmtBytes(datei.size) });
    ev.target.value = '';
    return;
  }
  const leser = new FileReader();
  leser.onload = () => {
    logoZwischenspeicher = leser.result;
    const logo = document.getElementById('marken-logo');
    logo.classList.add('hat-bild');
    logo.innerHTML = `<img src="${logoZwischenspeicher}" alt="">`;
    erg.className = '';
    erg.textContent = t('Logo loaded — not saved yet.');
  };
  leser.readAsDataURL(datei);
});

document.getElementById('btn-marke-speichern').addEventListener('click', async () => {
  const erg = document.getElementById('marke-ergebnis');
  const nutzlast = {
    anzeigeName: document.getElementById('marke-name-eingabe').value.trim(),
    akzentFarbe: document.getElementById('marke-farbe-hex').value.trim(),
  };
  if (logoZwischenspeicher !== null) nutzlast.logoDatenUrl = logoZwischenspeicher;
  try {
    const e = await api('/erscheinungsbild', { method: 'PUT', body: JSON.stringify(nutzlast) });
    erg.className = 'ok';
    erg.textContent = t('Appearance applied.');
    showToast(t('Appearance saved'), 'success');
    wendeErscheinungsbildAn(e);
    await ladeErscheinungsbild();
    markiereSettingsGespeichert();
  } catch (err) { erg.className = 'error'; erg.textContent = err.message; }
});

document.getElementById('btn-marke-zuruecksetzen').addEventListener('click', async () => {
  askConfirm(t('Logo, colour and display name will be removed. The application then appears in its default look again.'),
    t('Reset'), async () => {
      const e = await api('/erscheinungsbild', { method: 'PUT', body: JSON.stringify({ logoDatenUrl: '', akzentFarbe: '', anzeigeName: '' }) });
      wendeErscheinungsbildAn(e);
      await ladeErscheinungsbild();
      showToast(t('Reset done'), 'info');
      markiereSettingsGespeichert();
    });
});

ladeErscheinungsbild();

// ---------- Install package ----------

const updateDatei = document.getElementById('update-datei');
const btnEinspielen = document.getElementById('btn-update-einspielen');

updateDatei.addEventListener('change', () => {
  const d = updateDatei.files && updateDatei.files[0];
  const erg = document.getElementById('update-einspiel-ergebnis');
  btnEinspielen.disabled = !d;
  if (d) {
    erg.className = '';
    erg.textContent = t('Selected: {name} ({size})', { name: d.name, size: fmtBytes(d.size) });
  }
});

btnEinspielen.addEventListener('click', () => {
  const datei = updateDatei.files && updateDatei.files[0];
  if (!datei) return;

  askConfirm(
    t('“{file}” will be installed and the application restarted afterwards. Configuration, logs and users are kept. Running transfers are interrupted.', { file: datei.name }),
    t('Install'), () => {
      const fortschritt = document.getElementById('update-fortschritt');
      const balken = fortschritt.querySelector('span');
      const text = document.getElementById('update-fortschritt-text');
      const erg = document.getElementById('update-einspiel-ergebnis');
      fortschritt.classList.remove('hidden');
      btnEinspielen.disabled = true;
      erg.className = '';
      erg.textContent = '';

      const anfrage = new XMLHttpRequest();
      anfrage.open('POST', '/api/update/einspielen');
      anfrage.setRequestHeader('Content-Type', 'application/octet-stream');

      anfrage.upload.addEventListener('progress', (e) => {
        if (!e.lengthComputable) return;
        const anteil = Math.round((e.loaded / e.total) * 100);
        balken.style.width = anteil + '%';
        text.textContent = anteil < 100 ? t('{n} % uploaded', { n: anteil }) : t('installing …');
      });

      anfrage.addEventListener('load', () => {
        let antwort = {};
        try { antwort = JSON.parse(anfrage.responseText); } catch { /* ignore */ }
        if (anfrage.status !== 200) {
          fortschritt.classList.add('hidden');
          btnEinspielen.disabled = false;
          erg.className = 'error';
          erg.textContent = antwort.error || t('Installing failed.');
          return;
        }
        balken.style.width = '100%';
        text.textContent = t('Application is restarting …');
        erg.className = 'ok';
        erg.innerHTML = (antwort.neueVersion ? t('Installed — new version <strong>{v}</strong>', { v: escapeHtml(antwort.neueVersion) }) : t('Installed'))
          + ' ' + t('({n} files, backup: {backup}).', { n: antwort.ersetzteDateien, backup: escapeHtml(antwort.sicherung || '') })
          + `<br>${escapeHtml(antwort.hinweis || '')}`;
        text.textContent = antwort.neustartVerhalten === 'beenden'
          ? t('Application stopped — waiting for the restart by the task or service …')
          : t('Application is restarting …');
        // In both cases return as soon as it responds again
        warteAufNeustart(antwort.neustartVerhalten === 'beenden' ? 80 : 40);
      });

      anfrage.addEventListener('error', () => {
        fortschritt.classList.add('hidden');
        btnEinspielen.disabled = false;
        erg.className = 'error';
        erg.textContent = t('The connection was interrupted during the upload.');
      });

      anfrage.send(datei);
    }, t('Install package?'));
});

// Return automatically after the restart
function warteAufNeustart(maxVersuche = 40) {
  let versuche = 0;
  const pruefen = () => {
    versuche += 1;
    fetch('/api/oeffentlicher-status', { cache: 'no-store' })
      .then((r) => { if (r.ok) window.location.reload(); else weiter(); })
      .catch(weiter);
  };
  const weiter = () => {
    if (versuche > maxVersuche) {
      document.getElementById('update-fortschritt-text').textContent =
        t('The application does not respond — please check start.bat or the scheduled task.');
      return;
    }
    setTimeout(pruefen, 1500);
  };
  setTimeout(pruefen, 3000);
}

// ---------- Behaviour after installing ----------

async function ladeBetriebsart() {
  const hinweis = document.getElementById('betriebsart-hinweis');
  if (!hinweis) return;
  let art;
  try { art = await api('/update/betriebsart'); } catch { return; }

  document.getElementById('neustart-verhalten').value = art.eingestellt;

  const beschreibung = t({
    startbat: 'a console window (probably start.bat)',
    aufgabe: 'without a console window — probably as a scheduled task or service',
    konsole: 'a terminal',
    hintergrund: 'the background without a terminal',
  }[art.vermutung] || 'an unknown environment');

  hinweis.classList.remove('hidden');
  hinweis.classList.toggle('passt', art.passt);
  hinweis.innerHTML = art.passt
    ? t('The application runs in <strong>{env}</strong>. The selected setting matches.', { env: escapeHtml(beschreibung) })
    : t('The application runs in <strong>{env}</strong>. Recommended would be <strong>{rec}</strong> — otherwise the application might not come back up after installing.', {
      env: escapeHtml(beschreibung), rec: art.empfehlung === 'beenden' ? t('only shut down') : t('restart itself'),
    });
}

document.getElementById('btn-neustart-verhalten').addEventListener('click', async () => {
  const erg = document.getElementById('neustart-ergebnis');
  try {
    await api('/settings', {
      method: 'PUT',
      body: JSON.stringify({ neustartVerhalten: document.getElementById('neustart-verhalten').value }),
    });
    erg.className = 'ok';
    erg.textContent = t('Saved.');
    await ladeBetriebsart();
    markiereSettingsGespeichert();
  } catch (err) { erg.className = 'error'; erg.textContent = err.message; }
});

// ---------- Example names for the parts ----------

document.getElementById('btn-namen-vorschau').addEventListener('click', async () => {
  const el = document.getElementById('namen-vorschau');
  el.className = '';
  el.textContent = t('Generating …');
  try {
    const r = await api('/namen-vorschau', {
      method: 'POST',
      body: JSON.stringify({
        teilNamensmuster: document.getElementById('f-teilNamensmuster').value,
        beispielStamm: 'scan_20260901',
        beispielQr: 'ORDER-1001',
      }),
    });
    el.className = 'ok';
    el.innerHTML = r.namen.map((n, i) => `${i + 1}. <code>${escapeHtml(n)}</code>`).join(' &nbsp; ')
      + ` <span style="color:var(--text-faint)">${t('(third example without a detected QR code)')}</span>`;
  } catch (err) {
    el.className = 'error';
    el.textContent = err.message;
  }
});
