#!/usr/bin/env python3
"""
Gestionnaire de redirections 301 — sesame-technology.fr

Permet de créer des redirections 301 en masse via le plugin Redirection.

Usage:
  # Créer des redirections depuis un fichier CSV (source,destination)
  python add_redirects.py --csv redirects.csv

  # Créer une redirection unique
  python add_redirects.py --from /ancienne-page --to /nouvelle-page

  # Lister toutes les redirections existantes
  python add_redirects.py --list

  # Exporter les redirections en CSV
  python add_redirects.py --export redirections_actuelles.csv

Format du fichier CSV (sans en-tête):
  /ancienne-url,/nouvelle-url
  /page-supprimee,/page-equivalente
  /old-slug,https://sesame-technology.fr/new-slug
"""

import argparse
import csv
import json
import sys
import time

import requests


def load_config(path="config.json"):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


class RedirectionManager:
    def __init__(self, base_url, user, password):
        self.base = base_url.rstrip("/")
        self.api = f"{self.base}/wp-json/redirection/v1"
        self.session = requests.Session()
        self.session.auth = (user, password)
        self.session.headers.update({
            "User-Agent": "Mozilla/5.0 (SEO Redirect Manager)",
            "Accept": "application/json",
        })

    def test(self):
        try:
            resp = self.session.get(f"{self.api}/redirect", params={"per_page": 1}, timeout=15)
            return resp.status_code == 200
        except Exception:
            return False

    def list_all(self):
        items = []
        page = 1
        while True:
            try:
                resp = self.session.get(
                    f"{self.api}/redirect",
                    params={"per_page": 100, "page": page},
                    timeout=30,
                )
                if resp.status_code != 200:
                    break
                data = resp.json()
                batch = data.get("items", [])
                if not batch:
                    break
                items.extend(batch)
                total_pages = data.get("total", {})
                if isinstance(total_pages, dict):
                    total = int(total_pages.get("pages", 1))
                else:
                    total = 1
                if page >= total:
                    break
                page += 1
                time.sleep(0.3)
            except Exception as e:
                print(f"  Erreur : {e}")
                break
        return items

    def create(self, source, destination, code=301):
        """Create a single redirect. Returns (success, message)."""
        payload = {
            "url": source,
            "action_data": {"url": destination},
            "action_type": "url",
            "match_type": "url",
            "status": "enabled",
            "action_code": code,
        }
        try:
            resp = self.session.post(f"{self.api}/redirect", json=payload, timeout=30)
            if resp.status_code in (200, 201):
                return True, resp.json().get("id", "?")
            return False, f"HTTP {resp.status_code}: {resp.text[:120]}"
        except Exception as e:
            return False, str(e)

    def delete(self, redirect_id):
        try:
            resp = self.session.delete(f"{self.api}/redirect/{redirect_id}", timeout=15)
            return resp.status_code in (200, 204)
        except Exception:
            return False


def cmd_list(manager):
    items = manager.list_all()
    if not items:
        print("Aucune redirection trouvée.")
        return
    print(f"\n{'Code':6} {'Statut':10} {'Source':<50} {'Destination'}")
    print("─" * 110)
    for r in items:
        code = r.get("action_code", "?")
        status = r.get("status", "?")
        source = r.get("url", "")
        dest = (r.get("action_data") or {}).get("url", "")
        print(f"{code:<6} {status:<10} {source:<50} {dest}")
    print(f"\nTotal : {len(items)} redirections")


def cmd_export(manager, out_path):
    items = manager.list_all()
    with open(out_path, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(["id", "source", "destination", "code", "statut"])
        for r in items:
            w.writerow([
                r.get("id"),
                r.get("url"),
                (r.get("action_data") or {}).get("url", ""),
                r.get("action_code", 301),
                r.get("status", ""),
            ])
    print(f"  ✓ {len(items)} redirections exportées → {out_path}")


def cmd_create_one(manager, source, destination, code=301):
    ok, result = manager.create(source, destination, code)
    if ok:
        print(f"  ✓ Redirection créée (ID:{result}): {source} → {destination}")
    else:
        print(f"  ✗ Erreur : {result}")


def cmd_from_csv(manager, csv_path, code=301):
    pairs = []
    with open(csv_path, newline="", encoding="utf-8") as f:
        for row in csv.reader(f):
            if len(row) >= 2 and row[0].strip() and row[1].strip():
                pairs.append((row[0].strip(), row[1].strip()))

    print(f"\n  {len(pairs)} redirections à créer depuis {csv_path}\n")
    ok_count = 0
    for source, dest in pairs:
        success, result = manager.create(source, dest, code)
        if success:
            print(f"  ✓ {source} → {dest}")
            ok_count += 1
        else:
            print(f"  ✗ {source} → {dest} : {result}")
        time.sleep(0.2)

    print(f"\n  Résultat : {ok_count}/{len(pairs)} créées avec succès")


def main():
    parser = argparse.ArgumentParser(description="Gestion des redirections WordPress")
    parser.add_argument("--config", default="config.json")
    parser.add_argument("--list", action="store_true", help="Lister toutes les redirections")
    parser.add_argument("--export", metavar="FICHIER.CSV", help="Exporter les redirections en CSV")
    parser.add_argument("--csv", metavar="FICHIER.CSV", help="Créer des redirections depuis un CSV")
    parser.add_argument("--from", dest="source", help="URL source (chemin)")
    parser.add_argument("--to", dest="destination", help="URL de destination")
    parser.add_argument("--code", type=int, default=301, help="Code HTTP (301 ou 302, défaut: 301)")
    args = parser.parse_args()

    cfg = load_config(args.config)
    mgr = RedirectionManager(cfg["url"], cfg["user"], cfg["password"])

    print(f"\nConnexion à {cfg['url']}…")
    if not mgr.test():
        print("  ✗ Plugin Redirection non accessible.")
        print("    → Vérifiez que le plugin 'Redirection' est installé et activé.")
        print("    → URL requise : /wp-json/redirection/v1/")
        sys.exit(1)
    print("  ✓ Plugin Redirection accessible\n")

    if args.list:
        cmd_list(mgr)
    elif args.export:
        cmd_export(mgr, args.export)
    elif args.csv:
        cmd_from_csv(mgr, args.csv, args.code)
    elif args.source and args.destination:
        cmd_create_one(mgr, args.source, args.destination, args.code)
    else:
        parser.print_help()
        print("\nExemples :")
        print("  python add_redirects.py --list")
        print("  python add_redirects.py --from /vieille-page --to /nouvelle-page")
        print("  python add_redirects.py --csv mes_redirections.csv")
        print("  python add_redirects.py --export backup_redirections.csv")


if __name__ == "__main__":
    main()
