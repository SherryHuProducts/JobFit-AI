# Tenant Scan & Evaluate integration — draft, not production enabled

This is a tested orchestration layer, not a replacement evaluator. The private
Mac backend source, frozen V1.2 rules, v2 integrity contract and tenant services
are not present in this repository. Production integration remains blocked until
the adapters below are bound to those exact modules. Do not deploy this feature
based on the fictional test outputs. No live discovery has been performed.

## Files and mounting

- `store.mjs`: private SQLite WAL checkpoints with FULL synchronous durability.
- `service.mjs`: tenant-scoped operation admission, cancellation, recovery,
  candidate dispositions, evaluation reservations and result references.
- `scanner.mjs`: invokes the existing normal `scan.mjs`, not a second selector.
- `audit.mjs`: optional fsynced per-job Scanner observer. Default Scanner
  behavior is unchanged. Controlled parity tests compare the complete receipts.
- `http.mjs`: framework-neutral `/api/jobfit/v0.1/scans` router; returns `null`
  for unrelated routes, including manual Analyze.
- `worker.mjs`: polls the durable scans table; a lease prevents parallel workers.

Requires Node 22.13+ with `node:sqlite`. Keep the DB and operation workspaces under
the configured private `JOBFIT_DATA_ROOT`, outside the public repository. The
database directory must be restricted to the backend service account. The
deployment environment must verify filesystem permissions, disk space and
compatibility with its existing Node version.

Construct `ScanStore`, `ScanService`, then `scanWorker`. Supply the existing
credential verifier as `scanRouter.authenticate`, and the worker's `enqueue`
method as the queue callback. Call `worker.start()` at backend startup and await
`worker.stop()` during shutdown. Resolve worker principals with the existing
tenant registry. Never accept a tenant ID from browser JSON or inherit the owner
profile. Mount the scan router before the existing router and fall through on
`null`. Do not replace existing decision, artifact download or Analyze routes.

## Required existing-service adapter bindings

| Adapter | Contract |
|---|---|
| `snapshot(context, config)` | Existing tenant evidence snapshot plus `tenantId`, evidence, profile revision, `rubricVersion: "1.2"`, `integrityVersion: "v2"`, `scannerConfigHash`, config and a server-owned source plan. Reject missing private contracts. Resolve tracks/geography using existing tenant targeting presets; never loosen title exclusions. Normal authoritative ATS/company sources precede aggregators. |
| `discover(context, snapshot, source, emit, {signal})` | Normal source uses `normalScanner`. `workspaceFor` constructs and verifies a private operation workspace from the immutable snapshot; copy tenant history, canonical tracker and filters, never repository defaults. Limit each source plan to bounded configured boards/pages. Supply provider credentials through a server-only scoped transport when needed. Auth-gated plugins are not enabled by this adapter. |
| `canonicalKey(record)` | Existing Scanner URL canonicalization/dedup identity. No newly invented title filter or company matching rule. |
| `capture(context, candidate, {signal})` | Existing guarded liveness/full-JD capture. Returns active/expired/unconfirmed, canonical URL and verbatim full JD. Reject redirected general careers pages and unsafe destinations using existing SSRF guard. |
| `triage(context, snapshot, candidate, {signal})` | Existing tenant Triage. Copy its route/reason to PASS, REVIEW or SKIP without changing thresholds or objective exclusion rules. |
| `submitEvaluation(context, snapshot, candidate, key, {signal})` | Existing asynchronous V1.2 analysis service, using archived JD and immutable tenant evidence. Reuse `key` as its idempotency identity. Await terminal result; do not spawn an unbounded evaluator pool. |
| `findEvaluation(context, key, {signal})` | Existing private operation lookup by that identity. A reserved evaluation with an unknown result is looked up only; it is never blindly resubmitted. |
| `validateEvaluation(context, snapshot, candidate, result, {signal})` | Existing **v2 integrity validator** must verify tenant, job, operation, snapshot hash, archived JD hash, frozen rubric/report/handoff and full evidence bindings. Copy the existing recommendation bucket (APPLY/REVIEW/LOW/SKIP), fit score and explanation into the binding. Never derive a recommendation from score here. |
| `decision(context, input)` | Existing decision service; input has exact `job_id`, evaluation `operation_id`, human decision, expected revision and request ID. |
| `requestPdf(context, binding)` | Existing tenant-safe targeted PDF service. It enforces current explicit APPLY, profile freshness and the original evaluation binding. Existing authenticated download service remains authoritative. |

