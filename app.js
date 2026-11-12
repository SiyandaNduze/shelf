/* Shelf — anime tracker. Catalog: AniList (live). Storage: SQLite (sql.js+IndexedDB on web, native SQLite via Capacitor on phones). */
/* Sync backend: paste your Supabase project URL and anon key (see README). Leave empty for local-only. */
const CFG={url:'https://gbjnzkvwtmibnxsfyypt.supabase.co',key:'sb_publishable_rvf8YR0DSV6RLh44Ko2B4g_IBqntee8'};
const CDN='https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/';
const GQL=`query($q:String,$g:String,$p:Int,$s:[MediaSort]){Page(page:$p,perPage:30){pageInfo{hasNextPage}media(type:ANIME,isAdult:false,search:$q,genre:$g,sort:$s){id title{romaji english}seasonYear episodes genres tags{name rank}coverImage{large}}}}`;
const GENRES=['Action','Adventure','Comedy','Drama','Fantasy','Horror','Mahou Shoujo','Mecha','Music','Mystery','Psychological','Romance','Sci-Fi','Slice of Life','Sports','Supernatural','Thriller'];
const ST={p:'Plan to watch',w:'Watching',c:'Completed'};
const SCHEMA=[
'CREATE TABLE IF NOT EXISTS anime(id INTEGER PRIMARY KEY,title TEXT,year INT,eps INT,traits TEXT,cover TEXT)',
'CREATE TABLE IF NOT EXISTS entry(anime_id INTEGER PRIMARY KEY,status TEXT,score INT DEFAULT 0,rnk REAL)',
'CREATE TABLE IF NOT EXISTS cat(name TEXT PRIMARY KEY)',
'CREATE TABLE IF NOT EXISTS cat_item(cat TEXT,anime_id INT,PRIMARY KEY(cat,anime_id))',
'CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY,v TEXT)'];
 
/* ---------- storage layer: same SQL everywhere ---------- */
const idb=()=>new Promise((res,rej)=>{const r=indexedDB.open('shelf',1);r.onupgradeneeded=()=>r.result.createObjectStore('k');r.onsuccess=()=>res(r.result);r.onerror=rej});
const idbGet=async()=>{const d=await idb();return new Promise(r=>{const q=d.transaction('k').objectStore('k').get('db');q.onsuccess=()=>r(q.result);q.onerror=()=>r()})};
const idbSet=async b=>{const d=await idb();d.transaction('k','readwrite').objectStore('k').put(b,'db')};
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
      all:async(s,v=[])=>(await plug.query({database,statement:s,values:v})).values||[]};
  }
  await loadScript(CDN+'sql-wasm.js');
  const SQL=await initSqlJs({locateFile:f=>CDN+f});
  const d=new SQL.Database(await idbGet()||undefined);
  SCHEMA.forEach(s=>d.run(s));
  let t;const persist=()=>{clearTimeout(t);t=setTimeout(()=>idbSet(d.export()),250)};
  return{native:false,
    run:async(s,v=[])=>{d.run(s,v);persist()},
    all:async(s,v=[])=>{const st=d.prepare(s);st.bind(v);const r=[];while(st.step())r.push(st.getAsObject());st.free();return r}};
}
 
/* ---------- state ---------- */
let L=[],cats={},seen={},items=[],page=1,more=false,busy=false,offline=false;
let tab='browse',q='',gen='',flt='all',srt='title',dlg=null,timer;
const parse=r=>({...r,traits:JSON.parse(r.traits||'[]')});
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const inL=id=>L.find(a=>a.id==id);
async function reload(){
  L=(await DB.all('SELECT a.*,e.status,e.score,e.rnk FROM entry e JOIN anime a ON a.id=e.anime_id')).map(parse);
  L.forEach(a=>seen[a.id]=a);cats={};
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
}
 
