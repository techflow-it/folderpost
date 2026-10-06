#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 TechFlow IT
"""
demo-data.py — creates a neutral demo setup: config.json, a transfer log over the
last 28 days and the (empty) source folders of the demo jobs.

All names, paths and hosts are made up (example.org, \\\\fileserver\\share, /srv/…).
Used for the screenshots (tools/screenshots.py) and handy for trying out the interface.

    python3 tools/demo-data.py --out /tmp/folderpost-demo            # English demo
    python3 tools/demo-data.py --out /tmp/folderpost-demo --lang de  # German demo
    cd /tmp/folderpost-demo && cp -R /path/to/folderpost/* . && node server.js

Options:
    --out DIR     folder that receives config.json and data/ (default: current folder)
    --root DIR    folder for the job source folders (default: <out>/srv)
    --lang en|de  language of job names, log entries and settings (default: en)
    --port N      port written to config.json (default: 3000)
"""
import argparse
import json
import os
import random
import time

TEXT = {
    "en": {
        "jobs": [
            ("Orders → Partner API", "Sales"),
            ("Scans → Document system", "Back office"),
            ("Invoices → Folder", "Accounting"),
            ("Daily report → Mail", "Reporting"),
            ("Delivery notes → ERP", "Logistics"),
            ("Price lists → Web shop", "Sales"),
        ],
        "notes": "Partner contact: integration team, ticket INT-204. Switch to API v2 planned for Q1.",
        "mail_subject": "New file: {filename}",
        "folder": ["orders", "scans", "invoices", "reports", "delivery-notes", "price-lists"],
        "quarantine": "Moved to quarantine: 5 attempts failed. Folder \"_quarantine\". Copy the file back from there once the cause has been fixed.",
        "timeout": "Connection timed out after 30 s",
        "mail_to": "E-mail to reports@example.org",
    },
    "de": {
        "jobs": [
            ("Bestellungen → Partner-API", "Vertrieb"),
            ("Scans → Dokumentensystem", "Innendienst"),
            ("Rechnungen → Ordner", "Buchhaltung"),
            ("Tagesbericht → Mail", "Berichte"),
            ("Lieferscheine → ERP", "Logistik"),
            ("Preislisten → Webshop", "Vertrieb"),
        ],
        "notes": "Ansprechpartner: Integrationsteam, Ticket INT-204. Umstellung auf API v2 für Q1 geplant.",
        "mail_subject": "Neue Datei: {filename}",
        "folder": ["bestellungen", "scans", "rechnungen", "berichte", "lieferscheine", "preislisten"],
        "quarantine": "In Quarantäne verschoben: 5 Versuche fehlgeschlagen. Ordner \"_quarantine\". Nach Behebung der Ursache die Datei von dort zurückkopieren.",
        "timeout": "Zeitüberschreitung der Verbindung nach 30 s",
        "mail_to": "E-Mail an reports@example.org",
    },
}

BASE_JOB = dict(
    notes="", archived=False, archivedAt=None, active=True, minFileAgeSec=5, maxFileSizeMB=0, pollIntervalSec=60,
    extraTargetUrls=[], dryRun=False, dedupe=False, archiveRetentionDays=30, method="POST", headers=[],
    authType="none", authUser="", authPassword="", curlExtraArgs=[], uploadMode="binary", multipartField="file",
    onSuccess="archive", archiveSubfolder="_sent", onError="keep", errorSubfolder="_error", timeoutSec=30,
    scheduleEnabled=False, activeDays=["MO", "TU", "WE", "TH", "FR", "SA", "SU"], timeStart="00:00", timeEnd="23:59",
    zielTyp="http", zielOrdner="", ordnerUeberschreiben=False, smtpHost="", smtpPort=587, smtpSicher=True,
    smtpBenutzer="", smtpPasswort="", mailVon="", mailAn="", mailBetreff="", maxVersuche=5, wartezeitBasisSec=60,
    quarantaeneSubfolder="_quarantine", processor="none", stapelTeilen=False, vorspannVerwerfen=False,
    teilNamensmuster="{stem}_{no}_{qrValue}", sendeFormat="json", dateiFeldName="file1", metadataFeldName="metadata1",
    metadataVorlage='{\n  "document_id": "{qrValue}",\n  "file_name": "{filename}",\n  "received": {unixtime}\n}',
    qrSeite=1, qrDpi=200, dateinameRegex="", auftragsnummer="", targetUrl="",
)


def jobs(lang, root):
    t = TEXT[lang]
    names, folders = t["jobs"], t["folder"]
    src = [os.path.join(root, f) for f in folders]
    specs = [
        dict(filePattern="*.xml", targetUrl="https://partner-api.example.org/v1/orders",
             headers=["Content-Type: application/xml", "Authorization: Bearer ••••••"], notes=t["notes"]),
        dict(filePattern="*.pdf", targetUrl="https://dms.example.org/api/documents", processor="pdf-qr-json",
             stapelTeilen=True, sendeFormat="multipart-metadata", pollIntervalSec=30, minFileAgeSec=10),
        dict(filePattern="invoice_*.pdf" if lang == "en" else "rechnung_*.pdf", zielTyp="ordner",
             zielOrdner="\\\\fileserver\\share\\accounting\\inbox", pollIntervalSec=300),
        dict(filePattern="report_*.csv", zielTyp="email", smtpHost="smtp.example.org", mailVon="folderpost@example.org",
             mailAn="reports@example.org", mailBetreff=t["mail_subject"], pollIntervalSec=900,
             scheduleEnabled=True, activeDays=["MO", "TU", "WE", "TH", "FR"], timeStart="06:00", timeEnd="20:00"),
        dict(filePattern="*.json", targetUrl="https://erp.example.org/api/delivery-notes", active=False),
        dict(filePattern="*.csv", targetUrl="https://shop.example.org/import/prices", dryRun=True, pollIntervalSec=600),
    ]
    out = []
    for i, ((name, cat), path, spec) in enumerate(zip(names, src, specs)):
        out.append(dict(BASE_JOB, id=f"j_demo{i + 1}", sortOrder=i, name=name, category=cat, sourcePath=path, **spec))
    return out


