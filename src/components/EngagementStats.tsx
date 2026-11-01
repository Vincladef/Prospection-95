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
  <div><strong>{reading?.meanSeconds!=null ? duration(reading.meanSeconds) : reading?.cappedSamples ? "≥ 50 s" : "Indisponible"}</strong><span>durée de chargement observée</span><small>{reading?.meanSeconds!=null ? "Moyenne des durées non plafonnées" : reading?.cappedSamples ? "Connexions plafonnées uniquement" : "Aucune durée exploitable"}</small></div>
  <p>Durée technique de connexion au pixel, tous clients confondus, y compris les proxys et les chargements automatiques probables. {reading?.samples ?? 0} durées sur {reading?.measuredProspects ?? 0} prospects, chaque prospect ayant le même poids dans la moyenne ; {reading?.cappedSamples ?? 0} connexions d’au moins 50 s, hors moyenne. {reading?.attemptedMessages ?? 0} emails observés sur {reading?.enabledMessages ?? 0} équipés. {reading?.incompatibleMessages ?? 0} anciennes observations sans durée, {reading?.failedMessages ?? 0} échecs de mesure, {reading?.budgetLimitedMessages ?? 0} exclus par le budget de mesure. Les durées incertaines sont conservées ; elles ne prouvent pas une lecture humaine. Un échec ou une absence de mesure ne vaut pas zéro.</p>
  <details className="interaction-context-stats"><summary>Messageries et fiabilité des observations</summary>
   <p>Indices sur le demandeur de l’image, pas identification certaine de la messagerie du destinataire. « Apple possible » peut aussi être un navigateur utilisant WebKit. Une durée via proxy ou un chargement automatique décrit le téléchargement, pas le temps passé à lire. Un même email peut apparaître dans plusieurs profils ; chaque moyenne donne le même poids aux prospects observés.</p>
   {metrics?.contexts?.length ? <div className="interaction-context-table"><table><thead><tr><th>Messagerie probable</th><th>Connexion</th><th>Automatisation</th><th>Chargements</th><th>Durées / essais</th><th>Moyenne</th><th>Plafonds ≥50 s</th><th>Échecs / budget</th></tr></thead><tbody>{metrics.contexts.map(p=><tr key={JSON.stringify([p.provider,p.transport,p.automation])}><td>{{gmail:"Gmail / Google",apple:"Apple",apple_possible:"Apple possible",outlook:"Outlook",thunderbird:"Thunderbird",yahoo:"Yahoo",unknown:"Non identifiée"}[p.provider]??"Non identifiée"}</td><td>{p.transport==="proxy"?"Proxy":p.transport==="direct"?"Directe probable":"Inconnue"}</td><td>{p.automation===null?"Inconnue":p.automation?"Probable":"Non détectée"}</td><td>{p.requests}</td><td>{p.samples} / {p.attempts}</td><td>{duration(p.meanSeconds)}</td><td>{p.capped}</td><td>{p.failed} / {p.budget}</td></tr>)}</tbody></table></div>:<p>Le contexte n’était pas enregistré dans l’ancien historique. Il sera renseigné aux prochains chargements, sans reconstitution des données manquantes.</p>}
  </details>
  {metrics?.observedMessages ? <p>{metrics?.proxyOpenRequests ?? 0} chargements via proxy · {metrics?.automatedOpenRequests ?? 0} robots probables · {metrics?.directOpenRequests ?? 0} navigateurs apparents · {Math.max(0,(metrics?.openRequests ?? 0)-(metrics?.proxyOpenRequests ?? 0)-(metrics?.automatedOpenRequests ?? 0)-(metrics?.directOpenRequests ?? 0))} origine inconnue. Fenêtre glissante de 90 jours ; absence de signal ≠ absence d’intérêt.</p> : <p>Aucune chronologie disponible. L’historique détaillé commence après activation ; les anciens compteurs ne sont pas reconstitués. Absence de signal ≠ absence d’intérêt.</p>}
 </div>;
}