/* ---------- catalog (AniList) ---------- */
async function fetchAnime(){
  const r=await fetch('https://graphql.anilist.co',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({query:GQL,variables:{q:q||undefined,g:gen||undefined,p:page,s:[q?'SEARCH_MATCH':'POPULARITY_DESC']}})});
  const P=(await r.json()).data.Page;
  return{more:P.pageInfo.hasNextPage,items:P.media.map(m=>({id:m.id,title:m.title.english||m.title.romaji,year:m.seasonYear||0,eps:m.episodes||0,
    traits:[...m.genres,...m.tags.filter(t=>t.rank>=60).slice(0,3).map(t=>t.name)],cover:m.coverImage.large}))};
}
async function load(reset){
  if(reset){items=[];page=1}busy=true;render();
  try{const r=await fetchAnime();items=items.concat(r.items);more=r.more;offline=false;
    r.items.forEach(a=>{seen[a.id]=inL(a.id)||a;saveAnime(a)})}
  catch(e){offline=true;more=false;
    if(reset)items=(await DB.all('SELECT * FROM anime WHERE title LIKE ? ORDER BY title LIMIT 90',['%'+q+'%'])).map(parse).filter(a=>!gen||a.traits.includes(gen))}
  busy=false;render();
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
    `<div class="grid">${items.map(card).join('')}</div>`+(busy?'<p class="empty">Loading…</p>':more?'<p class="empty"><button class="btn" data-a="more">Load more</button></p>':items.length?'':'<p class="empty">No anime found.</p>');
  if(tab==='list'){
    const r=L.filter(a=>flt==='all'||a.status===flt).sort((p,q)=>srt==='title'?p.title.localeCompare(q.title):srt==='year'?p.year-q.year:q.score-p.score);
    h=`<div class="bar"><div class="chips">${[['all','All'],['p','Plan to watch'],['w','Watching'],['c','Completed']].map(([k,n])=>`<button class="chip ${flt===k?'on':''}" data-a="flt" data-v="${k}">${n}</button>`).join('')}</div><select id="srt">${[['title','Sort: title'],['year','Sort: year'],['score','Sort: score']].map(([k,n])=>`<option value="${k}" ${srt===k?'selected':''}>${n}</option>`).join('')}</select></div>`+
    (r.length?r.map(a=>`<div class="row"><b>${esc(a.title)}<br><small style="color:var(--mut);font-weight:400">${a.year||'?'} · ${a.eps||'?'} ep</small></b><select data-a="st" data-id="${a.id}">${Object.entries(ST).map(([k,n])=>`<option value="${k}" ${a.status===k?'selected':''}>${n}</option>`).join('')}</select><select data-a="sc" data-id="${a.id}"><option value="0">Score</option>${[10,9,8,7,6,5,4,3,2,1].map(n=>`<option ${a.score===n?'selected':''}>${n}</option>`).join('')}</select><button class="btn ghost" data-a="rm" data-id="${a.id}">Remove</button></div>`).join(''):'<p class="empty">Nothing here yet. Browse and press + on an anime.</p>');
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
  const f=document.activeElement&&document.activeElement.id;
  document.getElementById('app').innerHTML=h;
  if(f){const e=document.getElementById(f);if(e&&e.tagName==='INPUT'){e.focus();e.setSelectionRange(e.value.length,e.value.length)}}
}
 
/* ---------- events ---------- */
document.addEventListener('click',async e=>{
  const t=e.target.closest('[data-a]');if(!t||t.tagName==='SELECT')return;
  const a=t.dataset.a,id=+t.dataset.id,v=t.dataset.v;
  if(a==='close'&&e.target.closest('.dlg')&&!e.target.closest('button'))return;
  if(a==='tab')tab=v;
  else if(a==='plus')dlg=id;
  else if(a==='close')dlg=null;
  else if(a==='more'){page++;return load(false)}
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
    try{syncMsg='';const j=await authCall(a==='signin'?'token?grant_type=password':'signup',{email:em,password:pw});
      if(j.access_token){keep(j);syncMsg='Signed in.';render();await sync();return}
      syncMsg='Check your email to confirm your account, then sign in.'}catch(err){syncMsg=err.message}}
  else if(a==='syncnow'){await sync();return}
  else if(a==='signout'){await sync();const bad=syncMsg.startsWith('Couldn');
    if(!confirm(bad?'Some changes haven’t synced and will be lost. Sign out anyway?':'Sign out? Your list stays in your account.'))return;
    for(const t of['entry','cat','cat_item','anime','meta'])await DB.run('DELETE FROM '+t);setAuth(null);syncMsg='';await reload()}
  render();
});
document.addEventListener('input',e=>{if(e.target.id==='q'){q=e.target.value;clearTimeout(timer);timer=setTimeout(()=>load(true),450)}});
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
let auth=null,syncMsg='',pushT;
try{auth=JSON.parse(localStorage.getItem('shelf-auth'))}catch(e){}
const setAuth=a=>{auth=a;try{a?localStorage.setItem('shelf-auth',JSON.stringify(a)):localStorage.removeItem('shelf-auth')}catch(e){}};
const getMeta=async k=>{const r=await DB.all('SELECT v FROM meta WHERE k=?',[k]);return r[0]?r[0].v:null};
const setMeta=(k,v)=>DB.run('INSERT OR REPLACE INTO meta VALUES(?,?)',[k,String(v)]);
async function authCall(path,body){
  const r=await fetch(CFG.url+'/auth/v1/'+path,{method:'POST',headers:{apikey:CFG.key,'Content-Type':'application/json'},body:JSON.stringify(body)});
  const j=await r.json();if(!r.ok)throw new Error(j.error_description||j.msg||j.message||'Request failed');return j}
const keep=j=>setAuth({access_token:j.access_token,refresh_token:j.refresh_token,expires_at:Date.now()+(j.expires_in-60)*1000,user:{id:j.user.id,email:j.user.email}});
async function sb(path,o={}){
  if(Date.now()>auth.expires_at)keep(await authCall('token?grant_type=refresh_token',{refresh_token:auth.refresh_token}));
  const r=await fetch(CFG.url+path,{method:o.method||'GET',headers:{apikey:CFG.key,Authorization:'Bearer '+auth.access_token,'Content-Type':'application/json',...(o.headers||{})},body:o.body&&JSON.stringify(o.body)});
  if(!r.ok)throw new Error(await r.text());return o.method==='POST'?null:r.json()}
