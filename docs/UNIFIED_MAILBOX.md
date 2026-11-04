# Boîte mail unifiée (047)

L’onglet Boîte mail suit les échanges réels. Messages conserve les séquences
J0–R5, leur rédaction, leur validation et leur programmation. Le stockage des
emails reste `app.email_messages` ; les fils de correspondance ajoutent leur
état, leur brouillon et, lorsque disponible, le lien vers la conversation CRM.
Un échange sans campagne n’entraîne aucune création de prospect fictif.

La boîte affiche uniquement les fils ayant reçu au moins une réponse non
automatique du correspondant. Cette règle s’applique à tous les dossiers,
recherches et compteurs. Après une réponse manuelle, le fil reste accessible
dans En attente de réponse grâce à son historique entrant. Les contacts sans
réponse restent gérés dans Messages. Les rebonds, absences, warm-ups et messages
classés automatiques ou sans rapport ne suffisent pas à faire apparaître un fil.
Sans lien CRM, l’association à une réponse utilise les en-têtes de réponse ou un
envoi confirmé antérieur dans le même fil. Aucun email ni brouillon n’est supprimé.

L’interface reprend la maquette HTML V4 : dossiers, liste et lecteur, filtres
campagne/Gmail combinables, recherche, priorités, historique repliable et réponse
directement sous l’échange. Sur tablette et mobile, ouvrir un fil remplace la
liste ; le bouton Conversations permet d’y revenir. Le texte des emails est
rendu comme texte : les scripts et images de suivi reçus ne sont pas exécutés.

## Synchronisation

`sync-mailboxes` conserve son ingestion CRM et ajoute un curseur indépendant
`__UNIFIED_ALL__` pour reprendre progressivement l’historique de tous les comptes
connectés. Les comptes suspendus restent lisibles. Les newsletters automatiques
sans lien connu ne sont pas recopiées ; les réponses automatiques, rebonds et
warm-ups reconnus par leurs en-têtes sont séparés de la réception commerciale.
Un warm-up dépourvu de signal technique identifiable peut rester non reconnu.

`sync-unified-mailbox` est un worker court et reprenable : trois opérations
au plus puis un fil par invocation. Les baux par fil sérialisent les opérations
et les observations Gmail. L’historique avance par lots de 25 ; la liste et
l’historique affichés sont paginés par 50. Le premier chargement de l’historique
peut donc prendre plusieurs passages. Les états non lus et archivés sont lus
depuis les flags/labels Gmail ; leurs modifications utilisent la même identité
Gmail que le fil. Les actions À traiter et Prioritaire restent propres au CRM.

Une action est d’abord enregistrée dans Neon et dans la file de synchronisation
au sein d’une seule instruction SQL conditionnelle. Une version périmée ne
crée aucun travail Gmail. Les reprises sont idempotentes, avec huit tentatives
et un délai croissant plafonné à une heure. Une erreur reste visible dans le fil.

## Brouillons et réponses

Les brouillons sont sauvegardés dans Neon après 900 ms d’inactivité et à la sortie
du fil. Les écritures sont sérialisées dans l’éditeur et protégées par une version.
Un texte non enregistré reste dans sessionStorage, dans l’onglet du navigateur,
afin de pouvoir être récupéré après une erreur ou un rechargement.

Le worker utilise le dossier spécial Gmail Drafts, y compris en français. Un
identifiant RFC stable par fil et version permet la reprise après APPEND. Le
remplacement supprime uniquement le brouillon précédent identifié, après
confirmation du nouveau. Une modification ou une disparition dans Gmail devient
un conflit visible ; le worker ne la remplace pas silencieusement. Le bouton
Utiliser le brouillon Gmail permet d’adopter son texte en conservant jusque-là
celui de l’éditeur. Un brouillon en cours d’envoi n’est pas recréé.

Envoyer enregistre un instantané immuable dans l’outbox existante avec le type
`mailbox_reply`. L’expéditeur est résolu côté serveur depuis le fil ; le client
ne peut pas le choisir. Le Message-ID et la clé d’idempotence restent stables.
Les quotas, limites IA, pauses, exclusions, fenêtres horaires et protections
SMTP restent appliqués. L’état affiché distingue attente, acceptation SMTP,
échec, annulation et résultat incertain. Un résultat incertain n’est pas rejoué.

Les messages pertinents sont relus dans Gmail avant l’essai et avant la fin de
DATA. Un changement de message source bloque la réponse. Une action manuelle
supplante le travail IA encore en attente, arrête les relances du fil et conserve
les passes déjà rédigées. Aucun envoi en vol n’est remplacé par cette action.
La confirmation met à jour la correspondance sans changer l’étape J0–R5.
Une copie Envoyés peut rapprocher une réponse SMTP incertaine, y compris sans CRM.

## Vérification et exploitation

- `npm run check` : types, composants, API et transports avec Gmail simulé.
- `db/tests/047_unified_mailbox.sql` : fixtures annulées sur branche Neon ;
  versions, identité, idempotence, arrêt des relances, échanges sans campagne,
  rapprochement incertain, pause persistante et privilèges.
- Recettes 039, 040, 041 et `db/verify.sql` sur la même branche.
- Planification PostgreSQL des requêtes API/worker avec PREPARE.
- Chromium : ordinateur, mobile et absence de débordement horizontal.
- Build Netlify : distinguer l’empaquetage local et le build distant ; l’Edge
  Function de durée de lecture conserve son code et son routage existants.

Ces tests n’envoient aucun email réel. L’association visuelle d’un brouillon ou
d’une réponse dans Gmail nécessite une recette Gmail distincte ; les en-têtes
RFC et l’acceptation SMTP ne suffisent pas à affirmer cette présentation.

Le contrôle historique `migration_created_no_outbound_work` de `verify.sql`
concerne une base initiale : il est normalement faux sur une copie de production
dont les campagnes sont déjà autorisées. La migration 047 ne crée aucun job SMTP
et ne modifie pas `app.settings`, les statuts ni les instructions des campagnes.
