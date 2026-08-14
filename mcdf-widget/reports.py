"""Moteur de restitutions dynamiques pour le prototype MCDF.

Chaque fonction ci-dessous est une "restitution" paramétrable — c'est
exactement la brique qu'un copilote IA appellerait (function calling / tool
use) pour répondre à une question en langage naturel du type
"quel est le taux de nouveaux clients ce mois-ci ?" ou "montre-moi les 30
derniers stagiaires". Elles sont volontairement écrites comme des fonctions
Python pures (SQL + paramètres -> liste de dicts) pour pouvoir être exposées
telles quelles derrière une API REST plus tard.

Usage:
    python3 reports.py --db mcdf.db --out dashboard_data.json
"""
import argparse
import json
import sqlite3
from collections import OrderedDict
from datetime import date, timedelta
from pathlib import Path

TODAY = date(2026, 8, 14)


def _dict_factory(cursor, row):
    fields = [c[0] for c in cursor.description]
    return dict(zip(fields, row))


def _connect(db_path):
    conn = sqlite3.connect(db_path)
    conn.row_factory = _dict_factory
    return conn


def _last_n_months(n, ref=TODAY):
    months = []
    y, m = ref.year, ref.month
    for _ in range(n):
        months.append((y, m))
        m -= 1
        if m == 0:
            m = 12
            y -= 1
    return list(reversed(months))


# --------------------------------------------------------------------------
# 1. % de nouveaux clients par mois
# --------------------------------------------------------------------------
def pct_nouveaux_clients(conn, nb_mois=12):
    """Pour chaque mois : nb de clients actifs (au moins une inscription ce
    mois-là), nb de clients nouveaux (créés ce mois-là) parmi eux, et le %."""
    rows = []
    for y, m in _last_n_months(nb_mois):
        mois_debut = date(y, m, 1)
        mois_fin = (date(y + 1, 1, 1) if m == 12 else date(y, m + 1, 1)) - timedelta(days=1)

        actifs = conn.execute(
            """
            SELECT DISTINCT s.client_id
            FROM stagiaires s
            JOIN inscriptions i ON i.stagiaire_id = s.id
            WHERE i.date_inscription BETWEEN ? AND ?
            """,
            (mois_debut.isoformat(), mois_fin.isoformat()),
        ).fetchall()
        actifs_ids = {r["client_id"] for r in actifs}

        nouveaux = conn.execute(
            """
            SELECT id FROM clients
            WHERE date_creation BETWEEN ? AND ?
            """,
            (mois_debut.isoformat(), mois_fin.isoformat()),
        ).fetchall()
        nouveaux_ids = {r["id"] for r in nouveaux}

        nouveaux_actifs = actifs_ids & nouveaux_ids
        nb_actifs = len(actifs_ids)
        nb_nouveaux = len(nouveaux_actifs)
        pct = round(100 * nb_nouveaux / nb_actifs, 1) if nb_actifs else 0.0

        rows.append(OrderedDict(
            mois=f"{y}-{m:02d}",
            clients_actifs=nb_actifs,
            nouveaux_clients=nb_nouveaux,
            pourcentage_nouveaux=pct,
        ))
    return rows


# --------------------------------------------------------------------------
# 2. Derniers stagiaires inscrits
# --------------------------------------------------------------------------
def derniers_stagiaires(conn, n=30):
    rows = conn.execute(
        """
        SELECT
            st.nom, st.prenom, c.nom AS entreprise, f.titre AS formation,
            i.date_inscription, i.statut AS statut_inscription,
            se.date_debut AS date_session
        FROM inscriptions i
        JOIN stagiaires st ON st.id = i.stagiaire_id
        JOIN clients c ON c.id = st.client_id
        JOIN sessions se ON se.id = i.session_id
        JOIN formations f ON f.id = se.formation_id
        ORDER BY i.date_inscription DESC, i.id DESC
        LIMIT ?
        """,
        (n,),
    ).fetchall()
    return rows


