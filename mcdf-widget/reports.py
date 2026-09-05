"""Moteur de restitutions dynamiques pour le prototype MCDF v2.

Réécrit pour interroger le schéma calqué sur la vraie API MCDF
(entity/customer/company/actor/convention/conventionAttendee/invoice/
session — voir schema.sql). La logique de chaque restitution reflète
exactement celle de mcdf-widget/browser/live-reports.js, qui calcule les
mêmes indicateurs en direct sur l'API réelle : on peut ainsi comparer les
deux implémentations champ à champ.

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
# 1. Nouveaux clients par mois
#    (miroir de la section 1 de live-reports.js : customer.created par mois)
# --------------------------------------------------------------------------
def nouveaux_clients_par_mois(conn, nb_mois=12):
    rows = []
    for y, m in _last_n_months(nb_mois):
        mois_debut = date(y, m, 1)
        mois_fin = (date(y + 1, 1, 1) if m == 12 else date(y, m + 1, 1)) - timedelta(days=1)
        nb_nouveaux = conn.execute(
            "SELECT COUNT(*) AS n FROM customer WHERE substr(created,1,10) BETWEEN ? AND ?",
            (mois_debut.isoformat(), mois_fin.isoformat()),
        ).fetchone()["n"]
        rows.append(OrderedDict(mois=f"{y}-{m:02d}", nouveaux_clients=nb_nouveaux))
    return rows


# --------------------------------------------------------------------------
# 2. Derniers stagiaires inscrits
#    (miroir de la section 2 : conventionAttendee dédupliqué par actor_id,
#    on garde l'inscription la plus récente par personne)
# --------------------------------------------------------------------------
def derniers_stagiaires(conn, n=30):
    rows = conn.execute(
        """
        WITH latest AS (
            SELECT ca.*, ROW_NUMBER() OVER (
                PARTITION BY ca.actor_id ORDER BY ca.created DESC
            ) AS rn
            FROM convention_attendee ca
        )
        SELECT
            a.fullname AS nom, cv.name AS convention, s.name AS session,
            latest.created AS inscrit_le
        FROM latest
        JOIN actor a ON a.id = latest.actor_id
        JOIN convention cv ON cv.id = latest.convention_id
        LEFT JOIN session s ON s.id = latest.session_id
        WHERE latest.rn = 1
        ORDER BY latest.created DESC
        LIMIT ?
        """,
        (n,),
    ).fetchall()
    return rows


# --------------------------------------------------------------------------
# 3. Chiffre d'affaires facturé par mois
#    (miroir de la section 3 : invoice.amount par mois de billing_date)
# --------------------------------------------------------------------------
def ca_mensuel(conn, nb_mois=12):
    rows = []
    for y, m in _last_n_months(nb_mois):
        mois_debut = date(y, m, 1)
        mois_fin = (date(y + 1, 1, 1) if m == 12 else date(y, m + 1, 1)) - timedelta(days=1)
        total = conn.execute(
            "SELECT COALESCE(SUM(amount), 0) AS total FROM invoice "
            "WHERE billing_date BETWEEN ? AND ?",
            (mois_debut.isoformat(), mois_fin.isoformat()),
        ).fetchone()["total"]
        rows.append(OrderedDict(mois=f"{y}-{m:02d}", ca=round(total, 2)))
    return rows


# --------------------------------------------------------------------------
# 4. Devis à relancer (proposition sans signature, > N jours)
#    (miroir de la section 4 : convention.is_proposal sans signing_date)
# --------------------------------------------------------------------------
def devis_a_relancer(conn, jours=10):
    rows = conn.execute(
        """
        SELECT cv.id, cv.name, cv.proposal_code, cv.proposal_status,
               CAST(julianday(?) - julianday(substr(cv.provisional_date,1,10)) AS INTEGER) AS age_jours
        FROM convention cv
        WHERE cv.is_proposal = 1 AND cv.signing_date IS NULL
          AND julianday(?) - julianday(substr(cv.provisional_date,1,10)) > ?
        ORDER BY age_jours DESC
        """,
        (TODAY.isoformat(), TODAY.isoformat(), jours),
    ).fetchall()
    return rows


# --------------------------------------------------------------------------
# 5. Sessions avec capacité déclarée, par mois
#    (miroir de la section 5 : session.number_maxi par mois de start_date)
# --------------------------------------------------------------------------
def taux_remplissage(conn, nb_mois=6):
    rows = []
    for y, m in _last_n_months(nb_mois):
        mois_debut = date(y, m, 1)
        mois_fin = (date(y + 1, 1, 1) if m == 12 else date(y, m + 1, 1)) - timedelta(days=1)
        sessions = conn.execute(
            """
            SELECT s.id, s.number_maxi,
                   (SELECT COUNT(*) FROM convention_attendee ca WHERE ca.session_id = s.id) AS nb_inscrits
            FROM session s
            WHERE s.start_date BETWEEN ? AND ? AND s.number_maxi IS NOT NULL
              AND EXISTS (SELECT 1 FROM convention_attendee ca WHERE ca.session_id = s.id)
            """,
            (mois_debut.isoformat(), mois_fin.isoformat()),
        ).fetchall()
        if not sessions:
            taux = 0.0
        else:
            capacite = sum(s["number_maxi"] for s in sessions)
            taux = round(100 * sum(s["nb_inscrits"] for s in sessions) / capacite, 1) if capacite else 0.0
        rows.append(OrderedDict(
            mois=f"{y}-{m:02d}", nb_sessions=len(sessions), taux_remplissage=taux))
    return rows


# --------------------------------------------------------------------------
# 6. Top formateurs (par CA estimé : daily_rate x days sur les sessions)
#    (miroir de la section 6 de live-reports.js)
# --------------------------------------------------------------------------
def top_formateurs(conn, n=5):
    rows = conn.execute(
        """
        SELECT s.trainer_id, s.trainer_name AS nom,
               COUNT(*) AS nb_sessions,
               SUM(COALESCE(s.daily_rate, 0) * COALESCE(s.days, 0)) AS ca_estime
        FROM session s
        WHERE s.trainer_id IS NOT NULL
        GROUP BY s.trainer_id
        ORDER BY ca_estime DESC
        LIMIT ?
        """,
        (n,),
    ).fetchall()
    return rows


# --------------------------------------------------------------------------
# 7. Comparaison année en cours vs année précédente, à date égale (YTD)
#    (miroir de la section 7 de live-reports.js)
# --------------------------------------------------------------------------
def comparaison_annuelle(conn, ref=TODAY):
    year_n, year_n1 = ref.year, ref.year - 1

    def ytd_bounds(year):
        return date(year, 1, 1).isoformat(), date(year, ref.month, ref.day).isoformat()

    def ca_ytd(year):
        start, end = ytd_bounds(year)
        return conn.execute(
            "SELECT COALESCE(SUM(amount), 0) AS t FROM invoice WHERE billing_date BETWEEN ? AND ?",
            (start, end),
        ).fetchone()["t"]

    def clients_ytd(year):
        start, end = ytd_bounds(year)
        return conn.execute(
            "SELECT COUNT(*) AS n FROM customer WHERE substr(created,1,10) BETWEEN ? AND ?",
            (start, end),
        ).fetchone()["n"]

    def stagiaires_ytd(year):
        start, end = ytd_bounds(year)
        return conn.execute(
            "SELECT COUNT(DISTINCT actor_id) AS n FROM convention_attendee "
            "WHERE substr(created,1,10) BETWEEN ? AND ?",
            (start, end),
        ).fetchone()["n"]

    def devis_signes_ytd(year):
        start, end = ytd_bounds(year)
        return conn.execute(
            "SELECT COUNT(*) AS n FROM convention WHERE is_proposal = 1 "
            "AND signing_date IS NOT NULL AND substr(signing_date,1,10) BETWEEN ? AND ?",
            (start, end),
        ).fetchone()["n"]

    def pct_delta(cur, prev):
        if not prev:
            return None  # pas de base de comparaison (division par zéro évitée, JSON-safe)
        return round((cur - prev) / prev * 100, 1)

    metrics = [
        ("CA facturé (HT)", round(ca_ytd(year_n), 2), round(ca_ytd(year_n1), 2)),
        ("Nouveaux clients", clients_ytd(year_n), clients_ytd(year_n1)),
        ("Stagiaires inscrits", stagiaires_ytd(year_n), stagiaires_ytd(year_n1)),
        ("Devis signés", devis_signes_ytd(year_n), devis_signes_ytd(year_n1)),
    ]
    return [
        OrderedDict(
            indicateur=nom, annee_courante=cur, annee_precedente=prev,
            delta_pct=pct_delta(cur, prev),
        )
        for nom, cur, prev in metrics
    ]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", default="mcdf.db")
    parser.add_argument("--out", default="dashboard_data.json")
    args = parser.parse_args()

    conn = _connect(Path(__file__).parent / args.db)

    data = OrderedDict(
        generated_at=TODAY.isoformat(),
        nouveaux_clients_par_mois=nouveaux_clients_par_mois(conn, 12),
        derniers_stagiaires=derniers_stagiaires(conn, 30),
        ca_mensuel=ca_mensuel(conn, 12),
        devis_a_relancer=devis_a_relancer(conn, 10),
        taux_remplissage=taux_remplissage(conn, 6),
        top_formateurs=top_formateurs(conn, 5),
        comparaison_annuelle=comparaison_annuelle(conn),
    )

    out_path = Path(__file__).parent / args.out
    out_path.write_text(json.dumps(data, ensure_ascii=False, indent=2))
    print(f"Restitutions exportées : {out_path}")
    conn.close()


if __name__ == "__main__":
    main()
