#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 TechFlow IT
"""
i18n-scan.py — acceptance test: is the user interface completely in one language?

Starts the application in a temporary copy (the project folder stays untouched),
creates demo data, switches the interface to the chosen language and walks through
all views. Every visible text, placeholder, tooltip and aria-label is checked for
words of the other language.

Usage (in the project folder):
    pip3 install playwright && python3 -m playwright install chromium
    python3 tools/i18n-scan.py              # English interface: no German allowed
    python3 tools/i18n-scan.py --lang de    # German interface: no English allowed
    APP_DIR=/path/to/project python3 tools/i18n-scan.py

Exit code 0 = no findings, 1 = findings (suitable for CI).

Note: the test reads the whole DOM, including dialogs that are currently hidden.
The views are clicked through anyway, because many texts are only created when
they are opened (statistics, job details, menus, messages).
"""
import os, re, shutil, subprocess, sys, tempfile, time, json, signal
from playwright.sync_api import sync_playwright

APP_DIR = os.path.abspath(os.environ.get("APP_DIR", "."))
PORT = int(os.environ.get("PORT", "3999"))
NODE = os.environ.get("NODE", "node")
START = os.environ.get("START_FILE", "server.js")

LANG = "de" if "--lang" in sys.argv and sys.argv[sys.argv.index("--lang") + 1:][:1] == ["de"] else "en"

# German signal words and umlauts. "Scan", "Status", "Job" etc. are deliberately NOT included.
DE = re.compile(
    r"[äöüÄÖÜß]|\b(der|die|das|und|nicht|wird|werden|für|mit|bei|eine|einen|oder|dass|noch|keine|kein|"
    r"Datei|Dateien|Ordner|Einstellungen|Fehler|Übertragung|Übertragungen|Schnittstelle|Zeitraum|"
    r"gespeichert|Speichern|Abbrechen|Schließen|Neuer|Öffnen|Hinweis|Wartung|Aktualisierung|"
    r"Benutzer|Passwort|Anmeldung|erfolgreich|fehlgeschlagen|bitte|zuletzt|gerade|Minuten|Stunden|"
    r"Tage|Alle|Nur|Jetzt|nächster|Quelle|Quell|Ziel|ausgewählt|Wiederholung|Quarantäne)\b",
    re.I,
)
# English signal words for the German interface. Words that are also common in German
# technical language (Job, Status, Export, Import, Test, Name, Details, Webhook …) are left out.
EN = re.compile(
    r"\b(the|and|with|for|not|is|are|be|will|this|that|from|only|please|ago|selected|"
    r"file|files|folder|folders|settings|save|cancel|close|delete|error|errors|transfer|transfers|"
    r"password|user|users|sign|days|hours|minutes|never|none|show|hide|new|open|when|after|before|"
    r"until|of|on|at|by|yes|no|running|paused|success|failed|period|attempts|subfolder)\b",
    re.I,
)
FOREIGN = EN if LANG == "de" else DE
TECHNISCH = re.compile(r"[A-Za-z0-9_.{}<>/:\\-]+")  # ignore plain identifiers and paths


