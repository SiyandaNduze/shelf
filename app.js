/* Shelf — anime tracker. Catalog: AniList (live). Storage: SQLite (sql.js+IndexedDB on web, native SQLite via Capacitor on phones). */
/* Supabase project URL + publishable key. Never put a service_role/secret key in this public app. */
const CFG={url:'https://gbjnzkvwtmibnxsfyypt.supabase.co',key:'sb_publishable_rvf8YR0DSV6RLh44Ko2B4g_IBqntee8'};
const CDN='https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/';
const GQL=`query($q:String,$g:String,$p:Int,$s:[MediaSort]){Page(page:$p,perPage:30){pageInfo{hasNextPage}media(type:ANIME,isAdult:false,search:$q,genre:$g,sort:$s){id title{romaji english}seasonYear episodes genres tags{name rank}coverImage{large}}}}`;
const GENRES=['Action','Adventure','Comedy','Drama','Fantasy','Horror','Mahou Shoujo','Mecha','Music','Mystery','Psychological','Romance','Sci-Fi','Slice of Life','Sports','Supernatural','Thriller'];
const ST={p:'Plan to watch',w:'Watching',c:'Completed'};
const SCHEMA=[
'CREATE TABLE IF NOT EXISTS anime(id INTEGER PRIMARY KEY,title TEXT,year INT,eps INT,traits TEXT,cover TEXT)',
'CREATE TABLE IF NOT EXISTS anime_rel(anime_id INTEGER PRIMARY KEY,related_ids TEXT)',
'CREATE TABLE IF NOT EXISTS entry(anime_id INTEGER PRIMARY KEY,status TEXT,score INT DEFAULT 0,rnk REAL)',
'CREATE TABLE IF NOT EXISTS cat(name TEXT PRIMARY KEY)',
'CREATE TABLE IF NOT EXISTS cat_item(cat TEXT,anime_id INT,PRIMARY KEY(cat,anime_id))',
'CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY,v TEXT)'];
 
/* ---------- storage layer: same SQL everywhere ---------- */
const idb=()=>new Promise((res,rej)=>{const r=indexedDB.open('shelf',1);r.onupgradeneeded=()=>{if(!r.result.objectStoreNames.contains('k'))r.result.createObjectStore('k')};r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error||new Error('IndexedDB unavailable'));r.onblocked=()=>rej(new Error('IndexedDB is blocked by another tab'))});
const idbGet=async()=>{let d;try{d=await idb();return await new Promise((res,rej)=>{const q=d.transaction('k').objectStore('k').get('db');q.onsuccess=()=>res(q.result);q.onerror=()=>rej(q.error)})}catch(e){console.warn('Shelf local persistence unavailable:',e);return null}finally{if(d)d.close()}};
const idbSet=async b=>{const d=await idb();try{await new Promise((res,rej)=>{const tx=d.transaction('k','readwrite');tx.objectStore('k').put(b,'db');tx.oncomplete=res;tx.onerror=()=>rej(tx.error);tx.onabort=()=>rej(tx.error||new Error('IndexedDB write aborted'))})}finally{d.close()}};
const loadScript=src=>new Promise((res,rej)=>{const s=document.createElement('script');s.src=src;s.onload=res;s.onerror=rej;document.head.appendChild(s)});
let DB;
async function initDB(){
  const cap=window.Capacitor,plug=cap&&cap.isNativePlatform&&cap.isNativePlatform()&&cap.Plugins.CapacitorSQLite;
  if(plug){
    const database='shelf';
    await plug.createConnection({database,version:1,encrypted:false,mode:'no-encryption'});
    await plug.open({database});
    await plug.execute({database,statements:SCHEMA.join(';')+';'});
    return{native:true,
      run:(s,v=[])=>plug.run({database,statement:s,values:v,transaction:false}),
      batch:async ops=>{await plug.execute({database,statements:'BEGIN;',transaction:false});try{for(const [s,v=[]] of ops)await plug.run({database,statement:s,values:v,transaction:false});await plug.execute({database,statements:'COMMIT;',transaction:false});}catch(e){try{await plug.execute({database,statements:'ROLLBACK;',transaction:false});}catch(_){}throw e;}},
      all:async(s,v=[])=>(await plug.query({database,statement:s,values:v})).values||[]};
  }
  let base=CDN;try{await loadScript(base+'sql-wasm.js')}catch(e){base='https://cdn.jsdelivr.net/npm/sql.js@1.10.3/dist/';await loadScript(base+'sql-wasm.js')}
  const SQL=await initSqlJs({locateFile:f=>base+f});
  let d=new SQL.Database(await idbGet()||undefined);SCHEMA.forEach(s=>d.run(s));
  const channel='BroadcastChannel'in window?new BroadcastChannel('shelf-db'):null;
  const locked=fn=>navigator.locks&&navigator.locks.request?navigator.locks.request('shelf-db-write',{mode:'exclusive'},fn):fn();
  const refresh=async()=>{const latest=await idbGet();if(latest){d.close();d=new SQL.Database(latest)}};
  const persist=async()=>{try{await idbSet(d.export());if(channel)channel.postMessage({type:'changed'})}catch(e){console.warn('Shelf could not persist local data:',e)}};
  if(channel)channel.onmessage=async()=>{try{await locked(refresh);if(DB&&DB.native===false){await reload();render()}}catch(e){console.warn('Shelf cross-tab refresh failed:',e)}};
  return{native:false,
    run:async(s,v=[])=>locked(async()=>{await refresh();d.run(s,v);await persist()}),
    batch:async ops=>locked(async()=>{await refresh();d.run('BEGIN');try{for(const [s,v=[]] of ops)d.run(s,v);d.run('COMMIT');await persist()}catch(e){try{d.run('ROLLBACK')}catch(_){}throw e}}),
    refresh:()=>locked(refresh),
    all:async(s,v=[])=>{const st=d.prepare(s);st.bind(v);const r=[];while(st.step())r.push(st.getAsObject());st.free();return r}};
}
 
