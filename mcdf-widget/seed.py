"""Génère un jeu de données réaliste pour le prototype MCDF v2 (SQLite),
suivant le VRAI schéma découvert par capture réseau (entity/customer/
company/actor/convention/conventionAttendee/invoice/session).

Usage:
    python3 seed.py [--db mcdf.db] [--seed 42]

Ne dépend d'aucune librairie externe. Les identifiants suivent les
préfixes observés dans l'API réelle (A=actor, C=convention/customer/
company, S=session, CA=conventionAttendee, F=invoice) et les dates sont
au format ISO avec heure (ex: 2024-03-12T14:44:40), comme les vraies
réponses JSON.
"""
import argparse
import random
import sqlite3
from datetime import date, datetime, timedelta
from pathlib import Path

PRENOMS = [
    "Camille", "Lucas", "Manon", "Hugo", "Chloé", "Léo", "Emma", "Nathan",
    "Julie", "Louis", "Sarah", "Adam", "Léa", "Enzo", "Inès", "Raphaël",
    "Zoé", "Mathis", "Jade", "Noah", "Lina", "Gabriel", "Anna", "Tom",
    "Nora", "Arthur", "Sofia", "Paul", "Louise", "Marius",
]
NOMS = [
    "Martin", "Bernard", "Dubois", "Thomas", "Robert", "Petit", "Durand",
    "Leroy", "Moreau", "Simon", "Laurent", "Lefebvre", "Michel", "Garcia",
    "David", "Bertrand", "Roux", "Vincent", "Fontaine", "Chevalier",
]
RAISONS_SOCIALES = [
    "Solutions", "Groupe", "Industries", "Services", "Consulting",
    "Distribution", "Logistique", "Bâtiment", "Technologies", "Partners",
]
DISCIPLINES = [
    "Bureautique", "Management", "Sécurité", "Langues", "Informatique",
    "RH", "Finance", "Commercial", "Marketing", "Développement personnel",
]
SESSION_NAMES = [
    "Excel Perfectionnement", "PowerPoint Avancé", "Management d'équipe",
    "Gestion de projet", "Communication interpersonnelle",
    "Anglais professionnel", "SST - Sauveteur Secouriste du Travail",
    "Habilitation électrique", "CACES R489", "Prise de parole en public",
    "Excel VBA", "Négociation commerciale", "Comptabilité générale",
    "Paie et administration RH", "Cybersécurité - Sensibilisation",
    "Python pour l'analyse de données", "Marketing digital",
]
VILLES = [
    "Paris", "Lyon", "Marseille", "Toulouse", "Nantes", "Lille", "Bordeaux",
    "Strasbourg", "Rennes", "Montpellier",
]
SALLES = ["Salle A", "Salle B", "Salle C", "Salle Visio", "Salle D"]

TODAY = date(2026, 8, 14)
ENTITY_ID = "E00000361"
ENTITY_NAME = "DEMO"


def iso(d, rng):
    """Convertit une date en timestamp ISO avec heure aléatoire, comme l'API réelle."""
    h, m, s = rng.randint(8, 18), rng.randint(0, 59), rng.randint(0, 59)
    return datetime(d.year, d.month, d.day, h, m, s).isoformat()


def rand_date(rng, start: date, end: date) -> date:
    if end <= start:
        return start
    return start + timedelta(days=rng.randint(0, (end - start).days))


def seq_id(prefix, n, width=8):
    return f"{prefix}{n:0{width}d}"


