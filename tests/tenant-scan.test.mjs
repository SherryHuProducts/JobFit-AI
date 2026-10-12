import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScanStore, ScanError } from '../scan-service/store.mjs';
import { ScanService, LIMITS } from '../scan-service/service.mjs';
import { scanRouter } from '../scan-service/http.mjs';
import { scanWorker } from '../scan-service/worker.mjs';

const alice={tenantId:'tenant_alice_001'},bob={tenantId:'tenant_bob_00001'};
const config={tracks:['B'],geography:'Remote US',freshness_days:30,evaluation_budget:10};
const lead=(i,extra={})=>({observation_id:`observed_${String(i).padStart(8,'0')}`,company:`Fictional Company ${i}`,title:'Program Lead',
  url:`https://jobs.example/${i}`,source:'controlled-ats',posted_at:'2026-10-10T00:00:00Z',selection:'ELIGIBLE',reason:'native survivor',provenance:{controlled:true},...extra});
function harness(t,{leads=[lead(1)],sources=[{id:'source_normal_001',kind:'normal'}],overrides={}}={}){
  const root=mkdtempSync(join(tmpdir(),'tenant-scan-')),store=new ScanStore(join(root,'scans.db'));
  let time=Date.parse('2026-10-12T12:00:00Z');const registry=new Map(),decisions=new Map(),seen=[];
  const adapters={
    snapshot:async(context,cfg)=>({tenantId:context.tenantId,evidence:context.tenantId===alice.tenantId?'Led a fictional program.':'Coordinated a fictional workstream.',
      profileRevision:1,rubricVersion:'1.2',integrityVersion:'v2',scannerConfigHash:'controlled-frozen-scanner',config:cfg,sources}),
    discover:async(context,snapshot,source,emit)=>{for(const row of leads)await emit(row);},
    canonicalKey:row=>new URL(row.url).pathname,
    capture:async(context,c)=>({liveness:'active',canonical_url:c.url,jd:`Full controlled JD for ${c.company}. Own program delivery.`}),
    triage:async()=>({route:'PASS',reason:'controlled triage PASS'}),
    submitEvaluation:async(context,snapshot,c,key)=>{
      seen.push({tenant:context.tenantId,evidence:snapshot.evidence,key});
      // Deliberately fictional outputs. These tests do NOT claim rubric parity.
      const output={tenant:context.tenantId,evidence:snapshot.evidence,url:c.url,archiveHash:c.archive.sha256,
        job_id:`job_${context.tenantId}_${c.id.slice(-8)}`,operation_id:`operation_${context.tenantId}_${c.id.slice(-8)}`,
        disposition:context.tenantId===alice.tenantId?'APPLY':'LOW',fit_score:context.tenantId===alice.tenantId?82:58,
        reason:context.tenantId===alice.tenantId?'Controlled direct evidence':'Controlled partial evidence',recommendation:context.tenantId===alice.tenantId?'Apply':'Low priority'};
      registry.set(key,output);return output;
    },
    findEvaluation:async(context,key)=>registry.get(key),
    validateEvaluation:async(context,snapshot,c,output)=>{
      assert.equal(output.tenant,context.tenantId);assert.equal(output.evidence,snapshot.evidence);assert.equal(output.url,c.url);assert.equal(output.archiveHash,c.archive.sha256);
      return output;
    },
    decision:async(context,input)=>{
      assert.ok(input.job_id.includes(context.tenantId));assert.ok(input.operation_id.includes(context.tenantId));
      const old=decisions.get(input.job_id)||{revision:0};if(old.revision!==input.expected_revision)throw new ScanError('REVISION_CONFLICT');
      const state={job_id:input.job_id,operation_id:input.operation_id,human_decision:input.decision,revision:old.revision+1};decisions.set(input.job_id,state);return state;
    },
    requestPdf:async(context,input)=>{
      assert.ok(input.job_id.includes(context.tenantId));
      if(decisions.get(input.job_id)?.human_decision!=='APPLY')throw new ScanError('APPLY_REQUIRED');
      return {job_id:input.job_id,analysis_operation_id:input.operation_id,operation_id:'pdf_controlled_001'};
    },...overrides};
  const service=new ScanService({store,adapters,now:()=>time});
  t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
  return {service,store,registry,seen,adapters,advance:ms=>{time+=ms;}};
}
const create=(h,context=alice,cfg=config,request='request_controlled_001')=>h.service.create(context,cfg,request);

