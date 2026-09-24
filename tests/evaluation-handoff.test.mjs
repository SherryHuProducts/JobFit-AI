import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { persistHandoff, validateHandoff, selectedJob, validateSelectedJob } from '../evaluation-handoff.mjs';
import { buildDraft } from '../resume-tailoring/engine.mjs';
const example = JSON.parse(readFileSync(new URL('./fixtures/evaluation-handoff/synthetic.json', import.meta.url)));
function setup(data = example) {
  const root = mkdtempSync(join(tmpdir(), 'handoff-'));
  mkdirSync(join(root, 'reports'));
  const report = 'reports/001-example.md';
  const text = '# Example Systems — Finance Operations Manager\n\n## Machine Summary\n```yaml\nscore: 3.1\nrequirement_importance:\n  - requirement: Analyze department budgets\n    importance: high\n    match: partial\n  - requirement: Own enterprise software rollout budgets\n    importance: high\n    match: missing\n```\n\n## Evaluation Handoff\n```json\n' + JSON.stringify(data) + '\n```\n';
  writeFileSync(join(root, report), text);
  return { root, report, text };
}
test('saved evaluation → companion preserves every exact synthetic field and report hash/path', () => {
  const { root, report, text } = setup();
  const path = persistHandoff(root, report), a = validateHandoff(root, path);
  for (const [key, value] of Object.entries(example)) assert.deepEqual(a[key], value);
  assert.equal(a.report_path, report);
  assert.equal(a.report_sha256, createHash('sha256').update(text).digest('hex'));
  assert.equal(readFileSync(join(root, report), 'utf8'), text);
  assert.equal(existsSync(join(root, 'output')), false);
  assert.equal('human_decision' in a, false);
});
test('missing artifact fails closed', () => {
  const {root} = setup();
  assert.throws(() => selectedJob(root, 'reports/missing.handoff.json', [], 'APPLY'));
  assert.throws(() => validateSelectedJob(root, {}), /missing handoff/);
});
for (const field of ['canonical_job_id','canonical_url','company','title','fit_score_100','machine_score_5','report_path','report_sha256','requirements']) {
  test(`inconsistent ${field} fails closed`, () => {
    const {root, report} = setup(), path = persistHandoff(root, report);
    const artifact = JSON.parse(readFileSync(path)); artifact[field] = 'changed';
    writeFileSync(path, JSON.stringify(artifact));
    assert.throws(() => validateHandoff(root, path));
  });
}
test('changed report and outside/unnumbered report paths fail closed', () => {
  const {root, report, text} = setup(), path = persistHandoff(root, report);
  writeFileSync(join(root, report), text + '\nchanged');
  assert.throws(() => validateHandoff(root, path), /inconsistent/);
  writeFileSync(join(root, 'outside.md'), text);
  assert.throws(() => persistHandoff(root, 'outside.md'), /numbered report/);
  writeFileSync(join(root, 'reports/plain.md'), text);
  assert.throws(() => persistHandoff(root, 'reports/plain.md'), /numbered report/);
});
test('required values and mismatched Machine Summary fail closed without inference', () => {
  for (const key of Object.keys(example)) {
    const data = structuredClone(example); delete data[key];
    const {root, report} = setup(data);
    assert.throws(() => persistHandoff(root, report), key);
  }
  for (const mutate of [d => d.machine_score_5 = 4, d => d.requirements[0].status = 'supported', d => d.requirements.pop()]) {
    const data = structuredClone(example); mutate(data);
    const {root, report} = setup(data);
    assert.throws(() => persistHandoff(root, report));
  }
});
test('human APPLY is separate; exact identity and rows transfer without mutation', () => {
  const {root, report} = setup(), path = persistHandoff(root, report);
  for (const decision of [undefined, true, "DON'T APPLY"]) assert.throws(() => selectedJob(root, path, [], decision), /explicit human APPLY/);
  const input = selectedJob(root, path, [], 'APPLY');
  assert.deepEqual(input.evaluation.requirements, example.requirements);
  assert.equal(input.job.canonical_job_id, example.canonical_job_id);
  validateSelectedJob(root, input);
  input.evaluation.requirements[0].evidence_ids = [];
  assert.throws(() => validateSelectedJob(root, input), /inconsistent/);
  assert.equal(existsSync(join(root, 'output')), false);
});
test('handoff introduces no claims and existing engine blocks unsupported ownership', () => {
  const {root, report, text} = setup(), path = persistHandoff(root, report);
  const facts = [{id:'f1', source_quote:'Analyzed department budgets', claim:'Analyzed department budgets', level:'transferable_professional', kind:'experience', tracks:['C']}];
  const input = selectedJob(root, path, facts, 'APPLY');
  const source = {cvText:'## Experience\n- Analyzed department budgets\n', reportText:text};
  const result = buildDraft(input, source);
  assert.deepEqual(result.errors, []);
  assert.equal(result.draft.ledger[0].resume_claim, facts[0].claim);
  assert.equal(result.draft.evidence_map[1].include, false);
  input.facts[0].claim = 'Owned enterprise software rollout budgets';
  assert.ok(buildDraft(input, source).errors.some(e => e.code === 'claim'));
});

test('production CLI validates handoff, surfaces header warnings, and blocks tampering', () => {
  const {root, report} = setup(), path = persistHandoff(root, report);
  mkdirSync(join(root, 'data')); mkdirSync(join(root, 'config'));
  writeFileSync(join(root, 'cv.md'), '## Experience\n- Analyzed department budgets\n');
  writeFileSync(join(root, 'config/profile.yml'), 'candidate:\n  full_name: Fictional Candidate\n');
  const facts = [{id:'f1', source_quote:'Analyzed department budgets', level:'transferable_professional', kind:'experience', tracks:['C']}];
  const input = selectedJob(root, path, facts, 'APPLY'), inputPath = join(root, 'data/selected.json');
  writeFileSync(inputPath, JSON.stringify(input));
  const run = () => spawnSync(process.execPath, ['resume-tailoring.mjs', 'draft', inputPath], {env:{...process.env, CAREER_OPS_ROOT:root}, encoding:'utf8'});
  const drafted = run();
  assert.equal(drafted.status, 0, drafted.stderr);
  const receipt = JSON.parse(drafted.stdout);
  assert.equal(receipt.warnings.length, 4);
  assert.equal(JSON.parse(readFileSync(join(receipt.directory, 'contact.json'))).name, 'Fictional Candidate');
  assert.match(readFileSync(join(receipt.directory, 'review-summary.md'), 'utf8'), /HUMAN REVIEW: candidate.email/);
  assert.equal(existsSync(join(receipt.directory, 'draft.pdf')), false);
  input.job.canonical_job_id = 'other-job';
  writeFileSync(inputPath, JSON.stringify(input));
  assert.notEqual(run().status, 0);
  delete input.handoff_path;
  writeFileSync(inputPath, JSON.stringify(input));
  assert.match(run().stderr, /missing handoff artifact/);
});
