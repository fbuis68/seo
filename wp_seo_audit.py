#!/usr/bin/env python3
"""
WordPress SEO Audit & Optimization — sesame-technology.fr

Usage:
  python wp_seo_audit.py               # Audit + optimisation complète
  python wp_seo_audit.py --dry-run     # Audit uniquement, aucune modification
  python wp_seo_audit.py --skip-url-check  # Ignore les vérifications HTTP
"""

import argparse
import csv
import html
import json
import os
import re
import time
from datetime import datetime
from urllib.parse import urlparse

import requests
from bs4 import BeautifulSoup


# ─── CONFIG ───────────────────────────────────────────────────────────────────

def load_config(path="config.json"):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


# ─── WORDPRESS API CLIENT ─────────────────────────────────────────────────────

class WordPressAPI:
    def __init__(self, url, user, password):
        self.base = url.rstrip("/")
        self.api = f"{self.base}/wp-json/wp/v2"
        self.session = requests.Session()
        self.session.auth = (user, password)
        self.session.headers.update({
            "User-Agent": "Mozilla/5.0 (SEO Audit Bot; compatible)",
            "Accept": "application/json",
        })

    def get(self, endpoint, **params):
        url = f"{self.api}/{endpoint}"
        resp = self.session.get(url, params=params, timeout=30)
        resp.raise_for_status()
        return resp.json(), resp.headers

    def get_all(self, endpoint, **params):
        """Fetch all paginated results from a WP REST endpoint."""
        params["per_page"] = 100
        params["page"] = 1
        results = []
        while True:
            try:
                data, headers = self.get(endpoint, **params)
            except requests.HTTPError as e:
                print(f"  ✗ Erreur {endpoint}: {e}")
                break
            if not data:
                break
            results.extend(data)
            total_pages = int(headers.get("X-WP-TotalPages", 1))
            if params["page"] >= total_pages:
                break
            params["page"] += 1
            time.sleep(0.4)
        return results

    def patch(self, resource_type, resource_id, payload):
        """Update a WP resource (page or post) via REST."""
        url = f"{self.api}/{resource_type}/{resource_id}"
        resp = self.session.post(url, json=payload, timeout=30)
        resp.raise_for_status()
        return resp.json()

    def test_auth(self):
        try:
            data, _ = self.get("users/me")
            return True, data.get("name", "?")
        except requests.HTTPError as e:
            return False, str(e)


# ─── REDIRECTION PLUGIN ───────────────────────────────────────────────────────

class RedirectionPlugin:
    def __init__(self, wp_api: WordPressAPI):
        self.base = wp_api.base
        self.session = wp_api.session

    def list(self):
        try:
            resp = self.session.get(
                f"{self.base}/wp-json/redirection/v1/redirect",
                params={"per_page": 500},
                timeout=30,
            )
            if resp.status_code == 200:
                return resp.json().get("items", [])
            print(f"  ℹ Plugin Redirection non accessible (HTTP {resp.status_code})")
        except Exception as e:
            print(f"  ℹ Plugin Redirection inaccessible: {e}")
        return []

    def create(self, source_url, target_url, code=301):
        try:
            resp = self.session.post(
                f"{self.base}/wp-json/redirection/v1/redirect",
                json={
                    "url": source_url,
                    "action_data": {"url": target_url},
                    "action_type": "url",
                    "match_type": "url",
                    "status": "enabled",
                    "action_code": code,
                },
                timeout=30,
            )
            return resp.status_code in (200, 201), resp.json()
        except Exception as e:
            return False, str(e)


# ─── SEO ANALYSIS ─────────────────────────────────────────────────────────────

def word_count(html_content):
    if not html_content:
        return 0
    soup = BeautifulSoup(html_content, "lxml")
    return len(re.findall(r"\w+", soup.get_text()))


