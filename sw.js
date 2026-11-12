const C='shelf-v2',SHELL=['./','index.html','style.css','app.js','manifest.webmanifest','icon.svg'];
self.addEventListener('install',e=>{self.skipWaiting();e.waitUntil(caches.open(C).then(c=>c.addAll(SHELL)))});
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==C).map(x=>caches.delete(x))))));
self.addEventListener('fetch',e=>{const r=e.request,u=new URL(r.url);
if(r.method!=='GET'||u.hostname.endsWith('supabase.co'))return; // never cache account/sync traffic
const net=()=>fetch(r).then(n=>{const cp=n.clone();caches.open(C).then(c=>c.put(r,cp));return n});
e.respondWith(u.origin===location.origin?net().catch(()=>caches.match(r)):caches.match(r).then(h=>h||net()))});