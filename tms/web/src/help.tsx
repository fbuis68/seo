import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

/**
 * Aide contextuelle : chaque fonction porte un bouton « ? » qui ouvre ses grands principes.
 * Contenu centralisé ici, repris intégralement par la page Aide (/aide).
 */
export interface Topic { title: string; section: string; intro: string; points?: string[]; tip?: string }

export const HELP: Record<string, Topic> = {
  // ─── Prise en main ──────────────────────────────────────────────────────
  accueil: { section: 'Prise en main', title: 'Accueil et tableaux de bord',
    intro: 'L’accueil résume l’activité : chiffre d’affaires, encaissements, balance âgée et prochaines sessions.',
    points: ['Les montants sont calculés par le serveur à partir des factures émises et des règlements : aucune saisie manuelle.',
      'Cliquez sur un mois pour voir le détail des factures qui le composent (drill-down).',
      'La liste « Démarrer » guide les premières étapes : programme, session, apprenants, documents.'] },
  abonnement: { section: 'Prise en main', title: 'Abonnement, offres et quotas',
    intro: 'L’offre Free est gratuite et durable ; les offres payantes lèvent les quotas et ajoutent des modules.',
    points: ['Les quotas (clients facturés, apprenants par an, sessions actives, stockage, signatures) sont vérifiés au moment de chaque création.',
      'Archiver ne libère pas de place ; supprimer ou fusionner un doublon, oui.',
      'Changement d’offre : à la hausse immédiat, à la baisse à l’échéance. En fin d’abonnement, retour en Free si le volume le permet, sinon lecture seule avec export complet.',
      'Les options (banque connectée, pack de signatures) s’ajoutent à n’importe quelle offre payante.'] },

  // ─── Formations et sessions ─────────────────────────────────────────────
  sessions: { section: 'Formations et sessions', title: 'Sessions de formation',
    intro: 'Une session est une réalisation datée d’un programme de formation, en inter (plusieurs entreprises) ou intra (un client).',
    points: ['Cycle de vie : brouillon → planifiée → confirmée → en cours → terminée → archivée ; annulation possible avec motif.',
      'La version du programme utilisée est figée : modifier le programme crée une nouvelle version sans toucher aux sessions existantes.',
      'En offre Free, 3 sessions actives (planifiée, confirmée, en cours) au maximum.'] },
  'session.fiche': { section: 'Formations et sessions', title: 'Fiche session et « À compléter »',
    intro: 'Le bandeau « À compléter » liste ce qui manque, sans jamais bloquer les étapes : séances, formateurs, durée planifiée, convocations, convention, attestations.',
    points: ['Les boutons de statut n’affichent que les transitions autorisées.', 'Une modification après le démarrage de la session est tracée dans le journal.'] },
  'session.parametres': { section: 'Formations et sessions', title: 'Paramètres de planning de la session',
    intro: 'Informations utilisées par le planning et ses contrôles.',
    points: ['Référence : identifiant court, unique, repris dans les filtres, exports et imports.',
      'Effectif minimum (alerte) et maximum (capacité de la session).',
      'Site par défaut : sert de lieu aux séances qui n’en précisent pas.',
      'Durée cible : par défaut celle du programme ; l’écart avec les heures planifiées est signalé.',
      'Compétences exigées et équipements requis : la publication est bloquée si aucun formateur ou aucune salle ne les couvre (dérogeable).',
      'Couleur : utilisée par le planning quand la couleur est « par session ».'] },
  'session.deroule': { section: 'Formations et sessions', title: 'Déroulé : parties d’une session',
    intro: 'Découpez la durée en parties (ex. 7 h théorie + 7 h pratique engin) pour répartir les heures entre formateurs.',
    points: ['Chaque partie a une durée prévue ; le planifié est la somme des séances rattachées, pauses et séances annulées exclues.',
      '« Formateurs » d’une partie affecte, remplace ou retire un formateur sur toutes ses séances en une fois, avec le même contrôle de conflits.',
      'Supprimer une partie conserve ses séances, simplement détachées.'] },
  'session.creneaux': { section: 'Formations et sessions', title: 'Séances de la session',
    intro: 'Chaque séance a une date, des horaires, un ou plusieurs formateurs et des ressources (lieu, salle, matériel).',
    points: ['Une séance est créée en brouillon : elle réserve déjà les ressources, mais n’est visible des formateurs et stagiaires qu’après publication.',
      'Un brouillon jamais publié se supprime ; une séance publiée s’annule avec un motif (elle reste dans l’historique).',
      'Horaires saisis et affichés dans le fuseau de la session, quel que soit l’ordinateur.',
      'Pauses, récurrences, distanciel et suggestions de ressources libres : écran Planning.'] },
  'session.documents': { section: 'Formations et sessions', title: 'Documents de la session',
    intro: 'Convention, feuille d’émargement, convocations et attestations sont générées en PDF à partir des données de la session.',
    points: ['Un document généré est conservé tel quel (empreinte SHA-256) ; regénérer crée une nouvelle version.',
      'La signature électronique est payante (crédits inclus selon l’offre) ; en Free, déposez la convention signée hors plateforme.',
      'Les séances annulées n’apparaissent pas sur les documents.'] },
  'session.inscrits': { section: 'Formations et sessions', title: 'Inscriptions et présences',
    intro: 'Inscrivez un apprenant existant ou créez-le directement ; saisissez la présence par séance.',
    points: ['Un apprenant ne compte qu’une fois par an dans le quota, même inscrit à plusieurs sessions.',
      'Groupe : une séance réservée à un groupe n’attend que ses membres.',
      'À l’inscription, les séances futures sont revérifiées : en cas de collision avec une autre session ou de salle pleine, la participation passe « à résoudre » au lieu de créer une incohérence.',
      'La durée de présence est bornée par la durée de la séance.'] },

  // ─── Ressources ─────────────────────────────────────────────────────────
  ressources: { section: 'Lieux, salles et matériel', title: 'Lieux, salles et matériel',
    intro: 'Trois types de ressources : le lieu (site), partageable entre sessions simultanées ; la salle et le matériel, réservables une seule fois à la fois.',
    points: ['Rattachez salles et matériel à un site : il sert aux contrôles de site autorisé et de temps de déplacement.',
      'Capacité : nombre de places physiques ; plusieurs salles réservées ne s’additionnent pas automatiquement.',
      'Équipements de salle (vidéoprojecteur…) : comparés aux équipements requis par la session.',
      'Archiver retire la ressource des nouvelles séances sans la supprimer de l’historique.'] },
  'ressources.planning': { section: 'Lieux, salles et matériel', title: 'Temps tampon et horaires d’ouverture',
    intro: 'Paramètres de réservation utilisés par le planning.',
    points: ['Préparation et remise en état : la salle est réservée avant et après la séance ; une séance collée à la précédente est alors bloquée.',
      'Horaires d’ouverture : une séance hors plage est bloquée (dérogeable). Sans horaires, aucune contrainte.',
      'Une indisponibilité datée (maintenance) se saisit dans Planning → Disponibilités.'] },
  'ressources.vgp': { section: 'Lieux, salles et matériel', title: 'Vérification périodique du matériel (VGP)',
    intro: 'Pour les engins (CACES…), la date de prochaine vérification est suivie.',
    points: ['Pastille orange à moins de 30 jours, rouge si échue.', 'Une séance utilisant un engin dont la vérification est échue à sa date reste en brouillon : sa publication est bloquée.'] },

  // ─── Planning ───────────────────────────────────────────────────────────
  planning: { section: 'Planning', title: 'Principe du planning',
    intro: 'Une session regroupe plusieurs séances. Une séance est un créneau daté avec horaires, formateurs, salle ou lien de visioconférence et participants. Toutes les vues lisent les mêmes données et appliquent les mêmes règles.',
    points: ['Tous les contrôles sont faits par le serveur, quel que soit le chemin : formulaire, glisser-déposer, import, duplication, récurrence.',
      'Les contrôles portent sur toutes les réservations actives, même celles masquées par les filtres.',
      'Préparation et diffusion sont séparées : on prépare en brouillon, on publie quand c’est complet.'],
    tip: 'Double-cliquez sur un créneau libre pour créer une séance à cet endroit.' },
  'planning.vues': { section: 'Planning', title: 'Vues jour, semaine, mois, Timeline et liste',
    intro: 'Changer de vue ou de zoom conserve la date et les filtres.',
    points: ['Jour : grille horaire, colonnes par formateur, salle, matériel, site, session ou groupe ; indisponibilités hachurées.',
      'Semaine : jours ouvrés (case « 7 jours » pour tout afficher), trait rouge = heure actuelle.',
      'Mois : 3 séances par jour puis un compteur « + N autres » ; aucune séance masquée sans compteur. Cliquez sur le jour pour le détail.',
      'Timeline : une ligne par ressource, entêtes fixes, chevauchements empilés ; zoom jour, semaine ou mois ; une ligne de session se replie.',
      'Liste : pour le mobile, le clavier et l’édition groupée (cases à cocher).'] },
  'planning.filtres': { section: 'Planning', title: 'Recherche, filtres et vues favorites',
    intro: 'Recherche par intitulé, référence, formation, formateur, salle ou stagiaire ; filtres combinables.',
    points: ['« Séances incomplètes » : sans formateur, sans lieu en présentiel ou sans lien en distanciel.',
      'Vue, filtres, regroupement, couleur et hauteur de ligne sont mémorisés sur ce navigateur.',
      '« Enregistrer cette vue » crée un raccourci réutilisable (ex. « Salles de Lyon »).'] },
  'planning.legende': { section: 'Planning', title: 'Couleurs, statuts et symboles',
    intro: 'La couleur suit la session, la formation ou le statut ; la légende reste affichée.',
    points: ['Statuts toujours écrits ou symbolisés, lisibles sans couleur : ✎ brouillon (bord pointillé), ◷ à valider, ✓ publié, ■ réalisé, ✕ annulé (barré).',
      '⚠ séance incomplète ; « !N » participants à résoudre.', 'Hachures dans une carte : pause non pédagogique ; dans une colonne ou une ligne : indisponibilité.'] },
  'planning.glisser': { section: 'Planning', title: 'Glisser-déposer et redimensionner',
    intro: 'Déplacez une carte pour changer la date ou l’heure ; tirez son bord bas pour changer la fin.',
    points: ['Avant tout enregistrement, une fenêtre montre l’avant / après et le résultat des contrôles.',
      'Rien n’est enregistré sans « Confirmer » ; en cas de refus ou d’annulation, la séance reste à sa place.',
      'En vue jour groupée ou en Timeline, déplacer verticalement change la ressource (autre formateur, autre salle).',
      'Les pas suivent la grille (15 min par défaut). Alternative sans souris : ouvrir la fiche et modifier les champs.'] },
  'planning.fiche': { section: 'Planning', title: 'Fiche séance (panneau latéral)',
    intro: 'Création et modification sans quitter le planning : date, filtres et position sont conservés.',
    points: ['Le contrôle se fait en direct pendant la saisie : bloquants en rouge, alertes en orange.',
      '« disponibilités » à côté des formateurs, salles ou matériel liste qui est libre et pourquoi les autres ne le sont pas.',
      'Formateur principal ou coanimateur : la coanimation dans une même séance n’est pas une double réservation.',
      'Si la séance a été modifiée entre-temps par quelqu’un d’autre, l’enregistrement est refusé : rechargez, rien n’est écrasé.',
      'Échap ferme le panneau.'] },
  'planning.pauses': { section: 'Planning', title: 'Pauses et durée pédagogique',
    intro: 'Durée pédagogique = durée de la séance moins les pauses non pédagogiques.',
    points: ['Une pause doit être incluse dans la séance, de durée positive, sans chevauchement avec une autre.',
      'Salle et formateur restent réservés pendant les pauses ; pour les libérer, découpez en deux séances.',
      'Les totaux, la durée cible et les exports utilisent la durée pédagogique.'] },
  'planning.modalite': { section: 'Planning', title: 'Présentiel, distanciel, hybride',
    intro: 'La modalité détermine ce qui est exigé à la publication et qui compte dans la capacité.',
    points: ['Présentiel : un lieu ou une salle est exigé.', 'Distanciel : un lien de visioconférence est exigé, pas de salle.',
      'Hybride : lieu et lien exigés ; seuls les participants présents comptent dans la capacité de la salle.'] },
  'planning.participants': { section: 'Planning', title: 'Participants d’une séance',
    intro: 'Par défaut, sont attendus les inscrits actifs de la session (du groupe de la séance), dont les dates d’entrée et de sortie couvrent la séance.',
    points: ['Exceptions par séance : présentiel, à distance, non attendu ; « selon la modalité » rétablit la règle.',
      '« À résoudre » : collision avec une autre session ou salle pleine détectée à l’inscription ; le participant n’est pas compté tant que ce n’est pas réglé.',
      'Forcer la présence d’un stagiaire déjà pris ailleurs est refusé.'] },
  'planning.recurrence': { section: 'Planning', title: 'Récurrence',
    intro: 'Créez une série : jours de la semaine, date de fin (ou 10 occurrences), exclusions.',
    points: ['Les horaires sont gardés en heure locale : 9 h reste 9 h après le changement d’heure.',
      'Un horaire inexistant ou ambigu le jour du changement d’heure doit être corrigé explicitement.',
      '« Aperçu des occurrences » montre les séances créées, exclues et en conflit, sans rien écrire.',
      'Par défaut tout ou rien : une seule occurrence en conflit et aucune n’est créée.',
      'Modifier une séance d’une série : cette séance, celle-ci et les suivantes, ou toute la série ; les occurrences passées et réalisées sont protégées.'] },
  'planning.duplication': { section: 'Planning', title: 'Dupliquer une séance',
    intro: 'Copie le contenu pédagogique et propose les mêmes affectations sur d’autres dates, aux mêmes heures locales.',
    points: ['Chaque copie est contrôlée comme une nouvelle séance et créée en brouillon.', 'Ni émargement ni historique ne sont copiés.'] },
  'planning.statuts': { section: 'Planning', title: 'Statuts et publication',
    intro: 'Brouillon → À valider → Publié → Réalisé ; Annulé possible depuis tout état actif.',
    points: ['Brouillon : réserve les ressources pour les autres planificateurs, invisible dans les portails.',
      'À valider : demande de validation au responsable ; il peut publier ou renvoyer en brouillon.',
      'Publier exige des données complètes et aucun conflit bloquant ; la version publiée devient la référence.',
      'Réalisé : seulement après la fin de la séance ; ne vaut pas preuve de présence.',
      'Une séance réalisée ne se déplace plus ; une correction exige un motif et un rôle responsable.',
      'Annuler : motif obligatoire, réservations libérées, historique conservé, personnes prévenues si la séance était publiée.'] },
  'planning.controles': { section: 'Planning', title: 'Contrôles bloquants et alertes',
    intro: 'Les intervalles sont traités en [début, fin[ : une séance finissant à 12 h peut être suivie à 12 h, sauf temps tampon.',
    points: ['Bloquant : double réservation (formateur, salle, matériel, stagiaire), temps de préparation de salle, temps de déplacement formateur entre deux sites, indisponibilité, ressource ou formateur inactif, hors ouverture, fermeture, capacité dépassée, pauses invalides, dates d’inscription, compétence ou équipement requis, site non autorisé.',
      'Exigé à la publication : formateur, lieu (présentiel / hybride), lien visio (distanciel / hybride), vérification périodique du matériel à jour.',
      'Alertes (n’empêchent pas d’enregistrer) : durée cible non atteinte ou dépassée, effectif minimum, charge formateur, hors horaires habituels, horaires inhabituels, délai court.',
      'Chaque message indique la règle, la ressource, le créneau et la séance en conflit.',
      'Deux personnes qui réservent la même ressource au même moment : une seule réussit, l’autre reçoit un conflit.'] },
  'planning.derogation': { section: 'Planning', title: 'Dérogations',
    intro: 'Certaines règles peuvent être levées ponctuellement, avec un motif tracé dans l’historique.',
    points: ['Dérogeables : hors ouverture, fermeture, compétence, équipement requis, site non autorisé.',
      'Non dérogeables : indisponibilité, capacité, incohérence horaire, éléments exigés à la publication.',
      'Double réservation : non dérogeable sauf si le centre l’autorise dans les Paramètres.',
      'Réservé aux rôles habilités (permission « dérogation »). La dérogation tombe si l’horaire change.'] },
  'planning.groupee': { section: 'Planning', title: 'Édition groupée',
    intro: 'En vue Liste, cochez des séances puis choisissez une opération : décaler, changer de formateur ou de salle, modalité, publier, annuler.',
    points: ['« Prévisualiser » donne le bilan par séance sans rien écrire.', 'Application tout ou rien : si une seule séance est bloquée, aucune n’est modifiée.',
      'Décaler de N jours conserve l’heure locale ; décaler de N minutes déplace l’instant.'] },
  'planning.conflits': { section: 'Planning', title: 'Liste des conflits',
    intro: 'Contrôle de toutes les séances actives de la période affichée avec les mêmes règles que l’enregistrement.',
    points: ['« À résoudre » : conflits bloquants, chacun relié aux deux séances concernées.', 'Alertes et dérogations accordées sont listées à part.',
      'Utile après une indisponibilité, une fermeture ou une inscription tardive.'] },
  'planning.publication': { section: 'Planning', title: 'Aperçu avant publication',
    intro: 'Liste les séances en brouillon ou à valider de la période et vérifie qu’elles sont publiables.',
    points: ['« Contrôler la publication » affiche, séance par séance, ce qui bloque.', 'La publication est atomique : corrigez les séances bloquées ou retirez-les de la sélection.',
      'Sans droit de publication, le bouton devient « Demander la validation ».', 'Publier déclenche les notifications aux formateurs et stagiaires.'] },
  'planning.disponibilites': { section: 'Planning', title: 'Disponibilités',
    intro: 'Périodes datées pour un formateur ou une ressource : indisponibilité (congé, maintenance) ou disponibilité exceptionnelle.',
    points: ['Les périodes datées priment sur les horaires hebdomadaires.', 'Saisie par un gestionnaire : validée immédiatement ; par un formateur : soumise à validation.',
      'À la validation, les séances déjà planifiées sur la période sont listées pour être réaffectées ; rien n’est déplacé automatiquement.',
      'Ne saisissez jamais de motif médical : « absence » suffit.'] },
  'planning.profil': { section: 'Planning', title: 'Profil formateur',
    intro: 'Paramètres propres à chaque formateur, utilisés par les contrôles et les indicateurs.',
    points: ['Statut interne / externe et actif : un formateur inactif ne peut plus être affecté.', 'Compétences : comparées aux compétences exigées par la session.',
      'Sites autorisés : aucun coché = tous.', 'Horaires habituels : hors de ces horaires, simple alerte.',
      'Charge maximale par semaine : alerte au-delà ; sert aussi au calcul de charge.', 'Temps de déplacement : imposé entre deux séances de sessions différentes sur des sites différents.'] },
  'planning.fermetures': { section: 'Planning', title: 'Fermetures et jours fériés',
    intro: 'Fermeture du centre entier ou d’un site, sur un ou plusieurs jours.',
    points: ['Une séance sur une fermeture est bloquée (dérogeable).', 'À la création, les séances déjà planifiées sur ces dates sont listées : le report est décidé par le planificateur, jamais automatique.'] },
  'planning.indicateurs': { section: 'Planning', title: 'Indicateurs du planning',
    intro: 'Calculés sur la période affichée.',
    points: ['Heures pédagogiques : prévisionnelles (séances non annulées) et réalisées (statut Réalisé).',
      'Charge formateur = heures réservées / heures disponibles (horaires habituels, sinon charge maximale ou base hebdomadaire du centre, moins les indisponibilités).',
      'Occupation = temps réservé, temps tampon compris / heures d’ouverture.', 'Séances sans formateur et incomplètes : à traiter avant publication.'] },
  'planning.import': { section: 'Planning', title: 'Import de séances (CSV ou Excel)',
    intro: 'Une ligne par séance : Session (référence), Date, Début, Fin, Formateurs, Salles, Intitulé, Modalité, Lien.',
    points: ['Formateurs par email ou « Prénom Nom », plusieurs séparés par « | ».', 'Faites toujours un « Aperçu » : résultat ligne par ligne (valide, doublon, erreur, conflit), rien n’est écrit.',
      'Par défaut tout ou rien ; le mode partiel enregistre les lignes valides et rejette les autres, sur choix explicite.',
      'Réimporter le même fichier ne crée pas de doublon : les séances déjà présentes sont reconnues.'] },
  'planning.export': { section: 'Planning', title: 'Exports',
    intro: 'Exportent la période et les filtres actuellement affichés.',
    points: ['CSV : ouvrable dans Excel (début, fin, durées, session, lieu, salles, matériel, formateurs, modalité, statut).',
      'PDF : regroupé par session, formateur, salle ou groupe, période et filtres rappelés.', 'ICS : à importer dans un agenda (import ponctuel, pas de mise à jour automatique).',
      'Les vues jour et semaine s’impriment aussi directement depuis le navigateur.'] },
  'planning.journal': { section: 'Planning', title: 'Journal des modifications',
    intro: 'Chaque changement de séance crée une version : acteur, date, opération, motif, anciennes et nouvelles valeurs, règles dérogées.',
    points: ['L’historique d’une séance est aussi accessible depuis sa fiche.', 'Les séances annulées restent consultables.'] },
  'planning.notifications': { section: 'Planning', title: 'Notifications',
    intro: 'Formateurs et stagiaires concernés sont prévenus par email des séances publiées, modifiées (date, horaire, lieu, formateur, modalité, lien) ou annulées.',
    points: ['Envoi après validation de l’enregistrement, jamais lors d’un aperçu.', 'Les changements successifs sont regroupés en un seul message par personne.',
      'Une panne d’envoi n’annule pas la modification ; l’envoi est relancé sans doublon.', 'Les modifications internes (notes, brouillons) ne notifient personne.'] },
  'planning.parametres': { section: 'Planning', title: 'Paramètres du planning',
    intro: 'Règles propres au centre, réservées à l’administrateur.',
    points: ['Pas de grille (5 à 60 min), plage horaire visible et jours ouvrés affichés.', 'Publication directe : le planificateur publie sans validation (petits centres).',
      'Double réservation dérogeable : déconseillé, désactivé par défaut.', 'Seuils d’alerte : charge journalière, délai court, horaires inhabituels, base hebdomadaire de charge.'] },
  'planning.mon-planning': { section: 'Planning', title: 'Mon planning (formateur, stagiaire)',
    intro: 'Séances publiées qui vous concernent, sur 4 semaines.',
    points: ['Les brouillons n’y apparaissent pas ; une séance annulée reste visible avec son motif.', 'Un stagiaire ne voit ni le nom ni les coordonnées des autres stagiaires.',
      '« Ajouter à mon agenda » télécharge un fichier ICS.', 'Formateur : demandez une indisponibilité, elle sera validée par le responsable.'] },

  // ─── Clients et finances ────────────────────────────────────────────────
  clients: { section: 'Clients et finances', title: 'Clients et personnes',
    intro: 'Un client est une entreprise ou une personne facturée ; une personne peut être apprenant, formateur et contact à la fois.',
    points: ['Le quota Free compte les clients facturés, pas les prospects.', 'SIRET contrôlé à la saisie ; les doublons se fusionnent après validation.',
      'Créez ici les formateurs (rôle « formateur ») avant de les affecter aux séances.'] },
  facturation: { section: 'Clients et finances', title: 'Devis, factures, avoirs, règlements',
    intro: 'Une facture émise reçoit un numéro définitif et ne se modifie plus : on la corrige par un avoir.',
    points: ['Numérotation continue sans trou, même en émissions simultanées.', 'Calculs au centime, sans arrondi flottant ; TVA ou exonération (art. 261-4-4° du CGI).',
      'Un règlement peut couvrir plusieurs factures, ou une facture plusieurs règlements (paiement partiel).'] },

  // ─── Outils ─────────────────────────────────────────────────────────────
  assistant: { section: 'Outils', title: 'Assistant IA',
    intro: 'Fonctionne avec votre propre clé OpenAI ou Gemini : les frais du fournisseur vous sont facturés directement.',
    points: ['L’assistant consulte vos données mais n’écrit jamais seul : il propose, vous confirmez.', 'Une proposition devient caduque si les données concernées changent entre-temps.',
      'Un budget mensuel limite la consommation.'] },
  reprise: { section: 'Outils', title: 'Reprise de données',
    intro: 'Importez vos données depuis les fichiers de sauvegarde de votre ancien logiciel, jamais par connexion à son API.',
    points: ['Archive contrôlée (fichiers dangereux refusés), format reconnu, correspondance des colonnes.', 'Simulation : bilan complet sans rien écrire.',
      'Publication en une fois ; réimporter ne crée pas de doublon.', 'Annulation possible tant que les données reprises n’ont pas été utilisées (ex. facture émise).'] },
  'reglages.equipe': { section: 'Réglages', title: 'Équipe et rôles',
    intro: 'Invitez gestionnaires, formateurs et stagiaires par email.',
    points: ['Gestionnaire : gestion courante, publication et dérogations du planning (retirables individuellement).', 'Formateur : ses sessions, ses présences, son planning publié.',
      'Stagiaire : son planning publié uniquement.', 'Seuls les gestionnaires comptent dans le quota de l’offre.'] },
  'reglages.apparence': { section: 'Réglages', title: 'Apparence et logo',
    intro: 'Personnalisez l’interface aux couleurs de votre organisme et apposez votre logo sur tous vos documents.',
    points: ['Logo : PNG transparent conseillé ; il est redimensionné dans votre navigateur, affiché dans le menu et repris automatiquement en haut à droite de chaque PDF généré.',
      'Les documents déjà générés restent inchangés (pièces conservées telles quelles) : regénérez-les pour appliquer le nouveau logo.',
      'Couleur principale : boutons, liens et sélection ; un avertissement s’affiche si le contraste avec le texte blanc est insuffisant.',
      'Fond du menu : le texte du menu passe automatiquement en blanc ou en noir pour rester lisible.',
      'Couleur des documents : titres et entêtes de tableaux des PDF.',
      'Thème clair, sombre ou automatique ; les modifications s’affichent en aperçu avant d’être enregistrées et valent pour tous les utilisateurs.',
      'Réservé à l’administrateur de l’organisme.'] },
  'reglages.ia': { section: 'Réglages', title: 'Fournisseurs d’IA',
    intro: 'Votre clé est chiffrée et n’est jamais réaffichée.', points: ['Supprimer la clé désactive l’assistant immédiatement.'] },
  'reglages.smtp': { section: 'Réglages', title: 'Envoi depuis votre messagerie',
    intro: 'Les emails aux clients et apprenants partent de votre propre adresse via votre serveur SMTP (offres payantes).',
    points: ['Connexion chiffrée vérifiée (ports 465 ou 587).', 'Un envoi au statut incertain n’est jamais renvoyé automatiquement, pour éviter les doublons.'] },
  'reglages.banque': { section: 'Réglages', title: 'Banque connectée',
    intro: 'Lecture seule de vos relevés pour rapprocher les règlements (option payante).',
    points: ['Aucun paiement ne peut être initié.', 'Les rapprochements proposés sont toujours validés par vous.'] },
  'reglages.export': { section: 'Réglages', title: 'Export complet',
    intro: 'Archive ZIP de toutes vos données avec manifeste d’intégrité, réimportable : vos données vous appartiennent.',
    points: ['Disponible même en lecture seule.', 'Le lien de téléchargement est temporaire.'] },
};