/* ---------- state ---------- */
let L=[],cats={},seen={},items=[],page=1,more=false,busy=false,offline=false,relationMap={},loadToken=0,visibleTarget=30;
let tab='browse',q='',gen='',flt='all',srt='title',dlg=null,timer;
const parse=r=>({...r,traits:JSON.parse(r.traits||'[]')});
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const inL=id=>L.find(a=>a.id==id);
async function reload(){
  L=(await DB.all('SELECT a.*,e.status,e.score,e.rnk FROM entry e JOIN anime a ON a.id=e.anime_id')).map(parse);
  L.forEach(a=>seen[a.id]=a);cats={};relationMap={};
  for(const r of await DB.all('SELECT anime_id,related_ids FROM anime_rel')){try{relationMap[r.anime_id]=JSON.parse(r.related_ids||'[]').map(Number)}catch(e){relationMap[r.anime_id]=[]}}
  for(const c of await DB.all('SELECT name FROM cat'))cats[c.name]=[];
  for(const r of await DB.all('SELECT * FROM cat_item'))if(cats[r.cat])cats[r.cat].push(+r.anime_id);
}
const saveAnime=a=>DB.run('INSERT OR REPLACE INTO anime VALUES(?,?,?,?,?,?)',[a.id,a.title,a.year,a.eps,JSON.stringify(a.traits),a.cover]);
async function setStatus(id,s){
  if(!s){await DB.run('DELETE FROM entry WHERE anime_id=?',[id]);await DB.run('DELETE FROM cat_item WHERE anime_id=?',[id])}
  else{
    await saveAnime(seen[id]);const ex=inL(id);
    let rnk=null;if(s==='c')rnk=ex&&ex.rnk!=null?ex.rnk:Math.max(0,...L.map(a=>a.rnk||0))+1;
    await DB.run('INSERT INTO entry VALUES(?,?,?,?) ON CONFLICT(anime_id) DO UPDATE SET status=excluded.status,rnk=excluded.rnk',[id,s,ex?ex.score:0,rnk]);
  }
  await commit();
  if(s&&navigator.onLine)refreshRelations().catch(()=>{});
  if(s==='c'&&tab==='browse')await load(false,false);
}
 
