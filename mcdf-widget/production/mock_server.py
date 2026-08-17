#!/usr/bin/env python3
"""Serveur local pour tester widget-ia.html avec des données fictives.

Sert le widget de production **sans le modifier** et répond aux appels
`/wa/{entite}/list` avec des données générées en mémoire, dans le même
format que la vraie API MCDF (`{"success": true, "root": [...]}`) et avec
les mêmes noms de champs (camelCase, `entityId`, dates ISO avec heure...).
C'est le même test que passerait le widget une fois branché en production
— seule la source des données change.

Usage:
    python3 mock_server.py [--port 8000]
    puis ouvrir http://localhost:8000/widget-ia.html?entityId=E00000361

Ne dépend d'aucune librairie externe (juste la stdlib).
"""
import argparse
import json
import random
from datetime import date, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ENTITY_ID = "E00000361"
TODAY = date.today()

PRENOMS = [
    "Camille", "Lucas", "Manon", "Hugo", "Chloé", "Léo", "Emma", "Nathan",
    "Julie", "Louis", "Sarah", "Adam", "Léa", "Enzo", "Inès", "Raphaël",
    "Zoé", "Mathis", "Jade", "Noah", "Lina", "Gabriel", "Anna", "Tom",
]
NOMS = [
    "Martin", "Bernard", "Dubois", "Thomas", "Robert", "Petit", "Durand",
    "Leroy", "Moreau", "Simon", "Laurent", "Lefebvre", "Michel", "Garcia",
]
RAISONS = ["Solutions", "Groupe", "Industries", "Services", "Consulting", "Partners"]
FORMATIONS = [
    "Excel Perfectionnement", "Management d'équipe", "Gestion de projet",
    "Anglais professionnel", "SST - Sauveteur Secouriste du Travail",
    "Habilitation électrique", "Négociation commerciale", "Excel VBA",
]


def iso(d, rng):
    return datetime(d.year, d.month, d.day, rng.randint(8, 18), rng.randint(0, 59), rng.randint(0, 59)).isoformat()


def seq(prefix, n, width=8):
    return f"{prefix}{n:0{width}d}"


