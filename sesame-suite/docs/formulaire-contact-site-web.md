# Formulaire de contact du site web → CRM Sesame

Instructions pour l'équipe qui gère le site web public (`sesame-technology.com`
ou équivalent) : comment brancher un formulaire de contact simple sur le CRM
commercial interne de Sesame Suite.

## Ce que fait l'intégration

Chaque soumission valide du formulaire crée automatiquement, côté CRM
(`/crm`) :

- une **fiche prospect** (nom, email, secteur) — si une fiche existe déjà
  pour cet email, elle est réutilisée (pas de doublon créé à chaque nouvelle
  soumission de la même personne) ;
- une **tâche à traiter** dans le journal d'activité de la fiche, contenant
  le message du formulaire, marquée « à faire » — un commercial la voit
  immédiatement dans `/crm` et peut la cocher « fait » une fois traitée.

Aucune configuration côté CRM n'est nécessaire : le endpoint est déjà actif.

## Point d'entrée technique

```
POST https://<domaine-du-serveur-sesame-suite>/contact
Content-Type: application/json
```

Remplacer `<domaine-du-serveur-sesame-suite>` par l'URL du serveur où
Sesame Suite est déployé (à confirmer avec l'équipe technique Sesame selon
l'environnement — production, staging…).

Ce endpoint est **public** (pas d'authentification requise, pas de clé API)
— c'est volontaire, un formulaire de contact grand public ne peut pas
embarquer un secret.

### Corps de la requête (JSON)

| Champ     | Type   | Obligatoire | Remarque                              |
|-----------|--------|:-----------:|----------------------------------------|
| `nom`     | string | oui         | Nom du contact                        |
| `email`   | string | oui         | Doit contenir un `@`                  |
| `secteur` | string | non         | Ex. « Hôtellerie », « Location AirBnB »… libre |
| `message` | string | oui         | Contenu du message                    |

### Réponses

- **201** — succès : `{"ok": true}`
- **400** — champ manquant ou invalide : `{"error": "Nom requis"}` (ou
  `"Email valide requis"` / `"Message requis"`)

## Exemple de formulaire HTML minimal

```html
<form id="contact-form">
  <label>Nom <input type="text" name="nom" required></label>
  <label>Email <input type="email" name="email" required></label>
  <label>Secteur
    <select name="secteur">
      <option value="">— Sélectionner —</option>
      <option>Hôtellerie</option>
      <option>Appart Hotel</option>
      <option>Location appartement</option>
      <option>Location AirBnB</option>
      <option>Bureaux</option>
      <option>Location bureau</option>
      <option>Sport</option>
      <option>Garde meuble</option>
      <option>Love hôtel</option>
      <option>Agence gestion patrimoine</option>
    </select>
  </label>
  <label>Message <textarea name="message" required></textarea></label>
  <button type="submit">Envoyer</button>
</form>
<p id="contact-status"></p>

<script>
document.getElementById('contact-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const status = document.getElementById('contact-status');
  const body = {
    nom: form.nom.value,
    email: form.email.value,
    secteur: form.secteur.value,
    message: form.message.value,
  };
  status.textContent = 'Envoi en cours…';
  try {
    const res = await fetch('https://<domaine-du-serveur-sesame-suite>/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (res.ok) {
      status.textContent = 'Merci, votre message a bien été envoyé.';
      form.reset();
    } else {
      status.textContent = data.error || "Une erreur est survenue.";
    }
  } catch (err) {
    status.textContent = "Une erreur est survenue, veuillez réessayer.";
  }
});
</script>
```

Le champ `secteur` est une liste libre côté serveur (n'importe quelle valeur
texte est acceptée) ; les options ci-dessus reprennent simplement les
secteurs déjà suivis dans le CRM pour que les nouvelles fiches s'intègrent
proprement aux graphiques de répartition par secteur.

## Où voir le résultat

Dans `/crm`, vue Liste : la fiche apparaît (nouvelle ou mise à jour) avec un
badge de tâche non traitée. En l'ouvrant, le message du formulaire est visible
dans le journal d'activité, en haut, avec le bouton « ✓ Marquer fait » pour la
clôturer une fois le prospect recontacté.