/** Bouton « ? » : grands principes de la fonction ; lien vers l’aide complète. */
export function Help({ k, label }: { k: keyof typeof HELP | string; label?: string }) {
  const t = HELP[k];
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const ref = useRef<HTMLSpanElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const out = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); (ref.current?.querySelector('button') as HTMLButtonElement)?.focus(); } };
    const close = () => setOpen(false);
    document.addEventListener('mousedown', out); document.addEventListener('keydown', esc); window.addEventListener('resize', close);
    return () => { document.removeEventListener('mousedown', out); document.removeEventListener('keydown', esc); window.removeEventListener('resize', close); };
  }, [open]);
  if (!t) return null;
  return (
    <span className="help" ref={ref}>
      <button type="button" className="help-btn" aria-label={`Aide : ${label ?? t.title}`} aria-expanded={open} aria-controls={id}
        onClick={(e) => {
          e.preventDefault(); e.stopPropagation();
          // Positionnement fixe, recalé dans la fenêtre (y compris dans le panneau latéral).
          const r = e.currentTarget.getBoundingClientRect(); const w = Math.min(380, window.innerWidth - 16);
          const below = r.bottom + 6 + 320 < window.innerHeight || r.top < 340;
          setPos({ left: Math.max(8, Math.min(r.left - 8, window.innerWidth - w - 8)), top: below ? r.bottom + 6 : Math.max(8, r.top - 6 - 320) });
          setOpen(!open);
        }}>?</button>
      {open && (
        <span className="help-pop" id={id} role="dialog" aria-label={t.title} style={pos} onClick={(e) => e.stopPropagation()}>
          <strong>{t.title}</strong>
          <span className="help-intro">{t.intro}</span>
          {t.points && <ul>{t.points.map((p, i) => <li key={i}>{p}</li>)}</ul>}
          {t.tip && <span className="help-tip">Astuce : {t.tip}</span>}
          <Link to={`/aide#${k}`} onClick={() => setOpen(false)}>Toute l’aide</Link>
        </span>
      )}
    </span>
  );
}
