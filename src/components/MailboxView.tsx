import {useCallback,useEffect,useRef,useState} from "react";
import {api} from "../lib/api";
import type {Campaign,MailboxDetail,MailboxFolder,MailboxMessage,MailboxPage,MailboxThread} from "../types";
import {responseIsClosed,responseLabels} from "../lib/response-classification";
import "./MailboxView.css";

const folders:Array<[MailboxFolder,string,string]>=[["inbox","▣","Réception"],["action","◷","À traiter"],["waiting","↗","En attente de réponse"],["archive","▤","Archives"],["other","⚙","Automatiques / warm-up"]];
const explanations:Record<MailboxFolder,string>={inbox:"Conversations issues de la prospection Prospection 95, avec au moins une réponse reçue.",action:"Une réponse ou une décision est attendue de votre part.",waiting:"Vous avez répondu au correspondant ; sa prochaine réponse est attendue.",archive:"Conversations classées et conservées.",other:"Notifications automatiques liées à vos conversations de prospection."};
function dateLabel(date:string,long=false){return new Date(date).toLocaleString("fr-FR",{timeZone:"Europe/Paris",...(long?{day:"numeric",month:"short",year:"numeric",hour:"2-digit",minute:"2-digit"}:{day:"numeric",month:"short"})});}
function initials(name:string){return name.split(/[\s@.]+/).slice(0,2).map(x=>x[0]).join("").toUpperCase();}
function threadStatus(t:MailboxThread){return t.category==="warmup"?"Warm-up":t.category==="automatic"?"Automatique":t.archived?"Archivé":responseIsClosed(t.responseClassification)?"Traité":t.needsReply?"À répondre":t.lastDirection==="outbound"?"En attente":"Traité";}
function ResponseBadge({thread:t}:{thread:MailboxThread}){return <span className={`tag response-badge response-${t.responseClassification??"pending"}`} title={t.responseRationale??"La planification GPT classera cette réponse lors de son prochain passage."}>{t.responseClassification?responseLabels[t.responseClassification]:"À qualifier"}</span>;}

