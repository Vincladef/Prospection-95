# Prospection 95 — passage commercial horaire

Effectue un passage opérationnel réel dans Neon : projet snowy-math-99695975,
branche br-bitter-hill-baxuhpw7, base prospection95, login prospection95_runtime.
Lis le contrat actuel AGENT_PROSPECTION.md du dépôt Vincladef/Prospection-95,
en particulier la reprise du stock, les RPC de rédaction et les réponses. Les
réglages actuels de Neon prévalent sur les exemples et les souvenirs du chat.

## Périmètre

Utilise uniquement les vues et fonctions métier agent_api pour les opérations
commerciales. Exception : le SELECT documenté de app.campaign_prospects pour
compter les inscriptions du jour Europe/Paris. Aucune autre lecture/écriture
directe de app, aucun accès vault, Gmail, SMTP, IMAP, code, schéma ou déploiement.
Ne change aucune campagne, fréquence, autorisation d'envoi, pause, exclusion,
validation ou quota. Respecte les sources, la déduplication intercampagnes, les
comptes autorisés, l'identité Gmail stable et les plages appliquées par le backend.
N'invente ni contact, fait, résultat, précision, disponibilité ou envoi.

Ouvre UN run idempotent avec begin_run('prospection',...). Une activation n'ouvre
pas plusieurs runs pour accélérer artificiellement les itérations. Les clés sont
stables. Vérifie les signatures réelles si nécessaire ; ne devine pas une RPC.

## 1. Réponses humaines prioritaires

Lis fraîchement unanalyzed_responses : identifiant, réception, body_text et sa
longueur. Lis le texte complet ; si vide, relis la source dans
reply_conversation_messages. Un contenu toujours indisponible est un incident
backend à signaler avec ancienneté, pas un mail Gmail prétendument vide. Continue
avec les sources lisibles. Analyse chaque nouvelle réponse avec classify_response :
positive, negative (refus simple), opposition (arrêt/désinscription), information,
meeting, ambiguous, automatic_reply, out_of_office, bounce ou unrelated selon le
contrat. Qualifie le nouveau texte humain, pas la prospection citée. Justifie et
relis l'enregistrement ; meeting_confirmed exige un accord explicite.

Pour pending_reply_iterations, lis l'échange pertinent, claim_reply_iteration,
puis rédige réellement l'objet et le corps selon generalWritingInstructions,
replyInstructions, instruction et les pièces extraites replyAttachments. Termine
avec complete_reply_iteration ou fail_reply_iteration. UNE passe par source et
activation, aucune recréation de cycle. Le backend applique replyMode et
reply_auto_scope ; lui seul crée le brouillon ou programme la réponse après la
dernière passe, avec attente variable minimale de dix minutes et contrôles.
N'appelle pas propose_reply_draft. Une demande de brouillon n'est pas une preuve
Gmail : distingue demandé, confirmé, échec et envoi SMTP accepté. Respecte les
réponses manuelles et les sources devenues obsolètes.

Un refus simple negative peut recevoir UNE réponse courte, compréhensive et
polie, sans nouvelle offre, question, lien ni relance. Une opposition, exclusion,
absence, automatisme, rebond ou message sans rapport ne reçoit pas de réponse
commerciale. Ne lève jamais une exclusion. Les relances de prospection restent
arrêtées après une réponse humaine pertinente.

## 2. Reprendre les rédactions existantes AVANT le sourcing

C'est une obligation de travail, pas une simple lecture de compteurs. Le stock
comprend les candidats ET les réservés. Un prospect réservé peut n'avoir aucun
cycle commencé. Les recherches externes ne remplacent pas leur rédaction.

Lis les paramètres et consignes nécessaires, puis cette file compacte :

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

Exécute d'abord UN TOUR COMPLET : une rédaction ou finalisation réelle pour
CHAQUE campagne qui a du travail disponible. Ne t'arrête pas après le premier
prospect global. « Une passe par activation » s'applique à CHAQUE prospect et
attribution ; ce n'est pas une limite d'une seule rédaction pour toute l'application.
Après ce tour, poursuis les tours dans le temps disponible, en reprenant les plus
anciens cycles. Les campagnes sans cycle, notamment une campagne nouvelle, doivent
avancer elles aussi. Une erreur locale ne bloque pas le tour des autres campagnes.

Pour chaque ligne :
- Réserve si nécessaire avec reserve_prospect ; retrouve l'attribution stable
  avec assign_prospect_variant_v2 selon le test actuel. Un cycle commencé garde
  son attribution et ses consignes figées. Ne réinitialise aucun compteur.
- Si next_action=finalize, appelle propose_completed_sequence avec l'état terminé
  et l'expéditeur autorisé. Ne réclame aucune passe supplémentaire.
- Sinon, claim_prospect_iteration et applique réellement la consigne de LA passe
  reçue à input_sequence et aux faits vérifiés du prospect. Cette entrée contient
  déjà la dernière version : NE CHARGE PAS TOUT L'HISTORIQUE DE TOUS LES PROSPECTS.
  Si utile, filtre prospect_iteration_history par iteration_state_id et numéro
  précédent seulement. Lis les pièces et consignes propres à ce contexte.
- Conserve subject, subjectInstructions, steps et stepInstructions ; les deux
  tableaux ont SIX emplacements de chaînes. Le nombre de passes IA est distinct
  du nombre de messages actifs. Les étapes finales désactivées restent VIDES :
  une campagne limitée à J0/R1/R2 ne doit jamais acquérir R3/R4/R5.
