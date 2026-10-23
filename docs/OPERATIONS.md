# Guide d'exploitation — Prospection 95

## État initial sûr

Le système possède trois verrous indépendants :

1. variable Netlify `OUTBOUND_ENABLED=false` ;
2. `app.settings.outbound_enabled=false` ;
3. `app.settings.emergency_stop=true`.

Un déploiement ou un import ne doit modifier aucun de ces verrous. Seul le test SMTP unitaire, déclenché explicitement depuis le compte Gmail vers une adresse saisie par l'administrateur, peut vérifier la connexion sans ouvrir les envois de campagne.

## Environnements distants

- dépôt : `Vincladef/Prospection-95`, production sur `main` ;
- site Netlify : `prospection-95`, URL `https://prospection-95.netlify.app` ;
- projet Neon : `snowy-math-99695975`, base `prospection95` ;
- branche Neon principale : `br-bitter-hill-baxuhpw7`.

Une branche Neon temporaire doit toujours précéder une migration de la branche principale. Ne pas utiliser `DATABASE_URL` du runtime pour appliquer le schéma.

## Variables Netlify minimales

| Variable | Portée attendue | Sensibilité | État lors de la préparation |
| --- | --- | --- | --- |
| `VITE_NEON_AUTH_URL` | Builds | publique | configurée |
| `DATABASE_URL` | Functions | secrète | configurée avec `prospection95_runtime`, rôle applicatif restreint |
| `NEON_AUTH_JWKS_URL` | Functions | publique | configurée |
| `ADMIN_EMAIL` | Functions | non secrète | configurée |
| `APP_BASE_URL` | Functions | publique | configurée |
| `APP_TIMEZONE` | Functions | publique | configurée à `Europe/Paris` |
| `OUTBOUND_ENABLED` | Functions | non secrète | configurée à `false` |

`NEON_API_KEY` et `NETLIFY_AUTH_TOKEN` sont des jetons d'administration et ne sont pas requis par l'application. Ils doivent être absents de la configuration du site. Ne jamais les renommer pour les faire consommer par l'application.

### Clé du coffre

La clé AES de 32 octets est créée automatiquement après la première connexion de l’administrateur et conservée dans le store privé Netlify Blobs `prospection95-vault-keys`, région `eu-central-1`. La création est atomique (`onlyIfNew`) et les lectures utilisent la cohérence forte. La clé n’est envoyée ni au navigateur ni à Neon ; les Blobs ne sont accessibles qu’au code serveur du site.

`CREDENTIALS_ENCRYPTION_KEY` peut remplacer ce mécanisme en développement local. Une rotation utilise une nouvelle version (`CREDENTIALS_KEY_VERSION`) et doit réenregistrer les identifiants avant le retrait de l’ancienne clé. Ne jamais supprimer le store ou une version encore référencée par `vault.credentials.key_version` : les identifiants deviendraient irrécupérables.

## Migrations Neon

Les onze migrations sont additives et s'appliquent dans l'ordre lexical. Procédure :

1. créer une branche enfant de la branche principale ;
2. appliquer `db/migrations/001_...` à `011_...` avec le propriétaire de cette branche ;
3. exécuter toutes les assertions de `db/verify.sql` ;
4. inspecter le diff de schéma ;
5. obtenir l'accord explicite du propriétaire ;
6. prendre un snapshot/point de restauration ;
7. appliquer exactement les mêmes fichiers à la branche principale ;
8. relancer `db/verify.sql` avant de remplacer `DATABASE_URL`.

Pour un retour de sécurité sans destruction :

```sql
\i db/rollback/disable-application.sql
```

Ce script coupe l'envoi et diffère le travail actif. Un retour de schéma doit utiliser une restauration Neon contrôlée ; ne jamais supprimer des tables en urgence.

## Rôles SQL du runtime et des agents

Les migrations créent deux rôles de groupe `NOLOGIN` : `prospection95_app` et `prospection95_agent`.

Créer avec Neon un rôle LOGIN distinct pour le backend, puis :

```sql
GRANT prospection95_app TO prospection95_runtime;
```

Générer son URL poolée TLS et l'enregistrer dans `DATABASE_URL`. Vérifier :

```sql
SELECT pg_has_role(current_user, 'prospection95_app', 'member');
SELECT NOT has_schema_privilege(current_user, 'agent_api', 'CREATE');
```

Pour les planifications ChatGPT, créer un autre rôle LOGIN :

```sql
GRANT prospection95_agent TO prospection95_chatgpt;
```

Il ne doit recevoir aucun autre rôle. Vérifier avec les assertions de `db/verify.sql`, notamment l'absence totale d'accès à `vault.credentials`, `app.outbox_jobs` et `app.confirm_smtp_acceptance`.

## Import du CRM et de la V53

Dans **Paramètres → Prospects** :

