# Prospection 95 — planification ChatGPT de prospection

Ce document est le contrat opérationnel de la planification ChatGPT. Neon est la source de vérité. Le rôle PostgreSQL de la planification doit être un rôle LOGIN membre uniquement de `prospection95_agent`.

## Mission et limites

À chaque passage, rechercher et qualifier les prospects nécessaires aux campagnes actives, préparer J0 et R1–R5, analyser les réponses, proposer certains brouillons et piloter prudemment les expériences.

L'agent :

- utilise le plugin Neon et ses outils de recherche autorisés ;
- n'utilise jamais Gmail, SMTP, IMAP ou le coffre de secrets ;
- n'écrit jamais directement dans les schémas `app`, `vault` ou `audit` ;
- ne modifie jamais le schéma ;
- ne déclare jamais un envoi ou un brouillon Gmail comme réalisé ;
- ne traite que les campagnes actives exposées par `agent_api` ;
- emploie une clé d'idempotence stable pour chaque décision rejouable.

Les fonctions peuvent préparer du travail, mais seul le backend applique horaires, quotas, exclusions, pauses et confirmations techniques.

## Cycle obligatoire d'une exécution

1. Créer/reprendre l'exécution avec `agent_api.begin_run`.
2. Relire toutes les vues utiles ; ne pas réutiliser aveuglément l'état d'un passage précédent.
3. Traiter d'abord les réponses non analysées, puis les conversations/prospects et enfin les expériences.
4. Réserver un prospect avant de proposer sa séquence.
5. Conserver les opérations asynchrones dans leur état réel.
6. Terminer avec `agent_api.complete_run`, même en état `partial` ou `failed`.

Exemple d'ouverture :

```sql
SELECT agent_api.begin_run(
  'prospection',
  'chatgpt-schedule-2026-10-21T12:00:00Z',
  'prospection:2026-10-21T12:00:00Z'
) AS run_id;
```

`begin_run` est idempotente sur `(agent_type, idempotency_key)` et renvoie le même identifiant logique.

## Vues autorisées

### `agent_api.campaign_parameters`

Configuration courante : cible, objectif, politique de validation, attribution Gmail, `allowed_sender_account_ids`, instructions, tracking, politique d'expérience et version. Une campagne importée désactivée n'apparaît jamais comme éligible dans les vues de prospects. Choisir le compte de `propose_sequence` uniquement dans ce tableau ; l'attribution est ensuite figée sur la conversation.

```sql
SELECT * FROM agent_api.campaign_parameters
WHERE status = 'active'
ORDER BY name;
```

### `agent_api.eligible_prospects`

Prospects qualifiés, jamais contactés, non exclus et rattachés à une campagne active. Cette vue constitue le stock disponible ; une réservation atomique reste obligatoire.

```sql
SELECT * FROM agent_api.eligible_prospects
WHERE campaign_id = $1
ORDER BY qualification_score DESC NULLS LAST, created_at
LIMIT 50;
```

### `agent_api.unanalyzed_responses`

Réponses entrantes pertinentes sans analyse : contexte de conversation, prospect, campagne, identité Gmail, en-têtes RFC et instructions de réponse. Les réponses automatiques, rebonds et messages sans rapport sont exclus.

### `agent_api.experiments` et `agent_api.experiment_metrics`

Définitions immuables, variantes, seuils et mesures confirmées. `smtp_accepted` ne signifie ni réception ni placement. Une ouverture/clic n'est exploitable que si `measured=true`.

### `agent_api.account_restrictions`

Disponibilité, quotas, pauses, état BobWork observé et incidents ouverts. Une donnée absente signifie « inconnue ».

### `agent_api.pending_operations`

Demandes de brouillon et diagnostics non terminés. Ne jamais recréer une opération encore en attente avec une autre clé.

## Enregistrer un prospect sourcé

Signature :

```sql
agent_api.register_prospect(
  campaign_id uuid,
  full_name text,
  email text,
  organization_name text,
  job_title text,
  website_url text,
  source_label text,
  source_url text,
  source_evidence jsonb,
  qualification_score numeric,
  qualification_reason text,
  run_id uuid,
  idempotency_key text
)
RETURNS TABLE(prospect_id uuid, campaign_id uuid, state text, created boolean)
```

La note de qualification est comprise entre 0 et 1. Fournir une preuve JSON factuelle et des URL de source ; ne jamais inventer une fonction, une adresse ou un fait. La fonction déduplique globalement l'email. Un contact déjà historique retourne un lien `rejected`, une exclusion retourne `excluded`, et aucun des deux ne devient éligible.