export function MailboxView({campaigns,onOpenCampaign,onOpenProspect}:{campaigns:Campaign[];onOpenCampaign:(id:string)=>void;onOpenProspect:(id:string)=>void}){
 const [campaign,setCampaign]=useState("");const[account,setAccount]=useState("");const[folder,setFolder]=useState<MailboxFolder>("inbox");
 const[filter,setFilter]=useState("all");const[query,setQuery]=useState("");const[search,setSearch]=useState("");const[page,setPage]=useState(1);
 const[data,setData]=useState<MailboxPage|null>(null);const[selected,setSelected]=useState<string|null>(null);
 const[reading,setReading]=useState(false);const[loading,setLoading]=useState(true);const[error,setError]=useState("");
 const[refreshTick,setRefreshTick]=useState(0);const generation=useRef(0);
 useEffect(()=>{const timer=setTimeout(()=>setSearch(query),250);return()=>clearTimeout(timer);},[query]);
 useEffect(()=>{setPage(1);setReading(false);setSelected(null);},[campaign,account,folder,filter,search]);
 const refresh=useCallback(()=>setRefreshTick(t=>t+1),[]);
 useEffect(()=>{
  const controller=new AbortController();const current=++generation.current;
  const params=new URLSearchParams({folder,filter,q:search,page:String(page)});if(campaign)params.set("campaign",campaign);if(account)params.set("account",account);
  setLoading(true);
  api.mailbox(params,controller.signal).then(result=>{if(current!==generation.current)return;setData(result);setError("");
   setSelected(prior=>result.threads.some(t=>t.id===prior)?prior:result.threads[0]?.id??null);
  }).catch(e=>{if(!controller.signal.aborted)setError(e instanceof Error?e.message:"Chargement impossible");}).finally(()=>{if(current===generation.current)setLoading(false);});
  return()=>controller.abort();
 },[campaign,account,folder,filter,search,page,refreshTick]);
 useEffect(()=>{const update=()=>{if(document.visibilityState==="visible")refresh();};const timer=setInterval(update,15000);
  window.addEventListener("focus",update);return()=>{clearInterval(timer);window.removeEventListener("focus",update);};},[refresh]);
 const campaignLabel=campaign==="none"?"Sans campagne":campaigns.find(c=>c.id===campaign)?.name??"Toutes les campagnes";
 const accountLabel=data?.accounts.find(a=>a.id===account)?.email??"Tous les comptes Gmail";
 const counts=data?.counts;const accounts=data?.accounts??[];
 return <section className="unified-mailbox" aria-label="Boîte mail unifiée">
  <div className="view-head"><div><h1>Boîte de réception unifiée</h1><p>Les réponses à vos campagnes Prospection 95, réunies dans une seule boîte.</p></div>
   <div className="metrics"><span><b>{counts?.unread??0}</b> non lus</span><span><b>{counts?.action??0}</b> à traiter</span><span><b>{accounts.length}</b> comptes</span></div></div>
  {error?<div role="alert" className="mail-error">{error} <button onClick={refresh}>Réessayer</button></div>:null}
  <section className="mail-window">
   <header className="mail-window-title"><span>✉ Boîte mail · Vue commerciale</span><small>{campaignLabel} / {accountLabel}</small></header>
   <div className="scope-bar">
    <label className="scope-field scope-main">1 · Campagne<select aria-label="Filtrer les conversations par campagne" value={campaign} onChange={e=>setCampaign(e.target.value)}>
     <option value="">Toutes les campagnes</option>{campaigns.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}<option value="none">Sans campagne</option></select></label>
    <label className="scope-field">2 · Adresse Gmail<select aria-label="Filtrer les conversations par adresse Gmail" value={account} onChange={e=>setAccount(e.target.value)}>
     <option value="">Tous les comptes Gmail</option>{accounts.map(a=><option key={a.id} value={a.id}>{a.email}</option>)}</select></label>
    <button className="scope-clear" disabled={!campaign&&!account} onClick={()=>{setCampaign("");setAccount("");}}>Réinitialiser</button>
   </div>
   <div className="scope-hint"><span>◈</span><strong>{campaignLabel}</strong> · {accountLabel}</div>
   <div className="mail-toolbar"><label className="mail-search">⌕<input type="search" aria-label="Rechercher dans les conversations" placeholder="Rechercher dans les conversations…" value={query} onChange={e=>setQuery(e.target.value)}/></label>
    <div className="sync-button"><span>{accounts.length} comptes connectés</span><button className="win-button" onClick={()=>{refresh();if(selected)void api.mailboxRefresh(selected).catch(e=>setError(e.message));}}>{loading?"↻ Chargement…":"↻ Actualiser"}</button></div></div>
   <div className={`mail-grid ${reading?"reading":""}`}>
    <aside className="mail-side" aria-label="Dossiers"><div className="sidelabel">Conversations</div>
     {folders.map(([id,icon,label])=><button key={id} className={`folder ${folder===id?"active":""} ${id==="other"?"secondary-folder":""}`} aria-current={folder===id?"page":undefined} onClick={()=>setFolder(id)}><span>{icon} {label}</span><span className="number">{counts?.[id]??0}</span></button>)}
     <p className="side-note">Les contacts qui n’ont pas encore répondu restent dans l’onglet Messages.</p>
    </aside>
    <div className="thread-column" aria-label="Liste des conversations" aria-busy={loading}>
     <div className="list-top"><div className="filter-tabs">{[["all","Toutes"],["unread","Non lues"],["priority","Prioritaires"]].map(([id,label])=><button key={id} aria-pressed={filter===id} className={filter===id?"selected":""} onClick={()=>setFilter(id)}>{label}</button>)}</div>
      <div className="list-summary">{data?.total??0} conversation{data?.total===1?"":"s"}</div><div className="folder-explainer">{explanations[folder]}</div></div>
     {data?.threads.map(t=><button key={t.id} className={`thread-item ${selected===t.id?"active":""} ${t.unread?"unread":""}`} aria-current={selected===t.id?"true":undefined} onClick={()=>{setSelected(t.id);setReading(true);}}>
      <span className="avatar">{initials(t.name)}</span><span className="thread-content"><span className="thread-first"><span className="sender">{t.priority?"★ ":""}{t.name}</span><time>{dateLabel(t.lastMessageAt)}</time></span>
      <span className="subject">{t.subject||"(Sans objet)"}</span><span className="snippet">{t.lastDirection==="outbound"?"Vous : ":""}{t.snippet}</span>
      <span className="thread-tags"><ResponseBadge thread={t}/><span className={`tag ${t.needsReply?"action":"info"}`}>{threadStatus(t)}</span><span className="tag origin" title={t.accountEmail}>{t.accountEmail}</span>{t.campaignName?<span className="tag">{t.campaignName}</span>:null}</span></span></button>)}
     {!data?.threads.length?<div className="thread-blank">{loading?"Chargement des conversations…":accounts.length?"Aucune conversation dans cette vue. Essayez une autre campagne, adresse ou catégorie.":"Connectez un compte Gmail dans les paramètres pour retrouver vos échanges."}</div>:null}
     {data&&data.total>50?<div className="mail-pagination"><button disabled={page===1} onClick={()=>{setPage(p=>p-1);setReading(false);}}>← Précédent</button><span>{page} / {Math.ceil(data.total/50)}</span><button disabled={page*50>=data.total} onClick={()=>{setPage(p=>p+1);setReading(false);}}>Suivant →</button></div>:null}
    </div>
    {selected?<MailboxReader key={selected} id={selected} tick={refreshTick} onChanged={refresh} onBack={()=>setReading(false)} onOpenCampaign={onOpenCampaign} onOpenProspect={onOpenProspect}/>:<div className="reader empty-reader"><span>✉<br/>Sélectionnez une conversation pour lire l’échange.</span></div>}
   </div>
   <footer className="mail-statusbar"><span>Prêt · {campaignLabel} · {accountLabel}</span><span>{accounts.some(a=>!a.caughtUpAt)?"Historique Gmail en cours de synchronisation":"Synchronisation automatique"}</span></footer>
  </section>
  {accounts.some(a=>a.lastErrorCode)?<p className="mail-sync-warning" role="status">Un compte signale une erreur de synchronisation. Consultez son état dans les paramètres.</p>:null}
 </section>;
}

