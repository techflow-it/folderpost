#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 TechFlow IT
"""
xss-scan.py — browser test: does user-controlled data ever run as HTML/JavaScript?

Starts the application in a temporary copy (the project folder stays untouched),
fills every user-controlled field (job names, categories, notes, paths, filters,
targets, log entries, change log, templates, display name) with HTML payloads,
walks through all views and checks that none of the payloads executed.

Usage (in the project folder):
    pip3 install playwright && python3 -m playwright install chromium
    python3 tools/xss-scan.py

Exit code 0 = nothing executed, 1 = a payload executed (suitable for CI).
"""
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time

from playwright.sync_api import sync_playwright

APP_DIR = os.path.abspath(os.environ.get("APP_DIR", "."))
PORT = int(os.environ.get("PORT", "3998"))
NODE = os.environ.get("NODE", "node")


def payload(tag):
    # Breaks out of text, double- and single-quoted attributes alike.
    return f"\"'><img src=x onerror=\"window.__xss.push('{tag}')\">{tag}"


def config(port, src):
    base = dict(
        notes="", archived=False, active=True, minFileAgeSec=0, maxFileSizeMB=0, pollIntervalSec=3600,
        extraTargetUrls=[], dryRun=False, dedupe=False, archiveRetentionDays=0, method="POST", headers=[],
        authType="none", authUser="", authPassword="", curlExtraArgs=[], uploadMode="binary",
        multipartField="file", onSuccess="archive", onError="archive", timeoutSec=30, scheduleEnabled=False,
        activeDays=["MO", "TU", "WE", "TH", "FR", "SA", "SU"], timeStart="00:00", timeEnd="23:59",
        zielTyp="http", zielOrdner="", ordnerUeberschreiben=False, smtpHost="", smtpPort=587, smtpSicher=True,
        smtpBenutzer="", smtpPasswort="", mailVon="", mailAn="", mailBetreff="", maxVersuche=5,
        wartezeitBasisSec=60, processor="none", stapelTeilen=False, vorspannVerwerfen=False,
        teilNamensmuster="{stem}_{no}_{qrValue}", sendeFormat="json", dateiFeldName="file1",
        metadataFeldName="metadata1", metadataVorlage="{}", qrSeite=1, qrDpi=200,
    )
    jobs = []
    for i, extra in enumerate([
        dict(zielTyp="http"),
        dict(zielTyp="ordner", zielOrdner=os.path.join(src, payload("zielOrdner"))),
        dict(zielTyp="email", mailAn=payload("mailAn") + "@example.org", smtpHost="smtp.example.org"),
        dict(archived=True, archivedAt="2026-01-01T00:00:00.000Z"),
        dict(dryRun=True, processor="pdf-qr-json", stapelTeilen=True, active=False),
    ]):
        jobs.append(dict(
            base, id=f"j_{i}", sortOrder=i, name=payload(f"name{i}"), category=payload(f"category{i}"),
            notes=payload(f"notes{i}"), sourcePath=src, filePattern=payload(f"filter{i}") + "*",
            targetUrl="http://localhost:9/" + payload(f"url{i}"), extraTargetUrls=["http://localhost:9/" + payload(f"extra{i}")],
            archiveSubfolder=payload(f"archive{i}"), errorSubfolder=payload(f"error{i}"),
            quarantaeneSubfolder=payload(f"quarantine{i}"), headers=["X-Test: " + payload(f"header{i}")],
            curlExtraArgs=[payload(f"curl{i}")], **extra,
        ))
    return {
        "port": port, "globalPollIntervalSec": 600, "jobs": jobs,
        "templates": [{"id": "t_1", "name": payload("template"), "werte": {"filePattern": payload("tplfilter")}}],
        "settings": {"logRetentionDays": 90, "jobUebersichtImLogin": True, "updatePruefUrl": "",
                     "letzteUpdatePruefung": None, "neustartVerhalten": "selbst", "logoDatenUrl": "",
                     "akzentFarbe": "", "anzeigeName": payload("anzeigeName"), "benutzer": [], "language": "en"},
    }


def logs():
    now = time.time()
    rows = []
    for i in range(12):
        ok = bool(i % 3)
        rows.append(json.dumps({
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(now - i * 3600)),
            "jobId": f"j_{i % 3}", "jobName": payload(f"logjob{i}"), "targetUrl": "http://localhost:9/" + payload(f"logurl{i}"),
            "file": payload(f"file{i}") + ".xml", "fileSize": 900, "status": "success" if ok else "error",
            "httpStatus": 200 if ok else 502, "message": payload(f"message{i}"), "bodySnippet": payload(f"body{i}"),
            "qrWert": payload(f"qr{i}"), "category": payload(f"logcat{i}"),
        }))
    return "\n".join(rows) + "\n"


def audit():
    return "\n".join(json.dumps({
        "ts": "2026-01-01T00:00:00.000Z", "aktion": a, "benutzer": payload(f"auditUser{n}"),
        "jobId": "j_0", "jobName": payload(f"auditJob{n}"), "felder": [payload(f"auditField{n}")],
    }) for n, a in enumerate(["job.create", "job.update", "job.delete"])) + "\n"


