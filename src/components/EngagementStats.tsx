import type { EngagementMetrics } from "../types";

function duration(value:number|null|undefined){
 if(value==null)return "Indisponible";
 if(value<60)return `${Math.round(value)} s`;
 if(value<3600)return `${Math.round(value/60)} min`;
 return `${(value/3600).toLocaleString("fr-FR",{maximumFractionDigits:1})} h`;
}
export function EngagementStats({metrics}:{metrics?:EngagementMetrics|null}){
 const reading=metrics?.reading;
 return <div className="engagement-stats">
  <div><strong>{metrics?.openRequests ?? "—"}</strong><span>chargements du pixel</span><small>Signal bruité · {metrics?.observedMessages ?? 0} emails observés</small></div>
  <div><strong>{metrics?.repeatedOpenMessages ?? "—"}</strong><span>emails avec chargements répétés</span><small>Ne prouve pas plusieurs lectures</small></div>
  <div><strong>{duration(metrics?.meanOpenIntervalSeconds)}</strong><span>intervalle moyen entre chargements</span><small>Fréquence technique, pas humaine</small></div>
  <div><strong>{duration(metrics?.meanOpenToClickSeconds)}</strong><span>délai ouverture → clic</span><small>Approximatif · {metrics?.delaySamples ?? 0} emails</small></div>
  <div><strong>{reading?.meanSeconds!=null ? duration(reading.meanSeconds) : reading?.cappedSamples ? "≥ 50 s" : "Indisponible"}</strong><span>temps de lecture observé</span><small>{reading?.meanSeconds!=null ? "Moyenne des durées non plafonnées" : reading?.cappedSamples ? "Connexions plafonnées uniquement" : "Aucune durée exploitable"}</small></div>
  <p>Mesure indicative par durée de connexion au pixel, sur les clients compatibles. {reading?.samples ?? 0} durées sur {reading?.measuredProspects ?? 0} prospects, chaque prospect ayant le même poids dans la moyenne ; {reading?.cappedSamples ?? 0} connexions d’au moins 50 s, hors moyenne. {reading?.attemptedMessages ?? 0} emails observés sur {reading?.enabledMessages ?? 0} équipés. {reading?.incompatibleMessages ?? 0} incompatibles ou masqués par un proxy, {reading?.failedMessages ?? 0} échecs de mesure, {reading?.budgetLimitedMessages ?? 0} exclus par le budget de mesure. Les données exclues restent indisponibles et ne valent pas zéro.</p>
  {metrics?.observedMessages ? <p>{metrics?.proxyOpenRequests ?? 0} chargements via proxy · {metrics?.automatedOpenRequests ?? 0} robots probables · {metrics?.directOpenRequests ?? 0} navigateurs apparents · {Math.max(0,(metrics?.openRequests ?? 0)-(metrics?.proxyOpenRequests ?? 0)-(metrics?.automatedOpenRequests ?? 0)-(metrics?.directOpenRequests ?? 0))} origine inconnue. Fenêtre glissante de 90 jours ; absence de signal ≠ absence d’intérêt.</p> : <p>Aucune chronologie disponible. L’historique détaillé commence après activation ; les anciens compteurs ne sont pas reconstitués. Absence de signal ≠ absence d’intérêt.</p>}
 </div>;
}
