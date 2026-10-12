// Optional telemetry observer. It never participates in Scanner selection.
import { openSync, writeSync, fsyncSync, closeSync, realpathSync } from 'node:fs';
import { relative, isAbsolute, sep } from 'node:path';
import { createHash } from 'node:crypto';
export function scanAudit(filename, dataRoot, maxBytes = 32_000_000) {
  if (!filename) return () => {};
  const rel=relative(realpathSync(dataRoot),realpathSync(new URL('.',`file://${filename}`).pathname));
  if(rel==='..'||rel.startsWith(`..${sep}`)||isAbsolute(rel))throw new Error('SCAN_AUDIT_OUTSIDE_DATA_ROOT');
  const counts=new Map();let bytes=0;
  return (job,selection,reason,source) => {
    const identity=JSON.stringify([source,job.url,job.company,job.title]);
    const occurrence=(counts.get(identity)||0)+1;counts.set(identity,occurrence);
    const row={observation_id:`observed_${createHash('sha256').update(identity+':'+occurrence).digest('hex').slice(0,32)}`,
      company:job.company||'',title:job.title||'',url:job.url,source,posted_at:job.postedAt||null,
      selection,reason,provenance:{provider_source:source,location:job.location||'',posting_date:job.postedAt||null}};
    const line=JSON.stringify(row)+'\n';bytes+=Buffer.byteLength(line);
    if(bytes>maxBytes){const e=new Error('SCAN_AUDIT_QUOTA');e.code='SCAN_AUDIT_QUOTA';throw e;}
    const fd=openSync(filename,'a',0o600);try{writeSync(fd,line);fsyncSync(fd);}finally{closeSync(fd);}
  };
}
