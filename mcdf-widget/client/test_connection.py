"""Script de test manuel pour mcdf_client.py — à lancer en local.

Ne contient aucun identifiant en dur : passe-les par variables
d'environnement pour éviter de les laisser trainer dans un fichier.

Usage :
    MCDF_EMAIL="toi@example.com" MCDF_PASSWORD="..." python3 test_connection.py

Optionnel : MCDF_BASE_URL pour cibler une autre instance que
https://portal.moncentredeformation.fr (valeur par défaut).

Teste successivement :
1. Le login.
2. Une liste sur "accountManager" (entité confirmée par capture réseau).
3. Une liste sur quelques noms d'entités candidats pour la gestion de
   formation (session, dossier, convention, actor, participant...) —
   certains vont probablement échouer avec un message clair (403/404 ou
   {"success": false}), ce qui nous dira lesquels sont les bons noms.
"""
import os
import sys

from mcdf_client import MCDFAuthError, MCDFClient

CANDIDATE_ENTITIES = [
    "session",
    "dossier",
    "convention",
    "actor",
    "participant",
    "customer",
    "company",
    "invoice",
]


def main() -> None:
    email = os.environ.get("MCDF_EMAIL")
    password = os.environ.get("MCDF_PASSWORD")
    base_url = os.environ.get("MCDF_BASE_URL", "https://portal.moncentredeformation.fr")

    if not email or not password:
        print("Définis MCDF_EMAIL et MCDF_PASSWORD dans l'environnement avant de lancer ce script.")
        sys.exit(1)

    client = MCDFClient(base_url=base_url)

    print(f"→ Connexion à {base_url} en tant que {email}...")
    try:
        client.login(email, password)
        print("✓ Login réussi.\n")
    except MCDFAuthError as exc:
        print(f"✗ Échec du login : {exc}")
        sys.exit(1)

    print("→ Test sur l'entité confirmée 'accountManager'...")
    try:
        rows = client.list_entity("accountManager", activated=1, nopaging=True)
        print(f"✓ {len(rows)} enregistrement(s). Premier : {rows[0] if rows else '(vide)'}\n")
    except Exception as exc:
        print(f"✗ Échec : {exc}\n")

    print("→ Test des noms d'entités candidats pour la gestion de formation :")
    for entity in CANDIDATE_ENTITIES:
        try:
            rows = client.list_entity(entity, nopaging=True, limit=3)
            fields = sorted(rows[0].keys()) if rows else []
            print(f"  ✓ {entity:15s} → {len(rows)} résultat(s). Champs : {fields}")
        except Exception as exc:
            print(f"  ✗ {entity:15s} → {exc}")


if __name__ == "__main__":
    main()