def gen_data(seed=7):
    rng = random.Random(seed)
    start_history = TODAY - timedelta(days=730)

    customers = []
    cid = 0
    month_cursor = date(start_history.year, start_history.month, 1)
    while month_cursor <= TODAY:
        max_day = TODAY.day if (month_cursor.year, month_cursor.month) == (TODAY.year, TODAY.month) else 28
        for _ in range(rng.randint(1, 4)):
            d = date(month_cursor.year, month_cursor.month, rng.randint(1, max_day))
            name = f"{rng.choice(NOMS)} {rng.choice(RAISONS)}"
            customers.append({"id": seq("C", 61000 + cid), "entityId": ENTITY_ID, "name": name, "created": iso(d, rng)})
            cid += 1
        month_cursor = date(month_cursor.year + 1, 1, 1) if month_cursor.month == 12 else date(month_cursor.year, month_cursor.month + 1, 1)

    trainers = []
    for i in range(8):
        prenom, nom = rng.choice(PRENOMS), rng.choice(NOMS)
        trainers.append({"id": seq("A", 118400 + i), "name": f"{nom} {prenom}"})

    sessions = []
    sid = 0
    d = start_history
    while d <= TODAY + timedelta(days=30):
        if rng.random() < 0.3:
            trainer = rng.choice(trainers)
            days_n = rng.choice([1, 2, 3])
            maxi = rng.choice([6, 8, 10, 12])
            sessions.append({
                "id": seq("S", 33600 + sid), "entityId": ENTITY_ID,
                "name": rng.choice(FORMATIONS), "trainerId": trainer["id"], "trainerName": trainer["name"],
                "startDate": d.isoformat(), "endDate": (d + timedelta(days=days_n - 1)).isoformat(),
                "days": days_n, "dailyRate": 700, "numberMini": max(2, maxi - 4), "numberMaxi": maxi,
                "created": iso(d - timedelta(days=rng.randint(5, 30)), rng),
            })
            sid += 1
        d += timedelta(days=1)

    conventions = []
    convention_attendees = []
    invoices = []
    conv_i = 0
    att_i = 0
    inv_i = 0
    for cust in customers:
        for _ in range(rng.randint(1, 3)):
            cust_created = datetime.fromisoformat(cust["created"]).date()
            provisional = min(cust_created + timedelta(days=rng.randint(0, 550)), TODAY)
            age = (TODAY - provisional).days
            is_convention, signing_date, status = 0, None, "en_attente"
            if age >= 10:
                r = rng.random()
                if r < 0.55:
                    is_convention = 1
                    signing_date = iso(provisional + timedelta(days=rng.randint(1, 20)), rng)
                    status = "signe"
                elif r < 0.75:
                    status = "refuse"
                elif r < 0.9:
                    status = "expire"
            conv_id = seq("C", 20300 + conv_i)
            conventions.append({
                "id": conv_id, "entityId": ENTITY_ID,
                "name": f"Formation {rng.choice(FORMATIONS)} — {cust['name']}",
                "proposalCode": seq("PR", conv_i, width=5), "proposalStatus": status,
                "isProposal": True, "isConvention": bool(is_convention),
                "provisionalDate": provisional.isoformat(), "signingDate": signing_date,
                "created": iso(provisional, rng),
            })
            conv_i += 1

            if is_convention:
                nb_attendees = rng.randint(1, 6)
                for _ in range(nb_attendees):
                    prenom, nom = rng.choice(PRENOMS), rng.choice(NOMS)
                    created = min(provisional + timedelta(days=rng.randint(0, 20)), TODAY)
                    attendee_id = seq("A", 200000 + att_i)
                    convention_attendees.append({
                        "id": seq("CA", 75400 + att_i), "entityId": ENTITY_ID,
                        "conventionId": conv_id, "actorId": attendee_id, "attendeeId": attendee_id,
                        "fullname": f"{nom} {prenom}", "attendee": True,
                        "created": iso(created, rng),
                    })
                    att_i += 1

                if rng.random() > 0.25:
                    for _ in range(rng.randint(1, 2)):
                        billing = min(provisional + timedelta(days=rng.randint(15, 90)), TODAY)
                        invoices.append({
                            "id": f"F{inv_i + 1:05d}", "entityId": ENTITY_ID, "conventionId": conv_id,
                            "amount": round(rng.uniform(800, 9000), 2), "billingDate": billing.isoformat(),
                            "created": iso(billing, rng),
                        })
                        inv_i += 1

    return {
        "customer": customers, "convention": conventions, "invoice": invoices,
        "conventionAttendee": convention_attendees, "session": sessions,
    }


DATA = gen_data()


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path.startswith("/wa/") and parsed.path.endswith("/list"):
            entity = parsed.path.split("/")[2]
            rows = DATA.get(entity, [])
            body = json.dumps({"success": True, "root": rows}).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(body)
            return
        self.serve_static(parsed.path)

    def serve_static(self, path):
        if path == "/":
            path = "/widget-ia.html"
        file_path = (Path(__file__).parent / path.lstrip("/")).resolve()
        if Path(__file__).parent.resolve() not in file_path.parents and file_path != Path(__file__).parent.resolve():
            self.send_response(403); self.end_headers(); return
        if not file_path.exists() or not file_path.is_file():
            self.send_response(404); self.end_headers(); return
        content = file_path.read_bytes()
        ctype = "text/html; charset=utf-8" if file_path.suffix == ".html" else "text/plain; charset=utf-8"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    server = ThreadingHTTPServer(("0.0.0.0", args.port), Handler)
    counts = {k: len(v) for k, v in DATA.items()}
    print(f"Données fictives générées : {counts}")
    print(f"→ http://127.0.0.1:{args.port}/widget-ia.html?entityId={ENTITY_ID}")
    print("Ctrl+C pour arrêter.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
