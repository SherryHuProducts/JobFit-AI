// Mount behind the existing proxy + tenant credential verifier.
// Returns null for unrelated paths so the manual Analyze router is preserved.
import { ScanError } from './store.mjs';
const respond = (data,status=200) => Response.json(data,{status,headers:{'cache-control':'no-store'}});
export function scanRouter({ service, authenticate, enqueue }) {
  if(typeof authenticate!=='function'||typeof enqueue!=='function')throw new ScanError('SCAN_INTEGRATION_UNAVAILABLE',503);
  return async request => {
    const url=new URL(request.url);
    const match=url.pathname.match(/^\/api\/jobfit\/v0\.1\/scans(?:\/([A-Za-z0-9_-]{8,128})(?:\/(results|cancel|retry))?)?$/);
    if(!match)return null;
    try {
      const context=await authenticate(request); // No identity from request body.
      const [,id,action]=match;
      if(!id&&request.method==='POST'){
        if(Number(request.headers.get('content-length')||0)>4096)throw new ScanError('INVALID_SCAN_CONFIG',400);
        const body=await request.text();if(Buffer.byteLength(body)>4096)throw new ScanError('INVALID_SCAN_CONFIG',400);
        const input=JSON.parse(body);
        if(Object.keys(input).some(k=>!['config','request_id'].includes(k)))throw new ScanError('INVALID_SCAN_CONFIG',400);
        const operation=await service.create(context,input.config,input.request_id);
        await enqueue(context,operation.operation_id); // Durable worker queue; not a detached promise.
        return respond(operation,202);
      }
      if(id&&request.method==='GET'&&!action)return respond(service.status(context,id));
      if(id&&request.method==='GET'&&action==='results')return respond(service.results(context,id));
      if(id&&request.method==='POST'&&action==='cancel')return respond(service.cancel(context,id));
      if(id&&request.method==='POST'&&action==='retry'){
        const operation=service.retry(context,id);await enqueue(context,id);return respond(operation,202);
      }
      return respond({error:{code:'METHOD_NOT_ALLOWED'}},405);
    } catch(error) {
      const safe=error instanceof ScanError;
      return respond({error:{code:safe?error.code:error instanceof SyntaxError?'INVALID_JSON':'SCAN_UNAVAILABLE'}},safe?error.status:error instanceof SyntaxError?400:503);
    }
  };
}
