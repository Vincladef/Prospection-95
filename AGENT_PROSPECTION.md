# Prospection 95 — planification ChatGPT de prospection

Ce document est le contrat opérationnel de la planification ChatGPT. Neon est la source de vérité. En production, la planification se connecte avec le login existant `prospection95_runtime`, membre de `prospection95_agent` en plus de son rôle backend. Elle n'utilise que le schéma `agent_api` pour ses opérations commerciales.

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
3. Traiter d'abord les réponses non analysées, puis les prospects des campagnes actives.
4. Réserver un prospect, lui attribuer si nécessaire une variante A/B stable, puis traiter au plus une passe de rédaction pour ce prospect et cette attribution pendant le run courant.
5. Ne proposer J0–R5 qu'après la dernière passe archivée de ce prospect et de cette variante.
6. Conserver les opérations asynchrones dans leur état réel.
7. Terminer avec `agent_api.complete_run`, même en état `partial` ou `failed`.

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

Configuration courante : cible, objectif, politique de validation, attribution Gmail, `allowed_sender_account_ids`, instructions, tracking, politique d'expérience et version. Une campagne importée désactivée n'apparaît jamais comme éligible dans les vues de prospects. Choisir le compte de `propose_completed_sequence` uniquement dans ce tableau ; l'attribution est ensuite figée sur la conversation.

Les anciennes colonnes `writing_iteration_*` sont conservées pour compatibilité, mais ne pilotent plus la production. L'avancement fiable est celui de `agent_api.prospect_iteration_progress`.

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

Disponibilité, quotas, pauses, état et métriques BobWork observés, et incidents ouverts. Une donnée absente signifie « inconnue ».

`bobwork_metrics.ready_for_outbound=false` est un signal consultatif du service de préchauffage, pas une pause du compte ni un verrou serveur. Pris isolément, il ne bloque ni la recherche, ni la rédaction, ni la proposition, ni la planification. Seuls une pause enregistrée, un incident sérieux, un compte indisponible ou un garde-fou backend effectif sont bloquants ; quotas et horaires restent applicables.

### `agent_api.instruction_attachments`

Pièces jointes associées aux consignes globales, aux campagnes et aux variantes. Lire `extracted_text` lorsqu'il est disponible et toujours conserver le nom/type du fichier comme provenance. Pour un format binaire non extrait, ne pas inventer son contenu.

### `agent_api.bobwork_latest_resources`

Dernières réponses officielles BobWork pour les ressources `stats` et `domains`, assainies côté backend. Cette vue est en lecture seule et complète les métriques par compte.

### `agent_api.pending_operations`

Demandes de brouillon et diagnostics non terminés. Ne jamais recréer une opération encore en attente avec une autre clé.

### `agent_api.writing_settings`, `agent_api.prospect_iteration_progress` et `agent_api.prospect_iteration_history`

`writing_settings` expose les consignes générales à relire avant chaque rédaction. `prospect_iteration_progress` donne l'avancement par campagne, prospect et attribution A/B. `prospect_iteration_history` conserve l'entrée et la sortie exactes de chaque passe, sa variante, son run et ses horodatages. Une passe `completed` est immuable.

`pending_campaign_iterations` et les fonctions `claim/complete/fail_campaign_iteration` de la migration 018 sont obsolètes : la file de campagne est vide et le rôle agent ne peut plus appeler ces fonctions.

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

## Révisions successives de rédaction IA

La campagne encode éventuellement plusieurs passes dans `ai_instructions` sous la forme :

```text
<!-- prospection-95:writing-iterations:v1 -->
### Itération 1
[consignes de rédaction]
### Itération 2
[consignes de relecture critique]
### Itération 3
[consignes de révision finale]
```

Le nombre de passes est paramétrable dans l'éditeur (1 à 10), avec **trois passes par défaut** pour les nouvelles campagnes. Le backend n'appelle pas de LLM : la planification ChatGPT réalise la passe demandée. Une instruction simple sans marqueur est traitée comme une unique passe historique.

Une activation planifiée exécute **au plus une passe par couple prospect + attribution A/B**. Elle ne doit jamais enchaîner les trois passes dans le même run : Neon avance durablement de `0/3` à `1/3`, puis `2/3`, puis `3/3` lors d'activations distinctes. Deux prospects de la même campagne ont donc des historiques indépendants ; deux variantes ont également des configurations et archives distinctes.

1. Réserver d'abord le prospect avec `agent_api.reserve_prospect`.
2. Lire les expériences `recruiting` ou `threshold_reached`. Si une expérience s'applique, créer ou retrouver son attribution stable :

```sql
SELECT * FROM agent_api.assign_prospect_variant(
  $experiment_id,
  $prospect_id,
  $run_id,
  'variant:experiment-id:prospect-id'
);
```