def demo_config(port):
    base = dict(
        category="", notes="", archived=False, active=True, filePattern="*", minFileAgeSec=0,
        maxFileSizeMB=0, pollIntervalSec=600, targetUrl="http://localhost:9/x", extraTargetUrls=[],
        dryRun=False, dedupe=False, archiveRetentionDays=0, method="POST", headers=[], authType="none",
        authUser="", authPassword="", curlExtraArgs=[], uploadMode="binary", multipartField="file",
        onSuccess="archive", archiveSubfolder="_sent", onError="keep", errorSubfolder="_error",
        timeoutSec=30, scheduleEnabled=False, activeDays=["MO", "TU", "WE", "TH", "FR", "SA", "SU"],
        timeStart="00:00", timeEnd="23:59", zielTyp="http", zielOrdner="", ordnerUeberschreiben=False,
        smtpHost="", smtpPort=587, smtpSicher=True, smtpBenutzer="", smtpPasswort="", mailVon="",
        mailAn="", mailBetreff="", maxVersuche=5, wartezeitBasisSec=60, quarantaeneSubfolder="_quarantine",
        processor="none", stapelTeilen=False, vorspannVerwerfen=False,
        teilNamensmuster="{stamm}_{nr}_{qrWert}", sendeFormat="json", dateiFeldName="file1",
        metadataFeldName="metadata1", metadataVorlage="{}", qrSeite=1, qrDpi=200,
    )
    spec = [
        dict(name="Orders", category="Sales", sourcePath="/nonexistent/a", filePattern="*.xml"),
        dict(name="Scans", category="Lab", sourcePath="/nonexistent/b", processor="pdf-qr-json",
             stapelTeilen=True, sendeFormat="multipart-metadata"),
        dict(name="Nightly", category="Lab", sourcePath="/nonexistent/c", active=False),
        dict(name="Mailer", sourcePath="/nonexistent/d", zielTyp="email", mailAn="a@example.org", smtpHost="smtp.example.org"),
        dict(name="Dry", sourcePath="/nonexistent/e", dryRun=True),
    ]
    jobs = [dict(base, id=f"j_{i}", sortOrder=i, **s) for i, s in enumerate(spec)]
    return {
        "port": port, "globalPollIntervalSec": 600, "jobs": jobs, "templates": [],
        "settings": {"logRetentionDays": 90, "jobUebersichtImLogin": True, "updatePruefUrl": "",
                     "letzteUpdatePruefung": None, "neustartVerhalten": "selbst", "logoDatenUrl": "",
                     "akzentFarbe": "", "anzeigeName": "", "benutzer": [], "language": LANG},
    }


def demo_logs():
    now = int(time.time() * 1000)
    rows = []
    for i in range(12):
        ok = bool(i % 4)
        rows.append(json.dumps({
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime((now - i * 3600000) / 1000)),
            "jobId": "j_0", "jobName": "Orders", "targetUrl": "http://example.org", "file": f"a{i}.xml",
            "fileSize": 900, "status": "success" if ok else "error", "httpStatus": 200 if ok else 502,
            "message": "ok" if ok else "Bad Gateway"}))
    return "\n".join(rows) + "\n"


