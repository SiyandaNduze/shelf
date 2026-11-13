const CACHE='shelf-v4';
const SHELL=['./','index.html','style.css','app.js','manifest.webmanifest','icon.svg'];
self.addEventListener('install',event=>{
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(SHELL)));
});
self.addEventListener('activate',event=>{
  event.waitUntil((async()=>{
    const keys=await caches.keys();
    await Promise.all(keys.filter(key=>key!==CACHE).map(key=>caches.delete(key)));
    await self.clients.claim();
  })());
});
self.addEventListener('fetch',event=>{
  const request=event.request;
  if(request.method!=='GET')return;
  const url=new URL(request.url);
  if(url.origin!==self.location.origin||url.search||url.pathname.includes('/auth/')||url.hostname.endsWith('supabase.co'))return;
  event.respondWith((async()=>{
    const cache=await caches.open(CACHE);
    try{
      const response=await fetch(request);
      if(response.ok&&response.type==='basic')await cache.put(request,response.clone());
      return response;
    }catch(error){
      const cached=await cache.match(request);
      if(cached)return cached;
      throw error;
    }
  })());
});
