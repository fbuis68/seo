# Installation sur un serveur (Ubuntu 22.04 / 24.04)

Prérequis : un serveur Linux (2 vCPU, 4 Go RAM minimum, hébergé dans l'UE), un nom de domaine
(ex. `app.exemple.fr`) dont l'enregistrement DNS A pointe vers l'IP du serveur, et un compte Stripe.

## 1. Préparer le serveur

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y git ca-certificates curl ufw

# Docker + Compose (dépôt officiel)
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER && newgrp docker

# Pare-feu : SSH + HTTP/HTTPS uniquement
sudo ufw allow OpenSSH && sudo ufw allow 80,443/tcp && sudo ufw --force enable
```

## 2. Récupérer le code

```bash
sudo mkdir -p /opt/tms && sudo chown $USER /opt/tms
git clone -b claude/optimize-wordpress-seo-S9DUU https://github.com/fbuis68/seo.git /opt/tms/src
cd /opt/tms/src/tms
```

Dépôt privé : utilisez un jeton d'accès GitHub (`https://<jeton>@github.com/...`) ou une clé SSH de déploiement.

## 3. Configurer

```bash
cp .env.example .env
# Générer les secrets
sed -i "s|^SECRET_KEY=.*|SECRET_KEY=$(openssl rand -base64 32)|" .env
sed -i "s|^DB_OWNER_PASSWORD=.*|DB_OWNER_PASSWORD=$(openssl rand -hex 24)|" .env
sed -i "s|^DB_APP_PASSWORD=.*|DB_APP_PASSWORD=$(openssl rand -hex 24)|" .env
nano .env
```

À renseigner dans `.env` :

| Variable | Valeur |
|----------|--------|
| `PUBLIC_API_URL`, `APP_URL` | `https://app.exemple.fr` |
| `PUBLIC_ORIGINS` | domaines du site WordPress, ex. `https://www.sesame-technology.fr,https://sesame-technology.fr` |
| `STRIPE_SECRET_KEY` | `sk_test_…` pour un essai, `sk_live_…` en production |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` (étape 5) |
| `STRIPE_PRICE_*` | identifiants `price_…` créés dans Stripe (étape 5) |
| `SYSTEM_SMTP_URL` | ex. `smtps://utilisateur:motdepasse@smtp.fournisseur.eu:465` (emails de vérification) |
| `SYSTEM_MAIL_FROM` | `Sesame Formation <no-reply@exemple.fr>` |

Sans `SECRET_KEY` ni clés Stripe, l'API refuse de démarrer en production (comportement voulu).
Sans `SYSTEM_SMTP_URL`, les emails de vérification ne partent pas : ils sont seulement écrits dans les journaux.

## 4. Lancer

```bash
docker compose up -d --build
docker compose ps                  # db, api, worker, web : « running »
docker compose logs -f api         # attendre « API prête »
curl -s http://127.0.0.1:8080/api/v1/public/catalog | head -c 200
```

Les migrations de base de données s'exécutent automatiquement au démarrage de l'API.

## 5. HTTPS (Caddy) et Stripe

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy

sudo tee /etc/caddy/Caddyfile >/dev/null <<'EOF'
app.exemple.fr {
    encode gzip
    request_body { max_size 1100MB }
    reverse_proxy 127.0.0.1:8080
}
EOF
sudo systemctl reload caddy        # certificat Let's Encrypt obtenu automatiquement
```

Dans le tableau de bord Stripe :
1. **Produits** : créer Solo, Equipe, Centre (prix mensuel et annuel = 10 mensualités), « Banque connectée »
   et « Réception email » (mensuels), « Pack 20 signatures » (paiement unique). Copier chaque `price_…` dans `.env`.
2. **Webhooks** : endpoint `https://app.exemple.fr/api/v1/webhooks/payment`, événements
   `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`,
   `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`. Copier le `whsec_…`.
3. **Portail client** : l'activer (factures et moyen de paiement).

Puis : `docker compose up -d` pour appliquer le `.env`.

## 6. Brancher le site web (HTML)

Modèle prêt à l'emploi : `embed/tarifs.html` (bloc à coller, contenu de secours indexable, données
structurées schema.org, suivi des inscriptions). Le strict minimum à coller dans votre page :

```html
<div data-tms-widget data-api="https://app.exemple.fr" data-show="pricing,modules,signup"></div>
<script src="https://app.exemple.fr/embed/v1/tms-embed.js" defer></script>
```

* Le domaine du site doit figurer dans `PUBLIC_ORIGINS` (sinon le widget affiche « offres indisponibles »).
* Si votre site envoie un en-tête Content-Security-Policy, autoriser `https://app.exemple.fr`
  dans `script-src` et `connect-src`.
* Variantes : `data-show="pricing"` (grille seule), `data-plan="equipe"` (offre présélectionnée),
  `data-interval="year"`, `data-accent="#0e2a47"` (couleur), `data-theme="light"`.

Si le site vitrine est hébergé sur le même serveur, Caddy peut le servir aussi. Copier les fichiers
du site dans `/var/www/site`, puis ajouter à `/etc/caddy/Caddyfile` :

```
www.exemple.fr, exemple.fr {
    root * /var/www/site
    file_server
    encode gzip
}
```

et recharger : `sudo systemctl reload caddy`.

(L'extension `wordpress-plugin/` reste disponible si un site WordPress est utilisé un jour.)

## 7. Sauvegardes et mises à jour

```bash
# Sauvegarde quotidienne (base + documents), à planifier avec cron
mkdir -p /opt/tms/backups
docker compose exec -T db pg_dump -U tms_owner -Fc tms > /opt/tms/backups/tms-$(date +%F).dump
docker run --rm -v tms_storage:/data -v /opt/tms/backups:/b alpine tar czf /b/storage-$(date +%F).tgz -C /data .

# Mise à jour
cd /opt/tms/src && git pull && cd tms && docker compose up -d --build
```

Copiez les sauvegardes hors du serveur (stockage objet UE) et testez une restauration.