def main():
    work = tempfile.mkdtemp(prefix="xss-scan-")
    app = os.path.join(work, "app")
    src = os.path.join(work, "src")
    os.makedirs(src)
    open(os.path.join(src, payload("srcfile") + ".xml"), "w").write("<x/>")
    shutil.copytree(APP_DIR, app, ignore=shutil.ignore_patterns(".git", "node_modules", "data", "config.json", "tests", "docs"))
    os.makedirs(os.path.join(app, "data"), exist_ok=True)
    json.dump(config(PORT, src), open(os.path.join(app, "config.json"), "w"), indent=2)
    open(os.path.join(app, "data", "logs.jsonl"), "w").write(logs())
    open(os.path.join(app, "data", "aenderungen.jsonl"), "w").write(audit())

    srv = subprocess.Popen([NODE, "server.js"], cwd=app, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                           env={**os.environ, "PORT": str(PORT), "HOST": "127.0.0.1"})
    time.sleep(3)
    fired = {}
    errors = []

    def check(pg, where):
        for tag in pg.evaluate("() => window.__xss || []"):
            fired.setdefault(tag, where)

    def safe(fn, label="step"):
        try:
            fn()
        except Exception as e:  # a missing element must not hide the other views
            errors.append(f"{label}: {str(e).splitlines()[0]}")

    try:
        with sync_playwright() as p:
            b = p.chromium.launch()
            c = b.new_context(viewport={"width": 1600, "height": 1000})
            c.add_init_script("window.__xss = []; localStorage.setItem('language','en');")
            pg = c.new_page()
            pg.on("dialog", lambda d: (fired.setdefault("dialog:" + d.message, "dialog"), d.dismiss()))
            pg.goto(f"http://127.0.0.1:{PORT}", wait_until="networkidle")
            pg.wait_for_timeout(2500)
            check(pg, "Overview")
            for label, action in [
                ("Grouped view", lambda: pg.evaluate("() => document.getElementById('btn-toggle-grouping').click()")),
                ("Statistics", lambda: (pg.click('.tab[data-tab="statistik"]'), pg.wait_for_timeout(1200))),
                ("Overview again", lambda: (pg.click('.tab[data-tab="uebersicht"]'), pg.wait_for_timeout(500))),
                ("Job detail", lambda: (pg.click(".job-card >> nth=0"), pg.wait_for_timeout(1200))),
                ("Job detail close", lambda: pg.evaluate("() => document.getElementById('drawer-close').click()")),
                ("Job menu", lambda: (pg.evaluate("() => document.querySelector('.job-card [data-action=\"menu\"]')?.click()"), pg.wait_for_timeout(300))),
                ("Edit job", lambda: (pg.evaluate("() => document.querySelector('.job-card [data-action=\"edit\"]')?.click()"), pg.wait_for_timeout(800))),
                ("Close form", lambda: pg.evaluate("() => document.querySelectorAll('.modal-backdrop.open').forEach(m => m.classList.remove('open'))")),
                ("Log entries expanded", lambda: pg.evaluate("() => document.querySelectorAll('.log-entry, .log-msg').forEach(e => e.click())")),
                ("Log search", lambda: (pg.fill("#log-search, input[type=search]", "file"), pg.wait_for_timeout(1500))),
                ("Archive", lambda: (pg.evaluate("() => document.getElementById('btn-toggle-archive').click()"), pg.wait_for_timeout(800))),
                ("Settings", lambda: (pg.click("#btn-open-settings"), pg.wait_for_timeout(1200))),
                ("Settings tabs", lambda: [pg.evaluate(f"() => document.querySelector('.settings-tab[data-spanel=\"{t}\"]').click()") for t in ["allg", "zugriff", "benachr", "system"]]),
                ("Close settings", lambda: pg.evaluate("() => document.querySelectorAll('.modal-backdrop.open').forEach(m => m.classList.remove('open'))")),
                ("Command palette", lambda: (pg.keyboard.press("Control+k"), pg.keyboard.type("x"), pg.wait_for_timeout(400), pg.keyboard.press("Escape"))),
                ("Categories", lambda: (pg.evaluate("() => document.getElementById('btn-manage-categories').click()"), pg.wait_for_timeout(600))),
                ("Change log", lambda: (pg.evaluate("() => document.getElementById('btn-show-audit').click()"), pg.wait_for_timeout(600))),
                ("New job with template", lambda: (pg.evaluate("() => document.querySelectorAll('.modal-backdrop.open').forEach(m => m.classList.remove('open'))"),
                                                   pg.click("#btn-new-job"), pg.wait_for_timeout(500))),
            ]:
                safe(action, label)
                pg.wait_for_timeout(300)
                check(pg, label)
            # Sanity check: the payloads are really on the page as text, and the
            # detection works (a payload inserted on purpose must fire).
            visible = pg.evaluate("() => document.body.innerText.includes('name0')")
            pg.evaluate("""() => { const d = document.createElement('div'); document.body.appendChild(d);
                d.innerHTML = '<img src=x onerror="window.__xss.push(&quot;selftest&quot;)">'; }""")
            pg.wait_for_timeout(500)
            selftest = "selftest" in pg.evaluate("() => window.__xss")
            pg.evaluate("() => { window.__xss = window.__xss.filter(t => t !== 'selftest'); }")
            if not (visible and selftest):
                print(f"Self-test failed (payload text visible: {visible}, detection works: {selftest})")
                sys.exit(2)
            # Sign-in page with public job overview
            safe(lambda: (pg.goto(f"http://127.0.0.1:{PORT}/anmelden.html", wait_until="networkidle"), pg.wait_for_timeout(1000)))
            check(pg, "Sign-in page")
            b.close()
    finally:
        srv.send_signal(signal.SIGTERM)
        try:
            srv.wait(timeout=5)
        except Exception:
            srv.kill()
        shutil.rmtree(work, ignore_errors=True)

    print(f"Executed payloads: {len(fired)}")
    for tag, where in sorted(fired.items(), key=lambda x: x[1]):
        print(f"  [{where}] {tag}")
    for e in errors:
        print(f"  skipped step: {e}")
    sys.exit(1 if fired else 0)


if __name__ == "__main__":
    main()
