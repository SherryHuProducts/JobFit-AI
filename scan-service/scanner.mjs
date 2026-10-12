// Runs the existing normal Scanner in a tenant operation workspace. Its
// selection is unchanged; the fsynced observer supplies full job dispositions.
import { spawn } from 'node:child_process';
import { readFileSync, realpathSync, existsSync } from 'node:fs';
import { join, relative, isAbsolute, sep } from 'node:path';
import { ScanError } from './store.mjs';

export function normalScanner({ codeRoot, workspaceFor, maxOutputBytes=2_000_000 }) {
  return async (context,snapshot,source,emit,{signal}) => {
    if(source.kind!=='normal')throw new ScanError('SUPPLEMENTAL_ADAPTER_REQUIRED',503);
    // Existing integration creates a private workspace from the immutable
    // snapshot. No owner root or environment defaults are inherited.
    const workspace=realpathSync(await workspaceFor(context,snapshot,source));
    const audit=join(workspace,'data','scan-observations.jsonl');
    const rel=relative(workspace,realpathSync(join(workspace,'data')));
    if(rel==='..'||rel.startsWith(`..${sep}`)||isAbsolute(rel))throw new ScanError('INVALID_SCAN_WORKSPACE',503);
    const env={PATH:process.env.PATH,LANG:process.env.LANG||'en_US.UTF-8',
      CAREER_OPS_ROOT:workspace,CAREER_OPS_DATA_DIR:workspace,
      CAREER_OPS_PORTALS:join(workspace,'portals.yml'),CAREER_OPS_PROFILE:join(workspace,'config/profile.yml'),
      CAREER_OPS_PIPELINE:join(workspace,'data/pipeline.md'),CAREER_OPS_SCAN_HISTORY:join(workspace,'data/scan-history.tsv'),
      CAREER_OPS_TRACKER:join(workspace,'data/applications.md'),
      CAREER_OPS_SCAN_AUDIT:audit,CAREER_OPS_SCAN_CONCURRENCY:'2',NODE_OPTIONS:'--max-old-space-size=256'};
    const child=spawn(process.execPath,[join(codeRoot,'scan.mjs'),'--dry-run','--json','--quiet','--since',String(snapshot.config.freshness_days)],
      {cwd:workspace,env,stdio:['ignore','pipe','pipe']});
    let output='',bytes=0,interrupted=false;
    const abort=()=>{interrupted=true;child.kill('SIGTERM');};
    signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
    const killTimer=setInterval(()=>{if(interrupted)child.kill('SIGKILL');},1000);
    child.stdout.on('data',data=>{bytes+=data.length;if(bytes>maxOutputBytes)abort();else output+=data;});
    child.stderr.on('data',()=>{}); // Never expose private config or provider credentials.
    let exit,error;
    try { exit=await new Promise(resolve=>{child.once('error',e=>{error=e;resolve(-1);});child.once('close',resolve);}); }
    finally {clearInterval(killTimer);signal.removeEventListener('abort',abort);}
    // Even failure/interruption replays every observation already fsynced.
    if(existsSync(audit)){
      const raw=readFileSync(audit,'utf8');
      if(Buffer.byteLength(raw)>32_000_000)throw new ScanError('CANDIDATE_QUOTA',429);
      for(const line of raw.split('\n'))if(line.trim())await emit(JSON.parse(line));
    }
    if(interrupted||error)throw new ScanError('SCAN_INTERRUPTED');
    let receipt;try{receipt=JSON.parse(output);}catch{throw new ScanError('SOURCE_FAILED',502);}
    if(![0,2].includes(exit)||receipt.version!=='careerops.scan.receipt@1')throw new ScanError('SOURCE_FAILED',502);
    if(receipt.errors?.length){const limited=receipt.errors.some(e=>/429|rate.limit/i.test(e.error||''));
      const e=new ScanError(limited?'SOURCE_RATE_LIMITED':'SOURCE_FAILED',limited?429:502);e.retryAfterMs=60_000;throw e;}
  };
}
