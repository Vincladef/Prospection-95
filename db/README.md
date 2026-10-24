# Schéma Lakebase Postgres

Le dossier contient dix-neuf migrations additives, rejouables et sans données métier embarquées. Elles doivent être appliquées dans l’ordre lexical.

1. `001_foundation.sql` : rôles, schémas, paramètres, campagnes, comptes publics, prospects, anti-recontact et coffre chiffré.
2. `002_messaging.sql` : versions de messages, conversations, SMTP/IMAP, file d’envoi, baux et brouillons.
3. `003_experiments_deliverability_imports.sql` : A/B, vérificateurs, BobWork, incidents, audit et import V53.
4. `004_agent_contract.sql` : vues et fonctions limitées destinées aux planifications ChatGPT.
5. `005_permissions.sql` : privilèges minimaux et séparation stricte entre backend et agents.
6. `006_agent_operations.sql` : enregistrement sourcé des prospects, diagnostics matérialisés, quotas et incidents.
7. `007_sequence_scheduler.sql` : création idempotente des travaux J0–R5 arrivés à échéance.
8. `008_sent_mail_reconciliation.sql` : rapprochement des messages Gmail envoyés manuellement.
9. `009_campaign_sender_contract.sql` : comptes autorisés par campagne et attribution durable des conversations.
10. `010_signed_interaction_tracking_and_v53_verifiers.sql` : suivi signé des ouvertures/clics et catalogue V53 des vérificateurs.
11. `011_v53_tracking_defaults.sql` : activation par défaut du suivi des interactions sur les campagnes.
12. `012_product_flexibility_and_attachments.sql` : pièces jointes privées d’instructions et ressources BobWork étendues pour les agents.
13. `013_application_role_new_resources.sql` : droits du backend Netlify sur les nouvelles ressources et privilèges par défaut pour les prochains objets applicatifs.
14. `014_sequence_progression_and_diagnostics.sql` : progression effective de J0 à R5 après acceptation SMTP et compatibilité du worker avec les diagnostics.
15. `015_crm_plugin_contract.sql` : contrat restreint et idempotent de création de campagnes inactives pour le plugin CRM.
16. `016_crm_campaign_update.sql` : modification contrôlée des campagnes inactives, des modèles versionnés et des variantes A/B non exposées.
17. `017_crm_campaign_ai_instructions.sql` : modification limitée des consignes de rédaction sur une campagne active ou inactive.
18. `018_campaign_iteration_workflow.sql` : progression persistante des passes de rédaction, archive immuable et contrat agent idempotent.
19. `019_prospect_variant_iteration_workflow.sql` : révisions successives archivées par prospect et attribution A/B, proposition finale verrouillée et accès agent hérité par le login runtime existant.

## Principes de sécurité

- `prospection95_app` et `prospection95_agent` sont des rôles de groupe `NOLOGIN`. En production, le login existant `prospection95_runtime` hérite des deux contrats afin que Netlify et les planifications puissent utiliser le même identifiant sans exposer un second mot de passe.
- Le rôle agent ne possède aucun privilège sur `vault`, les tables `app`, les confirmations SMTP ou les journaux bruts.
- `vault.credentials` ne contient que le ciphertext AES-256-GCM, le nonce, le tag et la version de clé. La clé maître reste exclusivement dans Netlify.
- Une nouvelle base démarre avec `outbound_enabled=false`. Après autorisation du propriétaire, cet état opérationnel est persistant et n’est jamais réinitialisé lors d’un déploiement.
- Un import ne crée aucun job d’envoi et force toutes les campagnes créées à l’état `inactive` avec `imported_disabled=true`.
- Un statut CSV « Envoyé » est conservé comme déclaration historique non confirmée ; seule `app.confirm_smtp_acceptance` ou une réconciliation Gmail peut créer une confirmation technique.

## Application contrôlée

Le flux recommandé est : préparer la migration sur une branche Neon, exécuter `verify.sql`, inspecter le diff, puis promouvoir après validation. Les migrations de schéma utilisent une connexion directe. L’application Netlify utilise ensuite une URL poolée affectée à un rôle de connexion membre de `prospection95_app`.

Après application :

```sql
\i db/verify.sql
```

`verify.sql` est en lecture seule. Pour remettre immédiatement le système en état sûr sans supprimer de donnée, exécuter `rollback/disable-application.sql`.

## Import V53

`app.import_rows` conserve exactement les vingt colonnes de l’export CSV, ainsi que les valeurs normalisées et les erreurs de validation. Le backend suit ce protocole :

1. calculer SHA-256 du fichier et de chaque ligne ;
2. créer ou retrouver `app.import_batches` ;
3. insérer les lignes, parser date, booléens et type de contact sans perdre les valeurs brutes ;
4. afficher une prévisualisation ;
5. appeler `app.commit_import_batch(batch_id, actor)` après confirmation ;
6. examiner les lignes rejetées et activer manuellement les campagnes voulues.

Les contacts qui ne sont pas des emails (URL ou autre) sont conservés avec `contact_raw` et ne deviennent jamais des destinataires SMTP. Les six contenus J0–R5 et l’ID Gmail historique restent dans `app.import_rows` jusqu’à une réconciliation contrôlée.