Every asynchronous adapter must honor AbortSignal, await subprocess teardown and
apply existing shared backend admission controls. The scan lease alone does not
cap manual Analyze/PDF workers; binding their **shared resource limiter** is a
production prerequisite. The Mac runtime must not release admission while an
aborted child still runs.

Reverse ATS is separately labeled and `evaluate: false`. A bounded supplemental
discovery adapter may emit leads, but this change does not enable the full-directory
sweep in the web queue. Its remaining source integration is a blocker, not an
excuse to run an unbounded sweep. Web leads held by native Scanner liveness remain
DEFERRED and cannot bypass its remaining dedup/cooldown selection.

## Limits, disposition and recovery

Per run: 0–10 full evaluation reservations, 100 enrichments, 5,000 admitted
candidate observations, 20 configured source batches, 500 KB per full JD and
20 MB total JD archives. Per tenant: one pending/running scan, four submissions
and 40 evaluation reservations per rolling 24 hours, 30 retained runs. One scan
worker globally; the normal Scanner lowers only transport concurrency to two.
Step abort deadline is three minutes; run deadline is 30 minutes. Three attempts
maximum. Tenant-scoped retention/cleanup must be provided before raising quotas.

Every admitted observation has a durable disposition: DEFERRED, FILTERED,
DUPLICATE, EXPIRED, APPLY, REVIEW, LOW or SKIP. Reasons, source identity,
posting/discovery dates and server-only provenance are retained. Only confirmed
native survivors can reach Triage/V1.2. Full JD is archived before Triage.
Unfinished work is DEFERRED with a reason. No minimum Apply count is promised.

Creation is idempotent by tenant/request ID. Source attempts replay observations
without duplicate insertion. Source failures retain emitted observations and a
retry timestamp. A persisted evaluation reservation consumes its budget even
after interruption. Retry looks up the prior result, retaining DEFERRED when
unknown. Completed bindings are not reevaluated. Cancellation aborts the adapter
and preserves already captured observations. A stale worker cannot write after
losing its lease. Worker restart claims only queued or expired RUNNING work;
FAILED/PARTIAL/CANCELLED work requires explicit retry.

Candidate quota excludes upstream postings never admitted. The fsynced Scanner
observation spool preserves received records even if admission hits the quota;
source truncation must remain visible and must not be reported as a complete
market scan. The quota-limited spool is a bounded diagnostic archive, not an
unlimited queue. Private integration must validate per-source page/response
bounds and reconcile native receipt counters against observations, including
failure/truncation, before claiming complete live funnel coverage.

## Review and deployment

Run `node --test tests/tenant-scan.test.mjs tests/scan-audit-parity.test.mjs`, the
existing handoff/tailoring and Scanner regressions, `npm test` and
`npm run typecheck` under `web/`, then the controlled Site tests. Synthetic tenant
outputs validate orchestration; they do not validate frozen V1.2 scoring parity,
real PDF contents, real downloads or the absent Day 1 private artifacts.

Before release, apply this branch to the private Mac checkout; bind the existing
modules, shared limiter and authenticated routes; verify frozen Day 1 artifact
hashes, the two private tenant snapshots, real v2 integrity, controlled complete
funnel reconciliation and actual targeted PDF/download bindings. Keep live
source discovery disabled until those tests pass. The Sites versions are saved
without deployment and audiences must stay unchanged. Backend rollout and Site
deployment require the user's separate approval. No application submission is
implemented or authorized.