def main():
    work = tempfile.mkdtemp(prefix="i18n-scan-")
    app = os.path.join(work, "app")
    shutil.copytree(APP_DIR, app, ignore=shutil.ignore_patterns(".git", "node_modules", "data", "config.json"))
    os.makedirs(os.path.join(app, "data"), exist_ok=True)
    json.dump(demo_config(PORT), open(os.path.join(app, "config.json"), "w"), indent=2)
    open(os.path.join(app, "data", "logs.jsonl"), "w").write(demo_logs())

    srv = subprocess.Popen([NODE, START], cwd=app, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(3)
    fund = {}

    def sammle(pg, ort):
        texte = pg.evaluate("""() => {
          const out = [];
          const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n;
          while ((n = w.nextNode())) {
            const t = n.nodeValue.replace(/\\s+/g, ' ').trim(); if (!t) continue;
            const el = n.parentElement; if (!el || ['SCRIPT','STYLE'].includes(el.tagName)) continue;
            if (el.closest('[data-keine-uebersetzung],[data-no-translate]')) continue;
            out.push(t);
          }
          document.querySelectorAll('[placeholder],[title],[aria-label]').forEach(e => {
            ['placeholder','title','aria-label'].forEach(a => { const v = e.getAttribute(a); if (v && v.trim()) out.push('@' + a + ': ' + v.trim()); });
          });
          document.querySelectorAll('option').forEach(o => out.push('option: ' + o.textContent.trim()));
          return [...new Set(out)];
        }""")
        for t in texte:
            value = t.split(": ", 1)[1] if t.startswith(("@", "option: ")) else t
            if FOREIGN.search(t) and not TECHNISCH.fullmatch(value):
                fund.setdefault(t, ort)

    def sicher(fn):
        try: fn()
        except Exception: pass

    try:
        with sync_playwright() as p:
            b = p.chromium.launch()
            c = b.new_context(viewport={"width": 1400, "height": 1000}, locale="de-DE" if LANG == "de" else "en-US")
            c.add_init_script(f"localStorage.setItem('sprache','{LANG}'); localStorage.setItem('language','{LANG}');")
            pg = c.new_page()
            pg.goto(f"http://localhost:{PORT}", wait_until="networkidle"); pg.wait_for_timeout(3000)
            sammle(pg, "Overview")
            sicher(lambda: (pg.click('.tab[data-tab="statistik"]'), pg.wait_for_timeout(1200), sammle(pg, "Statistics"),
                            pg.click('.tab[data-tab="uebersicht"]'), pg.wait_for_timeout(400)))
            sicher(lambda: (pg.click(".job-card >> nth=0"), pg.wait_for_timeout(1000), sammle(pg, "Job detail"),
                            pg.click("#drawer-close"), pg.wait_for_timeout(300)))
            def formular():
                pg.click("#btn-new-job"); pg.wait_for_timeout(500)
                pg.evaluate("() => document.querySelectorAll('#job-form details').forEach(d => d.open = true)")
                for sel, val in [("#f-processor", "pdf-qr-json"), ("#f-zielTyp", "email")]:
                    sicher(lambda: (pg.select_option(sel, val), pg.wait_for_timeout(200)))
                sammle(pg, "Job form")
                pg.evaluate("() => document.getElementById('modal-backdrop').classList.remove('open')")
            sicher(formular)
            def einstellungen():
                pg.click("#btn-open-settings"); pg.wait_for_timeout(1200)
                for t in ["allg", "zugriff", "benachr", "system"]:
                    pg.evaluate(f"() => document.querySelector('.settings-tab[data-spanel=\"{t}\"]').click()")
                    pg.wait_for_timeout(300)
                    if pg.evaluate("() => document.getElementById('confirm-backdrop').classList.contains('open')"):
                        sammle(pg, "Unsaved-changes dialog"); pg.evaluate("() => document.getElementById('confirm-ok').click()")
                    pg.evaluate("() => ['benachr-email-aktiv','benachr-webhook-aktiv'].forEach(i => { const e = document.getElementById(i); if (e && !e.checked) e.click(); })")
                    sammle(pg, f"Settings/{t}")
                pg.evaluate("() => document.querySelectorAll('.modal-backdrop.open').forEach(m => m.classList.remove('open'))")
            sicher(einstellungen)
            sicher(lambda: (pg.keyboard.press("Control+k"), pg.wait_for_timeout(300), sammle(pg, "Command palette"), pg.keyboard.press("Escape")))
            sicher(lambda: (pg.evaluate("() => { const m = document.querySelector('.job-card [data-action=\"menu\"]'); if (m) m.click(); }"),
                            pg.wait_for_timeout(300), sammle(pg, "Job menu")))
            # Sign-in page (only shown when users exist — checked here as a static page)
            sicher(lambda: (pg.goto(f"http://localhost:{PORT}/anmelden.html", wait_until="networkidle"), pg.wait_for_timeout(800), sammle(pg, "Sign-in page")))
            b.close()
    finally:
        srv.send_signal(signal.SIGTERM)
        try: srv.wait(timeout=5)
        except Exception: srv.kill()
        shutil.rmtree(work, ignore_errors=True)

    if LANG == "de":
        print(f"English texts in the German interface: {len(fund)}")
    else:
        print(f"German texts in the English interface: {len(fund)}")
    for t, ort in sorted(fund.items(), key=lambda x: (x[1], x[0])):
        print(f"  [{ort}] {t[:120]}")
    sys.exit(1 if fund else 0)


if __name__ == "__main__":
    main()
