"""Génère un jeu de données réaliste pour le prototype MCDF (SQLite).

Usage:
    python3 seed.py [--db mcdf.db] [--seed 42]

Ne dépend d'aucune librairie externe (pas de faker) pour rester exécutable
sans installation. Les volumes et la répartition dans le temps sont choisis
pour produire des restitutions crédibles (nouveaux clients, remplissage des
sessions, etc.).
"""
import argparse
import random
import sqlite3
from datetime import date, timedelta
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
SECTEURS = [
    "Industrie", "BTP", "Commerce", "Santé", "Transport", "Informatique",
    "Banque/Assurance", "Hôtellerie-Restauration", "Public", "Logistique",
]
VILLES = [
    "Paris", "Lyon", "Marseille", "Toulouse", "Nantes", "Lille", "Bordeaux",
    "Strasbourg", "Rennes", "Montpellier",
]
RAISONS_SOCIALES = [
    "Solutions", "Groupe", "Industries", "Services", "Consulting",
    "Distribution", "Logistique", "Bâtiment", "Technologies", "Partners",
]
FORMATIONS = [
    ("Excel Perfectionnement", "Bureautique", 14),
    ("Excel Initiation", "Bureautique", 14),
    ("PowerPoint Avancé", "Bureautique", 7),
    ("Management d'équipe", "Management", 21),
    ("Gestion de projet", "Management", 21),
    ("Communication interpersonnelle", "Développement personnel", 14),
    ("Anglais professionnel", "Langues", 30),
    ("SST - Sauveteur Secouriste du Travail", "Sécurité", 14),
    ("Habilitation électrique", "Sécurité", 21),
    ("CACES R489", "Sécurité", 21),
    ("Prise de parole en public", "Développement personnel", 7),
    ("Excel VBA", "Bureautique", 14),
    ("Négociation commerciale", "Commercial", 14),
    ("Comptabilité générale", "Finance", 21),
    ("Paie et administration RH", "RH", 21),
    ("Cybersécurité - Sensibilisation", "Informatique", 7),
    ("Python pour l'analyse de données", "Informatique", 21),
    ("Marketing digital", "Marketing", 14),
    ("Gestion du stress", "Développement personnel", 7),
    ("Droit du travail", "RH", 14),
]
SPECIALITES = [
    "Bureautique", "Management", "Sécurité", "Langues", "Informatique",
    "RH", "Finance", "Commercial", "Marketing", "Développement personnel",
]
SALLES = ["Salle A", "Salle B", "Salle C", "Salle Visio", "Salle D"]

TODAY = date(2026, 8, 14)


def daterange_days(rng: random.Random, start: date, end: date):
    if end <= start:
        return start
    n = (end - start).days
    return start + timedelta(days=rng.randint(0, n))