def audit_item(item):
    """Return an audit dict with detected SEO issues for a page or post."""
    yoast = item.get("yoast_head_json") or {}
    content_html = (item.get("content") or {}).get("rendered", "")
    excerpt_html = (item.get("excerpt") or {}).get("rendered", "")

    seo_title = yoast.get("title", "")
    meta_desc = yoast.get("description", "")
    robots = yoast.get("robots") or {}
    canonical = yoast.get("canonical", "")
    wc = word_count(content_html)
    noindex = robots.get("index") == "noindex"

    issues = []

    # Title checks
    if not seo_title:
        issues.append("TITLE_MANQUANT")
    elif len(seo_title) > 65:
        issues.append("TITLE_TROP_LONG")
    elif len(seo_title) < 10:
        issues.append("TITLE_TROP_COURT")

    # Meta description checks
    if not meta_desc:
        issues.append("META_DESC_MANQUANTE")
    elif len(meta_desc) < 50:
        issues.append("META_DESC_TROP_COURTE")
    elif len(meta_desc) > 160:
        issues.append("META_DESC_TROP_LONGUE")

    # Content checks
    if item.get("status") == "publish" and wc < 300:
        issues.append("CONTENU_MINCE")

    # Noindex check
    if noindex:
        issues.append("NOINDEX")

    return {
        "id": item.get("id"),
        "type": item.get("type", "page"),
        "slug": item.get("slug", ""),
        "url": item.get("link", ""),
        "seo_title": seo_title,
        "title_wp": html.unescape((item.get("title") or {}).get("rendered", "")),
        "meta_description": meta_desc,
        "canonical": canonical,
        "word_count": wc,
        "status": item.get("status", ""),
        "noindex": noindex,
        "modified": (item.get("modified") or "")[:10],
        "issues": issues,
    }


# ─── URL CHECKER ──────────────────────────────────────────────────────────────

def check_url(url, session):
    try:
        resp = session.get(url, allow_redirects=True, timeout=15)
        chain = [r.url for r in resp.history]
        return {
            "url": url,
            "final_url": resp.url,
            "status": resp.status_code,
            "redirects": chain,
            "redirect_count": len(chain),
        }
    except requests.TooManyRedirects:
        return {"url": url, "status": 0, "error": "REDIRECT_LOOP", "redirects": [], "redirect_count": 0, "final_url": url}
    except Exception as e:
        return {"url": url, "status": 0, "error": str(e), "redirects": [], "redirect_count": 0, "final_url": url}


# ─── SEO OPTIMIZATION ─────────────────────────────────────────────────────────

def build_meta_description(item, max_len=155):
    """Generate a meta description from page content."""
    content_html = (item.get("content") or {}).get("rendered", "")
    soup = BeautifulSoup(content_html, "lxml")
    for p in soup.find_all("p"):
        text = p.get_text(" ", strip=True)
        if len(text) > 60:
            if len(text) > max_len:
                text = text[:max_len].rsplit(" ", 1)[0].rstrip(",.;:") + "…"
            return text
    # Fallback: excerpt
    excerpt_html = (item.get("excerpt") or {}).get("rendered", "")
    if excerpt_html:
        text = BeautifulSoup(excerpt_html, "lxml").get_text(" ", strip=True)
        if len(text) > max_len:
            text = text[:max_len].rsplit(" ", 1)[0] + "…"
        if text:
            return text
    return ""


def build_seo_title(item, site_name="Sesame Technology", max_len=65):
    """Generate an optimized SEO title."""
    raw_title = html.unescape((item.get("title") or {}).get("rendered", ""))
    if not raw_title:
        return ""
    separator = " | "
    suffix = site_name
    available = max_len - len(separator) - len(suffix)
    if len(raw_title) > available:
        raw_title = raw_title[:available].rsplit(" ", 1)[0]
    return f"{raw_title}{separator}{suffix}"


# ─── HTML REPORT ──────────────────────────────────────────────────────────────

_ISSUE_LABELS = {
    "TITLE_MANQUANT": ("Titre manquant", "red"),
    "TITLE_TROP_LONG": ("Titre trop long", "orange"),
    "TITLE_TROP_COURT": ("Titre trop court", "orange"),
    "META_DESC_MANQUANTE": ("Meta desc. manquante", "red"),
    "META_DESC_TROP_COURTE": ("Meta desc. trop courte", "orange"),
    "META_DESC_TROP_LONGUE": ("Meta desc. trop longue", "orange"),
    "CONTENU_MINCE": ("Contenu mince", "red"),
    "NOINDEX": ("noindex", "purple"),
}


def _badges(issues):
    parts = []
    for code in issues:
        label, color = _ISSUE_LABELS.get(code, (code, "gray"))
        parts.append(f'<span class="badge badge-{color}">{label}</span>')
    return "".join(parts)