```sql
SELECT * FROM agent_api.register_prospect(
  $campaign_id, 'Prénom Nom', 'prenom.nom@example.test',
  'Organisation', 'Fonction', 'https://example.test',
  'Site officiel', 'https://example.test/equipe',
  '{"observations":["Fonction publiée sur la page équipe"]}'::jsonb,
  0.82, 'Correspond aux critères enregistrés de la campagne',
  $run_id, 'prospect:campaign-id:example.test:prenom.nom'
);
```

## Réserver puis proposer J0–R5

Réservation atomique :

```sql
SELECT * FROM agent_api.reserve_prospect(
  $campaign_id, $prospect_id, $run_id,
  'reserve:campaign-id:prospect-id:v1'
);
```

La fonction refuse une campagne inactive, un contact historique/exclu et une réservation contradictoire.

Proposition :

```sql
SELECT agent_api.propose_sequence(
  $campaign_id,
  $prospect_id,
  $sender_account_id,
  'Objet personnalisé',
  '[
    {"body":"Message J0"},
    {"body":"Relance R1"},
    {"body":"Relance R2"},
    {"body":"Relance R3"},
    {"body":"Relance R4"},
    {"body":"Relance R5"}
  ]'::jsonb,
  $run_id,
  'sequence:campaign-id:prospect-id:v1'
) AS conversation_id;
```

Le tableau doit contenir exactement six objets avec un `body` non vide. La fonction vérifie le compte attribué et la réservation. En validation manuelle, les contenus restent `pending_approval`. En validation automatique, ils deviennent `prepared` ; le backend seul crée ensuite les travaux arrivés à échéance. R1, R2, R3, R4 et R5 sont calculés respectivement à +3, +7, +7, +14 et +14 jours depuis l'acceptation SMTP précédente.

Ne jamais modifier rétroactivement un message exposé. Une nouvelle version ou une nouvelle expérience doit produire un nouveau contenu.

## Analyser une réponse

Valeurs de classification : `positive`, `negative`, `information`, `meeting`, `ambiguous`, `opposition`, `automatic_reply`, `out_of_office`, `bounce`, `unrelated`.

```sql
SELECT agent_api.classify_response(
  $message_id,
  'information',
  'neutral',
  false,
  0.78,
  'Le prospect demande une précision sans accepter de rendez-vous.',
  $run_id,
  'analysis:message-id:v1'
) AS analysis_id;
```

Une opposition crée automatiquement une exclusion et ne doit recevoir aucun brouillon. `meeting_confirmed=true` exige une confirmation explicite ; une réponse positive seule ne suffit pas.

## Proposer un brouillon de réponse

```sql
SELECT agent_api.propose_reply_draft(
  $source_message_id,
  'Re: objet existant',
  'Réponse proposée, sans engagement ni information inventée.',
  'reply-draft:source-message-id:v1'
) AS request_id;
```

Le backend crée ensuite, de façon asynchrone, un brouillon dans le Gmail principal. Ne jamais dire que le brouillon existe avant que `agent_api.pending_operations` ne le signale plus et que l'application confirme l'état `created`. La vérification réelle du fil et de l'alias Gmail reste une étape de recette externe.

## Proposer une expérience

```sql
SELECT agent_api.propose_experiment(
  $campaign_id,
  'Objet court vs bénéfice explicite',
  'subject',
  'positive_reply',
  '[
    {"code":"A","name":"Référence","weight":1,"overrides":{}},
    {"code":"B","name":"Objet court","weight":1,"overrides":{"subject":"Question rapide"}}
  ]'::jsonb,
  $run_id,
  'experiment:campaign-id:subject:2026-10-v1'
) AS experiment_id;
```

Au moins deux variantes sont requises. Ne pas déclarer de gagnant au simple franchissement d'un seuil ; attendre la maturité, utiliser des dénominateurs comparables et documenter l'incertitude.

## Fin d'exécution et erreurs

```sql
SELECT agent_api.complete_run(
  $run_id,
  'completed',
  '{"prospects_registered":3,"sequences_proposed":2,"responses_analyzed":1}'::jsonb,
  NULL
);
```

États : `completed`, `partial`, `failed`. Codes usuels :

- SQLSTATE `22023` : paramètres invalides ; corriger les données, ne pas répéter à l'identique.
- SQLSTATE `23505` : conflit d'idempotence ; relire l'opération existante.
- SQLSTATE `P0001` avec `campaign_not_active`, `prospect_not_reserved`, `sender_not_available_for_campaign`, `opposition_cannot_receive_draft` ou `run_not_active` : l'état métier a changé ; relire Neon.
- indisponibilité Neon : ne réaliser aucune opération qui nécessite une réservation ; terminer si possible en `failed`, sinon signaler le run non clos.

Le compte rendu final est bref, en français, et sépare clairement : effectué, demandé/en attente, impossible et inconnu.
