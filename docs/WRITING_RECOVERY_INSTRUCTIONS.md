## Reprise obligatoire du stock de rédaction (correctif 2026-11-11)

Après les réponses humaines prioritaires et avant les recherches externes,
faire avancer le stock existant. Les objectifs de sourcing ne remplacent jamais
la rédaction des prospects déjà disponibles. La vue `eligible_prospects` inclut
les états `candidate` ET `reserved` : une réservation n'est ni un travail terminé,
ni une raison de rechercher uniquement de nouveaux contacts.

1. Vérifier `to_regclass('agent_api.pending_prospect_writing')`. Avec la migration
   049, lire la file avec le rôle runtime habituel :

```sql
WITH backlog AS (
 SELECT q.*,row_number() OVER (PARTITION BY campaign_id ORDER BY
   CASE WHEN next_action='finalize' THEN 0
        WHEN iteration_state_id IS NOT NULL THEN 1 ELSE 2 END,
   last_progress_at,prospect_id) AS tour
 FROM agent_api.pending_prospect_writing q WHERE next_action<>'wait'
)
SELECT * FROM backlog ORDER BY tour,last_progress_at,campaign_id,prospect_id;
```

Si 049 n'est pas encore appliquée, lire `eligible_prospects` ET
`prospect_iteration_progress`, joindre par campagne et prospect, puis retrouver
l'attribution stable selon le contrat avant toute passe. Les cycles `pending`,
les réservés sans cycle et les cycles `completed` sans séquence proposée sont
à traiter aussi. Ne pas abandonner toute la rédaction parce qu'une nouvelle vue
ou la validation de 049 est absente.

2. Parcourir les campagnes en tours successifs : d'abord une opération réelle par
   campagne disposant de travail, puis poursuivre les tours dans le temps restant.
   Reprendre les plus anciens cycles à l'intérieur de chaque campagne. Ne pas
   finir systématiquement le run après les expériences et le sourcing. Si le
   budget réel impose un arrêt, consigner les campagnes/prospects non traités,
   leur ancienneté et la raison précise ; ne pas prétendre que la file était vide.
   Une erreur sur un prospect ne bloque pas les autres.
3. Réserver avec `reserve_prospect` si nécessaire, retrouver l'attribution stable
   avec `assign_prospect_variant_v2`, puis `claim_prospect_iteration`. Réutiliser
   l'attribution d'un cycle commencé ; ne jamais réinitialiser son compteur.
   Faire UNE nouvelle passe maximum par prospect et attribution pendant cette
   activation. Si le claim retourne une passe déjà `completed` ou `failed` dans
   ce run, passer au suivant ; ne pas ouvrir un second run pour contourner la règle.
4. Reprendre exactement `input_sequence` et appliquer la consigne de la passe
   réclamée, les règles générales et les faits sourcés du prospect. Produire une
   séquence révisée, pas seulement un commentaire d'analyse. Conserver les quatre
   clés : `subject`, `subjectInstructions`, `steps`, `stepInstructions`. Les deux
   tableaux ont SIX emplacements de chaînes. Le nombre de passes IA (3, 5, 6…)
   est indépendant du nombre de messages actifs (J0 et ses relances).
5. Avec 049, appeler avant chaque completion :

```sql
SELECT agent_api.validate_prospect_iteration_sequence(
 $iteration_run_id,$run_id,$sequence::jsonb
);
```

   Corriger les chemins figurant dans `errors` dans LA MÊME passe réclamée avant
   `complete_prospect_iteration`. Cet ajustement d'un JSON rejeté n'est pas une
   nouvelle passe IA. Les messages actifs doivent être rédigés ; les emplacements
   finaux désactivés restent vides. Ne jamais fabriquer R3–R5 pour contourner un
   validateur lorsqu'une campagne impose seulement deux relances. Sans 049, un
   tel rejet est un blocage backend à signaler pour cette campagne ; poursuivre
   les autres campagnes et leurs séquences à six messages. Une erreur de format
   n'autorise ni à vider les étapes actives, ni à ignorer les consignes.
6. Enregistrer la passe avec une clé stable, relire l'historique et le compteur
   exact de CETTE attribution. Une erreur déjà marquée `failed` se reprend lors
   d'une activation ultérieure, avec le même cycle et son historique conservé.
7. Si le cycle est déjà `completed`, finaliser directement avec
   `propose_completed_sequence` ; ne pas réclamer une nouvelle passe. Relire la
   confirmation de la proposition. Une passe finale réussie doit être suivie de
   cette finalisation dans le même passage lorsque l'état le permet. Respecter
   les expéditeurs, la validation manuelle, les pauses et les exclusions ; une
   proposition n'est jamais un envoi confirmé.
8. Faire ensuite la recherche externe obligatoire pour chaque campagne active
   déficitaire, selon les règles de sourcing existantes. Ne pas augmenter les
   objectifs ni modifier les campagnes, leurs passes ou la cadence horaire.
9. Avant `complete_run`, relire la file et l'historique. Compter par campagne les
   prospects disponibles au début, les passes réellement archivées, les séquences
   finalisées et le reste à faire (nouveaux, cycles à reprendre, finalisations,
   erreurs, verrous). Une exécution sans aucune passe malgré un stock disponible
   doit rester `partial`, avec les raisons concrètes ; un résumé ne remplace
   jamais une opération persistée.