const snapshot=async()=>({anime:await DB.all('SELECT a.* FROM anime a JOIN entry e ON e.anime_id=a.id'),entry:await DB.all('SELECT * FROM entry'),cat:await DB.all('SELECT * FROM cat'),cat_item:await DB.all('SELECT * FROM cat_item')});
async function restore(s){
  for(const t of['entry','cat','cat_item'])await DB.run('DELETE FROM '+t);
  for(const a of s.anime)await DB.run('INSERT OR REPLACE INTO anime VALUES(?,?,?,?,?,?)',[a.id,a.title,a.year,a.eps,a.traits,a.cover]);
  for(const e of s.entry)await DB.run('INSERT INTO entry VALUES(?,?,?,?)',[e.anime_id,e.status,e.score,e.rnk]);
  for(const c of s.cat)await DB.run('INSERT INTO cat VALUES(?)',[c.name]);
  for(const c of s.cat_item)await DB.run('INSERT OR IGNORE INTO cat_item VALUES(?,?)',[c.cat,c.anime_id]);
}
const merge=(r,l)=>{ // first sign-in on a device: keep everything from both
  const have=new Set(r.entry.map(e=>+e.anime_id));let mx=Math.max(0,...r.entry.map(e=>e.rnk||0));
  const extra=l.entry.filter(e=>!have.has(+e.anime_id)).map(e=>({...e,rnk:e.rnk==null?null:++mx})),ids=new Set(extra.map(e=>+e.anime_id));
  return{anime:r.anime.concat(l.anime.filter(a=>ids.has(+a.id))),entry:r.entry.concat(extra),
    cat:[...new Map(r.cat.concat(l.cat).map(c=>[c.name,c])).values()],cat_item:r.cat_item.concat(l.cat_item)}};
async function push(){const t=Date.now();await setMeta('local_updated',t);
  await sb('/rest/v1/shelf_data',{method:'POST',headers:{Prefer:'resolution=merge-duplicates,return=minimal'},body:{user_id:auth.user.id,data:await snapshot(),updated_at:new Date(t).toISOString()}})}
function setSyncMsg(m){syncMsg=m;if(tab==='acct'&&!(document.activeElement&&document.activeElement.tagName==='INPUT'))render()}
async function sync(){
  if(!auth||!CFG.url)return;setSyncMsg('Syncing…');
  try{
    const rem=(await sb('/rest/v1/shelf_data?select=data,updated_at'))[0];
    const lu=+(await getMeta('local_updated')||0),ru=rem?Date.parse(rem.updated_at):0;
    if(await getMeta('user')!==String(auth.user.id)){
      const l=await snapshot();await restore(rem?merge(rem.data,l):l);await setMeta('user',auth.user.id);await push();await reload();
    }else if(ru>lu){await restore(rem.data);await setMeta('local_updated',ru);await reload()}
    else if(lu>ru)await push();
    setSyncMsg('Synced '+new Date().toLocaleTimeString());
  }catch(e){setSyncMsg('Couldn’t sync (offline?). Changes are saved on this device and will sync later.')}
  render();
}
async function commit(){await setMeta('local_updated',Date.now());await reload();clearTimeout(pushT);if(auth)pushT=setTimeout(sync,1500)}
function acctView(){
  if(!CFG.url)return`<div class="grp"><h3>Sync isn’t set up</h3><p>Add your Supabase URL and anon key at the top of app.js (README step 1). Until then your list is stored on this device only.</p></div>`;
  if(auth)return`<div class="grp"><h3>${esc(auth.user.email)}</h3><p>${esc(syncMsg||'Signed in.')}</p><button class="btn" data-a="syncnow">Sync now</button> <button class="btn ghost" data-a="signout">Sign out</button></div>`;
  return`<div class="grp"><h3>Sign in to sync your list across devices</h3><p>${esc(syncMsg)}</p><div class="bar"><input id="em" type="email" placeholder="Email" autocomplete="username"><input id="pw" type="password" placeholder="Password (6+ characters)" autocomplete="current-password"></div><button class="btn" data-a="signin">Sign in</button> <button class="btn ghost" data-a="signup">Create account</button></div>`}
 
/* ---------- start ---------- */
(async()=>{
  try{navigator.storage&&navigator.storage.persist&&navigator.storage.persist()}catch(e){}
  if('serviceWorker' in navigator)navigator.serviceWorker.register('sw.js').catch(()=>{});
  try{DB=await initDB()}catch(e){document.getElementById('app').innerHTML='<p class="empty">Could not start the local database: '+esc(e.message||e)+'</p>';return}
  await reload();load(true);sync();
  window.addEventListener('online',sync);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)sync()});
})();
 