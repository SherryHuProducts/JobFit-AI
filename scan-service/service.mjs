// Orchestration only. Scanner, Triage, V1.2, integrity, decisions and PDFs
// are injected existing services. No scoring or recommendation rules here.
import { createHash, randomUUID } from 'node:crypto';
import { ScanError } from './store.mjs';

export const LIMITS = Object.freeze({ evaluations: 10, candidates: 5000, sources: 20,
  runsPerDay: 4, evaluationsPerDay: 40, retainedRuns: 30,
  snapshotBytes: 2_000_000, archiveBytes: 500_000, totalArchiveBytes: 20_000_000,
  enrichments: 100, leaseMs: 30_000, stepMs: 180_000, runMs: 1_800_000, retries: 3 });
const terminal = new Set(['SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELLED']);
const ranked = ['APPLY', 'REVIEW', 'LOW', 'SKIP'];
const hash = value => createHash('sha256').update(value).digest('hex');
const size = value => Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value));
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(value);
const jsonCopy = value => JSON.parse(JSON.stringify(value));
const httpUrl = value => {
  try { const u = new URL(value); return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password; }
  catch { return false; }
};
function tenantOf(context) {
  // Context must come from the existing credential verifier, never request JSON.
  if (!validId(context?.tenantId)) throw new ScanError('AUTHENTICATION_REQUIRED', 401);
  return context.tenantId;
}
export function validateConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(k => !['tracks', 'geography', 'freshness_days', 'evaluation_budget'].includes(k)) ||
      !Array.isArray(value.tracks) || !value.tracks.length || value.tracks.length > 3 ||
      new Set(value.tracks).size !== value.tracks.length || value.tracks.some(t => !['A', 'B', 'C'].includes(t)) ||
      typeof value.geography !== 'string' || !value.geography.trim() || value.geography.length > 120 ||
      !Number.isInteger(value.freshness_days) || value.freshness_days < 1 || value.freshness_days > 30 ||
      !Number.isInteger(value.evaluation_budget) || value.evaluation_budget < 0 || value.evaluation_budget > LIMITS.evaluations)
    throw new ScanError('INVALID_SCAN_CONFIG', 400);
  return {tracks:[...value.tracks],geography:value.geography,freshness_days:value.freshness_days,evaluation_budget:value.evaluation_budget};
}