/* ---------- catalog (AniList) ---------- */
async function fetchAnime(requestPage=page){
  const r=await fetch('https://graphql.anilist.co',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({query:GQL,variables:{q:q||undefined,g:gen||undefined,p:requestPage,s:[q?'SEARCH_MATCH':'POPULARITY_DESC']}})});
  if(!r.ok)throw new Error('AniList request failed ('+r.status+')');const json=await r.json();if(json.errors||!json.data||!json.data.Page)throw new Error('AniList returned an invalid response');const P=json.data.Page;
  return{more:P.pageInfo.hasNextPage,items:P.media.map(m=>({id:m.id,title:m.title.english||m.title.romaji,year:m.seasonYear||0,eps:m.episodes||0,
    traits:[...m.genres,...m.tags.filter(t=>t.rank>=60).slice(0,3).map(t=>t.name)],cover:m.coverImage.large}))};
}
async function load(reset,appendMore=false){
  const token=++loadToken;if(reset){items=[];page=1;more=true}
  const visibleNow=items.filter(a=>{const x=inL(a.id);return !x||x.status!=='c'}).length;
  const target=reset||appendMore?visibleTarget:Math.max(0,visibleTarget-visibleNow);
  if(!target){busy=false;render();return}
  busy=true;render();
  try{let next=page,hasMore=more,added=[];while(hasMore&&added.filter(a=>{const x=inL(a.id);return !x||x.status!=='c'}).length<target){const r=await fetchAnime(next);if(token!==loadToken)return;added=added.concat(r.items);hasMore=r.more;next++;if(!r.items.length)break;}
    if(token!==loadToken)return;items=reset?added:items.concat(added);page=next;more=hasMore;offline=false;for(const a of added){seen[a.id]=inL(a.id)||a;await saveAnime(a)}
  }catch(e){if(token!==loadToken)return;offline=true;more=false;if(reset){items=(await DB.all('SELECT * FROM anime WHERE title LIKE ? ORDER BY title LIMIT 120',['%'+q+'%'])).map(parse).filter(a=>!gen||a.traits.includes(gen));for(const a of items)seen[a.id]=inL(a.id)||a}}
  if(token!==loadToken)return;busy=false;render();
}
 
/* ---------- AniList franchise relationships ---------- */
const RELATION_TYPES=new Set(['SEQUEL','PREQUEL','PARENT','SIDE_STORY','SPIN_OFF']);
const REL_QUERY=`query($ids:[Int]){Page(page:1,perPage:50){media(id_in:$ids,type:ANIME){id relations{edges{relationType node{id type}}}}}}`;
async function refreshRelations(){
  if(!L.length||!navigator.onLine)return;
  const cached=new Set(Object.keys(relationMap).map(Number));
  let frontier=L.map(a=>+a.id),visited=new Set(),changed=false;
  for(let depth=0;depth<10&&frontier.length&&visited.size<1000;depth++){
    const batch=frontier.filter(id=>!visited.has(id)).slice(0,1000-visited.size);
    if(!batch.length)break;
    const missing=batch.filter(id=>!cached.has(id));
    for(let i=0;i<missing.length;i+=40){
      const ids=missing.slice(i,i+40);
      try{
        const response=await fetch('https://graphql.anilist.co',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query:REL_QUERY,variables:{ids}})});
        if(!response.ok)throw new Error('AniList relationship lookup failed');
        const payload=await response.json();if(payload.errors)throw new Error('AniList relationship lookup failed');
        const found=new Set();
        for(const media of payload.data.Page.media){
          const related=media.relations.edges.filter(e=>RELATION_TYPES.has(e.relationType)&&e.node.type==='ANIME').map(e=>+e.node.id);
          relationMap[media.id]=related;cached.add(+media.id);found.add(+media.id);changed=true;
          await DB.run('INSERT OR REPLACE INTO anime_rel VALUES(?,?)',[+media.id,JSON.stringify(related)]);
        }
        // Cache missing records as empty only when AniList returned the requested media.
        for(const id of ids)if(!found.has(id)){relationMap[id]=[];cached.add(id);changed=true;await DB.run('INSERT OR REPLACE INTO anime_rel VALUES(?,?)',[id,'[]'])}
      }catch(e){return}
    }
    batch.forEach(id=>visited.add(id));
    frontier=batch.flatMap(id=>relationMap[id]||[]).filter(id=>!visited.has(id)&&!cached.has(id));
    // Cached neighbors still need to be traversed so a franchise can connect through an unlisted season.
    const cachedNeighbors=batch.flatMap(id=>relationMap[id]||[]).filter(id=>!visited.has(id));
    frontier=[...new Set(frontier.concat(cachedNeighbors))];
  }
  if(changed){await reload();if(tab==='list')render()}
}
function franchiseGroups(){
  const parent=new Map();
  const find=x=>{if(!parent.has(x))parent.set(x,x);if(parent.get(x)!==x)parent.set(x,find(parent.get(x)));return parent.get(x)};
  const unite=(a,b)=>{const x=find(a),y=find(b);if(x!==y)parent.set(Math.max(x,y),Math.min(x,y))};
  for(const [id,links] of Object.entries(relationMap))for(const other of links)unite(+id,+other);
  const groups=new Map();
  for(const a of L){const root=find(+a.id);if(!groups.has(root))groups.set(root,[]);groups.get(root).push(a)}
  return [...groups.values()].map(members=>{
    members.sort((a,b)=>(a.year||9999)-(b.year||9999)||a.title.length-b.title.length||a.title.localeCompare(b.title));
    return{title:members[0].title,items:members,completed:members.every(a=>a.status==='c')};
  }).sort((a,b)=>a.title.localeCompare(b.title));
}

