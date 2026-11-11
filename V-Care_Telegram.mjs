/**
 * V-Care_Telegram — DhanHQ Option-Chain Telegram Assistant
 * Cloudflare Worker, single-file build. No Angel One integration and no broker orders.
 * Trade analysis uses Dhan option-chain fields only. News briefing is a separate context feed.
 */
const APP = 'V-Care_Telegram';
const VERSION = '1.0.0-dhan-option-chain';
const TZ = 'Asia/Kolkata';
const Dhan = 'https://api.dhan.co/v2';
const NEWS_FEEDS = [
  ['Business Standard Markets', 'https://www.business-standard.com/rss/markets-106.rss'],
  ['Business Standard Economy', 'https://www.business-standard.com/rss/economy-policy-102.rss'],
  ['BBC Business', 'https://feeds.bbci.co.uk/news/business/rss.xml'],
  ['BBC Economy', 'https://feeds.bbci.co.uk/news/business/economy/rss.xml']
];

const now = () => Date.now();
const iso = t => new Date(t).toISOString();
const dayIST = () => new Intl.DateTimeFormat('en-CA', {timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const clockIST = () => new Intl.DateTimeFormat('en-GB', {timeZone:TZ,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date());
const weekdayIST = () => new Intl.DateTimeFormat('en-US', {timeZone:TZ,weekday:'short'}).format(new Date());
const num = v => v===null || v===undefined || v==='' ? null : (Number.isFinite(Number(v)) ? Number(v) : null);
const pct = (a,b) => Number.isFinite(a)&&Number.isFinite(b)&&b!==0 ? +((a/b-1)*100).toFixed(2) : null;
const json = (x,status=200) => new Response(JSON.stringify(x,null,2),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}});
const sleep = ms => new Promise(r=>setTimeout(r,ms));
let lastOptionChainApiCallAt = 0;
async function respectOptionChainRateLimit(){const wait=3100-(now()-lastOptionChainApiCallAt);if(wait>0)await sleep(wait);lastOptionChainApiCallAt=now();}
const safe = (s,n=240) => String(s??'').replace(/[\u0000-\u001f]/g,' ').slice(0,n);

function kvAvailable(env){return !!env.STATE?.get && !!env.STATE?.put;}
async function readKV(env,key){if(!kvAvailable(env))return null;try{const v=await env.STATE.get(key);return v?JSON.parse(v):null}catch{return null}}
async function writeKV(env,key,value,ttl=86400){if(!kvAvailable(env))return false;try{await env.STATE.put(key,JSON.stringify(value),{expirationTtl:Math.max(60,ttl)});return true}catch(e){console.error('KV write failed',safe(e?.message));return false}}
function missingConfig(env){return ['DHAN_CLIENT_ID','DHAN_ACCESS_TOKEN','TELEGRAM_BOT_TOKEN','TELEGRAM_CHAT_ID'].filter(k=>!env[k]);}
function marketOpen(env){
  const d=dayIST(),t=clockIST();
  const holidays=String(env.MARKET_HOLIDAYS||'').split(',').map(x=>x.trim()).filter(Boolean);
  return !['Sat','Sun'].includes(weekdayIST())&&!holidays.includes(d)&&t>='09:15'&&t<'15:25';
}
function parseRss(xml){
  const decode=s=>String(s||'').replace(/<!\[CDATA\[|\]\]>/g,'').replace(/<[^>]*>/g,'').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').trim();
  const blocks=xml.match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi)||xml.match(/<entry(?:\s[^>]*)?>[\s\S]*?<\/entry>/gi)||[];
  const tag=(b,t)=>{const m=b.match(new RegExp('<'+t+'(?:\\s[^>]*)?>([\\s\\S]*?)<\\/'+t+'>','i'));return m?decode(m[1]):''};
  return blocks.slice(0,20).map(b=>{const title=tag(b,'title'),published=tag(b,'pubDate')||tag(b,'published')||tag(b,'updated'),link=tag(b,'link')||((b.match(/<link[^>]+href=["']([^"']+)/i)||[])[1]||'');const ts=Date.parse(published);return {title:safe(title,200),publishedAt:Number.isFinite(ts)?iso(ts):null,url:/^https:\/\//i.test(link)?link:null,ts};}).filter(x=>x.title&&x.ts&&now()-x.ts<36*3600000&&x.ts<=now()+600000);
}
async function newsDigest(env,force=false){
  const cached=await readKV(env,'vc:news:last');
  if(!force&&cached&&now()-cached.at<15*60000)return cached;
  const results=await Promise.allSettled(NEWS_FEEDS.map(async ([source,url])=>{
    const r=await fetch(url,{headers:{accept:'application/rss+xml, application/xml, text/xml'},signal:AbortSignal.timeout(6500)});
    if(!r.ok)throw Error('HTTP '+r.status);
    const xml=(await r.text()).slice(0,300000);
    if(!/<(?:rss|feed|rdf:RDF)\b/i.test(xml))throw Error('Invalid RSS');
    return {source,items:parseRss(xml)};
  }));
  const items=[],seen=new Set(),sources=[];
  results.forEach((r,i)=>{const source=NEWS_FEEDS[i][0];if(r.status==='rejected'){sources.push({source,ok:false,error:safe(r.reason?.message,100)});return;}sources.push({source,ok:true,count:r.value.items.length});for(const x of r.value.items){const k=x.title.toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();if(!seen.has(k)){seen.add(k);items.push({...x,source});}}});
  items.sort((a,b)=>b.ts-a.ts);
  const out={at:now(),items:items.slice(0,20),sources,issues:sources.filter(x=>!x.ok).map(x=>x.source+': '+x.error),verifiedArticles:false,warning:'RSS headlines are not independently verified; news outlook is not used by the option-chain signal engine.'};
  if(!out.items.length&&cached?.items?.length&&now()-cached.at<36*3600000){out.items=cached.items;out.staleFallback=true;out.issues.push('Showing cached headlines; refresh failed.');}
  await writeKV(env,'vc:news:last',out,3600);
  return out;
}
async function telegram(env,message){
  if(!env.TELEGRAM_BOT_TOKEN||!env.TELEGRAM_CHAT_ID)throw Error('Telegram credentials missing');
  let rest=String(message),parts=[];
  while(rest.length){if(parts.length>=10)throw Error('Telegram message too long');if(rest.length<=3800){parts.push(rest);break;}let cut=rest.lastIndexOf('\n',3800);if(cut<1800)cut=3800;parts.push(rest.slice(0,cut));rest=rest.slice(cut).replace(/^\n/,'');}
  const ids=[];
  for(const part of parts){const r=await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:env.TELEGRAM_CHAT_ID,text:part,disable_web_page_preview:true}),signal:AbortSignal.timeout(12000)});let j;try{j=await r.json()}catch{throw Error('Telegram response unreadable; delivery uncertain');}if(!r.ok||j?.ok!==true)throw Error('Telegram rejected message: '+safe(j?.description||r.status));ids.push(j.result?.message_id||null);}
  return {delivered:true,messageIds:ids};
}

async function dhanRequest(env,path,body){
  if(!env.DHAN_CLIENT_ID||!env.DHAN_ACCESS_TOKEN)throw Error('Set DHAN_CLIENT_ID and DHAN_ACCESS_TOKEN Cloudflare secrets');
  const r=await fetch(Dhan+path,{method:'POST',headers:{'content-type':'application/json','accept':'application/json','access-token':env.DHAN_ACCESS_TOKEN,'client-id':env.DHAN_CLIENT_ID},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
  let data;try{data=await r.json()}catch{throw Error('Dhan returned non-JSON HTTP '+r.status);}
  if(!r.ok||String(data?.status||'').toLowerCase()!=='success')throw Error('Dhan API '+r.status+': '+safe(data?.remarks||data?.message||data?.errorMessage||'request rejected'));
  return data;
}
function underlyingConfig(env,name){
  const prefix=name==='NIFTY'?'DHAN_NIFTY':'DHAN_SENSEX';
  const scrip=Number(env[prefix+'_UNDERLYING_SCRIP']||(name==='NIFTY'?'13':name==='SENSEX'?'51':''));
  const segment=String(env[prefix+'_UNDERLYING_SEG']||'IDX_I');
  if(!Number.isSafeInteger(scrip)||scrip<=0)throw Error(`Missing ${prefix}_UNDERLYING_SCRIP. Set the Dhan index Security ID from the current instrument master.`);
  return {scrip,segment};
}
async function expiryList(env,name){
  const key='vc:expiries:'+name,cache=await readKV(env,key);
  if(cache?.dates?.length&&cache.at>Date.now()-12*3600000)return cache.dates;
  const u=underlyingConfig(env,name);
  await respectOptionChainRateLimit();
  const r=await dhanRequest(env,'/optionchain/expirylist',{UnderlyingScrip:u.scrip,UnderlyingSeg:u.segment});
  const dates=Array.isArray(r.data)?r.data.filter(x=>/^20\d{2}-\d{2}-\d{2}$/.test(x)).sort():[];
  if(!dates.length)throw Error('Dhan returned no valid option expiries for '+name);
  await writeKV(env,key,{at:now(),dates},86400);
  return dates;
}
function normalizeChain(raw,name,expiry){
  const data=raw?.data;if(!data?.oc||typeof data.oc!=='object')throw Error('Dhan option-chain response missing data.oc');
  const spot=num(data.last_price);if(!(spot>0))throw Error('Dhan option-chain underlying LTP missing');
  const rows=[];
  for(const [strikeText,pair] of Object.entries(data.oc)){
    const strike=num(strikeText);if(!(strike>0))continue;
    for(const side of ['ce','pe']){
      const x=pair?.[side];if(!x)continue;
      const g=x.greeks||{};
      const bid=num(x.top_bid_price),ask=num(x.top_ask_price),ltp=num(x.last_price),oi=num(x.oi),prevOi=num(x.previous_oi),volume=num(x.volume),prevVolume=num(x.previous_volume);
      const spreadPct=bid>0&&ask>=bid&&ltp>0?+((ask-bid)/ltp*100).toFixed(3):null;
      rows.push({underlying:name,exchange:name==='SENSEX'?'BSE':'NSE',expiry,strike,side:side.toUpperCase(),securityId:String(x.security_id??''),ltp,bid,ask,bidQty:num(x.top_bid_quantity),askQty:num(x.top_ask_quantity),spreadPct,oi,previousOi:prevOi,oiChange:oi!==null&&prevOi!==null?oi-prevOi:null,volume,previousVolume:prevVolume,volumeChange:volume!==null&&prevVolume!==null?volume-prevVolume:null,iv:num(x.implied_volatility),delta:num(g.delta),gamma:num(g.gamma),theta:num(g.theta),vega:num(g.vega),averagePrice:num(x.average_price),previousClose:num(x.previous_close_price)});
    }
  }
  if(!rows.length)throw Error('Dhan option chain contained no CE/PE contracts');
  return {underlying:name,expiry,spot,at:now(),chain:rows};
}
function chainSummary(snapshot,previous){
  const rows=snapshot.chain,ce=rows.filter(x=>x.side==='CE'),pe=rows.filter(x=>x.side==='PE');
  const sum=(a,k)=>a.reduce((n,x)=>n+(x[k]??0),0);
  const ceOi=sum(ce,'oi'),peOi=sum(pe,'oi'),ceVol=sum(ce,'volume'),peVol=sum(pe,'volume');
  const prior=new Map((previous?.chain||[]).map(x=>[x.securityId,x]));
  const withChange=rows.map(x=>{const p=prior.get(x.securityId);return {...x,oiDeltaSinceLast:p&&x.oi!==null&&p.oi!==null?x.oi-p.oi:null,premiumChangePct:p&&p.ltp>0&&x.ltp>0?pct(x.ltp,p.ltp):null};});
  const walls=a=>[...a].filter(x=>x.oi!==null).sort((x,y)=>y.oi-x.oi).slice(0,5).map(x=>({strike:x.strike,oi:x.oi,oiChange:x.oiChange}));
  const atm=[...new Set(rows.map(x=>x.strike))].sort((a,b)=>Math.abs(a-snapshot.spot)-Math.abs(b-snapshot.spot)).slice(0,8);
  const near=withChange.filter(x=>atm.includes(x.strike));
  const liquid=withChange.filter(x=>x.ltp>0&&x.bid>0&&x.ask>=x.bid&&x.oi>0&&x.volume>0&&x.spreadPct!==null&&x.spreadPct<=Number(snapshot.maxSpreadPct||2.5)).sort((a,b)=>(b.volume||0)-(a.volume||0)).slice(0,12);
  return {spot:snapshot.spot,expiry:snapshot.expiry,contracts:rows.length,ceOi,peOi,pcr:ceOi>0?+(peOi/ceOi).toFixed(3):null,ceVolume:ceVol,peVolume:peVol,callOiWalls:walls(ce),putOiWalls:walls(pe),nearSpot:near.slice(0,40),liquidCandidates:liquid.map(x=>({symbol:`${x.underlying}-${x.expiry}-${x.strike}-${x.side}`,securityId:x.securityId,strike:x.strike,side:x.side,ltp:x.ltp,bid:x.bid,ask:x.ask,spreadPct:x.spreadPct,oi:x.oi,oiChange:x.oiChange,oiDeltaSinceLast:x.oiDeltaSinceLast,volume:x.volume,volumeChange:x.volumeChange,iv:x.iv,delta:x.delta,gamma:x.gamma,theta:x.theta,vega:x.vega,premiumChangePct:x.premiumChangePct,bidQty:x.bidQty,askQty:x.askQty})),limitations:['OI does not by itself prove buyer or writer intent','Dhan option-chain snapshot is not an execution fill','AI output is constrained to this option-chain evidence only']};
}
function buildAIInput(name,snapshot,summary){
  return {underlying:name,asOf:iso(snapshot.at),spot:snapshot.spot,expiry:snapshot.expiry,chainMetrics:{pcr:summary.pcr,ceOi:summary.ceOi,peOi:summary.peOi,ceVolume:summary.ceVolume,peVolume:summary.peVolume,callOiWalls:summary.callOiWalls,putOiWalls:summary.putOiWalls},nearSpot:summary.nearSpot.map(x=>({strike:x.strike,side:x.side,ltp:x.ltp,oi:x.oi,oiChange:x.oiChange,volume:x.volume,iv:x.iv,delta:x.delta,gamma:x.gamma,theta:x.theta,vega:x.vega,bid:x.bid,ask:x.ask,bidQty:x.bidQty,askQty:x.askQty,spreadPct:x.spreadPct,oiDeltaSinceLast:x.oiDeltaSinceLast,premiumChangePct:x.premiumChangePct})),liquidCandidates:summary.liquidCandidates};
}
async function aiChainDecision(env,input){
  if(!env.AI?.run)return {status:'AI_UNAVAILABLE',action:'WAIT',reason:'Cloudflare Workers AI binding is missing'};
  const system=`You are V-Care_Telegram's options-chain analyst. Analyze ONLY the supplied Dhan option-chain snapshot: spot, CE/PE OI, OI changes, volume, IV, Greeks, premium, bid/ask and depth quantities. Do not use charts, candles, indicators, news, external assumptions, fixed named strategies, or invented data. Do not infer buyer/writer identity from OI alone. Return ONLY JSON with keys: action (BUY_CE, BUY_PE, WAIT), candidateSymbol (exact supplied candidate symbol or null), confidence (0..1), reason (max 240 chars), invalidation (max 160 chars). Select BUY only when multiple supplied option-chain facts align and the candidate has valid bid/ask, positive OI/volume and spread <= 2.5%; otherwise WAIT. Never recommend naked option selling. This is an alert simulation, not an order.`;
  const response=await env.AI.run(String(env.AI_MODEL||'@cf/meta/llama-3.2-3b-instruct'),{messages:[{role:'system',content:system},{role:'user',content:JSON.stringify(input).slice(0,14000)}],max_tokens:450});
  const raw=String(response?.response||'').trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
  let x;try{x=JSON.parse(raw)}catch{return {status:'AI_INVALID_JSON',action:'WAIT',reason:'AI response was not valid JSON'}};
  const allowed=new Map(input.liquidCandidates.map(c=>[c.symbol,c]));
  const action=['BUY_CE','BUY_PE','WAIT'].includes(x.action)?x.action:'WAIT';
  const candidate=allowed.get(x.candidateSymbol);
  const directionOk=candidate&&(action==='BUY_CE'&&candidate.side==='CE'||action==='BUY_PE'&&candidate.side==='PE');
  const confidence=num(x.confidence);
  if(action!=='WAIT'&&(!directionOk||confidence===null||confidence<0.72||candidate.spreadPct>2.5))return {status:'AI_DECISION_REJECTED',action:'WAIT',reason:'Candidate, direction, spread or confidence validation failed'};
  return {status:'AI_REVIEWED',action:action==='WAIT'?'WAIT':action,candidate:directionOk?candidate:null,confidence:confidence===null?0:Math.max(0,Math.min(1,confidence)),reason:safe(x.reason||'Insufficient evidence',240),invalidation:safe(x.invalidation||'Option-chain evidence changed or became stale',160),model:String(env.AI_MODEL||'@cf/meta/llama-3.2-3b-instruct')};
}
function riskConfig(env){return {targetPct:Math.max(1,Math.min(100,num(env.VC_TARGET_PCT)??12)),stopPct:Math.max(1,Math.min(50,num(env.VC_STOP_PCT)??8)),trailActivatePct:Math.max(1,Math.min(100,num(env.VC_TRAIL_ACTIVATE_PCT)??6)),trailGapPct:Math.max(0.5,Math.min(50,num(env.VC_TRAIL_GAP_PCT)??3)),maxHoldMinutes:Math.max(3,Math.min(240,num(env.VC_MAX_HOLD_MINUTES)??20))}};
async function checkOpenPosition(env,name,snapshot){
  const key='vc:position:'+name,pos=await readKV(env,key);if(!pos||pos.status!=='OPEN')return null;
  const live=snapshot.chain.find(x=>x.securityId===pos.securityId);if(!live||!(live.ltp>0))return {status:'OPEN_NO_FRESH_QUOTE',symbol:pos.symbol};
  const r=riskConfig(env);pos.lastPrice=live.ltp;pos.lastCheckedAt=now();pos.highWater=Math.max(pos.highWater||pos.entry,live.ltp);
  const gainPct=pct(live.ltp,pos.entry);let reason=null;
  if(live.ltp<=pos.stop)reason=pos.trailingActive?'TRAILING_STOP':'STOP_LOSS';
  else if(live.ltp>=pos.target)reason='TARGET_HIT';
  if(!reason&&gainPct!==null&&gainPct>=r.trailActivatePct){pos.trailingActive=true;const trailing=+(pos.highWater*(1-r.trailGapPct/100)).toFixed(2);pos.stop=Math.max(pos.stop,trailing);if(live.ltp<=pos.stop)reason='TRAILING_STOP';}
  if(!reason&&now()-pos.openedAt>=r.maxHoldMinutes*60000)reason='TIME_EXIT';
  if(reason){pos.status='CLOSED';pos.closedAt=now();pos.exit=live.ltp;pos.exitReason=reason;pos.pnlPct=gainPct;await writeKV(env,key,pos,86400*14);await telegram(env,`🔻 ${APP} EXIT / SELL TO CLOSE\n${pos.underlying} ${pos.symbol}\nEntry ₹${pos.entry} | Exit ₹${live.ltp}\nReason: ${reason}\nP/L (premium %): ${gainPct??'n/a'}%\nNo broker order was placed.`);return {status:'CLOSED',reason,symbol:pos.symbol};}
  await writeKV(env,key,pos,86400*2);return {status:'OPEN',symbol:pos.symbol,last:live.ltp,stop:pos.stop,target:pos.target,highWater:pos.highWater};
}
async function analyzeUnderlying(env,name){
  const expiries=await expiryList(env,name),today=dayIST(),expiry=expiries.find(x=>x>=today);if(!expiry)throw Error('No upcoming expiry for '+name);
  const u=underlyingConfig(env,name);
  await respectOptionChainRateLimit();
  const raw=await dhanRequest(env,'/optionchain',{UnderlyingScrip:u.scrip,UnderlyingSeg:u.segment,Expiry:expiry});
  const snapshot=normalizeChain(raw,name,expiry),previous=await readKV(env,'vc:chain:last:'+name);
  const summary=chainSummary(snapshot,previous);
  const positionResult=await checkOpenPosition(env,name,snapshot);
  // Save the latest chain only after position checks have consumed the prior snapshot.
  const saved=await writeKV(env,'vc:chain:last:'+name,snapshot,86400);
  const ai=await aiChainDecision(env,buildAIInput(name,snapshot,summary));
  let signal=null;
  if(ai.action==='BUY_CE'||ai.action==='BUY_PE'){
    const c=ai.candidate,r=riskConfig(env),entry=c.ask>0?c.ask:c.ltp;
    const posKey='vc:position:'+name,old=await readKV(env,posKey);
    if(old?.status==='OPEN')signal={status:'SKIPPED_OPEN_POSITION',reason:'Existing simulated position still open'};
    else if(!(entry>0))signal={status:'SKIPPED_INVALID_ENTRY'};
    else{
      const symbol=c.symbol,position={status:'OPEN',underlying:name,symbol,securityId:c.securityId,side:c.side,entry,stop:+(entry*(1-r.stopPct/100)).toFixed(2),target:+(entry*(1+r.targetPct/100)).toFixed(2),highWater:entry,trailingActive:false,openedAt:now(),lastCheckedAt:now(),confidence:ai.confidence,reason:ai.reason,expiry};
      const ok=await writeKV(env,posKey,position,86400*2);
      if(!ok)throw Error('Could not persist simulated position; alert blocked');
      await telegram(env,`🟢 ${APP} ${ai.action} ALERT (SIMULATED)\n${name} | ${symbol}\nExpiry: ${expiry}\nEntry reference: ₹${entry}\nTarget: ₹${position.target} (+${r.targetPct}%)\nStop-loss: ₹${position.stop} (-${r.stopPct}%)\nTrailing: activates +${r.trailActivatePct}%, gap ${r.trailGapPct}%\nTime exit: ${r.maxHoldMinutes} min if unresolved\nAI confidence: ${(ai.confidence*100).toFixed(0)}%\nOption-chain reason: ${ai.reason}\n⚠️ No order placed. Paper alert only; check live price and liquidity.`);
      signal={status:'ALERT_SENT',action:ai.action,symbol};
    }
  }
  const report={app:APP,version:VERSION,at:iso(snapshot.at),underlying:name,expiry,spot:snapshot.spot,chainContracts:snapshot.chain.length,metrics:{pcr:summary.pcr,ceOi:summary.ceOi,peOi:summary.peOi,ceVolume:summary.ceVolume,peVolume:summary.peVolume,callOiWalls:summary.callOiWalls,putOiWalls:summary.putOiWalls},ai:{status:ai.status,action:ai.action,confidence:ai.confidence??0,reason:ai.reason||null},signal,position:positionResult,kvSaved:saved,ordersPlaced:false,analysisSource:'DHAN_OPTION_CHAIN_ONLY'};
  await writeKV(env,'vc:analysis:last:'+name,report,86400);
  return report;
}
async function morningBriefing(env){
  const n=await newsDigest(env,true),items=n.items.slice(0,10).map(x=>({source:x.source,title:x.title,publishedAt:x.publishedAt,url:x.url}));
  let outlook={direction:'UNKNOWN',confidence:0,reason:'AI unavailable or no dated headlines'};
  if(env.AI?.run&&items.length){try{const r=await env.AI.run(String(env.AI_MODEL||'@cf/meta/llama-3.2-3b-instruct'),{messages:[{role:'system',content:'Summarize the supplied recent news headlines only. Return JSON {direction:BULLISH|BEARISH|MIXED|UNKNOWN,confidence:0..1,reason:string}. Do not invent events or prices. This is a news-context outlook, not an option-chain trading signal.'},{role:'user',content:JSON.stringify(items).slice(0,6000)}],max_tokens:180});const x=JSON.parse(String(r?.response||'').replace(/```json|```/g,'').trim());if(['BULLISH','BEARISH','MIXED','UNKNOWN'].includes(x.direction))outlook={direction:x.direction,confidence:Math.max(0,Math.min(1,num(x.confidence)??0)),reason:safe(x.reason,220)};}catch{outlook={direction:'UNKNOWN',confidence:0,reason:'News AI summary failed; headlines shown without a directional conclusion'};}}
  const lines=items.map((x,i)=>`${i+1}. ${x.title} (${x.source})`);
  const msg=`📰 ${APP} MORNING MARKET BRIEFING\nDate: ${dayIST()} | 08:30 IST\nNews-only outlook: ${outlook.direction} (${Math.round(outlook.confidence*100)}%)\n${outlook.reason}\n\nRECENT HEADLINES\n${lines.join('\n')||'No fresh market headlines found.'}\n\nNote: Headlines may be unverified. This news outlook is separate from the option-chain-only intraday signal engine. No trade call is made in this briefing.`;
  await telegram(env,msg);
  const result={at:now(),outlook,headlineCount:items.length,newsIssues:n.issues};await writeKV(env,'vc:briefing:last',result,86400*3);return result;
}
async function runCycle(env){
  if(!kvAvailable(env))throw Error('Cloudflare KV binding STATE is required');
  if(!marketOpen(env))return {status:'MARKET_CLOSED',at:iso(now()),ordersPlaced:false};
  const names=String(env.VC_UNDERLYINGS||'NIFTY,SENSEX').split(',').map(x=>x.trim().toUpperCase()).filter(x=>['NIFTY','SENSEX'].includes(x));
  const results={};for(const name of [...new Set(names)]){try{results[name]=await analyzeUnderlying(env,name);}catch(e){results[name]={status:'FAILED',error:safe(e?.message||e),ordersPlaced:false};}}
  const out={app:APP,version:VERSION,at:iso(now()),results,ordersPlaced:false};await writeKV(env,'vc:cycle:last',out,86400);return out;
}
async function handleTelegram(env,update){
  const msg=update?.message||update?.edited_message;if(!msg?.text)return;
  if(String(msg.chat?.id)!==String(env.TELEGRAM_CHAT_ID))return;
  const text=msg.text.trim(),cmd=text.split(/\s+/)[0].toLowerCase();let answer;
  if(['/start','/help'].includes(cmd))answer=`${APP} commands\n/status — worker, Dhan and latest cycle status\n/briefing — send latest market news briefing\n/options NIFTY|SENSEX — fetch and analyze option chain\n/analyze — run configured indices now\n\nSignal analysis uses Dhan option-chain data only. All alerts are simulated; no broker orders are placed.`;
  else if(cmd==='/status'){const [cycle,brief]=await Promise.all([readKV(env,'vc:cycle:last'),readKV(env,'vc:briefing:last')]);answer=JSON.stringify({app:APP,version:VERSION,marketOpen:marketOpen(env),missingSecrets:missingConfig(env),lastCycle:cycle?.at||null,lastBriefing:brief?.at||null,ordersPlaced:false},null,2);}
  else if(cmd==='/briefing'){const x=await morningBriefing(env);answer=`Briefing sent. News outlook: ${x.outlook.direction}; headlines: ${x.headlineCount}.`;}
  else if(cmd==='/options'){const name=(text.split(/\s+/)[1]||'NIFTY').toUpperCase();if(!['NIFTY','SENSEX'].includes(name))throw Error('Use /options NIFTY or /options SENSEX');const x=await analyzeUnderlying(env,name);answer=JSON.stringify(x,null,2);}
  else if(cmd==='/analyze'){const x=await runCycle(env);answer=JSON.stringify(x,null,2);}
  else answer='Unknown command. Send /help.';
  await telegram(env,answer);
}

export default {
  async fetch(request,env){
    const url=new URL(request.url);
    if(url.pathname==='/health')return json({ok:true,app:APP,version:VERSION,mode:'Dhan option-chain analysis + Telegram simulated alerts',ordersEnabled:false,signalSource:'DHAN_OPTION_CHAIN_ONLY'});
    if(url.pathname==='/status')return json({app:APP,version:VERSION,marketOpen:marketOpen(env),missingSecrets:missingConfig(env),lastCycle:await readKV(env,'vc:cycle:last'),lastBriefing:await readKV(env,'vc:briefing:last'),ordersPlaced:false});
    if(url.pathname==='/run'&&request.method==='POST'){
      if(request.headers.get('x-vcare-admin-token')!==env.VCARE_ADMIN_TOKEN||!env.VCARE_ADMIN_TOKEN)return json({error:'forbidden'},403);
      try{return json(await runCycle(env));}catch(e){return json({error:safe(e?.message||e),ordersPlaced:false},502);}
    }
    if(['/telegram','/telegram-webhook'].includes(url.pathname)&&request.method==='POST'){
      if(!env.TELEGRAM_WEBHOOK_SECRET||request.headers.get('X-Telegram-Bot-Api-Secret-Token')!==env.TELEGRAM_WEBHOOK_SECRET)return json({error:'forbidden'},403);
      let update;try{const raw=await request.text();if(raw.length>65536)return json({error:'payload too large'},413);update=JSON.parse(raw);}catch{return json({error:'invalid JSON'},400);}
      const id=update?.update_id;if(!Number.isSafeInteger(id))return json({error:'invalid update id'},400);
      const key='vc:telegram:update:'+id;if(await readKV(env,key))return json({ok:true,duplicate:true});
      try{await handleTelegram(env,update);await writeKV(env,key,{at:now()},86400*2);return json({ok:true});}catch(e){console.error('Telegram webhook error',safe(e?.message));return json({error:'handler failed'},500);}
    }
    return json({error:'not found'},404);
  },
  async scheduled(event,env,ctx){
    ctx.waitUntil((async()=>{
      const t=clockIST();
      // 08:30 IST daily briefing. Cron can overlap; KV marker suppresses repeats.
      if(t==='08:30'){
        const key='vc:briefing:sent:'+dayIST();
        if(!(await readKV(env,key))){try{await morningBriefing(env);await writeKV(env,key,{at:now()},86400*2);}catch(e){console.error('Morning briefing failed',safe(e?.message));}}
      }
      if(marketOpen(env)){
        try{const report=await runCycle(env);console.log('V-Care cycle',JSON.stringify({at:report.at,results:Object.keys(report.results||{})}));}
        catch(e){console.error('V-Care scheduled cycle failed',safe(e?.message));}
      }
    })());
  }
};
