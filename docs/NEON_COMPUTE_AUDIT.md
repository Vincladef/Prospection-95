# Audit du calcul Neon — 19 novembre 2026

## Mesures accessibles

Projet `snowy-math-99695975`, production `br-bitter-hill-baxuhpw7`.
Neon rapporte 396 258 CU-secondes (110,07 CU-heures) et 1 584 719 secondes
d'activité cumulée sur la période du 1er novembre au 1er décembre.
Le compute est déjà fixé à 0,25 CU ; l'auto-suspension est activée
(`suspend_timeout_seconds=0`, valeur par défaut du plan gratuit).
Les dix endpoints sont idle ; les endpoints de validation ne montrent aucune
activité récente. La production est suspendue depuis le 19 novembre à 03:49 UTC.

Une tentative de diagnostic SQL `inspect_database / calls` est refusée avec
HTTP 402 : quota épuisé. Aucun diagnostic SQL supplémentaire ni redémarrage
forcé n'est tenté. Les statistiques SQL, l'efficacité après déploiement et
une vraie reprise après sommeil restent à vérifier une fois le quota disponible.

Netlify : déploiement publié `6af45307543b9e66e3590b7f`, commit `fc44f050`.
Sur la fenêtre accessible de moins d'une heure, 57 invocations chacun pour
dispatch-outbox, sync-mailboxes et sync-unified-mailbox ; 5 pour sync-drafts.
Un HTTP 202 de fonction background ne prouve pas sa réussite SQL ou Gmail.

## Causes et correctifs

- Trois crons minute ; sync-mailboxes lit Neon, tente des réparations et exécute
  trois nettoyages de rétention même sans mail nouveau. sync-unified-mailbox
  vérifie une file et un fil à chaque minute.
- sync-drafts ajoute une lecture toutes les dix minutes, indépendamment du stock.
- Le tableau de bord se recharge toutes les 30 secondes, la boîte mail toutes
  les 15 secondes, même lorsque l'utilisateur a laissé l'onglet visible.
- Le health-check public exécute SELECT 1 et peut réveiller Neon sous surveillance.
- Le driver utilise déjà HTTP et les connexions IMAP sont bornées et fermées :
  pas de pool TCP ou d'IDLE IMAP permanent à supprimer.
- Les passages ChatGPT commerciaux sont horaires et ceux de délivrabilité toutes
  les cinq heures. La veille documentaire ne consulte pas Neon. Cadences conservées.

Les indices de repos utilisent un store Netlify Blobs propre au déploiement.
Ils ne contiennent que des horodatages et n'autorisent aucune opération.
Une vérification sans travail déclenche un repos jusqu'au prochain quart d'heure,
raccourci si une échéance SMTP déjà connue arrive avant.
Une action authentifiée réveille les workers ; une file ou un historique à
compléter maintient la cadence minute. Un indice absent, périmé ou illisible
rétablit le fonctionnement existant. Un quota épuisé entraîne un délai de
nouvel essai de quinze minutes, sans modifier les autorisations commerciales.

Pendant une utilisation interactive, les capacités restent une boîte IMAP,
trois opérations unifiées et un fil par passage. Au repos, les curseurs IMAP
sont regroupés par lots bornés (15 au maximum, 150 secondes
avant de commencer une autre opération). Une boîte vide ne masque pas les autres.
Chaque curseur rattrapé est contrôlé au plus une fois par quart d'heure au repos,
ou après deux minutes pendant une utilisation interactive. Les historiques non
terminés restent prioritaires pour la reprise. La maintenance de rétention reste
bornée et utilise la première fenêtre de quinze minutes de chaque journée UTC.
Les files de synchronisation unifiées utilisent un lot borné équivalent à leur
capacité précédente sur quinze minutes ; les pages historiques restantes
déclenchent une reprise minute. Les brouillons ont désormais un cron minute
soumis au même repos : reprise rapide en présence de travail, contrôle à vide
groupé avec les autres workers.

Le délai de découverte automatique au repos est de quinze minutes (plus le
pacing aléatoire SMTP existant pour les envois). Les actions de l'interface et
les travaux déjà identifiés reprennent sur la cadence minute. Les agents SQL
horaires restent inchangés ; leurs écritures sont découvertes au prochain
contrôle. L'interface s'actualise aux cadences habituelles pendant l'utilisation,
puis cesse le polling après deux minutes sans interaction. Le retour ou une
interaction relance immédiatement l'actualisation.

Le health-check public vérifie la configuration et indique
`database=null,databaseChecked=false`. La recette SQL explicite reste disponible
sur `GET /api/health?database=1`, avec authentification administrateur.

## Invariants