def build(conn: sqlite3.Connection, rng: random.Random):
    cur = conn.cursor()
    cur.execute("INSERT INTO entity VALUES (?,?)", (ENTITY_ID, ENTITY_NAME))

    # --- Companies -------------------------------------------------------
    companies = []
    for i in range(30):
        raison = f"{rng.choice(NOMS)} {rng.choice(RAISONS_SOCIALES)}"
        created = rand_date(rng, TODAY - timedelta(days=1000), TODAY)
        companies.append((
            seq_id("C", 61000 + i), ENTITY_ID, raison,
            f"{rng.randint(100000000,999999999):09d}00010",
            f"{rng.randint(1,150)} rue de la République", rng.choice(VILLES),
            f"{rng.randint(10000,95999):05d}", f"contact@{raison.lower().replace(' ','')}.fr",
            f"0{rng.randint(100000000,999999999)}", iso(created, rng), None,
        ))
    cur.executemany("INSERT INTO company VALUES (?,?,?,?,?,?,?,?,?,?,?)", companies)

    # --- Customers : flux régulier de nouveaux chaque mois sur 24 mois ---
    customers = []
    customer_id = 0
    start_history = TODAY - timedelta(days=730)
    month_cursor = date(start_history.year, start_history.month, 1)
    while month_cursor <= TODAY:
        max_day = TODAY.day if (month_cursor.year, month_cursor.month) == (TODAY.year, TODAY.month) else 28
        for _ in range(rng.randint(1, 4)):
            d = date(month_cursor.year, month_cursor.month, rng.randint(1, max_day))
            company = rng.choice(companies)
            customers.append((
                seq_id("C", 112000 + customer_id), ENTITY_ID, company[0], company[2],
                "company", 1 if rng.random() < 0.15 else 0, 1 if rng.random() < 0.1 else 0,
                rng.choice(["active", "active", "active", "inactive"]),
                company[7], company[5], None, iso(d, rng), None,
            ))
            customer_id += 1
        month_cursor = date(month_cursor.year + 1, 1, 1) if month_cursor.month == 12 \
            else date(month_cursor.year, month_cursor.month + 1, 1)
    cur.executemany("INSERT INTO customer VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", customers)

    # --- Actors : formateurs (fixe) + chargés de compte + stagiaires -----
    actors = []
    trainers = []
    for i in range(12):
        d = rand_date(rng, TODAY - timedelta(days=1500), TODAY - timedelta(days=200))
        prenom, nom = rng.choice(PRENOMS), rng.choice(NOMS)
        a = (
            seq_id("A", 118400 + i), ENTITY_ID, None, rng.choice(["M.", "Mme"]),
            prenom, nom, f"{nom} {prenom}", f"{prenom.lower()}.{nom.lower()}@demo-mcdf.fr",
            f"06{rng.randint(10000000,99999999)}", 0, 1, 0, 0, 0, 1, 0,
            iso(d, rng), None,
        )
        actors.append(a)
        trainers.append(a)

    account_managers = []
    for i in range(4):
        d = rand_date(rng, TODAY - timedelta(days=1500), TODAY - timedelta(days=400))
        prenom, nom = rng.choice(PRENOMS), rng.choice(NOMS)
        a = (
            seq_id("A", 118500 + i), ENTITY_ID, None, rng.choice(["M.", "Mme"]),
            prenom, nom, f"{nom} {prenom}", f"{prenom.lower()}.{nom.lower()}@demo-mcdf.fr",
            f"06{rng.randint(10000000,99999999)}", 0, 0, 0, 1, 0, 1, 0,
            iso(d, rng), None,
        )
        actors.append(a)
        account_managers.append(a)

    attendee_actors = []
    for i in range(400):
        company = rng.choice(companies)
        d = rand_date(rng, datetime.fromisoformat(company[9]).date(), TODAY)
        prenom, nom = rng.choice(PRENOMS), rng.choice(NOMS)
        a = (
            seq_id("A", 200000 + i), ENTITY_ID, company[0], rng.choice(["M.", "Mme"]),
            prenom, nom, f"{nom} {prenom}", f"{prenom.lower()}.{nom.lower()}{i}@example.com",
            f"06{rng.randint(10000000,99999999)}", 1, 0, 0, 0, 0, 1, 0,
            iso(d, rng), None,
        )
        actors.append(a)
        attendee_actors.append(a)
    cur.executemany("INSERT INTO actor VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", actors)

    # --- Sessions : réparties sur 24 mois -----------------------------
    sessions = []
    d = start_history
    session_i = 0
    while d <= TODAY + timedelta(days=45):
        if rng.random() < 0.35:
            trainer = rng.choice(trainers)
            days_n = rng.choice([1, 2, 3])
            end = d + timedelta(days=days_n - 1)
            number_maxi = rng.choice([6, 8, 10, 12])
            number_mini = max(2, number_maxi - rng.choice([2, 4, 6]))
            sessions.append((
                seq_id("S", 33600 + session_i), ENTITY_ID, rng.choice(SESSION_NAMES),
                seq_id("AC", session_i, width=5), rng.choice(DISCIPLINES),
                trainer[0], trainer[6], rng.choice(SALLES),
                d.isoformat(), end.isoformat(), days_n * 7, days_n,
                700, 100, number_mini, number_maxi,
                0 if end < TODAY else 1, 1, iso(d - timedelta(days=rng.randint(5, 40)), rng), None,
            ))
            session_i += 1
        d += timedelta(days=1)
    cur.executemany("INSERT INTO session VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", sessions)

    # --- Conventions (devis + dossiers) ----------------------------------
    conventions = []
    conv_i = 0
    for cust in customers:
        for _ in range(rng.randint(1, 3)):
            cust_created = datetime.fromisoformat(cust[11]).date()
            provisional = min(cust_created + timedelta(days=rng.randint(0, 550)), TODAY)
            age = (TODAY - provisional).days
            if age < 10:
                is_convention, signing_date, status = 0, None, "en_attente"
            else:
                r = rng.random()
                if r < 0.55:
                    is_convention = 1
                    signing_date = iso(provisional + timedelta(days=rng.randint(1, 20)), rng)
                    status = "signe"
                elif r < 0.75:
                    is_convention, signing_date, status = 0, None, "refuse"
                elif r < 0.9:
                    is_convention, signing_date, status = 0, None, "expire"
                else:
                    is_convention, signing_date, status = 0, None, "en_attente"
            start = provisional + timedelta(days=rng.randint(5, 30))
            manager = rng.choice(account_managers)
            conventions.append((
                seq_id("C", 20300 + conv_i), ENTITY_ID,
                f"Formation {rng.choice(SESSION_NAMES)} — {cust[2]}",
                seq_id("C", 20300 + conv_i), seq_id("PR", conv_i, width=5),
                cust[0], manager[0], 1, is_convention, status, status,
                iso(provisional, rng), signing_date,
                start.isoformat(), (start + timedelta(days=rng.choice([1, 2, 3]))).isoformat(),
                rng.choice([7, 14, 21]), 1 if is_convention and rng.random() > 0.2 else 0,
                rng.choice([7, 14, 21]) if is_convention else 0,
                iso(provisional, rng), None,
            ))
            conv_i += 1
    cur.executemany(
        "INSERT INTO convention VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", conventions)

    # --- Convention attendees (inscriptions) ------------------------------
    dossiers = [c for c in conventions if c[8] == 1]  # is_convention=1
    attendees = []
    att_i = 0
    for conv in dossiers:
        nb = rng.randint(1, 8)
        session_pool = [s for s in sessions if s[8] <= conv[13]] or sessions  # sessions démarrées avant la fin du dossier
        session = rng.choice(session_pool) if session_pool else None
        for _ in range(nb):
            actor = rng.choice(attendee_actors)
            provisional = datetime.fromisoformat(conv[11]).date()
            created = min(provisional + timedelta(days=rng.randint(0, 20)), TODAY)
            attendees.append((
                seq_id("CA", 75400 + att_i), ENTITY_ID, conv[0], actor[0],
                session[0] if session else None, iso(created, rng),
            ))
            att_i += 1
    cur.executemany("INSERT INTO convention_attendee VALUES (?,?,?,?,?,?)", attendees)

    # --- Invoices ----------------------------------------------------------
    customer_name_by_id = {c[0]: c[3] for c in customers}
    invoices = []
    inv_i = 0
    for conv in dossiers:
        if not conv[16]:  # invoiced flag
            continue
        for _ in range(rng.randint(1, 2)):
            provisional = datetime.fromisoformat(conv[11]).date()
            billing = min(provisional + timedelta(days=rng.randint(15, 90)), TODAY)
            amount = round(rng.uniform(800, 9000), 2)
            age = (TODAY - billing).days
            status = "payee" if age > 45 or rng.random() > 0.15 else ("retard" if age > 30 else "en_attente")
            invoices.append((
                f"F{inv_i+1:05d}", ENTITY_ID, conv[0], customer_name_by_id.get(conv[5], ""),
                amount, round(amount * 1.2, 2), 0.0 if status == "payee" else round(amount * 1.2, 2),
                billing.isoformat(), billing.isoformat() if status == "payee" else None,
                status, iso(billing, rng), None,
            ))
            inv_i += 1
    cur.executemany("INSERT INTO invoice VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", invoices)

    conn.commit()
    print(f"Companies: {len(companies)} | Customers: {len(customers)} | "
          f"Actors: {len(actors)} (dont {len(trainers)} formateurs) | "
          f"Sessions: {len(sessions)} | Conventions: {len(conventions)} "
          f"(dont {len(dossiers)} dossiers) | Inscriptions: {len(attendees)} | "
          f"Factures: {len(invoices)}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", default="mcdf.db")
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    db_path = Path(__file__).parent / args.db
    if db_path.exists():
        db_path.unlink()

    conn = sqlite3.connect(db_path)
    conn.executescript((Path(__file__).parent / "schema.sql").read_text())

    build(conn, random.Random(args.seed))
    conn.close()
    print(f"Base générée : {db_path}")


if __name__ == "__main__":
    main()