1. sélectionner le CSV/JSON ou analyser les clés `localStorage` du navigateur V53 ;
2. examiner les volumes, emails valides, contacts non adressables, exclusions, historiques et doublons ;
3. confirmer uniquement après sauvegarde ;
4. contrôler les lignes rejetées et les campagnes créées.

Toutes les campagnes importées restent `inactive` avec `imported_disabled=true`. L'import ne crée aucun travail SMTP. Les vingt colonnes du CSV restent dans `app.import_rows`; une date française est interprétée en `Europe/Paris`. Un lien ou texte non-email reste dans `contact_raw` et n'est jamais destinataire SMTP.

Le CRM transmis a été uniquement prévisualisé localement pendant le développement : aucune donnée réelle n'a été ajoutée au dépôt ni à Neon.

## Ajouter les comptes Gmail

Prérequis : HTTPS et utilisateur Neon Auth correspondant à `ADMIN_EMAIL`. Le coffre est initialisé automatiquement à la première connexion.

1. Activer la validation en deux étapes du compte Google.
2. Créer un mot de passe d'application dédié.
3. Dans **Paramètres → Comptes Gmail**, choisir le rôle : expéditeur, Gmail principal ou boîte de test.
4. Saisir adresse, identité, mot de passe, limite et calendrier.
5. Lancer le test. Avec `OUTBOUND_ENABLED=false`, l'IMAP peut être vérifié mais aucune expédition n'est réalisée ; l'interface ne doit pas appeler cela un test d'envoi.
6. Vérifier la date IMAP et les éventuels codes d'erreur.

Dans le Gmail principal, configurer manuellement :

- les transferts des comptes expéditeurs vers le compte principal ;
- les identités **Envoyer des e-mails en tant que** ;
- l'autorisation et l'adresse de réponse correctes pour chaque alias.

Le worker lit `INBOX` et le dossier spécial IMAP `\Sent` de façon incrémentale. Un message envoyé manuellement n'est conservé que s'il correspond à une conversation existante.

### Recette réelle brouillon/alias

Cette recette ne peut pas être remplacée par un test unitaire :

1. utiliser deux adresses de test explicitement autorisées ;
2. envoyer J0 vers le destinataire de test ;
3. répondre, laisser le transfert arriver au Gmail principal ;
4. vérifier dans Neon la réponse et l'arrêt des relances ;
5. faire proposer un brouillon via `agent_api.propose_reply_draft` ;
6. confirmer que le brouillon apparaît dans le Gmail principal, dans le bon fil, avec le bon alias `From` ;
7. le modifier et l'envoyer manuellement ;
8. confirmer la détection dans `\Sent` et l'absence de second brouillon/relance.

Le backend IMAP positionne les en-têtes RFC mais ne peut pas garantir à lui seul le fil ou l'alias sélectionné par l'interface Gmail. Si ce test échoue, conserver la demande en attente et prévoir un consentement OAuth Gmail API explicite ; un mot de passe d'application ne donne pas accès à l'API REST Gmail.

## BobWork et vérificateurs

La clé BobWork est saisie dans **Paramètres → Tests & réception** et stockée dans le coffre, jamais comme variable BobWork Netlify. L'état « configuré » ne prouve pas que l'API fonctionne.

Si BobWork fournit une documentation d’API officielle, ouvrir **Contrat API avancé** et renseigner l’URL HTTPS, le chemin des comptes, l’URL de documentation et le schéma d’authentification exactement comme documentés. En l’absence de contrat officiel vérifiable, conserver uniquement la clé : le worker laisse alors l’état inconnu au lieu d’inventer un endpoint.

Après saisie :

1. attendre le worker `sync-bobwork` ;
2. vérifier une réponse réelle et la date `observed_at` ;
3. comparer les comptes renvoyés aux comptes Gmail ;
4. conserver `unknown` pour toute propriété absente ;
5. ne modifier aucun paramètre de préchauffage automatiquement.

L'adaptateur doit être validé contre la documentation et une clé réelles avant de considérer l'intégration opérationnelle. TinyFish reste dans la planification ChatGPT, jamais dans Netlify.

## Suivi signé des ouvertures et des clics

Les options se règlent campagne par campagne et ne modifient que les futurs envois. Le backend transforme les liens HTTP(S) en redirections signées et ajoute, si demandé, un pixel d'ouverture. La clé HMAC est créée atomiquement dans le store privé Netlify Blobs `prospection95-tracking-keys`, région `eu-central-1`, puis lue en cohérence forte. `TRACKING_SIGNING_KEY`, limitée aux Functions, permet uniquement un remplacement contrôlé.

Les endpoints publics `/t/c/:token` et `/t/o/:token` n'acceptent que des jetons signés et expirables. La base conserve l'empreinte SHA-256 du jeton, le domaine du lien et une classe d'agent ; elle ne conserve ni adresse IP ni agent utilisateur brut. Une ouverture reste une observation technique potentiellement déclenchée par un proxy d'images comme Gmail. Ne jamais la présenter comme une lecture humaine certaine.

