import {useEffect,useMemo,useRef,useState} from "react";
import type {GmailAccount} from "../types";
import "./BobworkHistoryChart.css";

type Point=NonNullable<GmailAccount["bobworkHistory"]>[number];
type Metric="spamRate7d"|"sent7d"|"errors7d";
const labels:Record<Metric,string>={spamRate7d:"Taux de spam (7 j)",sent7d:"Envois BobWork (7 j)",errors7d:"Erreurs BobWork (7 j)"};
const date=(at:string,long=false)=>new Date(at).toLocaleString("fr-FR",{timeZone:"Europe/Paris",day:"numeric",month:"short",...(long?{year:"numeric",hour:"2-digit",minute:"2-digit"}:{})});

export function BobworkHistoryChart({points,accountEmail}:{points:Point[];accountEmail:string}){
 const[metric,setMetric]=useState<Metric>("spamRate7d");const[days,setDays]=useState(30);const[selected,setSelected]=useState<number|null>(null);
 const svg=useRef<SVGSVGElement>(null);const[width,setWidth]=useState(760);
 const data=useMemo(()=>points.filter(p=>Number.isFinite(Date.parse(p.at))&&Date.parse(p.at)>=Date.now()-days*86400000).sort((a,b)=>Date.parse(a.at)-Date.parse(b.at)),[points,days]);
 const valid=data.filter(p=>p[metric]!=null&&Number.isFinite(p[metric]));
 const selectedIndex=selected==null?valid.length-1:Math.min(selected,valid.length-1);
 const current=valid[selectedIndex];const percent=metric==="spamRate7d";
 useEffect(()=>{if(!svg.current||typeof ResizeObserver==="undefined")return;const observer=new ResizeObserver(entries=>{
  const size=entries[0]?.contentRect.width;if(size>0)setWidth(Math.max(300,Math.round(size)));
 });observer.observe(svg.current);return()=>observer.disconnect();},[!!current]);
 const format=(value:number)=>`${value.toLocaleString("fr-FR",{maximumFractionDigits:2})}${percent?" %":""}`;
 const first=Date.parse(data[0]?.at??"");const last=Date.parse(data.at(-1)?.at??"");
 const max=percent?100:Math.max(4,Math.ceil(Math.max(...valid.map(p=>p[metric]!),0)/4)*4);
 const right=width-25;
 const x=(at:string)=>last===first?(55+right)/2:55+(Date.parse(at)-first)/(last-first)*(right-55);
 const y=(value:number)=>190-value/max*160;
 const segments:Point[][]=[];let segment:Point[]=[];
 for(const point of data){if(point[metric]==null){if(segment.length)segments.push(segment);segment=[];}else segment.push(point);}
 if(segment.length)segments.push(segment);
 return <section className="bobwork-history" aria-label={`Historique BobWork de ${accountEmail}`}>
  <div className="bw-chart-heading"><strong>Évolution BobWork</strong><small>{data.length} observation{data.length===1?"":"s"}</small></div>
  <div className="bw-chart-controls">
   <label>Indicateur<select aria-label={`Indicateur BobWork de ${accountEmail}`} value={metric} onChange={e=>{setMetric(e.target.value as Metric);setSelected(null);}}>{Object.entries(labels).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
   <label>Période<select aria-label={`Période BobWork de ${accountEmail}`} value={days} onChange={e=>{setDays(Number(e.target.value));setSelected(null);}}><option value={7}>7 jours</option><option value={30}>30 jours</option><option value={180}>Tout l’historique (180 j max.)</option></select></label>
  </div>
  {current?<>
   <div className="bw-chart-reading" aria-live="polite"><b>{format(current[metric]!)}</b><span>{labels[metric]} · {date(current.at,true)}</span></div>
   <svg ref={svg} viewBox={`0 0 ${width} 225`} role="img" aria-label={`${labels[metric]} : évolution pour ${accountEmail}`}>
    {[0,1,2,3,4].map(i=><g key={i}><line x1={55} x2={right} y1={y(max*i/4)} y2={y(max*i/4)}/><text x={47} y={y(max*i/4)+4} textAnchor="end">{max*i/4}{percent?" %":""}</text></g>)}
    {segments.map((s,i)=><polyline key={i} className={`bw-series bw-${metric}`} points={s.map(p=>`${x(p.at)},${y(p[metric]!)}`).join(" ")}/>)}
    {valid.map((p,i)=><circle key={`${p.at}:${i}`} className={`bw-point bw-${metric}`} cx={x(p.at)} cy={y(p[metric]!)} r={i===selectedIndex?5:3} onMouseEnter={()=>setSelected(i)} onClick={()=>setSelected(i)}><title>{date(p.at,true)} · {format(p[metric]!)}</title></circle>)}
    <text x={55} y={215}>{date(data[0].at)}</text><text x={right} y={215} textAnchor="end">{date(data.at(-1)!.at)}</text>
   </svg>
   {valid.length>1?<label className="bw-chart-slider">Parcourir les observations<input type="range" aria-label={`Parcourir les observations BobWork de ${accountEmail}`} min={0} max={valid.length-1} value={selectedIndex} onChange={e=>setSelected(Number(e.target.value))}/></label>:<p>Une seule mesure disponible : aucune tendance ne peut encore être tracée.</p>}
  </>:<p className="bw-chart-empty">Aucune mesure disponible pour cet indicateur sur cette période. Une donnée absente n’est pas un zéro.</p>}
  <p className="bw-chart-note">Valeurs déclarées par BobWork sur sept jours glissants, observées aux dates indiquées. Elles ne mesurent pas à elles seules le placement des campagnes en boîte de réception.</p>
 </section>;
}
