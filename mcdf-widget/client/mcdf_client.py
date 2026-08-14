"""Client HTTP pour l'API MCDF (Mon Centre De Formation / Serigest Premium).

Reverse-engineered à partir d'une capture réseau réelle (DevTools) sur
https://portal.moncentredeformation.fr :

    GET /wa/accountManager/list?activated=1&nopaging=1&_up=E00000305
        &_dc=1786716777884&page=1&start=0&limit=25
    -> {"success": true, "root": [ {...}, ... ]}

Le format de réponse ({success, root}) est celui d'un JSON reader Ext JS
(Sencha), qui est le framework front-end de MCDF. Chaque entité métier
(session, actor, convention/dossier, invoice, customer...) est exposée
sous le même schéma d'URL générique : /wa/{entite}/list.

CE QUI RESTE À CONFIRMER (voir TODO) :
- L'endpoint et le format exacts du login (probablement un POST classique
  sur /login.html plutôt qu'un appel XHR JSON — à vérifier).
- Le rôle exact du paramètre `_up` (vu dans la capture réelle : "_up=E00000305").
- Les noms d'entités pour les objets de gestion de formation (le nom
  `accountManager` est confirmé ; `session`, `convention`/`dossier`,
  `actor`/`participant`, `invoice`/`facture` sont déduits de
  controller-beans.xml mais pas encore vérifiés par une capture réseau).
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any

import requests


class MCDFAuthError(RuntimeError):
    """Levée quand l'authentification échoue ou n'a pas encore été faite."""


@dataclass
class MCDFClient:
    base_url: str = "https://portal.moncentredeformation.fr"
    session: requests.Session = field(default_factory=requests.Session)
    _up: str | None = None  # identifiant de profil/utilisateur courant, vu dans les captures

    # ------------------------------------------------------------------
    # Authentification
    # ------------------------------------------------------------------
    def login(self, email: str, password: str) -> None:
        """Authentifie la session.

        TODO: implémentation provisoire — à ajuster une fois la vraie
        requête de login capturée (DevTools, filtre "All", après un
        "Déconnexion" puis reconnexion). Deux hypothèses possibles :

        1. Formulaire classique (POST application/x-www-form-urlencoded
           vers /login.html, avec redirection) :

               self.session.post(f"{self.base_url}/login.html", data={
                   "email": email, "password": password,
               })

        2. Endpoint JSON généré par le même mécanisme que /wa/{entite}/list
           (vu le bean `loginController` avec commande `checkLogin` dans
           controller-beans.xml) :

               resp = self.session.post(f"{self.base_url}/wa/login/checkLogin", json={
                   "email": email, "password": password,
               })

        Une fois la vraie requête connue, remplacer le corps de cette
        méthode en conséquence. Le `requests.Session()` conserve
        automatiquement le cookie de session entre les appels suivants.
        """
        raise NotImplementedError(
            "Login non implémenté : capture réseau du vrai formulaire de "
            "connexion nécessaire (voir TODO dans login())."
        )

    # ------------------------------------------------------------------
    # Lecture générique — pattern confirmé par capture réseau réelle
    # ------------------------------------------------------------------
    def list_entity(
        self,
        entity: str,
        *,
        page: int = 1,
        start: int = 0,
        limit: int = 25,
        nopaging: bool = False,
        **filters: Any,
    ) -> list[dict]:
        """Récupère une liste d'enregistrements pour une entité MCDF.

        `entity` est le nom déclaré côté serveur (ex: "accountManager",
        "session", "convention", "actor"...) — voir la liste complète des
        noms enregistrés dans `chiefOrchester` (controller-beans.xml).

        `filters` est transmis tel quel en paramètres de requête : les
        clés correspondent aux propriétés des interceptors Spring
        (ex: activated=1, status="CURRENT", entityId=...).
        """
        params = {
            "page": page,
            "start": start,
            "limit": limit,
            "_dc": int(time.time() * 1000),
            **({"nopaging": 1} if nopaging else {}),
            **filters,
        }
        if self._up:
            params["_up"] = self._up

        resp = self.session.get(f"{self.base_url}/wa/{entity}/list", params=params)
        resp.raise_for_status()
        data = resp.json()
        if not data.get("success"):
            raise RuntimeError(f"Appel /wa/{entity}/list refusé : {data}")
        return data.get("root", [])

    def get_item(self, entity: str, item_id: str) -> dict:
        """Récupère un enregistrement unique par id (pattern `item?id=...`)."""
        params = {"id": item_id, "_dc": int(time.time() * 1000)}
        resp = self.session.get(f"{self.base_url}/wa/{entity}/item", params=params)
        resp.raise_for_status()
        data = resp.json()
        if not data.get("success"):
            raise RuntimeError(f"Appel /wa/{entity}/item refusé : {data}")
        return data.get("data", data.get("root"))


if __name__ == "__main__":
    client = MCDFClient()
    # client.login("email@example.com", "motdepasse")  # TODO une fois confirmé
    # sessions = client.list_entity("session", activated=1, nopaging=True)
    # print(sessions[:3])