def generate_html_report(audit_results, url_checks, changes, redirects, out_path):
    now = datetime.now().strftime("%d/%m/%Y à %H:%M")
    total = len(audit_results)
    with_issues = sum(1 for p in audit_results if p["issues"])
    noindex_count = sum(1 for p in audit_results if p["noindex"])
    thin = sum(1 for p in audit_results if "CONTENU_MINCE" in p["issues"])
    no_desc = sum(1 for p in audit_results if "META_DESC_MANQUANTE" in p["issues"])
    err_404 = sum(1 for u in url_checks if u.get("status") == 404)
    redirect_chains = sum(1 for u in url_checks if u.get("redirect_count", 0) > 1)

    issue_counts = {}
    for r in audit_results:
        for i in r["issues"]:
            issue_counts[i] = issue_counts.get(i, 0) + 1

    rows_issues = ""
    for p in sorted(audit_results, key=lambda x: len(x["issues"]), reverse=True):
        if not p["issues"]:
            continue
        t = html.escape(p["seo_title"][:70]) or "<em style='color:#aaa'>—</em>"
        d = html.escape(p["meta_description"][:90]) or "<em style='color:#aaa'>—</em>"
        rows_issues += f"""<tr>
          <td><a href="{p['url']}" target="_blank">{html.escape(p['slug'])}</a></td>
          <td>{p['type']}</td>
          <td>{t}</td>
          <td>{d}</td>
          <td>{p['word_count']}</td>
          <td>{_badges(p['issues'])}</td>
        </tr>"""

    rows_urls = ""
    for u in url_checks:
        s = u.get("status", 0)
        cls = "ok" if s == 200 else ("warn" if s in (301, 302) else "err")
        chain = " → ".join(u.get("redirects", []))
        final = u.get("final_url", "")
        rows_urls += f"""<tr>
          <td><a href="{u['url']}" target="_blank">{u['url']}</a></td>
          <td class="status-{cls}">{s}</td>
          <td>{u.get('redirect_count', 0)}</td>
          <td>{html.escape(final[:80])}</td>
        </tr>"""

    rows_changes = ""
    for c in changes:
        rows_changes += f"""<tr>
          <td>{html.escape(c['slug'])}</td>
          <td>{html.escape(c['field'])}</td>
          <td style="color:#888">{html.escape(str(c['old'])[:80])}</td>
          <td style="color:#27ae60">{html.escape(str(c['new'])[:80])}</td>
        </tr>"""

    rows_redirects = ""
    for r in redirects[:200]:
        rows_redirects += f"""<tr>
          <td>{html.escape(str(r.get('url', '')))}</td>
          <td>{html.escape(str((r.get('action_data') or {}).get('url', '')))}</td>
          <td>{r.get('action_code', '')}</td>
          <td>{r.get('status', '')}</td>
        </tr>"""

    report = f"""<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Rapport SEO — sesame-technology.fr — {now}</title>
<style>
  *{{box-sizing:border-box;margin:0;padding:0}}
  body{{font-family:'Segoe UI',Arial,sans-serif;background:#f0f2f5;color:#2c3e50;padding:24px}}
  h1{{font-size:1.8em;margin-bottom:4px}}
  .subtitle{{color:#7f8c8d;margin-bottom:24px}}
  h2{{font-size:1.2em;margin:28px 0 12px;padding-bottom:6px;border-bottom:2px solid #3498db}}
  .cards{{display:flex;flex-wrap:wrap;gap:14px;margin-bottom:28px}}
  .card{{background:#fff;border-radius:10px;padding:18px 22px;min-width:130px;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.08)}}
  .card .num{{font-size:2.2em;font-weight:700;line-height:1.1}}
  .card .lbl{{font-size:.78em;color:#7f8c8d;margin-top:4px}}
  .card.red .num{{color:#e74c3c}}
  .card.orange .num{{color:#e67e22}}
  .card.green .num{{color:#27ae60}}
  .card.blue .num{{color:#3498db}}
  .card.purple .num{{color:#8e44ad}}
  table{{width:100%;border-collapse:collapse;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08);margin-bottom:28px;font-size:.88em}}
  th{{background:#2c3e50;color:#fff;padding:11px 14px;text-align:left;font-weight:600}}
  td{{padding:9px 14px;border-bottom:1px solid #f0f2f5;vertical-align:top}}
  tr:last-child td{{border-bottom:none}}
  tr:hover td{{background:#fafbfc}}
  .badge{{display:inline-block;padding:2px 9px;border-radius:20px;font-size:.75em;font-weight:600;margin:1px}}
  .badge-red{{background:#fde8e8;color:#c0392b}}
  .badge-orange{{background:#fef3e2;color:#d35400}}
  .badge-purple{{background:#f5eef8;color:#6c3483}}
  .badge-gray{{background:#f0f0f0;color:#555}}
  .status-ok{{color:#27ae60;font-weight:600}}
  .status-warn{{color:#e67e22;font-weight:600}}
  .status-err{{color:#e74c3c;font-weight:600}}
  a{{color:#3498db;text-decoration:none}}
  a:hover{{text-decoration:underline}}
  .issue-summary{{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:20px}}
  .issue-pill{{background:#fff;border-radius:6px;padding:8px 14px;font-size:.85em;box-shadow:0 1px 4px rgba(0,0,0,.1)}}
  .issue-pill strong{{color:#e74c3c}}
  footer{{text-align:center;color:#aaa;font-size:.8em;margin-top:40px;padding-top:16px;border-top:1px solid #ddd}}
</style>
</head>
<body>
<h1>Rapport SEO — sesame-technology.fr</h1>
<p class="subtitle">Généré le {now} &nbsp;·&nbsp; Outil : wp_seo_audit.py</p>

<div class="cards">
  <div class="card blue"><div class="num">{total}</div><div class="lbl">Pages auditées</div></div>
  <div class="card red"><div class="num">{with_issues}</div><div class="lbl">Avec problèmes</div></div>
  <div class="card orange"><div class="num">{no_desc}</div><div class="lbl">Meta desc. manquante</div></div>
  <div class="card orange"><div class="num">{thin}</div><div class="lbl">Contenu mince</div></div>
  <div class="card purple"><div class="num">{noindex_count}</div><div class="lbl">Pages noindex</div></div>
  <div class="card red"><div class="num">{err_404}</div><div class="lbl">Erreurs 404</div></div>
  <div class="card orange"><div class="num">{redirect_chains}</div><div class="lbl">Chaînes redirect.</div></div>
  <div class="card green"><div class="num">{len(changes)}</div><div class="lbl">Optimisations</div></div>
</div>

<div class="issue-summary">
{"".join(f'<div class="issue-pill"><strong>{v}</strong> {_ISSUE_LABELS.get(k,(k,""))[0]}</div>' for k,v in sorted(issue_counts.items(),key=lambda x:-x[1]))}
</div>

<h2>Pages avec problèmes SEO ({with_issues})</h2>
<table>
  <thead><tr>
    <th>Slug</th><th>Type</th><th>Titre SEO</th>
    <th>Meta description</th><th>Mots</th><th>Problèmes</th>
  </tr></thead>
  <tbody>{rows_issues}</tbody>
</table>

<h2>Vérification HTTP des URLs ({len(url_checks)})</h2>
<table>
  <thead><tr><th>URL</th><th>Code</th><th>Nb redirections</th><th>URL finale</th></tr></thead>
  <tbody>{rows_urls}</tbody>
</table>

<h2>Optimisations appliquées ({len(changes)})</h2>
<table>
  <thead><tr><th>Slug</th><th>Champ</th><th>Ancienne valeur</th><th>Nouvelle valeur</th></tr></thead>
  <tbody>{rows_changes if rows_changes else '<tr><td colspan="4" style="text-align:center;color:#aaa">Aucune modification (mode dry-run ou déjà optimisé)</td></tr>'}</tbody>
</table>

<h2>Redirections actives — plugin Redirection ({len(redirects)})</h2>
<table>
  <thead><tr><th>Source</th><th>Destination</th><th>Code</th><th>Statut</th></tr></thead>
  <tbody>{rows_redirects if rows_redirects else '<tr><td colspan="4" style="text-align:center;color:#aaa">Aucune redirection trouvée</td></tr>'}</tbody>
</table>

<footer>sesame-technology.fr &nbsp;·&nbsp; Rapport SEO automatisé &nbsp;·&nbsp; {now}</footer>
</body>
</html>"""

    with open(out_path, "w", encoding="utf-8") as f:
        f.write(report)


