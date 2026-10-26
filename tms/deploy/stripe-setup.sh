#!/usr/bin/env bash
# Crée dans Stripe les produits, prix et le webhook attendus par l'application, puis écrit
# les identifiants dans .env. Relançable sans doublon (prix repérés par lookup_key, webhook par URL).
#
#   cd /opt/tms/src/tms && bash deploy/stripe-setup.sh            # utilise STRIPE_SECRET_KEY et APP_DOMAIN du .env
#
# Mode test (sk_test_…) puis mode live (sk_live_…) : relancer après avoir changé la clé dans .env.
set -euo pipefail
cd "$(dirname "$0")/.."
ENV_FILE=.env
get() { grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2-; }
KEY="${STRIPE_SECRET_KEY:-$(get STRIPE_SECRET_KEY)}"
DOMAIN="$(get APP_DOMAIN)"
[[ "$KEY" == sk_* ]] || { echo "STRIPE_SECRET_KEY absente ou invalide dans $ENV_FILE (sk_test_… ou sk_live_…)"; exit 1; }
[[ -n "$DOMAIN" ]] || { echo "APP_DOMAIN absent de $ENV_FILE"; exit 1; }
MODE=$([[ "$KEY" == sk_live_* ]] && echo live || echo test)
echo "Stripe en mode $MODE — domaine $DOMAIN"
cp "$ENV_FILE" "$ENV_FILE.avant-stripe"

api() { curl -sS -u "$KEY:" "$@"; }
json() { python3 -c "import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1]))" "$1"; }
setenv() {
  if grep -qE "^$1=" "$ENV_FILE"; then sed -i "s|^$1=.*|$1=$2|" "$ENV_FILE"; else echo "$1=$2" >> "$ENV_FILE"; fi
}

# price <VAR .env> <lookup_key> <nom produit> <montant centimes> <month|year|once>
declare -A PRODUCTS=()
price() {
  local var=$1 lookup=$2 name=$3 amount=$4 interval=$5
  local id found
  found=$(api -G https://api.stripe.com/v1/prices --data-urlencode "lookup_keys[]=$lookup" -d active=true | json "(d['data'][0]['id']+' '+d['data'][0]['product']) if d.get('data') else ('ERR '+d['error']['message'] if 'error' in d else '')")
  [[ "$found" == ERR* ]] && { echo "Erreur Stripe : ${found#ERR }"; exit 1; }
  id=${found%% *}
  [[ -n "$id" ]] && PRODUCTS[$name]=${found#* }
  if [[ -z "$id" ]]; then
    local prod="${PRODUCTS[$name]:-}"
    if [[ -z "$prod" ]]; then
      prod=$(api https://api.stripe.com/v1/products -d "name=$name" -d "metadata[app]=tms" | json "d.get('id') or d['error']['message']")
      [[ "$prod" == prod_* ]] || { echo "Erreur produit $name : $prod"; exit 1; }
      PRODUCTS[$name]=$prod
    fi
    local args=(-d product="$prod" -d currency=eur -d unit_amount="$amount" -d tax_behavior=exclusive -d lookup_key="$lookup" -d transfer_lookup_key=true)
    [[ "$interval" != once ]] && args+=(-d "recurring[interval]=$interval")
    id=$(api https://api.stripe.com/v1/prices "${args[@]}" | json "d.get('id') or d['error']['message']")
    [[ "$id" == price_* ]] || { echo "Erreur prix $lookup : $id"; exit 1; }
    echo "  créé    $var = $id ($name, $((amount / 100)) €, $interval)"
  else
    echo "  existant $var = $id"
  fi
  setenv "$var" "$id"
}

echo "Produits et prix (HT) :"
price STRIPE_PRICE_SOLO_MONTH    tms_solo_month    "TMS Solo"   3900   month
price STRIPE_PRICE_SOLO_YEAR     tms_solo_year     "TMS Solo"   39000  year
price STRIPE_PRICE_EQUIPE_MONTH  tms_equipe_month  "TMS Equipe" 8900   month
price STRIPE_PRICE_EQUIPE_YEAR   tms_equipe_year   "TMS Equipe" 89000  year
price STRIPE_PRICE_CENTRE_MONTH  tms_centre_month  "TMS Centre" 14900  month
price STRIPE_PRICE_CENTRE_YEAR   tms_centre_year   "TMS Centre" 149000 year
price STRIPE_PRICE_ADDON_BANK       tms_addon_bank       "TMS Option Banque connectée" 1200 month
price STRIPE_PRICE_ADDON_MAIL_INBOX tms_addon_mail_inbox "TMS Option Réception email"  900  month
price STRIPE_PRICE_SIGNATURE_PACK   tms_signature_pack   "TMS Pack 20 signatures"      2900 once

echo "Webhook :"
URL="https://$DOMAIN/api/v1/webhooks/payment"
EXISTING=$(api -G https://api.stripe.com/v1/webhook_endpoints -d limit=100 | json "next((w['id'] for w in d['data'] if w['url']=='$URL'), '')")
if [[ -n "$EXISTING" ]]; then
  echo "  existant $EXISTING ($URL)"
  [[ "$(get STRIPE_WEBHOOK_SECRET)" == whsec_* ]] || echo "  ATTENTION : STRIPE_WEBHOOK_SECRET vide dans .env. Copiez la clé de signature whsec_… de ce webhook (Développeurs > Webhooks) dans .env"
else
  SECRET=$(api https://api.stripe.com/v1/webhook_endpoints -d url="$URL" -d description="TMS abonnements" \
    -d "enabled_events[]=checkout.session.completed" -d "enabled_events[]=customer.subscription.created" \
    -d "enabled_events[]=customer.subscription.updated" -d "enabled_events[]=customer.subscription.deleted" \
    -d "enabled_events[]=invoice.paid" -d "enabled_events[]=invoice.payment_failed" | json "d.get('secret') or d['error']['message']")
  [[ "$SECRET" == whsec_* ]] || { echo "Erreur webhook : $SECRET"; exit 1; }
  setenv STRIPE_WEBHOOK_SECRET "$SECRET"
  echo "  créé ($URL), secret enregistré dans .env"
fi

setenv PAYMENT_PROVIDER stripe
setenv DEMO_PAYMENTS false
echo
echo "Terminé. Sauvegarde de l'ancien fichier : $ENV_FILE.avant-stripe (à supprimer après vérification : contient des secrets)."
echo "Appliquer : docker compose up -d --force-recreate api worker"
echo "À faire dans le tableau de bord Stripe : Paramètres > Facturation > Portail client (activer) ; Emails clients (reçus et factures)."