Aucune migration, aucun changement de campagne, de seuil, de quota, de pause ou
de droit. Le pacing aléatoire, les verrous, les contrôles Gmail avant SMTP,
les exclusions, l'idempotence et les validations SQL restent en place.
Le cache ne remplace aucun de ces contrôles et ne contient aucun secret.

## Vérification à effectuer après rétablissement du quota

1. Laisser l'interface fermée/inactive et observer les logs des quatre workers :
   indices `skipped=idle`, contrôle au quart d'heure, reprise d'un vrai stock.
2. Observer le compute via le plan de contrôle Neon, sans SELECT périodique :
   au moins une transition active → idle, puis une reprise sur action utile.
3. Vérifier une réception, une pagination historique, un brouillon et une action
   de lecture/archivage ; confirmer dans Gmail sans envoyer de mail de test
   commercial non demandé.
4. Comparer les CU-secondes sur une journée représentative. Une simulation des
   lectures évitées n'est pas une économie réelle mesurée ; une activité utile,
   les agents et les liens de suivi peuvent légitimement réveiller Neon.

## Recette SQL indépendante du quota Neon

`scripts/test-idle-mailbox-query.mjs` exécute le SELECT/claim actuel du worker,
extrait directement du fichier source, sur un PostgreSQL 17 jetable dans la CI.
Les données sont fictives. La recette vérifie plusieurs comptes, l'absence
de relecture inutile dans le même quart d'heure, le rafraîchissement interactif,
la poursuite d'un historique incomplet et le délai entre deux tentatives.
Ce test ne constitue pas une migration ni une validation sur la production Neon.

## Alignement des contrôles SMTP à vide

Le dispatcher vérifie la présence de travaux après la programmation normale,
avant de jouer la loterie SMTP lorsqu'il sort d'un repos. Si la file est vide,
il rend immédiatement la main et partage ainsi le réveil des autres workers.
Cette vérification inclut les baux expirés et la prochaine échéance connue.
La loterie et l'attente aléatoire avant toute prise de bail restent appliquées
dès qu'un travail est disponible. Une erreur de quota commercial n'est pas
confondue avec le refus de quota de la plateforme Neon.

## Ordres de grandeur et limites des économies

Les chiffres ci-dessous décrivent le code en régime calme ; ce ne sont pas des
mesures de la production, restée sur l'ancien déploiement au moment de l'audit.

| Appels automatiques | Avant | Après publication |
| --- | --- | --- |
| File SMTP vide, sans activité interactive | En moyenne 24 requêtes HTTP Neon/heure (12 occasions aléatoires, 2 requêtes chacune) | 8/heure (4 vérifications groupées, 2 requêtes chacune) |
| Tableau de bord visible laissé sans interaction | 120 actualisations/heure | Arrêt après 2 minutes |
| Boîte mail visible laissée sans interaction | 240 actualisations/heure pour la liste, plus le détail du fil | Arrêt après 2 minutes |
| Health-check public | 1 requête SQL par appel | 0 ; diagnostic SQL explicite et authentifié conservé |
| Synchronisations IMAP/unifiées au repos | Travail réparti chaque minute | 4 plages groupées par heure, avec reprise minute si un rattrapage reste nécessaire |

Les lots continuent à parcourir les comptes et à enregistrer leurs curseurs :
la réduction du nombre de réveils n'est pas une réduction identique de toutes
les requêtes SQL. Le nombre réel dépend aussi des comptes, des messages nouveaux,
des historiques incomplets et des opérations utilisateur. La maintenance des
trois tables de rétention ne tourne plus chaque minute : elle utilise uniquement
la première fenêtre de quinze minutes de la journée UTC.

À 0,25 CU, une base active en permanence pendant 30 jours consomme 180 CU-heures.
Un scénario sans autre activité avec quatre réveils par heure de cinq minutes
chacun représente environ 60 CU-heures ; avec huit minutes par plage, 96 CU-heures.
Ces scénarios illustrent l'intérêt de la mise en veille : ils ne prédisent pas
la facture. Le temps des vrais traitements, des agents, de l'interface utilisée
et des requêtes supplémentaires s'y ajoute. Aucun maintien sous un plafond précis
ne peut être garanti avant une observation représentative.

## Publication depuis GitHub Actions

Le workflow contrôle l'application et construit les Functions et l'Edge Function
sur le runner GitHub, puis publie avec `netlify deploy --prod --no-build`.
Le jeton est lu uniquement depuis le secret GitHub Actions
`NETLIFY_AUTH_TOKEN`, jamais depuis un fichier versionné ni une variable publique.
La publication exige le commit courant de main et vérifie ensuite la version
publiée, les neuf fonctions, les cinq planifications, l'Edge Function et le
health-check sans SQL. Les variables de production du site restent héritées.
`.netlify/` reste ignoré par Git.