def logs(lang, job_list, days=28, seed=7):
    rnd = random.Random(seed)
    t = TEXT[lang]
    now = time.time()
    rows = []
    # (job index, transfers per working day, error rate)
    profile = [(0, (14, 26), 0.06), (1, (6, 14), 0.08), (2, (3, 8), 0.0), (3, (1, 1), 0.0), (5, (1, 2), 0.0)]
    counter = {"order": 10400, "scan": 800, "inv": 9100}
    for day in range(days, -1, -1):
        day_start = now - day * 86400
        weekend = time.localtime(day_start).tm_wday >= 5
        for idx, (lo, hi), err in profile:
            job = job_list[idx]
            n = rnd.randint(lo, hi) if not weekend else rnd.randint(0, lo // 4)
            for _ in range(n):
                ts = day_start - rnd.randint(0, 9 * 3600) if day else now - rnd.randint(60, 6 * 3600)
                ok = rnd.random() >= err
                entry = {"ts": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(ts)), "jobId": job["id"],
                         "jobName": job["name"], "status": "success" if ok else "error"}
                if idx == 0:
                    counter["order"] += 1
                    entry.update(file=f"order_{counter['order']}.xml", fileSize=rnd.randint(2200, 9800),
                                 targetUrl=job["targetUrl"], httpStatus="201" if ok else "503",
                                 message='{"status":"accepted"}' if ok else "HTTP 503 Service Unavailable")
                elif idx == 1:
                    counter["scan"] += 1
                    qr = f"DOC-2026-{counter['scan']:04d}"
                    entry.update(file=f"scan_{counter['scan']:04d}_01_{qr}.pdf", fileSize=rnd.randint(90000, 420000),
                                 targetUrl=job["targetUrl"], httpStatus="200" if ok else None, qrWert=qr, qrGefunden=True,
                                 message=f"QR: {qr} · " + ('{"id":' + str(rnd.randint(5000, 9999)) + "}" if ok else t["timeout"]))
                elif idx == 2:
                    counter["inv"] += 1
                    prefix = "invoice" if lang == "en" else "rechnung"
                    entry.update(file=f"{prefix}_2026-{counter['inv']}.pdf", fileSize=rnd.randint(40000, 160000),
                                 targetUrl=job["zielOrdner"], httpStatus="ORDNER", message="")
                elif idx == 3:
                    stamp = time.strftime("%Y-%m-%d", time.localtime(ts))
                    entry.update(file=f"report_{stamp}.csv", fileSize=rnd.randint(12000, 30000),
                                 targetUrl=t["mail_to"], httpStatus="MAIL", message="250 OK")
                else:
                    entry.update(file=f"prices_{rnd.randint(1, 9)}.csv", fileSize=rnd.randint(50000, 90000),
                                 targetUrl=job["targetUrl"], httpStatus=None, dryRun=True, message="")
                if not ok:
                    entry["exitCode"] = 0 if entry.get("httpStatus") else 28
                rows.append(entry)
    # one quarantined file a few days ago
    rows.append({"ts": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(now - 3 * 86400 + 4000)),
                 "jobId": job_list[0]["id"], "jobName": job_list[0]["name"], "targetUrl": job_list[0]["targetUrl"],
                 "file": "order_10377.xml", "fileSize": 4410, "status": "error", "httpStatus": None,
                 "message": t["quarantine"]})
    rows.sort(key=lambda r: r["ts"])
    return "\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n"


def config(lang, root, port):
    return {
        "port": port, "globalPollIntervalSec": 5, "jobs": jobs(lang, root), "templates": [],
        "settings": {
            "logRetentionDays": 90, "jobUebersichtImLogin": False, "updatePruefUrl": "", "letzteUpdatePruefung": None,
            "neustartVerhalten": "beenden", "logoDatenUrl": "", "akzentFarbe": "", "anzeigeName": "", "benutzer": [],
            "language": lang,
            "dashboardAuth": {"enabled": False, "username": "", "salt": "", "hash": ""},
            "benachrichtigung": {
                "emailAktiv": True, "smtpHost": "smtp.example.org", "smtpPort": 587, "smtpSicher": True,
                "smtpBenutzer": "folderpost@example.org", "smtpPasswort": "", "von": "folderpost@example.org",
                "an": "ops@example.org", "webhookAktiv": True, "webhookUrl": "https://hooks.example.org/folderpost",
            },
        },
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default=".")
    ap.add_argument("--root")
    ap.add_argument("--lang", choices=["en", "de"], default="en")
    ap.add_argument("--port", type=int, default=3000)
    a = ap.parse_args()
    out = os.path.abspath(a.out)
    root = os.path.abspath(a.root or os.path.join(out, "srv"))
    os.makedirs(os.path.join(out, "data"), exist_ok=True)
    cfg = config(a.lang, root, a.port)
    for job in cfg["jobs"]:
        os.makedirs(job["sourcePath"], exist_ok=True)
    with open(os.path.join(out, "config.json"), "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
    with open(os.path.join(out, "data", "logs.jsonl"), "w", encoding="utf-8") as f:
        f.write(logs(a.lang, cfg["jobs"]))
    print(f"Demo data ({a.lang}) written to {out}")


if __name__ == "__main__":
    main()