# ─── MAIN ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="WordPress SEO Audit & Optimization")
    parser.add_argument("--dry-run", action="store_true",
                        help="Audit uniquement, aucune modification appliquée")
    parser.add_argument("--skip-url-check", action="store_true",
                        help="Ignore la vérification HTTP des URLs")
    parser.add_argument("--config", default="config.json",
                        help="Chemin vers le fichier de configuration (défaut: config.json)")
    args = parser.parse_args()

    cfg = load_config(args.config)
    dry_run = args.dry_run or cfg.get("dry_run", False)
    skip_url = args.skip_url_check or cfg.get("skip_url_check", False)
    site_name = cfg.get("site_name", "Sesame Technology")

    wp = WordPressAPI(cfg["url"], cfg["user"], cfg["password"])
    redir_plugin = RedirectionPlugin(wp)

    sep = "─" * 60
    print(f"\n{sep}")
    print("  SEO AUDIT & OPTIMISATION — sesame-technology.fr")
    print(sep)

    # ── Auth check ────────────────────────────────────────────────
    ok, info = wp.test_auth()
    if ok:
        print(f"\n  ✓ Connecté en tant que : {info}")
    else:
        print(f"\n  ✗ Échec d'authentification : {info}")
        print("    → Vérifiez vos identifiants dans config.json")
        print("    → Ou créez un Application Password dans WP-Admin > Utilisateurs > Profil")
        return

    if dry_run:
        print("  ℹ Mode DRY-RUN activé — aucune modification ne sera appliquée\n")

    # ── 1. Fetch content ──────────────────────────────────────────
    print(f"\n[1/5] Récupération du contenu WordPress…")
    fields = "id,type,slug,link,title,content,excerpt,status,modified,yoast_head_json,meta"

    pages = wp.get_all("pages", status="any", _fields=fields)
    print(f"  ✓ {len(pages)} pages")

    posts = wp.get_all("posts", status="any", _fields=fields)
    print(f"  ✓ {len(posts)} articles")

    all_items = pages + posts

    # ── 2. Audit ──────────────────────────────────────────────────
    print(f"\n[2/5] Audit SEO de {len(all_items)} contenus…")
    audit_results = [audit_item(p) for p in all_items]

    issue_counts = {}
    for r in audit_results:
        for i in r["issues"]:
            issue_counts[i] = issue_counts.get(i, 0) + 1

    if issue_counts:
        print("  Problèmes détectés :")
        for code, count in sorted(issue_counts.items(), key=lambda x: -x[1]):
            label = _ISSUE_LABELS.get(code, (code, ""))[0]
            print(f"    ⚠  {label} : {count}")
    else:
        print("  ✓ Aucun problème détecté !")

    # ── 3. URL checks ─────────────────────────────────────────────
    url_checks = []
    if not skip_url:
        pub_urls = [r["url"] for r in audit_results
                    if r["status"] == "publish" and r["url"]]
        print(f"\n[3/5] Vérification HTTP de {len(pub_urls)} URLs publiées…")

        http_sess = requests.Session()
        http_sess.headers.update({"User-Agent": "Mozilla/5.0 (SEO Audit)"})
        http_sess.max_redirects = 10

        for i, url in enumerate(pub_urls, 1):
            result = check_url(url, http_sess)
            url_checks.append(result)
            s = result.get("status", 0)
            if s == 404:
                print(f"  ✗ 404 — {url}")
            elif result.get("redirect_count", 0) > 1:
                print(f"  ⚠  Chaîne de {result['redirect_count']} redirections — {url}")
            elif s == 0:
                print(f"  ✗ ERREUR — {url} ({result.get('error', '?')})")
            if i % 15 == 0:
                print(f"  … {i}/{len(pub_urls)} vérifiées")
                time.sleep(1)
    else:
        print("\n[3/5] Vérification URL ignorée (--skip-url-check)")

    # ── 4. Optimize ───────────────────────────────────────────────
    changes = []
    if not dry_run:
        needs_update = [
            (item, a) for item, a in zip(all_items, audit_results)
            if any(i in a["issues"] for i in (
                "META_DESC_MANQUANTE", "META_DESC_TROP_COURTE",
                "TITLE_MANQUANT", "TITLE_TROP_LONG",
            ))
        ]
        print(f"\n[4/5] Optimisation de {len(needs_update)} pages…")

        for item, audited in needs_update:
            meta_payload = {}
            item_changes = []

            # Meta description
            if audited["meta_description"] == "" or "META_DESC_TROP_COURTE" in audited["issues"]:
                new_desc = build_meta_description(item)
                if new_desc and new_desc != audited["meta_description"]:
                    meta_payload["_yoast_wpseo_metadesc"] = new_desc
                    item_changes.append({
                        "slug": audited["slug"],
                        "field": "meta_description",
                        "old": audited["meta_description"],
                        "new": new_desc,
                    })

            # SEO title
            if "TITLE_MANQUANT" in audited["issues"] or "TITLE_TROP_LONG" in audited["issues"]:
                new_title = build_seo_title(item, site_name)
                if new_title and new_title != audited["seo_title"]:
                    meta_payload["_yoast_wpseo_title"] = new_title
                    item_changes.append({
                        "slug": audited["slug"],
                        "field": "seo_title",
                        "old": audited["seo_title"],
                        "new": new_title,
                    })

            if not meta_payload:
                continue

            resource = "pages" if item.get("type") == "page" else "posts"
            try:
                wp.patch(resource, item["id"], {"meta": meta_payload})
                changes.extend(item_changes)
                print(f"  ✓ {audited['slug']}")
                time.sleep(0.3)
            except requests.HTTPError as e:
                print(f"  ✗ {audited['slug']} : {e}")
    else:
        print("\n[4/5] Optimisation ignorée (dry-run)")

    # ── 5. Redirections ───────────────────────────────────────────
    print("\n[5/5] Lecture des redirections (plugin Redirection)…")
    redirects = redir_plugin.list()
    if redirects:
        active = sum(1 for r in redirects if r.get("status") == "enabled")
        print(f"  ✓ {len(redirects)} redirections — {active} actives")
    else:
        print("  ℹ Aucune redirection trouvée (plugin absent ou non accessible)")

    # 404s summary
    errors_404 = [u for u in url_checks if u.get("status") == 404]
    if errors_404:
        print(f"\n  ⚠  {len(errors_404)} erreurs 404 détectées :")
        for e in errors_404:
            print(f"    ✗ {e['url']}")
        print("\n  → Utilisez add_redirects.py pour créer des redirections 301 vers ces URLs")

    # ── Reports ───────────────────────────────────────────────────
    os.makedirs("reports", exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")

    # CSV
    csv_path = f"reports/seo_audit_{ts}.csv"
    with open(csv_path, "w", newline="", encoding="utf-8-sig") as f:
        fields_csv = ["id", "type", "slug", "url", "seo_title", "meta_description",
                      "word_count", "status", "noindex", "modified", "issues"]
        w = csv.DictWriter(f, fieldnames=fields_csv, extrasaction="ignore")
        w.writeheader()
        for row in audit_results:
            row["issues"] = " | ".join(row["issues"])
            w.writerow(row)

    # HTML
    html_path = f"reports/seo_report_{ts}.html"
    generate_html_report(audit_results, url_checks, changes, redirects, html_path)

    # JSON
    json_path = f"reports/seo_data_{ts}.json"
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump({
            "generated": ts,
            "site": cfg["url"],
            "summary": issue_counts,
            "audit": audit_results,
            "url_checks": url_checks,
            "changes_applied": changes,
            "redirects": redirects,
        }, f, ensure_ascii=False, indent=2)

    # ── Final summary ─────────────────────────────────────────────
    print(f"\n{sep}")
    print("  RÉSUMÉ FINAL")
    print(sep)
    print(f"  Pages auditées       : {len(audit_results)}")
    print(f"  Pages avec problèmes : {sum(1 for p in audit_results if p['issues'])}")
    print(f"  Optimisations faites : {len(changes)}")
    print(f"  Erreurs 404          : {len(errors_404)}")
    print(f"  Redirections actives : {sum(1 for r in redirects if r.get('status')=='enabled')}")
    print(f"\n  Rapports générés :")
    print(f"    📊 {html_path}")
    print(f"    📋 {csv_path}")
    print(f"    🗃  {json_path}")
    print(sep)


if __name__ == "__main__":
    main()