Une conversation ne porte qu'une attribution. S'il existe plusieurs expériences ouvertes sur la même campagne, sélectionner exactement celle indiquée par la stratégie et les instructions de test ; ne jamais combiner arbitrairement leurs variantes. Si le choix est ambigu, terminer le run en `partial` sans proposer d'emails.

3. Réclamer la prochaine passe avec l'identifiant d'attribution retourné, ou `NULL` seulement lorsqu'aucune expérience ouverte ne s'applique :

```sql
SELECT * FROM agent_api.claim_prospect_iteration(
  $campaign_id,
  $prospect_id,
  $experiment_assignment_id,
  $run_id,
  'prospect-iteration:campaign-id:prospect-id:assignment-or-reference:scheduled-run-id'
);
```

La fonction retourne `iteration_run_id`, `iteration_state_id`, la variante stable, le numéro de passe, son instruction et `input_sequence`. Pour l'itération 1, l'entrée est la séquence de campagne avec les seuls blocs surchargés par cette variante. Pour les suivantes, c'est la sortie archivée de la passe précédente. Une modification de la campagne, de la variante, du prospect ou des consignes globales démarre un nouveau cycle sans supprimer l'ancien historique.

4. Appliquer les consignes globales, le contexte vérifié du prospect et uniquement `instruction` à la séquence complète reçue : objet, instructions d'objet, J0, R1–R5 et leurs instructions. La critique doit produire une version effectivement révisée, pas un commentaire séparé. Ne jamais transférer une consigne ou un contenu d'une autre variante.
5. Enregistrer la sortie complète :

```sql
SELECT agent_api.complete_prospect_iteration(
  $iteration_run_id,
  $run_id,
  '{
    "subject":"Objet révisé",
    "subjectInstructions":"Consignes objet",
    "steps":["J0","R1","R2","R3","R4","R5"],
    "stepInstructions":["Consigne J0","Consigne R1","Consigne R2","Consigne R3","Consigne R4","Consigne R5"]
  }'::jsonb,
  'prospect-iteration-complete:iteration-run-id'
);
```

Chaque réussite archive l'entrée et la sortie de cette passe. Après la dernière, l'état du prospect et de son attribution passe à `completed`. Lors d'un nouveau run, relire `prospect_iteration_progress` avant d'agir.

6. En cas d'échec après la réclamation, libérer proprement la passe afin qu'une activation ultérieure reprenne le même numéro :

```sql
SELECT agent_api.fail_prospect_iteration(
  $iteration_run_id,
  $run_id,
  'generation_incomplete'
);
```

Les réclamations expirent après deux heures et les répétitions avec la même clé sont idempotentes. Une contrainte empêche le même run planifié d'effectuer deux passes sur le même état prospect/variante. Les sorties ne modifient jamais les modèles de référence de la campagne : elles restent des versions personnalisées archivées pour le prospect concerné.

## Réserver puis proposer J0–R5

Réservation atomique :

```sql
SELECT * FROM agent_api.reserve_prospect(
  $campaign_id, $prospect_id, $run_id,
  'reserve:campaign-id:prospect-id:v1'
);
```

La fonction refuse une campagne inactive, un contact historique/exclu et une réservation contradictoire.

Une fois `status='completed'` dans `prospect_iteration_progress`, proposer exclusivement la dernière version archivée :

```sql
SELECT agent_api.propose_completed_sequence(
  $iteration_state_id,
  $sender_account_id,
  $run_id,
  'sequence:iteration-state-id:v1'
);
```

La fonction vérifie la réservation, le compte expéditeur, l'achèvement de toutes les passes et l'absence de changement de configuration. Elle attache l'attribution A/B à la conversation et marque la variante comme exposée. `agent_api.propose_sequence` n'est volontairement plus exécutable par le rôle agent afin qu'aucune planification ne puisse contourner les itérations.

En validation manuelle, les contenus restent `pending_approval`. Son libellé utilisateur est « En attente… » : la valeur technique ne change pas. Tant que les passes ne sont pas toutes achevées, l'interface affiche « En attente… x/n » depuis `prospect_iteration_progress`, séparément pour chaque prospect et attribution A/B. Ce compteur ne doit jamais être modifié comme un statut de message. Aucun contenu ne peut être validé, planifié ou envoyé avant l'état `completed`, et l'absence de message ne doit jamais être interprétée comme « Préparé ».

En validation automatique, les contenus deviennent `prepared` après l'achèvement confirmé des passes ; le backend seul crée ensuite les travaux arrivés à échéance. R1, R2, R3, R4 et R5 sont calculés respectivement à +3, +7, +7, +14 et +14 jours depuis l'acceptation SMTP précédente.

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

Le backend crée ensuite, de façon asynchrone, un brouillon dans le Gmail principal lorsqu'il est configuré ; sinon il utilise le compte expéditeur de la conversation. Ne jamais dire que le brouillon existe avant que `agent_api.pending_operations` ne le signale plus et que l'application confirme l'état `created`. La vérification réelle du fil et de l'alias Gmail reste une étape de recette externe.

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