export class ScanService {
  constructor({ store, adapters, now = Date.now }) {
    this.store = store; this.adapters = adapters; this.now = now; this.controllers = new Map();
    for (const name of ['snapshot', 'discover', 'canonicalKey', 'capture', 'triage',
      'submitEvaluation', 'findEvaluation', 'validateEvaluation', 'decision', 'requestPdf'])
      if (typeof adapters?.[name] !== 'function') throw new ScanError('SCAN_INTEGRATION_UNAVAILABLE', 503);
  }
  async create(context, config, requestId) {
    const tenant = tenantOf(context); config = validateConfig(config);
    if (!validId(requestId)) throw new ScanError('INVALID_REQUEST_ID', 400);
    const existing = this.store.db.prepare('SELECT id,state FROM scans WHERE tenant=? AND request_id=?').get(tenant, requestId);
    if (existing) {
      if (JSON.stringify(JSON.parse(existing.state).config) !== JSON.stringify(config)) throw new ScanError('REQUEST_CONFLICT');
      return this.status(context, existing.id);
    }
    // Resolves an immutable tenant snapshot, frozen contracts and a bounded
    // server-owned source plan. No template/owner fallback is permitted.
    const snapshot = jsonCopy(await this.adapters.snapshot(context, config));
    if (snapshot.tenantId !== tenant || !snapshot.evidence || snapshot.rubricVersion !== '1.2' ||
        snapshot.integrityVersion !== 'v2' || !snapshot.scannerConfigHash || !Array.isArray(snapshot.sources) ||
        !snapshot.sources.length || snapshot.sources.length > LIMITS.sources || size(snapshot) > LIMITS.snapshotBytes ||
        new Set(snapshot.sources.map(s => s.id)).size !== snapshot.sources.length ||
        snapshot.sources.some(s => !validId(s.id) || !['normal', 'reverse_ats'].includes(s.kind) ||
          (s.kind === 'reverse_ats' && s.evaluate !== false))) throw new ScanError('INVALID_TENANT_SNAPSHOT', 503);
    const id = `scan_${randomUUID().replaceAll('-', '')}`;
    this.store.transaction(() => {
      const duplicate = this.store.db.prepare('SELECT id FROM scans WHERE tenant=? AND request_id=?').get(tenant, requestId);
      if (duplicate) throw new ScanError('REQUEST_CONFLICT');
      this.checkAdmission(tenant);
      const now = this.now();
      const state = { operation_id: id, status: 'QUEUED', config, snapshot, snapshot_hash: hash(JSON.stringify(snapshot)),
        created_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString(),
        attempts: 0, evaluations_used: 0, enrichments_used: 0, archive_bytes: 0, cancelled: false,
        sources: snapshot.sources.map(s => ({ id: s.id, kind: s.kind, status: 'DEFERRED', attempts: 0, retry_at: 0 })),
        candidates: [], events: [{ type: 'CREATED', at: now }], errors: [] };
      this.store.db.prepare('INSERT INTO scans(id,tenant,request_id,created,state) VALUES(?,?,?,?,?)')
        .run(id, tenant, requestId, now, JSON.stringify(state));
    });
    return this.status(context, id);
  }
  checkAdmission(tenant, exceptId) {
    const rows = this.store.db.prepare('SELECT id,created,state FROM scans WHERE tenant=?').all(tenant);
    if (rows.length >= LIMITS.retainedRuns && !exceptId) throw new ScanError('SCAN_STORAGE_QUOTA', 429);
    const day = this.now() - 86_400_000;
    const today = rows.filter(r => r.created >= day);
    if (!exceptId && today.length >= LIMITS.runsPerDay) throw new ScanError('SCAN_RATE_LIMITED', 429);
    if (rows.some(r => r.id !== exceptId && !terminal.has(JSON.parse(r.state).status))) throw new ScanError('TENANT_SCAN_BUSY', 429);
    const spent = today.reduce((n, r) => n + JSON.parse(r.state).evaluations_used, 0);
    if (spent >= LIMITS.evaluationsPerDay) throw new ScanError('EVALUATION_DAILY_QUOTA', 429);
  }
  status(context, id) {
    const { state } = this.store.row(tenantOf(context), id);
    const dispositions = {};
    for (const c of state.candidates) dispositions[c.disposition] = (dispositions[c.disposition] || 0) + 1;
    return { operation_id: id, status: state.status, created_at: state.created_at, updated_at: state.updated_at,
      evaluation_budget: state.config.evaluation_budget, evaluations_used: state.evaluations_used,
      telemetry: { discovered: state.candidates.length, dispositions, reconciled: Object.values(dispositions).reduce((a,b)=>a+b,0) === state.candidates.length,
        sources: state.sources.map(s => ({ source_id: s.id, kind: s.kind, status: s.status, attempts: s.attempts, retry_at: s.retry_at })) },
      errors: state.errors.map(e => ({ code: e.code, source_id: e.source_id ?? null })) };
  }
  results(context, id) {
    const state = this.store.row(tenantOf(context), id).state;
    const results = state.candidates.map(c => ({ candidate_id: c.id, company: c.company, title: c.title,
      posting_url: c.url, source: c.source, source_kind: c.source_kind, posted_at: c.posted_at,
      discovered_at: c.discovered_at, disposition: c.disposition, reason: c.reason,
      ...(c.binding ? { job_id: c.binding.job_id, analysis_operation_id: c.binding.operation_id,
        fit_score: c.binding.fit_score, recommendation: c.binding.recommendation } : {}) }));
    results.sort((a, b) => (ranked.indexOf(a.disposition) < 0 ? 4 : ranked.indexOf(a.disposition)) -
      (ranked.indexOf(b.disposition) < 0 ? 4 : ranked.indexOf(b.disposition)) || (b.fit_score ?? -1) - (a.fit_score ?? -1) || a.candidate_id.localeCompare(b.candidate_id));
    return { operation_id: id, results, telemetry: this.status(context, id).telemetry };
  }
  cancel(context, id) {
    const tenant = tenantOf(context);
    this.store.transaction(() => {
      const row = this.store.row(tenant, id);
      if (terminal.has(row.state.status)) return;
      row.state.cancelled = true; row.state.status = 'CANCELLED';
      for (const c of row.state.candidates) if (c.disposition === 'DEFERRED') c.reason = 'CANCELLED';
      row.state.updated_at = new Date(this.now()).toISOString(); this.store.save(row);
    });
    this.controllers.get(id)?.abort();
    return this.status(context, id);
  }
  retry(context, id) {
    const tenant = tenantOf(context);
    this.store.transaction(() => {
      const row = this.store.row(tenant, id), state = row.state;
      if (row.lease_until > this.now()) throw new ScanError('SCAN_BUSY', 429);
      if (state.attempts >= LIMITS.retries) throw new ScanError('SCAN_RETRY_LIMIT', 429);
      const retryAt = Math.max(0, ...state.sources.filter(s => s.status !== 'SUCCEEDED').map(s => s.retry_at));
      if (retryAt > this.now()) throw new ScanError('SOURCE_RATE_LIMITED', 429);
      this.checkAdmission(tenant, id);
      state.status = 'QUEUED'; state.cancelled = false; this.store.save(row);
    });
    return this.status(context, id);
  }
  async decide(context, id, candidateId, input) {
    const c = this.boundCandidate(context, id, candidateId);
    if (!['APPLY', 'SKIP'].includes(input?.decision) || !Number.isSafeInteger(input?.expected_revision) || input.expected_revision < 0 || !validId(input?.request_id))
      throw new ScanError('INVALID_DECISION', 400);
    // Existing decision service owns revision, profile freshness and job binding.
    return this.adapters.decision(context, { decision:input.decision,expected_revision:input.expected_revision,request_id:input.request_id,job_id:c.binding.job_id,operation_id:c.binding.operation_id });
  }
  async pdf(context, id, candidateId) {
    const c = this.boundCandidate(context, id, candidateId);
    return this.adapters.requestPdf(context, { job_id: c.binding.job_id, operation_id: c.binding.operation_id });
  }
  boundCandidate(context, id, candidateId) {
    const state = this.store.row(tenantOf(context), id).state;
    const c = state.candidates.find(c => c.id === candidateId);
    if (!c) throw new ScanError('RESULT_NOT_FOUND', 404);
    if (!c.binding) throw new ScanError('COMPLETED_EVALUATION_REQUIRED');
    return jsonCopy(c);
  }
  // A backend worker calls run; HTTP submission never waits for this method.
  async run(context, id) {
    const tenant = tenantOf(context), token = randomUUID(), controller = new AbortController();
    this.store.transaction(() => {
      const row = this.store.row(tenant, id);
      if (terminal.has(row.state.status)) throw new ScanError('SCAN_NOT_QUEUED');
      if (this.store.db.prepare('SELECT id FROM scans WHERE lease_until>?').get(this.now())) throw new ScanError('BACKEND_SCAN_BUSY', 429);
      row.state.status = 'RUNNING'; row.state.attempts++; this.store.save(row);
      this.store.db.prepare('UPDATE scans SET lease=?,lease_until=? WHERE tenant=? AND id=?').run(token, this.now() + LIMITS.leaseMs, tenant, id);
    });
    this.controllers.set(id, controller);
    const change = (fn, {allowCancelled=false}={}) => this.store.transaction(() => {
      const row = this.store.row(tenant, id);
      if (row.lease !== token || row.lease_until <= this.now()) throw new ScanError('LEASE_LOST');
      if (row.state.cancelled && !allowCancelled) throw new ScanError('SCAN_CANCELLED');
      fn(row.state); row.state.updated_at = new Date(this.now()).toISOString(); this.store.save(row);
      return jsonCopy(row.state);
    });
    const heartbeat = setInterval(() => {
      const row = this.store.row(tenant, id);
      if (row.lease !== token || row.state.cancelled || row.lease_until <= this.now()) { controller.abort(); return; }
      this.store.db.prepare('UPDATE scans SET lease_until=? WHERE tenant=? AND id=? AND lease=?').run(this.now()+LIMITS.leaseMs,tenant,id,token);
    }, 5000);
    const runTimeout = setTimeout(() => controller.abort(), LIMITS.runMs);
    const invoke = async (fn, ...args) => {
      if (controller.signal.aborted) throw new ScanError('SCAN_INTERRUPTED');
      const timer = setTimeout(() => controller.abort(), LIMITS.stepMs);
      // Adapters MUST honor signal and await subprocess teardown; no detached
      // race releases a lease while its external work continues running.
      try { const result = await fn(...args, { signal: controller.signal });
        if (controller.signal.aborted) throw new ScanError('SCAN_INTERRUPTED'); return result; }
      finally { clearTimeout(timer); }
    };
    try {
      let state = change(s => { if(hash(JSON.stringify(s.snapshot))!==s.snapshot_hash)throw new ScanError('SNAPSHOT_INTEGRITY'); });
      for (const source of state.snapshot.sources) {
        const progress = state.sources.find(s => s.id === source.id);
        if (progress.status === 'SUCCEEDED') continue;
        if (progress.retry_at > this.now() || progress.attempts >= LIMITS.retries) continue;
        change(s => { const p=s.sources.find(x=>x.id===source.id); p.status='RUNNING'; p.attempts++; });
        try {
          await invoke(this.adapters.discover, context, jsonCopy(state.snapshot), source, async record => {
            if (!record || !validId(record.observation_id) || typeof record.title !== 'string' || record.title.length > 300 ||
                typeof record.company !== 'string' || record.company.length > 200 || !httpUrl(record.url) ||
                !['ELIGIBLE', 'FILTERED', 'DUPLICATE', 'DEFERRED', 'EXPIRED'].includes(record.selection) || typeof record.reason !== 'string' ||
                record.reason.length > 1000) throw new ScanError('INVALID_DISCOVERY_RECORD', 502);
            const key = this.adapters.canonicalKey(record);
            if (typeof key !== 'string' || !key) throw new ScanError('INVALID_DEDUP_KEY', 502);
            change(s => {
              const observation = `${source.id}:${record.observation_id}`;
              if (s.candidates.some(c => c.observation === observation)) return;
              if (s.candidates.length >= LIMITS.candidates) throw new ScanError('CANDIDATE_QUOTA', 429);
              const duplicate = s.candidates.find(c => c.key === key && c.selection === 'ELIGIBLE' && c.source_kind === 'normal');
              let disposition = record.selection === 'ELIGIBLE' ? 'DEFERRED' : record.selection;
              let reason = record.reason || 'AWAITING_LIVENESS';
              if (duplicate && record.selection === 'ELIGIBLE') { disposition='DUPLICATE'; reason='CANONICAL_POSTING_ALREADY_DISCOVERED'; }
              if (source.kind === 'reverse_ats' && record.selection === 'ELIGIBLE') { disposition='DEFERRED'; reason='SUPPLEMENTAL_DISCOVERY_ONLY'; }
              if(s.cancelled && disposition==='DEFERRED')reason='CANCELLED';
              s.candidates.push({ id:`candidate_${hash(observation).slice(0,32)}`, observation, key,
                company:record.company,title:record.title,url:record.url,source:record.source || source.id,
                source_kind:source.kind,posted_at:record.posted_at ?? null,discovered_at:new Date(this.now()).toISOString(),
                provenance:jsonCopy(record.provenance ?? {}), selection:record.selection,disposition,reason });
            }, {allowCancelled:true});
          });
          state=change(s=>{ s.sources.find(x=>x.id===source.id).status='SUCCEEDED'; });
        } catch (error) {
          if (controller.signal.aborted || ['SCAN_CANCELLED','LEASE_LOST'].includes(error.code)) throw error;
          const code = ['CANDIDATE_QUOTA','SOURCE_RATE_LIMITED','INVALID_DISCOVERY_RECORD'].includes(error.code) ? error.code : 'SOURCE_FAILED';
          state=change(s=>{ const p=s.sources.find(x=>x.id===source.id); p.status='DEFERRED';
            p.retry_at=this.now()+Math.max(1000,Math.min(3_600_000,Number(error.retryAfterMs)||30_000));
            s.errors.push({code,source_id:source.id}); });
        }
      }
      for (const candidate of state.candidates) {
        if (candidate.disposition !== 'DEFERRED' || candidate.source_kind !== 'normal' || candidate.selection !== 'ELIGIBLE') continue;
        try {
          let c = this.store.row(tenant,id).state.candidates.find(x=>x.id===candidate.id);
          if (!c.archive) {
            const admitted=change(s=>{if(s.enrichments_used>=LIMITS.enrichments){s.candidates.find(x=>x.id===c.id).reason='ENRICHMENT_QUOTA';return;}s.enrichments_used++;});
            if(admitted.enrichments_used>LIMITS.enrichments||admitted.candidates.find(x=>x.id===c.id).reason==='ENRICHMENT_QUOTA')continue;
            const capture = await invoke(this.adapters.capture,context,jsonCopy(c));
            if (capture?.liveness === 'expired') { change(s=>{const x=s.candidates.find(x=>x.id===c.id);x.disposition='EXPIRED';x.reason='POSTING_EXPIRED';}); continue; }
            if (capture?.liveness !== 'active') { change(s=>{s.candidates.find(x=>x.id===c.id).reason='LIVENESS_UNCONFIRMED';}); continue; }
            if (typeof capture.jd !== 'string' || !capture.jd.trim() || size(capture.jd)>LIMITS.archiveBytes || !httpUrl(capture.canonical_url)) throw new ScanError('JD_ARCHIVE_INVALID');
            change(s=>{ if(s.archive_bytes+size(capture.jd)>LIMITS.totalArchiveBytes)throw new ScanError('ARCHIVE_QUOTA');
              const x=s.candidates.find(x=>x.id===c.id);x.archive={jd:capture.jd,sha256:hash(capture.jd),canonical_url:capture.canonical_url,captured_at:new Date(this.now()).toISOString()};s.archive_bytes+=size(capture.jd); });
          }
          c=this.store.row(tenant,id).state.candidates.find(x=>x.id===c.id);
          if (!c.triage) {
            const triage=await invoke(this.adapters.triage,context,jsonCopy(state.snapshot),jsonCopy(c));
            if(!['PASS','REVIEW','SKIP'].includes(triage?.route)||typeof triage.reason!=='string'||triage.reason.length>1000)throw new ScanError('TRIAGE_INVALID');
            change(s=>{const x=s.candidates.find(x=>x.id===c.id);x.triage=jsonCopy(triage);if(triage.route!=='PASS'){x.disposition=triage.route;x.reason=triage.reason;}});
            if(triage.route!=='PASS')continue;
          }
          c=this.store.row(tenant,id).state.candidates.find(x=>x.id===c.id);
          // A reservation is never refunded, including timeout/crash/failure.
          // Uncertain outcomes use lookup only; retry never blindly resubmits.
          let evaluated;
          if (c.evaluation_key) {
            evaluated=await invoke(this.adapters.findEvaluation,context,c.evaluation_key);
            if(!evaluated){change(s=>{s.candidates.find(x=>x.id===c.id).reason='EVALUATION_OUTCOME_UNKNOWN';});continue;}
          } else {
            const evaluationKey=`eval_${hash(id+':'+c.id).slice(0,32)}`;
            const admitted=change(s=>{
              if(s.evaluations_used>=s.config.evaluation_budget){s.candidates.find(x=>x.id===c.id).reason='EVALUATION_BUDGET';return;}
              const total=this.store.db.prepare('SELECT state FROM scans WHERE tenant=? AND created>=?').all(tenant,this.now()-86_400_000).reduce((n,r)=>n+JSON.parse(r.state).evaluations_used,0);
              if(total>=LIMITS.evaluationsPerDay){s.candidates.find(x=>x.id===c.id).reason='EVALUATION_DAILY_QUOTA';return;}
              s.evaluations_used++;const x=s.candidates.find(x=>x.id===c.id);x.evaluation_key=evaluationKey;x.reason='EVALUATION_RESERVED';
              s.events.push({type:'EVALUATION_RESERVED',candidate_id:c.id,at:this.now()});
            });
            if(!admitted.candidates.find(x=>x.id===c.id).evaluation_key)continue;
            evaluated=await invoke(this.adapters.submitEvaluation,context,jsonCopy(state.snapshot),jsonCopy(c),evaluationKey);
          }
          const binding=await invoke(this.adapters.validateEvaluation,context,jsonCopy(state.snapshot),jsonCopy(c),evaluated);
          if(!validId(binding?.job_id)||!validId(binding?.operation_id)||!ranked.includes(binding.disposition)||
              !Number.isFinite(binding.fit_score)||binding.fit_score<0||binding.fit_score>100||typeof binding.reason!=='string'||binding.reason.length>1000||typeof binding.recommendation!=='string'||binding.recommendation.length>200)
            throw new ScanError('EVALUATION_BINDING_INVALID');
          change(s=>{const x=s.candidates.find(x=>x.id===c.id);x.binding=jsonCopy(binding);x.disposition=binding.disposition;x.reason=binding.reason;});
        } catch(error) {
          if(controller.signal.aborted||['SCAN_CANCELLED','LEASE_LOST'].includes(error.code))throw error;
          change(s=>{const x=s.candidates.find(x=>x.id===candidate.id);x.reason=x.evaluation_key?'EVALUATION_OUTCOME_UNKNOWN': ['JD_ARCHIVE_INVALID','ARCHIVE_QUOTA','TRIAGE_INVALID'].includes(error.code)?error.code:'CANDIDATE_RETRY_REQUIRED';});
        }
      }
      change(s=>{s.status=s.candidates.some(c=>c.disposition==='DEFERRED')||s.sources.some(x=>x.status!=='SUCCEEDED')?'PARTIAL':'SUCCEEDED';});
    } catch(error) {
      this.store.transaction(()=>{const row=this.store.row(tenant,id);if(row.lease!==token)return;
        if(!row.state.cancelled){row.state.status='FAILED';row.state.errors.push({code:'SCAN_INTERRUPTED'});this.store.save(row);}});
    } finally {
      clearInterval(heartbeat);clearTimeout(runTimeout);this.controllers.delete(id);
      this.store.db.prepare('UPDATE scans SET lease=NULL,lease_until=0 WHERE tenant=? AND id=? AND lease=?').run(tenant,id,token);
    }
    return this.status(context,id);
  }
}