- Appelle validate_prospect_iteration_sequence(iteration_run_id,run_id,sequence),
  corrige les champs indiqués dans errors dans LA MÊME passe, puis
  complete_prospect_iteration avec une clé stable. Archive une séquence réellement
  révisée, pas un commentaire ou une fausse réussite. Si échec irrécupérable,
  fail_prospect_iteration et continue le tour. Une passe déjà failed/completed
  pour ce run ne permet pas d'en créer une seconde.
- Relis l'archive et le compteur de CETTE attribution. Après la dernière passe,
  finalise immédiatement avec propose_completed_sequence si l'état le permet.
  En validation manuelle, conserve pending_approval : ne valide rien. Le backend
  choisit le compte du pool et applique les restrictions ; tu n'envoies rien.

Si une nouvelle vue/RPC manque réellement, utilise eligible_prospects et
prospect_iteration_progress filtrés par campagne/prospect pour reprendre les
séquences possibles. Signale le blocage de format d'une séquence courte, sans
inventer de rappels ; continue les autres campagnes.

## 3. Expériences A/B/C

Fais avancer chaque test ouvert avec advance_experiment. Un seul test ouvert par
campagne ; aucun mélange arbitraire d'expériences ou réattribution d'un prospect
exposé. Active le prochain draft pertinent si aucun test n'est ouvert. Si mature,
analyse les métriques confirmées et les dénominateurs SMTP, puis conclus uniquement
avec un gagnant justifiable, une rationale et les limites. Aucun faux résultat,
aucune conclusion sur les seuls clics/ouvertures. Des populations différentes
sont une limite d'interprétation, pas une interdiction de travailler. Si stabilize,
attribue la gagnante close ; si continue, propose/active le test suivant selon les
next_test_instructions, les résultats et le contrat. Respecte seuils et maturation.

## 4. Sourcing quotidien, après le premier tour de rédaction

Pour TOUTES les campagnes active avec objectif >0, compte les inscriptions de la
journée civile Europe/Paris avec le SELECT documenté de campaign_prospects.
Eligible_prospects est un stock, pas le compteur du jour. Si compteur refusé,
signale l'erreur et l'inconnu ; ne change aucun droit. Compare l'objectif aux
ajouts confirmés hors rejected/excluded. Pour chaque campagne déficitaire,
effectue une recherche externe réelle de contacts professionnels et emails
vérifiables, avec faits, preuve et URL, puis register_prospect avec clé stable
et relecture. Priorise celles à zéro et les variantes moins alimentées. Les
candidats/doublons ne sont pas des inscriptions. Une file vide déclenche la
recherche ; aucun résultat sérieux ne doit être inventé. Les objectifs sont des
objectifs de sourcing, pas des quotas d'envoi. Respecte les limites raisonnables.

Ne recherche/n'enregistre rien pour existing_only, inactive ou archived. Existing_only
permet uniquement les rédactions/réponses/propositions de ses prospects existants.
Préserve les critères de chaque campagne/variante et la déduplication globale.
Réserve les nouveaux contacts et prépare une passe s'il reste du temps, sans
négliger les tours du stock ancien.

## 5. Contrôles et clôture véridiques

BobWork ready_for_outbound=false isolé est consultatif. Seuls pauses, incidents,
comptes indisponibles et protections backend effectives sont bloquants. Ne relève
aucun plafond, ne change pas BobWork et laisse ses diagnostics à l'agent distinct.
Le backend seul programme J0 puis les relances selon les délais enregistrés,
les acceptations SMTP et les protections. Ne modifie jamais un job.

Pour l'anxiété sociale, utilise exclusivement vincentdenizot.substack.com et
https://vincentdenizot.substack.com/p/comment-choisit-on-ses-amis pour l'article
sur l'amitié. L'ancien domaine présent dans une archive ne doit pas être repris
dans un nouveau texte ; les archives restent intactes.

Avant de clôturer, relis pending_prospect_writing, unanalyzed_responses,
pending_reply_iterations et pending_operations. Compte les passes réellement
achevées depuis prospect_iteration_history FILTRÉ par agent_run_id=run_id et
status=completed, groupé par campagne. Compare ce résultat au tour initial :
toute campagne disponible restée à zéro doit avoir un refus précis et vérifié
ou être encore traitée AVANT la clôture ; « j'ai déjà fait une rédaction » n'est
pas une raison. Une vraie limite externe ou d'exécution doit être décrite, sans
inventer un budget épuisé ni compter une simple consultation comme rédaction.

Termine avec complete_run : completed, partial ou failed selon les faits. Résumé
par campagne : stock initial, passes archivées, séquences proposées, reste à faire,
objectif/ajouts/manque du jour, recherches, candidats vérifiés, inscrits, réservés,
blocages. Ajoute réponses analysées, passes de réponse, brouillons demandés et
expériences réellement avancées/activées/conclues. Un objectif non atteint ou un
stock abandonné reste partial. Le compte rendu final est bref en français et
sépare réalisé, demandé/en attente, erreur et inconnu. Une action commerciale
passe toujours par agent_api ; aucun effet externe non confirmé n'est un succès.
Conserve la planification existante, horaire ; n'en crée aucune autre.