# --------------------------------------------------------------------------
# 3. Taux de remplissage des sessions par mois
# --------------------------------------------------------------------------
def taux_remplissage(conn, nb_mois=6):
    rows = []
    for y, m in _last_n_months(nb_mois):
        mois_debut = date(y, m, 1)
        mois_fin = (date(y + 1, 1, 1) if m == 12 else date(y, m + 1, 1)) - timedelta(days=1)
        sessions = conn.execute(
            """
            SELECT se.id, se.capacite,
                   (SELECT COUNT(*) FROM inscriptions i
                    WHERE i.session_id = se.id AND i.statut != 'annule') AS nb_inscrits
            FROM sessions se
            WHERE se.date_debut BETWEEN ? AND ? AND se.statut != 'annulee'
            """,
            (mois_debut.isoformat(), mois_fin.isoformat()),
        ).fetchall()
        if not sessions:
            taux = 0.0
        else:
            taux = round(
                100 * sum(s["nb_inscrits"] for s in sessions)
                / sum(s["capacite"] for s in sessions), 1)
        rows.append(OrderedDict(
            mois=f"{y}-{m:02d}", nb_sessions=len(sessions), taux_remplissage=taux))
    return rows


# --------------------------------------------------------------------------
# 4. Chiffre d'affaires facturé par mois
# --------------------------------------------------------------------------
def ca_mensuel(conn, nb_mois=12):
    rows = []
    for y, m in _last_n_months(nb_mois):
        mois_debut = date(y, m, 1)
        mois_fin = (date(y + 1, 1, 1) if m == 12 else date(y, m + 1, 1)) - timedelta(days=1)
        total = conn.execute(
            """
            SELECT COALESCE(SUM(montant), 0) AS total
            FROM factures
            WHERE date_emission BETWEEN ? AND ?
            """,
            (mois_debut.isoformat(), mois_fin.isoformat()),
        ).fetchone()["total"]
        rows.append(OrderedDict(mois=f"{y}-{m:02d}", ca=round(total, 2)))
    return rows


# --------------------------------------------------------------------------
# 5. Devis en attente depuis plus de N jours (relance commerciale)
# --------------------------------------------------------------------------
def devis_a_relancer(conn, jours=10):
    rows = conn.execute(
        """
        SELECT d.id, c.nom AS client, d.montant, d.date_creation,
               CAST(julianday(?) - julianday(d.date_creation) AS INTEGER) AS age_jours
        FROM devis d
        JOIN clients c ON c.id = d.client_id
        WHERE d.statut = 'en_attente'
          AND julianday(?) - julianday(d.date_creation) >= ?
        ORDER BY age_jours DESC
        """,
        (TODAY.isoformat(), TODAY.isoformat(), jours),
    ).fetchall()
    return rows


# --------------------------------------------------------------------------
# 6. Top formateurs par CA généré
# --------------------------------------------------------------------------
def top_formateurs(conn, n=5):
    rows = conn.execute(
        """
        SELECT fo.nom, fo.prenom, fo.specialite,
               COUNT(DISTINCT se.id) AS nb_sessions,
               COALESCE(SUM(fa.montant), 0) AS ca_genere
        FROM formateurs fo
        JOIN sessions se ON se.formateur_id = fo.id
        LEFT JOIN factures fa ON fa.session_id = se.id
        GROUP BY fo.id
        ORDER BY ca_genere DESC
        LIMIT ?
        """,
        (n,),
    ).fetchall()
    return rows


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", default="mcdf.db")
    parser.add_argument("--out", default="dashboard_data.json")
    args = parser.parse_args()

    db_path = Path(__file__).parent / args.db
    conn = _connect(db_path)

    data = OrderedDict(
        generated_at=TODAY.isoformat(),
        pct_nouveaux_clients=pct_nouveaux_clients(conn, 12),
        derniers_stagiaires=derniers_stagiaires(conn, 30),
        taux_remplissage=taux_remplissage(conn, 6),
        ca_mensuel=ca_mensuel(conn, 12),
        devis_a_relancer=devis_a_relancer(conn, 10),
        top_formateurs=top_formateurs(conn, 5),
    )

    out_path = Path(__file__).parent / args.out
    out_path.write_text(json.dumps(data, ensure_ascii=False, indent=2))
    print(f"Restitutions exportées : {out_path}")
    conn.close()


if __name__ == "__main__":
    main()