test('distinct tenant evidence and evaluations, scoped operations/results, snapshot stays immutable',async t=>{
  const h=harness(t),a=await create(h),b=await create(h,bob);
  await h.service.run(alice,a.operation_id);await h.service.run(bob,b.operation_id);
  const ar=h.service.results(alice,a.operation_id),br=h.service.results(bob,b.operation_id);
  assert.equal(ar.results[0].disposition,'APPLY');assert.equal(br.results[0].disposition,'LOW');
  assert.notEqual(h.seen[0].evidence,h.seen[1].evidence);
  assert.throws(()=>h.service.status(bob,a.operation_id),{code:'SCAN_NOT_FOUND'});
  assert.throws(()=>h.service.results(bob,a.operation_id),{code:'SCAN_NOT_FOUND'});
  assert.throws(()=>h.service.cancel(bob,a.operation_id),{code:'SCAN_NOT_FOUND'});
  assert.throws(()=>h.service.retry(bob,a.operation_id),{code:'SCAN_NOT_FOUND'});
  await assert.rejects(h.service.run(bob,a.operation_id),{code:'SCAN_NOT_FOUND'});
  h.adapters.snapshot=async()=>{throw new Error('must not reload current evidence');};
  h.service.retry(alice,a.operation_id);await h.service.run(alice,a.operation_id);
  assert.equal(h.seen.length,2);assert.equal(h.store.row(alice.tenantId,a.operation_id).state.snapshot.profileRevision,1);
});
test('budget reserves at most ten, failures consume slots; all unfinished candidates DEFERRED',async t=>{
  const h=harness(t,{leads:Array.from({length:15},(_,i)=>lead(i))}),op=await create(h);
  await h.service.run(alice,op.operation_id);
  const status=h.service.status(alice,op.operation_id),results=h.service.results(alice,op.operation_id).results;
  assert.equal(status.status,'PARTIAL');assert.equal(status.evaluations_used,10);assert.equal(h.seen.length,10);
  assert.equal(results.filter(c=>c.reason==='EVALUATION_BUDGET').length,5);
  assert.equal(results.filter(c=>c.disposition==='DEFERRED').length,5);
  assert.equal(status.telemetry.reconciled,true);assert.equal(status.telemetry.discovered,15);
  h.service.retry(alice,op.operation_id);await h.service.run(alice,op.operation_id);assert.equal(h.seen.length,10);
});
test('duplicates and interrupted source replay reconcile without losing candidates',async t=>{
  let attempts=0;
  const leads=[lead(1),lead(2,{url:'https://jobs.example/1'}),lead(3,{selection:'FILTERED',reason:'title: native exclusion'})];
  const h=harness(t,{leads,overrides:{discover:async(context,snap,source,emit)=>{for(const row of leads)await emit(row);if(attempts++===0)throw new Error('controlled outage');}}}),op=await create(h);
  await h.service.run(alice,op.operation_id);
  assert.equal(h.service.status(alice,op.operation_id).telemetry.discovered,3);
  assert.throws(()=>h.service.retry(alice,op.operation_id),{code:'SOURCE_RATE_LIMITED'});
  h.advance(31_000);h.service.retry(alice,op.operation_id);await h.service.run(alice,op.operation_id);
  const s=h.service.status(alice,op.operation_id);
  assert.equal(s.status,'SUCCEEDED');assert.equal(s.telemetry.discovered,3);assert.equal(s.evaluations_used,1);
  assert.deepEqual(s.telemetry.dispositions,{APPLY:1,DUPLICATE:1,FILTERED:1});
});
test('supplemental reverse ATS candidates never automatically enter evaluation',async t=>{
  const h=harness(t,{sources:[{id:'source_reverse_01',kind:'reverse_ats',evaluate:false}]}),op=await create(h);
  await h.service.run(alice,op.operation_id);assert.equal(h.seen.length,0);
  assert.equal(h.service.results(alice,op.operation_id).results[0].reason,'SUPPLEMENTAL_DISCOVERY_ONLY');
});
test('source rate limits retain durable dispositions and retry time',async t=>{
  const h=harness(t,{overrides:{discover:async(ctx,snap,source,emit)=>{await emit(lead(1));const e=new ScanError('SOURCE_RATE_LIMITED',429);e.retryAfterMs=120_000;throw e;}}}),op=await create(h);
  await h.service.run(alice,op.operation_id);
  assert.equal(h.service.status(alice,op.operation_id).errors[0].code,'SOURCE_RATE_LIMITED');
  assert.throws(()=>h.service.retry(alice,op.operation_id),{code:'SOURCE_RATE_LIMITED'});
  assert.equal(h.service.status(alice,op.operation_id).telemetry.discovered,1);
});
test('interrupted evaluation recovers by lookup without reserving or submitting twice',async t=>{
  const h=harness(t),real=h.adapters.submitEvaluation;
  h.adapters.submitEvaluation=async(...args)=>{await real(...args);throw new Error('controlled interrupted response');};
  const op=await create(h);await h.service.run(alice,op.operation_id);
  assert.equal(h.service.results(alice,op.operation_id).results[0].reason,'EVALUATION_OUTCOME_UNKNOWN');
  h.service.retry(alice,op.operation_id);await h.service.run(alice,op.operation_id);
  assert.equal(h.seen.length,1);assert.equal(h.service.status(alice,op.operation_id).evaluations_used,1);
  assert.equal(h.service.results(alice,op.operation_id).results[0].disposition,'APPLY');
});
test('an unknown interrupted evaluation remains DEFERRED and is never resubmitted',async t=>{
  let submits=0;const h=harness(t,{overrides:{submitEvaluation:async()=>{submits++;throw new Error('failure before acknowledged');}}}),op=await create(h);
  await h.service.run(alice,op.operation_id);h.service.retry(alice,op.operation_id);await h.service.run(alice,op.operation_id);
  assert.equal(submits,1);assert.equal(h.service.status(alice,op.operation_id).evaluations_used,1);
  assert.equal(h.service.results(alice,op.operation_id).results[0].disposition,'DEFERRED');
});
test('liveness, archival and existing Triage precede V1.2',async t=>{
  const h=harness(t,{leads:[lead(1),lead(2),lead(3),lead(4)],overrides:{capture:async(ctx,c)=>c.url.endsWith('/1')?{liveness:'expired'}:c.url.endsWith('/2')?{liveness:'unconfirmed'}:{liveness:'active',jd:'Verbatim controlled JD.',canonical_url:c.url},
    triage:async(ctx,snap,c)=>({route:c.url.endsWith('/3')?'REVIEW':'SKIP',reason:'controlled existing Triage'})}}),op=await create(h);
  await h.service.run(alice,op.operation_id);assert.equal(h.seen.length,0);
  assert.deepEqual(h.service.status(alice,op.operation_id).telemetry.dispositions,{EXPIRED:1,DEFERRED:1,REVIEW:1,SKIP:1});
  assert.equal(h.store.row(alice.tenantId,op.operation_id).state.candidates[2].archive.jd,'Verbatim controlled JD.');
});
test('Apply/Skip, decision revision, and targeted PDF use the exact tenant job/evaluation binding',async t=>{
  const h=harness(t),op=await create(h);await h.service.run(alice,op.operation_id);
  const c=h.service.results(alice,op.operation_id).results[0];
  await assert.rejects(h.service.pdf(alice,op.operation_id,c.candidate_id),{code:'APPLY_REQUIRED'});
  await assert.rejects(h.service.decide(bob,op.operation_id,c.candidate_id,{decision:'APPLY',expected_revision:0,request_id:'decision_request_01'}),{code:'SCAN_NOT_FOUND'});
  await assert.rejects(h.service.pdf(bob,op.operation_id,c.candidate_id),{code:'SCAN_NOT_FOUND'});
  const decision=await h.service.decide(alice,op.operation_id,c.candidate_id,{decision:'APPLY',expected_revision:0,request_id:'decision_request_01'});
  assert.equal(decision.job_id,c.job_id);assert.equal(decision.operation_id,c.analysis_operation_id);
  const pdf=await h.service.pdf(alice,op.operation_id,c.candidate_id);assert.equal(pdf.job_id,c.job_id);assert.equal(pdf.analysis_operation_id,c.analysis_operation_id);
  await assert.rejects(h.service.decide(alice,op.operation_id,c.candidate_id,{decision:'SKIP',expected_revision:0,request_id:'decision_request_02'}),{code:'REVISION_CONFLICT'});
  await h.service.decide(alice,op.operation_id,c.candidate_id,{decision:'SKIP',expected_revision:1,request_id:'decision_request_03'});
  await assert.rejects(h.service.pdf(alice,op.operation_id,c.candidate_id),{code:'APPLY_REQUIRED'});
});
test('cancellation and global concurrency cap; cancelled discoveries keep a disposition',async t=>{
  let enter;const entered=new Promise(r=>{enter=r;});
  const h=harness(t,{overrides:{discover:async(ctx,snap,source,emit,{signal})=>{await emit(lead(1));enter();await new Promise(r=>signal.addEventListener('abort',r,{once:true}));await emit(lead(2));}}}),a=await create(h),b=await create(h,bob);
  const running=h.service.run(alice,a.operation_id);await entered;
  await assert.rejects(h.service.run(bob,b.operation_id),{code:'BACKEND_SCAN_BUSY'});
  h.service.cancel(alice,a.operation_id);await running;
  assert.equal(h.service.status(alice,a.operation_id).status,'CANCELLED');assert.equal(h.seen.length,0);
  assert.equal(h.service.status(alice,a.operation_id).telemetry.discovered,2);
  assert.equal(h.service.status(alice,a.operation_id).telemetry.dispositions.DEFERRED,2);
});
test('idempotent submission, config conflict, tenant cap, invalid budget and no owner fallback',async t=>{
  const h=harness(t),op=await create(h);
  assert.equal((await create(h)).operation_id,op.operation_id);
  await assert.rejects(create(h,alice,{...config,evaluation_budget:11}),{code:'INVALID_SCAN_CONFIG'});
  await assert.rejects(create(h,alice,{...config,evaluation_budget:9}),{code:'REQUEST_CONFLICT'});
  await assert.rejects(create(h,alice,config,'request_controlled_002'),{code:'TENANT_SCAN_BUSY'});
  h.adapters.snapshot=async()=>({tenantId:alice.tenantId,evidence:'owner'});
  await assert.rejects(create(h,bob),{code:'INVALID_TENANT_SNAPSHOT'});
});
test('reopened SQLite checkpoint, expired lease and a reserved evaluation recover',async t=>{
  const h=harness(t),op=await create(h);
  await h.service.run(alice,op.operation_id);
  const recovered=new ScanService({store:h.store,adapters:h.adapters,now:()=>Date.parse('2026-10-12T12:01:00Z')});
  const row=h.store.row(alice.tenantId,op.operation_id);row.state.status='RUNNING';h.store.save(row);
  h.store.db.prepare('UPDATE scans SET lease=?,lease_until=? WHERE id=?').run('controlled_dead_worker',1,op.operation_id);
  recovered.retry(alice,op.operation_id);await recovered.run(alice,op.operation_id);
  assert.equal(h.seen.length,1);assert.equal(recovered.status(alice,op.operation_id).telemetry.reconciled,true);
});
test('untrusted HTTP tenant input rejected and cross-tenant results denied',async t=>{
  const h=harness(t),queued=[];
  const route=scanRouter({service:h.service,authenticate:async req=>req.headers.get('authorization')==='fictional-alice'?alice:bob,enqueue:async(ctx,id)=>{queued.push({ctx,id});}});
  const request=(path,body,auth='fictional-alice')=>new Request('https://backend.example/api/jobfit/v0.1/scans'+path,{method:body?'POST':'GET',headers:{authorization:auth,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  assert.equal((await route(request('',{config,request_id:'request_controlled_001',tenant_id:bob.tenantId}))).status,400);
  const response=await route(request('',{config,request_id:'request_controlled_001'}));assert.equal(response.status,202);
  const {operation_id:id}=await response.json();assert.equal(queued[0].ctx.tenantId,alice.tenantId);
  assert.equal((await route(request(`/${id}/results`,null,'fictional-bob'))).status,404);
  assert.equal(await route(new Request('https://backend.example/api/jobfit/v0.1/analyze')),null);
});
test('daily run admission limit persists across terminal operations',async t=>{
  const h=harness(t);
  for(let i=0;i<LIMITS.runsPerDay;i++){const op=await create(h,alice,config,`request_controlled_${i}`);h.service.cancel(alice,op.operation_id);}
  await assert.rejects(create(h,alice,config,'request_controlled_final'),{code:'SCAN_RATE_LIMITED'});
});
test('native held leads cannot bypass Scanner selection and enrichment quota leaves a durable remainder',async t=>{
  const h=harness(t,{leads:[lead(900,{selection:'DEFERRED',reason:'native liveness hold'}),...Array.from({length:101},(_,i)=>lead(i))]}),op=await create(h,alice,{...config,evaluation_budget:0});
  await h.service.run(alice,op.operation_id);const rows=h.service.results(alice,op.operation_id).results;
  assert.equal(h.seen.length,0);assert.equal(rows.find(c=>c.posting_url.endsWith('/900')).reason,'native liveness hold');
  assert.equal(rows.filter(c=>c.reason==='ENRICHMENT_QUOTA').length,1);
  assert.equal(rows.filter(c=>c.reason==='EVALUATION_BUDGET').length,100);
  assert.equal(h.service.status(alice,op.operation_id).telemetry.discovered,102);
});
test('corrupt immutable snapshot and forged cross-tenant evaluation never publish a result',async t=>{
  const h=harness(t),op=await create(h);const row=h.store.row(alice.tenantId,op.operation_id);
  row.state.snapshot.evidence='corrupted';h.store.save(row);await h.service.run(alice,op.operation_id);
  assert.equal(h.seen.length,0);assert.equal(h.service.status(alice,op.operation_id).status,'FAILED');
  const b=await create(h,bob);h.adapters.submitEvaluation=async()=>({tenant:alice.tenantId});await h.service.run(bob,b.operation_id);
  assert.equal(h.service.results(bob,b.operation_id).results[0].reason,'EVALUATION_OUTCOME_UNKNOWN');
  assert.equal(h.service.results(bob,b.operation_id).results[0].job_id,undefined);
});
test('durable worker drains queued operations using server-resolved tenant principals',async t=>{
  const h=harness(t),op=await create(h),principals=[];
  const worker=scanWorker({service:h.service,contextForTenant:async tenant=>{principals.push(tenant);return {tenantId:tenant};},intervalMs:5});
  t.after(()=>worker.stop());worker.start();
  for(let i=0;i<100;i++){if(h.service.status(alice,op.operation_id).status==='SUCCEEDED')break;await new Promise(r=>setTimeout(r,5));}
  await worker.stop();assert.equal(h.service.status(alice,op.operation_id).status,'SUCCEEDED');assert.deepEqual(principals,[alice.tenantId]);
});
