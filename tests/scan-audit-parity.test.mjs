import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { scanAudit } from '../scan-service/audit.mjs';

test('controlled normal Scanner telemetry preserves selection and records every filter/duplicate disposition',t=>{
  const root=mkdtempSync(join(tmpdir(),'scanner-audit-parity-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  mkdirSync(join(root,'data'));mkdirSync(join(root,'config'));writeFileSync(join(root,'config/profile.yml'),'{}');
  writeFileSync(join(root,'portals.yml'),`title_filter:\n  positive: [program]\nmax_posting_age_days: 30\ntracked_companies:\n  - name: Fictional Inc\n    provider: greenhouse\n    careers_url: https://job-boards.greenhouse.io/fictional\n`);
  const mock=join(root,'mock.mjs');
  writeFileSync(mock,`globalThis.fetch=async url=>{if(!String(url).includes('greenhouse.io'))throw new Error('live discovery forbidden');return Response.json({jobs:[
    {id:1,title:'Program Manager',absolute_url:'https://job-boards.greenhouse.io/fictional/jobs/1',location:{name:'Fremont CA'},content:'Own program delivery.',first_published:new Date().toISOString()},
    {id:1,title:'Program Manager',absolute_url:'https://job-boards.greenhouse.io/fictional/jobs/1',location:{name:'Fremont CA'},content:'Own program delivery.',first_published:new Date().toISOString()},
    {id:2,title:'Chef',absolute_url:'https://job-boards.greenhouse.io/fictional/jobs/2',location:{name:'Fremont CA'},content:'Cook food.',first_published:new Date().toISOString()},
    {id:3,title:'Program Coordinator',absolute_url:'https://job-boards.greenhouse.io/fictional/jobs/3',location:{name:'Fremont CA'},content:'Support programs.',first_published:'2020-01-01T00:00:00Z'}
  ]})};`);
  const env={...process.env,CAREER_OPS_ROOT:root,CAREER_OPS_PORTALS:join(root,'portals.yml'),CAREER_OPS_PROFILE:join(root,'config/profile.yml'),
    CAREER_OPS_PIPELINE:join(root,'data/pipeline.md'),CAREER_OPS_SCAN_HISTORY:join(root,'data/scan-history.tsv')};
  delete env.CAREER_OPS_SCAN_AUDIT;
  const run=extra=>spawnSync(process.execPath,['--import',mock,resolve('scan.mjs'),'--dry-run','--json'],{cwd:root,env:{...env,...extra},encoding:'utf8',timeout:30_000});
  const before=run({}),after=run({CAREER_OPS_SCAN_AUDIT:join(root,'data/audit.jsonl'),CAREER_OPS_SCAN_CONCURRENCY:'2'});
  assert.equal(before.status,0,before.stderr);assert.equal(after.status,0,after.stderr);
  assert.deepEqual(JSON.parse(after.stdout),JSON.parse(before.stdout));
  const rows=readFileSync(join(root,'data/audit.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.length,4);assert.equal(new Set(rows.map(r=>r.observation_id)).size,4);
  assert.deepEqual(rows.map(r=>r.selection),['ELIGIBLE','DUPLICATE','FILTERED','FILTERED']);
  assert.match(rows[2].reason,/title/);assert.match(rows[3].reason,/freshness/);
});
test('telemetry paths cannot escape the tenant root and audit quotas fail closed',t=>{
  const root=mkdtempSync(join(tmpdir(),'scanner-audit-path-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  assert.throws(()=>scanAudit(join(tmpdir(),'outside.jsonl'),root),/OUTSIDE_DATA_ROOT/);
  const observer=scanAudit(join(root,'audit.jsonl'),root,10);
  assert.throws(()=>observer({url:'https://jobs.example/1',company:'Fictional',title:'Program Lead'},'ELIGIBLE','native pass','controlled'),/SCAN_AUDIT_QUOTA/);
});