Recette réelle minimale :

1. conserver les trois verrous d'envoi actifs et utiliser uniquement le test SMTP explicitement déclenché vers une adresse autorisée ;
2. pour la recette d'une campagne, obtenir d'abord l'autorisation commerciale explicite puis n'activer qu'un destinataire de test ;
3. activer le suivi sur la campagne avant la génération de l'email ;
4. vérifier que le clic redirige vers la destination et apparaît comme « Clic observé » ;
5. vérifier l'ouverture sur un client qui charge les images, en conservant la qualification « signal technique ».

## Arrêt, reprise et activation SMTP

### Arrêt immédiat

Utiliser le bouton d'arrêt d'urgence. Si l'interface est indisponible, exécuter `db/rollback/disable-application.sql`, puis remettre `OUTBOUND_ENABLED=false`.

### Reprise

Avant de désactiver l'arrêt d'urgence :

- résoudre les travaux `uncertain` et les incidents sérieux ;
- vérifier les exclusions et l'historique global ;
- vérifier chaque compte, quota, horaire et état BobWork réellement disponible ;
- contrôler les campagnes actives et l'approbation des messages ;
- effectuer la recette de réponse juste avant relance ;
- saisir une raison de reprise dans l'interface.

### Activation commerciale

L'activation nécessite une autorisation explicite du propriétaire. Ordre conseillé :

1. compte et destinataire de test uniquement ;
2. `OUTBOUND_ENABLED=true` ;
3. arrêt d'urgence encore actif ;
4. activer `app.settings.outbound_enabled` ;
5. désactiver l'arrêt d'urgence avec une raison ;
6. vérifier un unique message de test et sa réconciliation ;
7. réactiver seulement les campagnes voulues.

## Sauvegarde et restauration

L'export JSON depuis **Paramètres → Prospects** sert à l'inspection et à la conservation métier. Il ne remplace pas une sauvegarde de base complète.

Avant migration, import important ou activation : créer un snapshot/une branche Neon. Pour restaurer :

1. activer l'arrêt d'urgence et couper `OUTBOUND_ENABLED` ;
2. restaurer le snapshot dans une branche séparée ;
3. exécuter `db/verify.sql` et comparer les volumes ;
4. basculer seulement après validation ;
5. conserver l'ancienne branche jusqu'à la fin de la recette.

Ne pas réimporter aveuglément l'export JSON dans le formulaire CSV : les formats n'ont pas le même rôle.

## Build, déploiement et retour arrière

Avant commit :

```bash
npm ci
npm run check
npx netlify-cli@latest build --offline
git diff --check
```

Le push sur `main` déclenche la production Netlify. Ne pousser qu'après migration principale réussie et configuration sûre des variables. Après déploiement : vérifier `/api/health`, la connexion, le tableau de bord et les fonctions planifiées, sans activer SMTP.

Retour arrière applicatif : republier le dernier déploiement Netlify sain ou revert du commit, puis laisser les verrous d'envoi actifs. Les migrations sont additives ; restaurer Neon séparément seulement si la compatibilité l'exige.

## Limites à ne pas masquer

- Aucun email Gmail, brouillon/alias, BobWork ou parcours TinyFish réel n'a encore été validé avec des identifiants utilisateur.
- Le coffre dépend du store privé Netlify Blobs ; ne jamais supprimer `prospection95-vault-keys` tant que des identifiants existent dans Neon.
- Le suivi d'ouverture/clic est instrumenté et signé, mais une recette réelle sur un futur email de campagne reste nécessaire ; les ouvertures peuvent être bruitées par les proxys et scanners.
- Les métriques A/B reposent sur les événements présents ; aucune conclusion statistique automatique n'est fabriquée.
- Le build et une branche Neon de validation ne prouvent pas le fonctionnement des services externes.

## Checklist de recette finale

- [ ] onze migrations et toutes les assertions `db/verify.sql` sur la branche principale ;
- [ ] `DATABASE_URL` du rôle runtime restreint ;
- [ ] aucun jeton d'administration dans le runtime Netlify ;
- [ ] coffre Netlify Blobs initialisé et ajout Gmail/BobWork disponible ;
- [ ] compte Neon Auth administrateur et refus d'un autre compte ;
- [ ] import contrôlé sans travail SMTP ;
- [ ] Gmail principal + expéditeur de test, IMAP réel ;
- [ ] J0 de test, réponse, arrêt des relances, brouillon, alias/fil, envoi manuel et réconciliation `\Sent` ;
- [ ] diagnostic de test idempotent et rapport sourcé ;
- [ ] BobWork réel ou état explicitement inconnu ;
- [ ] concurrence, quota, résultat SMTP incertain et arrêt d'urgence ;
- [ ] `OUTBOUND_ENABLED` maintenu à `false` jusqu'à l'autorisation commerciale explicite.