function MailMessage({message}:{message:MailboxMessage}){
 const outgoing=message.direction==="outbound";
 return <article className={`mail-message ${outgoing?"outbound":"inbound"}`} aria-label={outgoing?"Message envoyé":"Message reçu"}>
  <div className="sender-header"><div className="sender-person"><span className="big-avatar" aria-hidden="true">{outgoing?"↗":initials(message.from)}</span><div className="sender-identity"><span className="message-direction">{outgoing?"↗ Envoyé":"↙ Reçu"}</span><strong>{outgoing?"Vous":message.from}</strong><div className="address">De : {message.from}<br/>À : {message.to.join(", ")}{message.cc?.length?` · Cc : ${message.cc.join(", ")}`:""}</div></div></div><time>{dateLabel(message.at,true)}</time></div>
  <div className="message-body">{message.body||"Message sans contenu texte."}</div>
 </article>;
}

function MailboxReader({id,tick,onChanged,onBack,onOpenCampaign,onOpenProspect}:{id:string;tick:number;onChanged:()=>void;onBack:()=>void;onOpenCampaign:(id:string)=>void;onOpenProspect:(id:string)=>void}){
 const[data,setData]=useState<MailboxDetail|null>(null);const[error,setError]=useState("");const[busy,setBusy]=useState(false);const[older,setOlder]=useState<MailboxMessage[]>([]);const[hasOlder,setHasOlder]=useState(false);const[expanded,setExpanded]=useState(false);
 const generation=useRef(0);const mounted=useRef(true);const lastMarked=useRef<string|null>(null);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
 const refresh=useCallback(async()=>{const current=++generation.current;try{const result=await api.mailboxDetail(id);if(current===generation.current&&mounted.current){setData(result);setError("");if(!older.length)setHasOlder(result.hasOlder);}}catch(e){if(mounted.current)setError((e as Error).message);}},[id,older.length]);
 useEffect(()=>{void refresh();},[refresh,tick]);
 useEffect(()=>{void api.mailboxRefresh(id).catch(()=>undefined);},[id]);
 useEffect(()=>{if(!data?.thread.unread||lastMarked.current===data.thread.lastMessageId)return;lastMarked.current=data.thread.lastMessageId;
  api.mailboxState(id,{version:data.thread.version,unread:false}).then(()=>{void refresh();onChanged();}).catch(()=>{lastMarked.current=null;});
 },[data,id,onChanged,refresh]);
 async function change(patch:Record<string,boolean>){if(!data)return;setBusy(true);try{await api.mailboxState(id,{version:data.thread.version,...patch});await refresh();onChanged();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
 async function loadOlder(){if(!data)return;setBusy(true);try{const first=older[0]??data.messages[0];const result=await api.mailboxDetail(id,undefined,first.id);setOlder(rows=>[...result.messages,...rows]);setHasOlder(result.hasOlder);setExpanded(true);}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
 if(!data)return <section className="reader"><button className="mobile-back" onClick={onBack}>← Conversations</button><div className="empty-reader">{error?<p role="alert">{error} <button onClick={()=>void refresh()}>Réessayer</button></p>:"Chargement du fil…"}</div></section>;
 const t=data.thread;const all=[...older,...data.messages].filter((m,i,list)=>list.findIndex(x=>x.id===m.id)===i);const latest=all[all.length-1];
 return <section className="reader" aria-label="Lecture de la conversation">
  <div className="reader-toolbar"><button className="mobile-back" onClick={onBack}>← Conversations</button><span className="reader-action-label">Conversation</span><div className="reader-actions">
   {t.gmailUrl?<a className="win-button gmail-conversation-link" href={t.gmailUrl} target="_blank" rel="noopener noreferrer" title={`Ouvrir ce fil dans Gmail (${t.accountEmail})`}>Ouvrir dans Gmail ↗</a>:<button className="win-button gmail-conversation-link" disabled title="Le lien Gmail sera disponible après la synchronisation du fil.">Ouvrir dans Gmail ↗</button>}
   <button className="icon-button" disabled={busy} title={t.priority?"Retirer la priorité":"Marquer prioritaire"} aria-label={t.priority?"Retirer la priorité":"Marquer prioritaire"} onClick={()=>void change({priority:!t.priority})}>{t.priority?"★":"☆"}</button>
   <button className="icon-button" disabled={busy} title="Marquer comme non lue" aria-label="Marquer comme non lue" onClick={()=>void change({unread:true})}>✉</button>
   <button className="win-button" disabled={busy||responseIsClosed(t.responseClassification)} title={responseIsClosed(t.responseClassification)?"Cette réponse est classée : aucune réponse commerciale n’est attendue.":undefined} onClick={()=>void change({needsReply:!t.needsReply})}>{responseIsClosed(t.responseClassification)?"✓ Classé":t.needsReply?"✓ Traité":"◷ À traiter"}</button>
   <button className="win-button" disabled={busy} onClick={()=>void change({archived:!t.archived})}>{t.archived?"↶ Restaurer":"▤ Archiver"}</button></div></div>
  <div className="reader-scroll">
   {error?<div className="mail-error" role="alert">{error}</div>:null}
   <header className="reader-heading"><h2>{t.subject||"(Sans objet)"}</h2><div className="meta"><span>{t.campaignName??"Sans campagne"}</span> · <span>{t.accountEmail}</span> · <span className="status-meta">{threadStatus(t)}</span></div>
    <div className="response-analysis"><ResponseBadge thread={t}/><small>{t.responseAnalyzedAt?`Analyse GPT · ${dateLabel(t.responseAnalyzedAt,true)}`:"Classement GPT en attente"}</small>
     {t.responseRationale?<details><summary>Motif du classement</summary><p>{t.responseRationale}</p></details>:null}</div>
    {responseIsClosed(t.responseClassification)?<div className="classified-hint">Cette réponse ne nécessite pas de relance ni de réponse commerciale.</div>:!t.needsReply&&t.lastDirection==="outbound"?<div className="waiting-hint">◷ Dernier message envoyé. Réponse du correspondant attendue.</div>:null}</header>
   {all.length>1?<button className="older" aria-expanded={expanded} onClick={()=>setExpanded(v=>!v)}>{expanded?"▾ Masquer":"▸ Afficher"} les messages précédents ({all.length-1})</button>:null}
   {expanded?<div className="older-content">{hasOlder?<button className="older" disabled={busy} onClick={()=>void loadOlder()}>Charger les messages plus anciens</button>:null}{all.slice(0,-1).map(m=><MailMessage key={m.id} message={m}/>)}</div>:hasOlder&&all.length<2?<button className="older" onClick={()=>void loadOlder()}>Charger l’historique précédent</button>:null}
   {latest?<MailMessage message={latest}/>:null}
   {t.category==="normal"?<ReplyComposer id={id} detail={data} onSent={()=>{void refresh();onChanged();}}/>:<p className="waiting-hint">Message automatique ou warm-up : aucune réponse commerciale proposée.</p>}
   <details className="crm-details"><summary>Contexte CRM</summary><div className="crm-inner"><div className="crm-grid">
    <div>Prospect<strong>{t.name}</strong>{t.prospectId?<button className="actionlink" onClick={()=>onOpenProspect(t.prospectId!)}>Ouvrir la fiche CRM ↗</button>:<small>Contact sans fiche CRM</small>}</div>
    <div>Campagne<strong>{t.campaignName??"Sans campagne"}</strong>{t.campaignId?<button className="actionlink" onClick={()=>onOpenCampaign(t.campaignId!)}>Ouvrir la campagne ↗</button>:null}</div>
    <div>Suivi<strong>{t.followupsStoppedAt?"Relances arrêtées":t.nextFollowupAt?`Prochaine échéance : ${dateLabel(t.nextFollowupAt,true)}`:"Aucune relance prévue"}</strong></div></div></div></details>
   <div className="reply-note" role="status">{t.syncError?`Synchronisation Gmail à vérifier : ${t.syncError}`:t.pendingSync?"Changements enregistrés · synchronisation Gmail en attente.":t.lastSyncedAt?`Gmail synchronisé le ${dateLabel(t.lastSyncedAt,true)}`:"Première synchronisation du fil en attente."}</div>
  </div>
 </section>;
}

function ReplyComposer({id,detail,onSent}:{id:string;detail:MailboxDetail;onSent:()=>void}){
 const t=detail.thread;const cacheKey=`p95-mail-draft:${id}`;
 const[body,setBody]=useState(()=>{try{return sessionStorage.getItem(cacheKey)??t.draftBody;}catch{return t.draftBody;}});
 const[status,setStatus]=useState("");const[error,setError]=useState("");const[sending,setSending]=useState(false);
 const saved=useRef({body:t.draftBody,version:t.draftVersion});const current=useRef(body);const alive=useRef(true);const chain=useRef<Promise<void>>(Promise.resolve());
 const sendKey=useRef<{body:string;key:string}|null>(null);const dirty=body!==saved.current.body;
 const remoteConflict=useRef(t.draftRemoteBody);remoteConflict.current=t.draftRemoteBody;
 const persist=useCallback(()=>{
  const work=async()=>{const value=current.current;if(value===saved.current.body&&remoteConflict.current===null)return;
   if(alive.current){setStatus("Enregistrement…");setError("");}
   try{const result=await api.mailboxDraft(id,saved.current.version,value);saved.current={body:value,version:result.version};
    if(current.current===value){try{sessionStorage.removeItem(cacheKey);}catch{/* unavailable storage */}}
    if(alive.current)setStatus("Brouillon enregistré.");
   }catch(e){if(alive.current){setError((e as Error).message);setStatus("Texte conservé dans cet onglet.");}throw e;}
  };
  const next=chain.current.catch(()=>undefined).then(work);chain.current=next;return next;
 },[id,cacheKey]);
 useEffect(()=>{current.current=body;try{if(body!==saved.current.body)sessionStorage.setItem(cacheKey,body);}catch{/* storage optional */}
  const timer=setTimeout(()=>{void persist().catch(()=>undefined);},900);return()=>clearTimeout(timer);
 },[body,cacheKey,persist]);
 useEffect(()=>{alive.current=true;const before=(event:BeforeUnloadEvent)=>{if(current.current!==saved.current.body){event.preventDefault();event.returnValue="";}};
  window.addEventListener("beforeunload",before);return()=>{alive.current=false;window.removeEventListener("beforeunload",before);void persist().catch(()=>undefined);};
 },[persist]);
 useEffect(()=>{
  if(t.draftVersion>saved.current.version&&current.current===saved.current.body){saved.current={body:t.draftBody,version:t.draftVersion};current.current=t.draftBody;setBody(t.draftBody);}
 },[t.draftVersion,t.draftBody]);
 async function send(){setSending(true);setError("");try{await persist();
   if(!sendKey.current||sendKey.current.body!==current.current)sendKey.current={body:current.current,key:crypto.randomUUID()};
   await api.mailboxSend(id,saved.current.version,t.lastMessageId,sendKey.current.key);setStatus("Réponse placée dans la file d’envoi sécurisée.");onSent();
  }catch(e){setError((e as Error).message);}finally{setSending(false);}}
 const sendState=detail.send?.status;const active=!!sendState&&!["completed","failed","cancelled"].includes(sendState);
 const sendLabel=sendState==="completed"?"✓ Réponse acceptée par Gmail.":sendState==="uncertain"?"Résultat SMTP incertain. Aucun nouvel envoi automatique ; rapprochement Gmail en cours.":sendState==="failed"?"Échec d’envoi. Le brouillon est conservé.":sendState==="cancelled"?"Envoi annulé : le fil ou une protection a changé. Le brouillon est conservé.":active?"Réponse en attente d’envoi : les plages horaires, quotas et pauses du compte restent appliqués.":"";
 return <section className="reply-compose" aria-label="Réponse intégrée"><div className="reply-heading"><strong>↩ Répondre à {t.name}</strong><span className="reply-from">Depuis <b>{t.accountEmail}</b></span></div>
  {t.draftRemoteBody!==null?<div className="mail-error" role="alert">Le brouillon Gmail a été modifié. Votre texte est conservé.<details><summary>Voir le brouillon Gmail</summary><pre>{t.draftRemoteBody||"(Brouillon vide)"}</pre></details><button onClick={()=>{setBody(t.draftRemoteBody!);current.current=t.draftRemoteBody!;void persist().then(onSent).catch(()=>undefined);}}>Utiliser le brouillon Gmail</button></div>:null}
  <label className="sr-only" htmlFor={`reply-${id}`}>Votre réponse</label><textarea id={`reply-${id}`} className="reply-edit" placeholder="Écrivez votre réponse ici…" value={body} maxLength={100000} disabled={sending||active} onChange={e=>setBody(e.target.value)}/>
  <div className="reply-foot"><span className="reply-editor-hint" role="status">{status||(!dirty?(t.draftSyncedVersion===saved.current.version?"Brouillon synchronisé avec Gmail.":"Sauvegarde automatique des brouillons."):"Modifications à enregistrer…")}</span>
   <div className="reply-foot-right"><button className="win-button" disabled={sending||active} onClick={()=>void persist().catch(()=>undefined)}>Enregistrer</button><button className="win-button send" disabled={!body.trim()||!t.canReply||sending||active||t.draftRemoteBody!==null} onClick={()=>void send()}>{sending?"En cours…":"Envoyer ↗"}</button></div></div>
  {!t.canReply?<div className="reply-note">{t.replyContextChanged?"La conversation Gmail a changé. Ouvrez-la dans Gmail pour vérifier le dernier échange.":"Envoi indisponible : vérifiez la pause, le compte Gmail et les exclusions dans les paramètres."}</div>:null}
  {sendLabel?<p className={`reply-note ${sendState==="uncertain"?"mail-error":""}`} role="status">{sendLabel}</p>:null}
  {error?<div className="mail-error" role="alert">{error}<button onClick={()=>{saved.current={body:t.draftBody,version:t.draftVersion};setError("");setStatus("Version actualisée. Votre texte reste prêt à enregistrer.");}}>Actualiser la version enregistrée</button></div>:null}
 </section>;
}