/* ---------- auto categories: greedy grouping by most-shared trait ---------- */
function auto(){
  const cnt={};L.forEach(a=>a.traits.forEach(g=>cnt[g]=(cnt[g]||0)+1));
  let left=new Set(L.map(a=>a.id)),out=[];
  while(left.size){
    const c={};left.forEach(id=>seen[id].traits.forEach(g=>{if(cnt[g]>1)c[g]=(c[g]||0)+1}));
    const top=Object.entries(c).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]))[0];
    if(!top||top[1]<2)break;
    const m=[...left].filter(id=>seen[id].traits.includes(top[0]));
    const sh={};m.forEach(id=>seen[id].traits.forEach(g=>{if(g!==top[0])sh[g]=(sh[g]||0)+1}));
    const sec=Object.entries(sh).sort((a,b)=>b[1]-a[1])[0];
    out.push({name:top[0]+(sec&&m.length>2&&sec[1]>=m.length/2?' + '+sec[0]:''),ids:m});m.forEach(id=>left.delete(id));
  }
  if(left.size)out.push({name:'Unsorted',ids:[...left]});return out;
}
 
/* ---------- views ---------- */
const hue=t=>{let h=0;for(const c of t)h=(h*31+c.charCodeAt(0))%360;return h};
const card=a=>{const x=inL(a.id);return`<div class="card"><div class="cov" style="background:hsl(${hue(a.title)} 50% 35%)"><img src="${esc(a.cover||'')}" alt="${esc(a.title)} cover" loading="lazy" onerror="this.remove()"><button class="add ${x?'has':''}" data-a="plus" data-id="${a.id}" aria-label="Add ${esc(a.title)} to list">${x?x.status.toUpperCase():'+'}</button></div><div class="cb"><b>${esc(a.title)}</b><small>${a.year||'?'} · ${a.eps||'?'} ep<br>${esc(a.traits.slice(0,2).join(', '))}</small></div></div>`};
function render(){
  document.getElementById('nav').innerHTML=[['browse','Browse'],['list','My list'],['rank','Rankings'],['cats','Categories'],['acct','Account']].map(([k,n])=>`<button class="${tab===k?'on':''}" data-a="tab" data-v="${k}">${n}${k==='list'?' ('+L.length+')':''}</button>`).join('');
  let h='';
  if(tab==='browse')h=`<div class="bar"><input type="search" id="q" placeholder="Search every anime on AniList" value="${esc(q)}"><select id="gen"><option value="">All genres</option>${GENRES.map(g=>`<option ${g===gen?'selected':''}>${g}</option>`).join('')}</select></div>`+
    (offline?'<p class="note">You’re offline. Showing anime you’ve already viewed on this device.</p>':'')+
    `<div class="grid">${items.filter(a=>{const saved=inL(a.id);return !saved||saved.status!=='c'}).map(card).join('')}</div>`+(busy?'<p class="empty">Loading…</p>':more?'<p class="empty"><button class="btn" data-a="more">Load more</button></p>':items.some(a=>{const saved=inL(a.id);return !saved||saved.status!=='c'})?'':'<p class="empty">No uncompleted anime in these results.</p>');
  if(tab==='list'){
    const groups=franchiseGroups();
    const counts={all:groups.length,p:groups.filter(g=>g.items.some(a=>a.status==='p')).length,w:groups.filter(g=>g.items.some(a=>a.status==='w')).length,c:groups.filter(g=>g.completed).length};
    const visible=groups.filter(g=>flt==='all'||(flt==='c'?g.completed:g.items.some(a=>a.status===flt))).sort((a,b)=>{
      const p=a.items[0],q=b.items[0];return srt==='title'?a.title.localeCompare(b.title):srt==='year'?(p.year||0)-(q.year||0):Math.max(...b.items.map(x=>x.score||0))-Math.max(...a.items.map(x=>x.score||0));
    });
    const row=a=>`<div class="row"><b>${esc(a.title)}<br><small style="color:var(--mut);font-weight:400">${a.year||'?'} · ${a.eps||'?'} ep</small></b><select data-a="st" data-id="${a.id}">${Object.entries(ST).map(([k,n])=>`<option value="${k}" ${a.status===k?'selected':''}>${n}</option>`).join('')}</select><select data-a="sc" data-id="${a.id}"><option value="0">Score</option>${[10,9,8,7,6,5,4,3,2,1].map(n=>`<option ${a.score===n?'selected':''}>${n}</option>`).join('')}</select><button class="btn ghost" data-a="rm" data-id="${a.id}">Remove</button></div>`;
    const group=g=>g.items.length===1?row(g.items[0]):`<section class="franchise"><div class="franchise-head"><b>${esc(g.title)}</b><small>${g.items.length} related entries · ${g.items.filter(a=>a.status==='c').length}/${g.items.length} completed</small></div>${g.items.map(row).join('')}</section>`;
    h=`<div class="bar"><div class="chips">${[['all','All'],['p','Plan to watch'],['w','Watching'],['c','Completed']].map(([k,n])=>`<button class="chip ${flt===k?'on':''}" data-a="flt" data-v="${k}">${n} (${counts[k]})</button>`).join('')}</div><select id="srt">${[['title','Sort: title'],['year','Sort: year'],['score','Sort: score']].map(([k,n])=>`<option value="${k}" ${srt===k?'selected':''}>${n}</option>`).join('')}</select></div>`+
    (visible.length?visible.map(group).join(''):'<p class="empty">Nothing here yet. Browse and press + on an anime.</p>');
  }
  if(tab==='rank'){
    const r=L.filter(a=>a.status==='c').sort((a,b)=>(a.rnk||1e9)-(b.rnk||1e9));
    h=`<div class="bar"><button class="btn" data-a="byscore">Sort by score</button></div><p class="note">Your completed anime, best first. Use the arrows to reorder.</p>`+
    (r.length?r.map((a,i)=>`<div class="row"><span class="rk">${i+1}</span><b>${esc(a.title)}</b><small>${a.score?'★ '+a.score:'unscored'}</small><button class="btn ghost" data-a="up" data-id="${a.id}" aria-label="Move up">▲</button><button class="btn ghost" data-a="dn" data-id="${a.id}" aria-label="Move down">▼</button></div>`).join(''):'<p class="empty">Mark anime as Completed to rank them.</p>');
  }
  if(tab==='cats')h=`<h2>Your categories</h2><div class="bar"><input id="nc" placeholder="New category, e.g. Comfort watches"><button class="btn" data-a="newcat">Create</button></div>`+
    (Object.keys(cats).map(c=>`<div class="grp"><h3>${esc(c)}</h3><div>${cats[c].filter(inL).map(id=>`<span class="tag">${esc(inL(id).title)} <button data-a="uncat" data-c="${esc(c)}" data-id="${id}" aria-label="Remove">×</button></span>`).join('')||'<p>Empty</p>'}</div><div class="bar" style="margin:8px 0 0"><select data-a="addcat" data-c="${esc(c)}"><option value="">Add from my list…</option>${L.filter(a=>!cats[c].includes(+a.id)).map(a=>`<option value="${a.id}">${esc(a.title)}</option>`).join('')}</select><button class="btn ghost" data-a="delcat" data-c="${esc(c)}">Delete</button></div></div>`).join('')||'<p class="empty">No categories yet.</p>')+
    `<h2 style="margin-top:28px">Auto categories</h2><p class="note">Grouped by the genres and themes your anime share. The most common shared trait forms a group first, then the next, until everything is placed.</p>`+
    (auto().map(g=>`<div class="grp"><h3>${esc(g.name)} <small style="color:var(--mut);font-weight:400">${g.ids.length}</small></h3><div>${g.ids.map(id=>`<span class="tag">${esc(seen[id].title)}</span>`).join('')}</div></div>`).join('')||'<p class="empty">Add at least two anime that share a trait to see groups.</p>');
  if(tab==='acct')h=acctView();
  if(dlg){const a=seen[dlg],x=inL(dlg);h+=`<div class="ov" data-a="close"><div class="dlg"><h2>${esc(a.title)}</h2>${Object.entries(ST).map(([k,n])=>`<button class="btn ${x&&x.status===k?'':'ghost'}" data-a="set" data-v="${k}">${n}</button>`).join('')}${x?'<button class="btn ghost" data-a="set" data-v="">Remove from list</button>':''}<button class="btn ghost" data-a="close">Close</button></div></div>`}
  const active = document.activeElement;
const f = active && active.id;

const value = active &&
  (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')
  ? active.value
  : null;

const start = active && typeof active.selectionStart === 'number'
  ? active.selectionStart
  : null;

const end = active && typeof active.selectionEnd === 'number'
  ? active.selectionEnd
  : null;

document.getElementById('app').innerHTML = h;

if (f) {
  const e = document.getElementById(f);

  if (e) {
    if (value !== null) e.value = value;

    e.focus();

    if (start !== null && e.setSelectionRange) {
      e.setSelectionRange(start, end);
    }
  }
}}
 
/* ---------- events ---------- */
document.addEventListener('click',async e=>{
  const t=e.target.closest('[data-a]');if(!t||t.tagName==='SELECT')return;
  const a=t.dataset.a,id=+t.dataset.id,v=t.dataset.v;
  if(a==='close'&&e.target.closest('.dlg')&&!e.target.closest('button'))return;
  if(a==='tab')tab=v;
  else if(a==='plus')dlg=id;
  else if(a==='close')dlg=null;
  else if(a==='more'){return load(false,true)}
  else if(a==='set'){await setStatus(dlg,v);dlg=null}
  else if(a==='flt')flt=v;
  else if(a==='rm')await setStatus(id,'');
  else if(a==='up'||a==='dn'){
    const r=L.filter(x=>x.status==='c').sort((p,q)=>(p.rnk||1e9)-(q.rnk||1e9)),i=r.findIndex(x=>x.id==id),j=a==='up'?i-1:i+1;
    if(r[j]){await DB.run('UPDATE entry SET rnk=? WHERE anime_id=?',[j+1,id]);await DB.run('UPDATE entry SET rnk=? WHERE anime_id=?',[i+1,r[j].id]);
      for(let k=0;k<r.length;k++)if(k!==i&&k!==j)await DB.run('UPDATE entry SET rnk=? WHERE anime_id=?',[k+1,r[k].id]);await commit()}}
  else if(a==='byscore'){const r=L.filter(x=>x.status==='c').sort((p,q)=>q.score-p.score);for(let k=0;k<r.length;k++)await DB.run('UPDATE entry SET rnk=? WHERE anime_id=?',[k+1,r[k].id]);await commit()}
  else if(a==='newcat'){const n=document.getElementById('nc').value.trim();if(n){await DB.run('INSERT OR IGNORE INTO cat VALUES(?)',[n]);await commit()}}
  else if(a==='delcat'){await DB.run('DELETE FROM cat WHERE name=?',[t.dataset.c]);await DB.run('DELETE FROM cat_item WHERE cat=?',[t.dataset.c]);await commit()}
  else if(a==='uncat'){await DB.run('DELETE FROM cat_item WHERE cat=? AND anime_id=?',[t.dataset.c,id]);await commit()}
  else if(a==='signin'||a==='signup'){
    const em=document.getElementById('em').value.trim(),pw=document.getElementById('pw').value;
    try{
      if(!sbClient)throw new Error('Supabase is unavailable. Your local list still works.');syncMsg='';
      const redirectTo=window.location.origin+window.location.pathname;
      const result=a==='signin'
        ? await sbClient.auth.signInWithPassword({email:em,password:pw})
        : await sbClient.auth.signUp({email:em,password:pw,options:{emailRedirectTo:redirectTo}});
      if(result.error)throw result.error;
      if(result.data.session){
        setAuth(result.data.session);accountPassword='';syncMsg='Signed in.';render();await sync();return;
      }
      accountPassword='';
      syncMsg='Account created. Check your email to confirm, then return here to sign in.';
    }catch(err){syncMsg=err.message}finally{accountPassword='';render()}}
  else if(a==='google'||a==='github'){
    try{
      const {error}=await sbClient.auth.signInWithOAuth({
        provider:a,
        options:{redirectTo:window.location.origin+window.location.pathname}
      });
      if(error)throw error;
      return;
    }catch(err){syncMsg=err.message}
  }
  else if(a==='syncnow'){await sync();return}
  else if(a==='signout'){await sync();const bad=syncMsg.startsWith('Sync failed');
    if(!confirm(bad?'Some changes haven’t synced and will be lost. Sign out anyway?':'Sign out? Your list stays in your account.'))return;
    const {error}=await sbClient.auth.signOut();if(error){syncMsg=error.message;render();return}
    await DB.batch(['entry','cat','cat_item','anime','anime_rel','meta'].map(t=>['DELETE FROM '+t]));setAuth(null);accountPassword='';syncMsg='';await reload()}
  render();
});
document.addEventListener('input',e=>{
  if(e.target.id==='q'){q=e.target.value;clearTimeout(timer);timer=setTimeout(()=>load(true),450)}
  if(e.target.id==='em')accountEmail=e.target.value;
  if(e.target.id==='pw')accountPassword=e.target.value;
});
document.addEventListener('change',async e=>{
  const t=e.target,a=t.dataset.a;
  if(t.id==='gen'){gen=t.value;return load(true)}
  if(t.id==='srt')srt=t.value;
  else if(a==='st')await setStatus(+t.dataset.id,t.value);
  else if(a==='sc'){await DB.run('UPDATE entry SET score=? WHERE anime_id=?',[+t.value,+t.dataset.id]);await commit()}
  else if(a==='addcat'&&t.value){await DB.run('INSERT OR IGNORE INTO cat_item VALUES(?,?)',[t.dataset.c,+t.value]);await commit()}
  render();
});
 
 
/* ---------- accounts & sync (Supabase REST, last-write-wins) ---------- */
let auth=null,syncMsg='',pushT,accountEmail='',accountPassword='';
const sbClient=window.supabase&&CFG.url&&CFG.key?window.supabase.createClient(CFG.url,CFG.key,{
  auth:{flowType:'pkce',detectSessionInUrl:true,persistSession:true,autoRefreshToken:true}
}):null;
const setAuth=session=>{
  auth=session?{
    access_token:session.access_token,
    refresh_token:session.refresh_token,
    expires_at:(session.expires_at||0)*1000,
    user:{id:session.user.id,email:session.user.email}
  }:null;
};
const getMeta=async k=>{const r=await DB.all('SELECT v FROM meta WHERE k=?',[k]);return r[0]?r[0].v:null};
const setMeta=(k,v)=>DB.run('INSERT OR REPLACE INTO meta VALUES(?,?)',[k,String(v)]);
async function sb(path,o={}){
  const {data,error}=await sbClient.auth.getSession();if(error)throw error;
  if(!data.session)throw new Error('Your session has expired. Please sign in again.');
  const r=await fetch(CFG.url+path,{method:o.method||'GET',headers:{apikey:CFG.key,Authorization:'Bearer '+data.session.access_token,'Content-Type':'application/json',...(o.headers||{})},body:o.body&&JSON.stringify(o.body)});
  if(!r.ok)throw new Error(await r.text());if(r.status===204)return null;return r.json()}
const snapshot=async()=>({anime:await DB.all('SELECT a.* FROM anime a JOIN entry e ON e.anime_id=a.id'),entry:await DB.all('SELECT * FROM entry'),cat:await DB.all('SELECT * FROM cat'),cat_item:await DB.all('SELECT * FROM cat_item')});
async function restore(s){const ops=[['DELETE FROM entry'],['DELETE FROM cat'],['DELETE FROM cat_item']];for(const a of s.anime||[])ops.push(['INSERT OR REPLACE INTO anime VALUES(?,?,?,?,?,?)',[a.id,a.title,a.year,a.eps,a.traits,a.cover]]);for(const e of s.entry||[])ops.push(['INSERT INTO entry VALUES(?,?,?,?)',[e.anime_id,e.status,e.score,e.rnk]]);for(const c of s.cat||[])ops.push(['INSERT INTO cat VALUES(?)',[c.name]]);for(const c of s.cat_item||[])ops.push(['INSERT OR IGNORE INTO cat_item VALUES(?,?)',[c.cat,c.anime_id]]);await DB.batch(ops);
}
const merge=(r,l)=>{
  const anime=new Map((r.anime||[]).concat(l.anime||[]).map(a=>[+a.id,a]));
  const entry=new Map((r.entry||[]).map(e=>[+e.anime_id,e]));for(const e of l.entry||[])entry.set(+e.anime_id,e);
  return{anime:[...anime.values()],entry:[...entry.values()],
    cat:[...new Map((r.cat||[]).concat(l.cat||[]).map(c=>[c.name,c])).values()],
    cat_item:[...new Map((r.cat_item||[]).concat(l.cat_item||[]).map(c=>[c.cat+':'+c.anime_id,c])).values()]};
};
async function push(expectedUpdatedAt=null){
  const t=Date.now(),body={user_id:auth.user.id,data:await snapshot(),updated_at:new Date(t).toISOString()};
  if(expectedUpdatedAt){
    const rows=await sb('/rest/v1/shelf_data?user_id=eq.'+encodeURIComponent(auth.user.id)+'&updated_at=eq.'+encodeURIComponent(expectedUpdatedAt),{method:'PATCH',headers:{Prefer:'return=representation'},body});
    if(!rows||!rows.length)throw new Error('Your cloud list changed on another device during sync. Press Sync now to merge the latest changes safely.');
  }else{
    const rows=await sb('/rest/v1/shelf_data?on_conflict=user_id',{method:'POST',headers:{Prefer:'resolution=ignore-duplicates,return=representation'},body});
    if(!rows||!rows.length)throw new Error('A cloud sync was created on another device. Press Sync now to merge it safely.');
  }
  await setMeta('local_updated',t);await setMeta('last_sync',t);return t;
}
function setSyncMsg(m){syncMsg=m;if(tab==='acct'&&!(document.activeElement&&document.activeElement.tagName==='INPUT'))render()}
let syncPromise=null,syncRequested=false;
async function sync(){if(!auth||!CFG.url||!sbClient)return;if(syncPromise){syncRequested=true;return syncPromise;}syncPromise=(async()=>{setSyncMsg('Syncing…');try{
    const rem=(await sb('/rest/v1/shelf_data?select=data,updated_at'))[0];
    const lu=+(await getMeta('local_updated')||0),ru=rem?Date.parse(rem.updated_at):0,last=+(await getMeta('last_sync')||0);
    const userChanged=await getMeta('user')!==String(auth.user.id);
    if(userChanged){
      const previousUser=await getMeta('user');
      const local=previousUser?{anime:[],entry:[],cat:[],cat_item:[]}:await snapshot();
      if(previousUser)await DB.batch([['DELETE FROM anime'],['DELETE FROM anime_rel']]);
      await restore(rem?merge(rem.data,local):local);await setMeta('user',auth.user.id);await reload();
      if(previousUser)await setMeta('local_updated',Date.now());
      await push(rem?rem.updated_at:null);
    }else if(rem&&lu>last&&ru>last){
      const local=await snapshot();await restore(merge(rem.data,local));await reload();await push(rem.updated_at);
    }else if(rem&&ru>lu){
      await restore(rem.data);await setMeta('local_updated',ru);await setMeta('last_sync',ru);await reload();
    }else if(!rem||lu>ru)await push(rem?rem.updated_at:null);
    else await setMeta('last_sync',Math.max(lu,ru));
    setSyncMsg('Synced '+new Date().toLocaleTimeString());
  }catch(e){setSyncMsg('Sync failed: '+(e.message||'Unknown error')+'. Your local data is still on this device.')}
  render();})();try{await syncPromise}finally{syncPromise=null;if(syncRequested){syncRequested=false;sync()}}
}
async function commit(){await setMeta('local_updated',Date.now());await reload();clearTimeout(pushT);if(auth)pushT=setTimeout(sync,1500)}
function acctView(){
  if(!CFG.url||!sbClient)return`<div class="grp"><h3>Cloud sync unavailable</h3><p>Supabase could not load or is not configured. Shelf will continue working with local storage; sign-in and cloud sync are temporarily unavailable.</p></div>`;
  if(auth)return`<div class="grp"><h3>${esc(auth.user.email)}</h3><p>${esc(syncMsg||'Signed in.')}</p><button class="btn" data-a="syncnow">Sync now</button> <button class="btn ghost" data-a="signout">Sign out</button></div>`;
  return`<div class="grp"><h3>Sign in to sync your list across devices</h3><p>${esc(syncMsg)}</p><div class="bar"><input id="em" type="email" placeholder="Email" autocomplete="username" value="${esc(accountEmail)}"><input id="pw" type="password" placeholder="Password (6+ characters)" autocomplete="current-password" value="${esc(accountPassword)}"></div><button class="btn" data-a="signin">Sign in</button> <button class="btn ghost" data-a="signup">Create account</button><div class="bar" style="margin-top:12px"><button class="btn ghost" data-a="google">Continue with Google</button><button class="btn ghost" data-a="github">Continue with GitHub</button></div></div>`}
 
/* ---------- start ---------- */
(async()=>{
  try{navigator.storage&&navigator.storage.persist&&navigator.storage.persist()}catch(e){}
  if('serviceWorker' in navigator)navigator.serviceWorker.register('sw.js').catch(()=>{});
  try{DB=await initDB()}catch(e){document.getElementById('app').innerHTML='<p class="empty">Could not start the local database: '+esc(e.message||e)+'</p>';return}
  await reload();
  if(sbClient){const {data:{session},error:sessionError}=await sbClient.auth.getSession();if(sessionError)syncMsg=sessionError.message;setAuth(session);sbClient.auth.onAuthStateChange((event,nextSession)=>{setAuth(nextSession);if(tab==='acct'&&!(document.activeElement&&['INPUT','TEXTAREA'].includes(document.activeElement.tagName)))render();});}else syncMsg='Cloud sync unavailable; local mode is active.';
  load(true);if(auth)sync().finally(()=>refreshRelations().catch(()=>{}));else refreshRelations().catch(()=>{});
  window.addEventListener('online',sync);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)sync()});
})();
 