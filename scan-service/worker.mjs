// One durable queue (the scans table), one worker across backend processes.
// contextForTenant resolves a trusted server principal; no profile fallback.
export function scanWorker({ service, contextForTenant, intervalMs=1000 }) {
  if(typeof contextForTenant!=='function')throw new Error('SCAN_CONTEXT_RESOLVER_REQUIRED');
  let stopped=false,timer=null,running=null;
  async function tick(){
    if(stopped||running)return;
    const rows=service.store.db.prepare('SELECT id,tenant,state,lease_until FROM scans ORDER BY created').all();
    const row=rows.find(r=>{
      const s=JSON.parse(r.state);
      return !s.cancelled && (s.status==='QUEUED'||(s.status==='RUNNING'&&r.lease_until<=service.now()));
    });
    if(row){
      running=(async()=>{
        const context=await contextForTenant(row.tenant);
        if(context?.tenantId!==row.tenant)throw new Error('SCAN_CONTEXT_MISMATCH');
        if(JSON.parse(row.state).status==='RUNNING')service.retry(context,row.id);
        await service.run(context,row.id);
      })();
      try{await running;}catch{/* Safe status/errors live in the store; never log evidence. */}finally{running=null;}
    }
    if(!stopped)timer=setTimeout(tick,intervalMs);
  }
  return {
    start(){if(!timer&&!running&&!stopped)timer=setTimeout(tick,0);},
    async enqueue(context,id){service.status(context,id);if(!stopped&&!running){clearTimeout(timer);timer=setTimeout(tick,0);}},
    async stop(){stopped=true;clearTimeout(timer);for(const c of service.controllers.values())c.abort();if(running)await running.catch(()=>{});},
  };
}