def build(conn: sqlite3.Connection, rng: random.Random):
    cur = conn.cursor()

    # --- Formateurs ---------------------------------------------------
    formateurs = []
    for i in range(15):
        formateurs.append((
            i + 1, rng.choice(NOMS), rng.choice(PRENOMS),
            rng.choice(SPECIALITES), rng.choice([350, 400, 450, 500, 550, 600]),
        ))
    cur.executemany(
        "INSERT INTO formateurs VALUES (?,?,?,?,?)", formateurs)

    # --- Formations (catalogue) ---------------------------------------
    formations = [(i + 1, t, c, d) for i, (t, c, d) in enumerate(FORMATIONS)]
    cur.executemany("INSERT INTO formations VALUES (?,?,?,?)", formations)

    # --- Clients : 24 mois d'historique, avec un flux régulier de
    #     nouveaux clients chaque mois (utile pour le KPI "% nouveaux clients")
    clients = []
    client_id = 1
    start_history = TODAY - timedelta(days=730)
    month_cursor = date(start_history.year, start_history.month, 1)
    while month_cursor <= TODAY:
        nb_nouveaux_ce_mois = rng.randint(1, 4)
        max_day = 28
        if month_cursor.year == TODAY.year and month_cursor.month == TODAY.month:
            max_day = TODAY.day
        for _ in range(nb_nouveaux_ce_mois):
            nom = f"{rng.choice(NOMS)} {rng.choice(RAISONS_SOCIALES)}"
            day = rng.randint(1, max_day)
            d = date(month_cursor.year, month_cursor.month, day)
            clients.append((
                client_id, nom, rng.choice(SECTEURS), rng.choice(VILLES),
                d.isoformat(),
            ))
            client_id += 1
        # mois suivant
        if month_cursor.month == 12:
            month_cursor = date(month_cursor.year + 1, 1, 1)
        else:
            month_cursor = date(month_cursor.year, month_cursor.month + 1, 1)
    cur.executemany("INSERT INTO clients VALUES (?,?,?,?,?)", clients)

    # --- Sessions : réparties sur 24 mois, dont quelques-unes à venir ---
    sessions = []
    session_id = 1
    d = start_history
    while d <= TODAY + timedelta(days=45):
        if rng.random() < 0.35:  # ~ une session tous les ~3 jours en moyenne
            formation = rng.choice(formations)
            formateur = rng.choice(formateurs)
            duree_jours = max(1, formation[3] // 7)
            date_debut = d
            date_fin = d + timedelta(days=duree_jours - 1)
            capacite = rng.choice([6, 8, 10, 12])
            if date_fin < TODAY:
                statut = "realisee" if rng.random() > 0.05 else "annulee"
            elif date_debut <= TODAY <= date_fin:
                statut = "confirmee"
            else:
                statut = rng.choice(["planifiee", "confirmee"])
            sessions.append((
                session_id, formation[0], formateur[0],
                rng.choice(SALLES), date_debut.isoformat(), date_fin.isoformat(),
                capacite, statut,
            ))
            session_id += 1
        d += timedelta(days=1)
    cur.executemany("INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?)", sessions)

    # --- Stagiaires + inscriptions --------------------------------------
    stagiaires = []
    inscriptions = []
    stagiaire_id = 1
    inscription_id = 1
    for sess in sessions:
        (sid, _formation_id, _formateur_id, _salle, date_debut_s,
         date_fin_s, capacite, statut) = sess
        if statut == "annulee":
            continue
        date_debut = date.fromisoformat(date_debut_s)
        date_fin = date.fromisoformat(date_fin_s)
        # taux de remplissage variable, légèrement moins bon sur les sessions
        # les plus récentes / à venir (histoire réaliste à raconter au copilote)
        taux_cible = rng.uniform(0.4, 1.0)
        nb_inscrits = max(1, round(capacite * taux_cible))
        client = rng.choice(clients)
        for _ in range(nb_inscrits):
            date_creation_stagiaire = daterange_days(
                rng, date.fromisoformat(client[4]), min(date_debut, TODAY))
            stagiaires.append((
                stagiaire_id, client[0], rng.choice(NOMS), rng.choice(PRENOMS),
                f"stagiaire{stagiaire_id}@example.com",
                date_creation_stagiaire.isoformat(),
            ))
            date_inscription = daterange_days(
                rng, date.fromisoformat(client[4]), min(date_debut, TODAY))
            if date_fin < TODAY:
                statut_inscription = rng.choices(
                    ["present", "absent", "annule"], weights=[85, 10, 5])[0]
                note = (round(rng.uniform(3.0, 5.0), 1)
                        if statut_inscription == "present" and rng.random() > 0.15
                        else None)
            else:
                statut_inscription = "inscrit"
                note = None
            inscriptions.append((
                inscription_id, sid, stagiaire_id,
                date_inscription.isoformat(), statut_inscription, note,
            ))
            stagiaire_id += 1
            inscription_id += 1
    cur.executemany("INSERT INTO stagiaires VALUES (?,?,?,?,?,?)", stagiaires)
    cur.executemany(
        "INSERT INTO inscriptions VALUES (?,?,?,?,?,?)", inscriptions)

    # --- Devis -----------------------------------------------------------
    devis = []
    for i, c in enumerate(clients):
        nb_devis = rng.randint(1, 3)
        for _ in range(nb_devis):
            dc = daterange_days(rng, date.fromisoformat(c[4]), TODAY)
            montant = round(rng.uniform(800, 12000), 2)
            age_jours = (TODAY - dc).days
            if age_jours < 10:
                statut, dr = "en_attente", None
            else:
                statut = rng.choices(
                    ["signe", "refuse", "expire", "en_attente"],
                    weights=[55, 20, 15, 10])[0]
                dr = (dc + timedelta(days=rng.randint(1, 20))).isoformat() \
                    if statut != "en_attente" else None
            devis.append((
                len(devis) + 1, c[0], montant, dc.isoformat(), statut, dr,
            ))
    cur.executemany("INSERT INTO devis VALUES (?,?,?,?,?,?)", devis)

    # --- Factures (une par session réalisée, au client tiré parmi ses
    #     stagiaires inscrits) -------------------------------------------
    factures = []
    inscriptions_by_session = {}
    for ins in inscriptions:
        inscriptions_by_session.setdefault(ins[1], []).append(ins)
    stagiaire_client = {s[0]: s[1] for s in stagiaires}
    for sess in sessions:
        sid, formation_id, _f, _s, date_debut_s, date_fin_s, capacite, statut = sess
        if statut != "realisee":
            continue
        session_inscriptions = inscriptions_by_session.get(sid, [])
        if not session_inscriptions:
            continue
        client_ids = {stagiaire_client[i[2]] for i in session_inscriptions}
        prix_jour_moyen = 180
        duree = next(f[3] for f in formations if f[0] == formation_id) // 7
        for cid in client_ids:
            nb = sum(1 for i in session_inscriptions
                     if stagiaire_client[i[2]] == cid)
            montant = round(nb * duree * prix_jour_moyen, 2)
            date_emission = date.fromisoformat(date_fin_s) + timedelta(days=rng.randint(1, 5))
            age = (TODAY - date_emission).days
            if age < 0:
                continue
            statut_p = "payee" if age > 45 or rng.random() > 0.15 else (
                "retard" if age > 30 else "en_attente")
            factures.append((
                len(factures) + 1, cid, sid, montant, date_emission.isoformat(),
                statut_p,
            ))
    cur.executemany("INSERT INTO factures VALUES (?,?,?,?,?,?)", factures)

    # --- Conventions (une par session x client, corrélée aux factures) --
    conventions = []
    seen = set()
    for f in factures:
        _id, cid, sid, *_ = f
        key = (sid, cid)
        if key in seen:
            continue
        seen.add(key)
        r = rng.random()
        statut = "signee" if r > 0.15 else ("en_attente" if r > 0.05 else "absente")
        ds = None
        if statut == "signee":
            sess_fin = date.fromisoformat(
                next(s[5] for s in sessions if s[0] == sid))
            ds = (sess_fin - timedelta(days=rng.randint(1, 15))).isoformat()
        conventions.append((len(conventions) + 1, sid, cid, statut, ds))
    cur.executemany("INSERT INTO conventions VALUES (?,?,?,?,?)", conventions)

    conn.commit()
    print(f"Clients: {len(clients)} | Stagiaires: {len(stagiaires)} | "
          f"Sessions: {len(sessions)} | Inscriptions: {len(inscriptions)} | "
          f"Devis: {len(devis)} | Factures: {len(factures)} | "
          f"Conventions: {len(conventions)}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", default="mcdf.db")
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    db_path = Path(__file__).parent / args.db
    if db_path.exists():
        db_path.unlink()

    conn = sqlite3.connect(db_path)
    schema = (Path(__file__).parent / "schema.sql").read_text()
    conn.executescript(schema)

    rng = random.Random(args.seed)
    build(conn, rng)
    conn.close()
    print(f"Base générée : {db_path}")


if __name__ == "__main__":
    main()
