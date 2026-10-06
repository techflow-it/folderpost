#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 TechFlow IT
"""
screenshots.py — creates the screenshots in docs/img/ from the running application
with neutral demo data (tools/demo-data.py), in English and German, dark and light.

The application runs in a temporary copy; the project folder is only written to
docs/img/. The demo source folders live in a temporary directory; in the API
responses shown in the browser that prefix is replaced by /srv/folderpost, so the
images only show neutral paths.

    pip3 install playwright && python3 -m playwright install chromium
    python3 tools/screenshots.py
"""
import base64
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import urllib.request

from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
APP_DIR = os.path.abspath(os.path.join(HERE, ".."))
OUT = os.path.join(APP_DIR, "docs", "img")
NODE = os.environ.get("NODE", "node")
PORT = int(os.environ.get("PORT", "3997"))
SHOWN_ROOT = "/srv/folderpost"
DESKTOP = {"width": 1400, "height": 900}
MOBILE = {"width": 390, "height": 844}


def api(method, path, body=None):
    req = urllib.request.Request(f"http://127.0.0.1:{PORT}{path}", method=method,
                                 data=None if body is None else json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read() or b"null")


def start(lang, work):
    app = os.path.join(work, "app")
    shutil.copytree(APP_DIR, app, ignore=shutil.ignore_patterns(".git", "node_modules", "data", "config.json", "tests", "docs"))
    root = os.path.join(work, "srv")
    subprocess.run([sys.executable, os.path.join(HERE, "demo-data.py"), "--out", app, "--root", root,
                    "--lang", lang, "--port", str(PORT)], check=True)
    srv = subprocess.Popen([NODE, "server.js"], cwd=app, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                           env={**os.environ, "PORT": str(PORT), "HOST": "127.0.0.1"})
    for _ in range(50):
        try:
            api("GET", "/api/info")
            break
        except Exception:
            time.sleep(0.2)
    # Run every active job once so that "last run" is filled (the folders are empty, nothing is sent).
    for job in api("GET", "/api/jobs"):
        if job.get("active"):
            api("POST", f"/api/jobs/{job['id']}/run-now")
    time.sleep(1.5)
    return srv, root


def neutral(route, root):
    response = route.fetch()
    body = response.text()
    body = body.replace(json.dumps(root)[1:-1], SHOWN_ROOT).replace(root, SHOWN_ROOT)
    route.fulfill(response=response, body=body)


def shoot(browser, lang, theme, root):
    def context(viewport):
        c = browser.new_context(viewport=viewport, device_scale_factor=2, locale="de-DE" if lang == "de" else "en-GB",
                                timezone_id="Europe/Berlin", color_scheme=theme)
        c.add_init_script(f"localStorage.setItem('language','{lang}'); localStorage.setItem('theme','{theme}');")
        c.route("**/api/**", lambda route: neutral(route, root))
        return c

    def save(pg, name):
        path = os.path.join(OUT, f"{lang}-{theme}-{name}.png")
        pg.screenshot(path=path)
        print("  " + os.path.relpath(path, APP_DIR))

    def close_all(pg):
        pg.evaluate("() => document.querySelectorAll('.modal-backdrop.open').forEach(m => m.classList.remove('open'))")
        pg.keyboard.press("Escape")
        pg.wait_for_timeout(300)

    c = context(DESKTOP)
    pg = c.new_page()
    pg.goto(f"http://127.0.0.1:{PORT}/", wait_until="networkidle")
    pg.wait_for_timeout(2500)
    pg.mouse.move(5, 890)
    save(pg, "overview")

    pg.click('.job-card[data-id="j_demo1"]')
    pg.wait_for_timeout(1500)
    pg.mouse.move(5, 890)
    save(pg, "job-detail")
    pg.evaluate("() => document.getElementById('drawer-close').click()")
    pg.wait_for_timeout(500)

    pg.evaluate("() => document.querySelector('.job-card[data-id=\"j_demo2\"] [data-action=\"edit\"]').click()")
    pg.wait_for_timeout(900)
    pg.evaluate("""() => {
      document.querySelectorAll('#job-form details').forEach((d, i) => { d.open = i < 2; });
      const body = document.querySelector('#modal-backdrop .modal-body') || document.querySelector('#modal-backdrop .modal');
      const proc = document.getElementById('f-processor');
      if (proc) proc.scrollIntoView({ block: 'start' });
    }""")
    pg.wait_for_timeout(500)
    save(pg, "job-form")
    close_all(pg)

    pg.click('.tab[data-tab="statistik"]')
    pg.wait_for_timeout(2000)
    pg.mouse.move(5, 890)
    save(pg, "statistics")
    pg.click('.tab[data-tab="uebersicht"]')
    pg.wait_for_timeout(600)

    pg.click("#btn-open-settings")
    pg.wait_for_timeout(1200)
    pg.evaluate("() => document.querySelector('.settings-tab[data-spanel=\"benachr\"]').click()")
    pg.wait_for_timeout(800)
    save(pg, "settings-notifications")
    close_all(pg)

    pg.keyboard.press("Control+k")
    pg.wait_for_timeout(300)
    pg.keyboard.type("sc")
    pg.wait_for_timeout(500)
    save(pg, "command-palette")
    c.close()

    m = context(MOBILE)
    pg = m.new_page()
    pg.goto(f"http://127.0.0.1:{PORT}/", wait_until="networkidle")
    pg.wait_for_timeout(2500)
    save(pg, "mobile")
    m.close()


def social_preview(browser):
    shot = os.path.join(OUT, "en-dark-overview.png")
    data = base64.b64encode(open(shot, "rb").read()).decode()
    html = f"""<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      body {{ margin:0; width:1280px; height:640px; overflow:hidden; background:#1c1b1a; color:#f1ece6;
             font-family: -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif; }}
      .text {{ position:absolute; left:72px; top:150px; width:470px; }}
      h1 {{ font-size:76px; margin:0 0 22px; letter-spacing:-2px; }}
      h1 span {{ color:#d0764c; }}
      p {{ font-size:28px; line-height:1.35; margin:0 0 30px; color:#cfc7bd; }}
      .tags {{ font-size:19px; color:#9c948a; }}
      .shot {{ position:absolute; left:590px; top:70px; width:820px; border-radius:14px;
               box-shadow:0 30px 80px rgba(0,0,0,.55); border:1px solid #3a3734; }}
    </style></head><body>
      <div class="text"><h1>Folder<span>post</span></h1>
      <p>Folder → API file transfer with QR-based document splitting</p>
      <div class="tags">Self-hosted · Node.js · no dependencies · GPL-3.0</div></div>
      <img class="shot" src="data:image/png;base64,{data}">
    </body></html>"""
    c = browser.new_context(viewport={"width": 1280, "height": 640}, device_scale_factor=1)
    pg = c.new_page()
    pg.set_content(html)
    pg.wait_for_timeout(500)
    path = os.path.join(OUT, "social-preview.png")
    pg.screenshot(path=path)
    print("  " + os.path.relpath(path, APP_DIR))
    c.close()


def main():
    os.makedirs(OUT, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for lang in ["en", "de"]:
            work = tempfile.mkdtemp(prefix=f"folderpost-shots-{lang}-")
            srv, root = start(lang, work)
            try:
                for theme in ["dark", "light"]:
                    shoot(browser, lang, theme, root)
            finally:
                srv.send_signal(signal.SIGTERM)
                try:
                    srv.wait(timeout=5)
                except Exception:
                    srv.kill()
                shutil.rmtree(work, ignore_errors=True)
        social_preview(browser)
        browser.close()


if __name__ == "__main__":
    main()
