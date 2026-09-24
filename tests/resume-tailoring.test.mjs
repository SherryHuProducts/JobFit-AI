import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildDraft as buildEngineDraft, verifyClaim, sourceStatement } from '../resume-tailoring/engine.mjs';
import { persistHandoff, selectedJob } from '../evaluation-handoff.mjs';
import { renderHtml } from '../resume-tailoring/render.mjs';
import { validateDocx } from '../resume-tailoring/presentation.mjs';

const cv = `# Fictional Candidate
## Experience
Example Employer — Operations Analyst — 2022–2024
- Coordinated implementation projects with operations teams
- Analyzed project budgets and prepared monthly forecasts
- Documented customer onboarding workflows
## Projects
- Built a retrieval prototype for a portfolio project
## Skills
- SQL and Python
## Education
- Completed a finance systems course
## In Progress
- Learning cloud deployment tools
`;
const scenarios = [
  ['A', 'Implement customer solutions', 'Documented customer onboarding workflows', 'experience'],
  ['B', 'Coordinate implementation projects', 'Coordinated implementation projects with operations teams', 'experience'],
  ['C', 'Analyze project budgets', 'Analyzed project budgets and prepared monthly forecasts', 'experience'],
];
const level = 'transferable_professional';
function reportFrom(input, visibleText = '') {
  const rows = input.evaluation.requirements.filter(r => visibleText.includes(r.text));
  return '## Machine Summary\n```yaml\nrequirement_importance:\n' + rows.map(r =>
    `  - requirement: ${JSON.stringify(r.text)}\n    importance: ${r.importance}\n    match: ${{ supported: 'strong', partial: 'partial', missing: 'missing', unsupported: 'na' }[r.status]}\n`
  ).join('') + '```\n## Block A\n';
}
function makeDraft(input, { cvText, reportText }) {
  return buildEngineDraft(input, { cvText, reportText: reportFrom(input, reportText) });
}
function spec(track, reqs, facts) {
  return {
    job: { company: 'Example Co', title: 'Example Role', canonical_url: 'https://example.invalid/jobs/1', selected_by_human: true },
    evaluation: { report_path: 'reports/001-example.md', rubric_version: '1.2', track, requirements: reqs },
    facts,
  };
}
function fact(id, quote, kind = 'experience', tracks = ['A', 'B', 'C'], extra = {}) {
  return { id, source_quote: quote, claim: quote, level: kind === 'project' ? 'portfolio_hands_on' : level, kind, tracks,
    ...(kind === 'experience' ? { organization: 'Example Employer', role: 'Operations Analyst', dates: '2022–2024' } : {}), ...extra };
}
function req(id, text, evidence_ids, importance = 'high', status = 'supported') {
  return { id, text, importance, status, evidence_ids, evidence_level: evidence_ids.length ? level : null };
}
for (const [track, requirement, quote, kind] of scenarios) {
  test(`Track ${track}: maps V1.2 requirement to verified source and selected claim`, () => {
    const input = spec(track, [req('r1', requirement, ['f1'])], [fact('f1', quote, kind, [track])]);
    const result = makeDraft(input, { cvText: cv, reportText: requirement });
    assert.deepEqual(result.errors, []);
    assert.equal(result.draft.evidence_map[0].evidence[0].level, level);
    assert.equal(result.draft.ledger[0].source_quote, quote);
    assert.equal(result.draft.review.state, 'draft');
    assert.equal(result.draft.content.section_order[0], 'experience');
  });
}
test('cross-track role selects A and C evidence with evidence-driven section order', () => {
  const input = spec('cross', [req('a', 'Implement customer solutions', ['fa']), req('c', 'Analyze project budgets', ['fc'])], [
    fact('fa', 'Documented customer onboarding workflows', 'experience', ['A']),
    fact('fc', 'Analyzed project budgets and prepared monthly forecasts', 'experience', ['C']),
  ]);
  const result = makeDraft(input, { cvText: cv, reportText: 'Implement customer solutions\nAnalyze project budgets' });
  assert.deepEqual(result.errors, []);
  assert.equal(result.draft.ledger.length, 2);
  assert.deepEqual(new Set(result.draft.ledger.map(x => x.claim_id)), new Set(['fa', 'fc']));
});
test('track-aware section order places Projects before Skills for B and Skills before Projects for C', () => {
  const facts = [
    fact('experience', 'Coordinated implementation projects with operations teams'),
    fact('project', 'Built a retrieval prototype for a portfolio project', 'project', ['A', 'B']),
    fact('skill', 'SQL and Python', 'skill', ['B', 'C']),
  ];
  const rows = [
    req('r1', 'Coordinate implementation projects', ['experience']),
    { ...req('r2', 'Build retrieval prototype', ['project']), evidence_level: 'portfolio_hands_on' },
    req('r3', 'Use SQL', ['skill']),
  ];
  for (const [track, expected] of [['B', ['experience', 'project', 'skill']], ['C', ['experience', 'skill', 'project']]]) {
    const result = makeDraft(spec(track, rows, facts), { cvText: cv, reportText: rows.map(r => r.text).join('\n') });
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.draft.content.section_order.slice(0, 3), expected);
  }
});
test('High and Critical gaps remain unclaimed', () => {
  const input = spec('B', [req('r1', 'Coordinate implementation projects', ['f1']), req('gap', 'Own enterprise production go-lives', [], 'critical', 'missing')], [fact('f1', 'Coordinated implementation projects with operations teams')]);
  const result = makeDraft(input, { cvText: cv, reportText: 'Coordinate implementation projects\nOwn enterprise production go-lives' });
  assert.deepEqual(result.errors, []);
  assert.equal(result.draft.evidence_map[1].include, false);
  assert.match(result.draft.evidence_map[1].reason, /deliberately unclaimed/);
  assert.equal(result.draft.ledger.some(x => x.resume_claim.includes('go-lives')), false);
  input.evaluation.requirements[1].evidence_ids = ['f1'];
  assert.ok(makeDraft(input, { cvText: cv, reportText: 'Coordinate implementation projects\nOwn enterprise production go-lives' }).errors.some(e => e.code === 'gap_conflict'));
});
test('cannot relabel or omit a V1.2 High/Critical gap in the tailoring input', () => {
  const original = spec('B', [req('r1', 'Coordinate implementation projects', ['f1']), req('gap', 'Own enterprise production go-lives', [], 'critical', 'missing')], [fact('f1', 'Coordinated implementation projects with operations teams')]);
  const report = reportFrom(original, 'Coordinate implementation projects\nOwn enterprise production go-lives');
  const relabeled = structuredClone(original);
  relabeled.evaluation.requirements[1].status = 'supported';
  assert.ok(buildEngineDraft(relabeled, { cvText: cv, reportText: report }).errors.some(e => e.code === 'evaluation_trace'));
  const omitted = structuredClone(original);
  omitted.evaluation.requirements.pop();
  assert.ok(buildEngineDraft(omitted, { cvText: cv, reportText: report }).errors.some(e => e.code === 'evaluation_coverage'));
});
test('portfolio cannot be upgraded to professional evidence', () => {
  const input = spec('A', [req('r1', 'Build retrieval systems', ['f1'])], [fact('f1', 'Built a retrieval prototype for a portfolio project', 'project', ['A'], { level: 'direct_professional' })]);
  assert.ok(makeDraft(input, { cvText: cv, reportText: 'Build retrieval systems' }).errors.some(e => e.code === 'evidence_level'));
});
test('invented metric, ownership, and completed-state wording are blocked', () => {
  assert.ok(verifyClaim('Reduced costs by 35%', 'Analyzed project budgets and prepared monthly forecasts').length);
  assert.ok(verifyClaim('Owned customer onboarding workflows', 'Documented customer onboarding workflows').length);
  assert.ok(verifyClaim('Deployed cloud tools', 'Learning cloud deployment tools').length);
  assert.ok(verifyClaim('Delivered implementation projects', 'Team delivered implementation projects').length);
  assert.ok(verifyClaim('Managed production rollout', 'Did not manage production rollout').length);
  assert.ok(verifyClaim('Projects implementation coordinated', 'Coordinated implementation projects').length);
  assert.ok(verifyClaim('Improved response time by 10%', 'Improved response time by approximately 10% in a portfolio prototype').length);
});
test('complete cv.md statement controls attribution, negation, metrics, and status', () => {
  const cases = [
    ['team attribution', 'Team delivered implementation projects', 'delivered implementation projects', 'Delivered implementation projects', 'transferable_professional', false],
    ['negation', 'Did not deploy cloud tools', 'deploy cloud tools', 'Deployed cloud tools', 'transferable_professional', false],
    ['negation with unchanged verb', 'Did not deploy cloud tools', 'deploy cloud tools', 'Deploy cloud tools', 'transferable_professional', false],
    ['estimated pilot metric', 'Estimated 10% time saving in a pilot', '10% time saving in a pilot', 'Achieved 10% time savings', 'transferable_professional', false],
    ['estimated pilot qualifier omitted', 'Estimated 10% time saving in a pilot', '10% time saving in a pilot', '10% time saving in a pilot', 'transferable_professional', false],
    ['estimated pilot qualifier preserved', 'Estimated 10% time saving in a pilot', '10% time saving in a pilot', 'Estimated 10% time saving in a pilot', 'transferable_professional', true],
    ['contribution changed to sole ownership', 'Supported implementation projects with operations teams', 'implementation projects with operations teams', 'Owned implementation projects with operations teams', 'transferable_professional', false],
    ['planned work changed to completed', 'Planned deployment of cloud tools', 'deployment of cloud tools', 'Deployed cloud tools', 'in_progress', false],
  ];
  for (const [name, statement, quote, claim, evidenceLevel, allowed] of cases) {
    const input = spec('B', [req('r1', 'Coordinate implementation projects', ['f1'])], [fact('f1', quote, 'experience', ['B'], { claim, level: evidenceLevel })]);
    input.evaluation.requirements[0].evidence_level = evidenceLevel;
    const source = `## Experience\nExample Employer — Operations Analyst — 2022–2024\n- ${statement}\n`;
    const result = makeDraft(input, { cvText: source, reportText: 'Coordinate implementation projects' });
    assert.equal(result.errors.length === 0, allowed, `${name}: ${JSON.stringify(result.errors)}`);
    if (allowed) {
      assert.equal(result.draft.ledger[0].source_statement, statement);
      assert.equal(result.draft.ledger[0].resume_claim, claim);
    }
  }
});
test('wrapped evidence and scope limitations cannot be dropped by a short quote', () => {
  const source = '## Experience\n- Delivered implementation projects\n  only in a simulated pilot under supervision.\n';
  const resolved = sourceStatement(source, 'Delivered implementation projects');
  assert.match(resolved.statement, /simulated pilot under supervision/);
  assert.ok(verifyClaim('Delivered implementation projects', resolved.statement).length);
  assert.deepEqual(verifyClaim('Delivered implementation projects only in a simulated pilot under supervision', resolved.statement), []);
  assert.ok(verifyClaim('Deployed cloud tools', "Didn't deploy cloud tools").length);
});
test('source excerpt, metadata, and V1.2 report are mandatory', () => {
  const input = spec('C', [req('r1', 'Analyze project budgets', ['f1'])], [fact('f1', 'Managed a $5 million budget')]);
  assert.ok(makeDraft(input, { cvText: cv, reportText: 'Analyze project budgets' }).errors.some(e => e.code === 'source_quote'));
  input.facts[0] = fact('f1', 'Analyzed project budgets and prepared monthly forecasts', 'experience', ['C'], { organization: 'Imaginary Corp' });
  assert.ok(makeDraft(input, { cvText: cv, reportText: 'Analyze project budgets' }).errors.some(e => e.code === 'metadata'));
  assert.ok(makeDraft(input, { cvText: cv, reportText: 'Other requirement' }).errors.some(e => e.code === 'machine_summary'));
});
test('one-page content budget removes lower-priority content without inventing content', () => {
  const input = spec('B', [req('r1', 'Coordinate implementation projects', ['f1', 'f2'])], [
    fact('f1', 'Coordinated implementation projects with operations teams'),
    fact('f2', 'Documented customer onboarding workflows'),
  ]);
  input.layout = { max_items: { experience: 1 } };
  const result = makeDraft(input, { cvText: cv, reportText: 'Coordinate implementation projects' });
  assert.deepEqual(result.errors, []);
  assert.equal(result.draft.ledger.length, 1);
  assert.equal(result.draft.omitted.length, 1);
  input.layout.max_items.experience = 0;
  const empty = makeDraft(input, { cvText: cv, reportText: 'Coordinate implementation projects' });
  assert.equal(empty.draft.evidence_map[0].include, false);
  assert.match(empty.draft.evidence_map[0].reason, /one-page/);
});
test('V1.2 evidence level prevents a stronger resume classification', () => {
  const input = spec('B', [req('r1', 'Coordinate implementation projects', ['f1'])], [fact('f1', 'Coordinated implementation projects with operations teams')]);
  input.evaluation.requirements[0].evidence_level = 'portfolio_hands_on';
  assert.ok(makeDraft(input, { cvText: cv, reportText: 'Coordinate implementation projects' }).errors.some(e => e.code === 'evaluation_level'));
});
test('same frozen inputs produce the same claim ledger and section order', () => {
  const input = spec('C', [req('r1', 'Analyze project budgets', ['f1'])], [fact('f1', 'Analyzed project budgets and prepared monthly forecasts', 'experience', ['C'])]);
  const first = makeDraft(input, { cvText: cv, reportText: 'Analyze project budgets' }).draft;
  const second = makeDraft(input, { cvText: cv, reportText: 'Analyze project budgets' }).draft;
  assert.deepEqual(first.ledger, second.ledger);
  assert.deepEqual(first.content.section_order, second.content.section_order);
});
test('canonical HTML is single-column and keeps content separate from styling', () => {
  const input = spec('B', [req('r1', 'Coordinate implementation projects', ['f1'])], [fact('f1', 'Coordinated implementation projects with operations teams')]);
  const draft = makeDraft(input, { cvText: cv, reportText: 'Coordinate implementation projects' }).draft;
  const html = renderHtml(draft, { name: 'Fictional Candidate' });
  assert.match(html, /Coordinated implementation projects/);
  assert.doesNotMatch(html, /<table|<img|sidebar|column-count/i);
  assert.match(html, /@page \{ size: letter/);
});
test('DOCX preview uses the same validated content and no tables or images', () => {
  const temp = mkdtempSync(join(tmpdir(), 'jobfit-docx-'));
  const input = spec('B', [req('r1', 'Coordinate implementation projects', ['f1'])], [fact('f1', 'Coordinated implementation projects with operations teams')]);
  const draft = makeDraft(input, { cvText: cv, reportText: 'Coordinate implementation projects' }).draft;
  const draftPath = join(temp, 'draft.json'), contactPath = join(temp, 'contact.json'), docx = join(temp, 'draft.docx');
  writeFileSync(draftPath, JSON.stringify(draft)); writeFileSync(contactPath, JSON.stringify({ name: 'Fictional Candidate' }));
  const result = spawnSync('python3', ['resume-tailoring/render_docx.py', draftPath, contactPath, docx], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(docx), true);
  const check = spawnSync('python3', ['-c', 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); s=z.read("word/document.xml").decode(); assert "Coordinated implementation projects" in s; assert "<w:tbl>" not in s; assert "<w:drawing>" not in s', docx], { encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr);
});
test('DOCX-only CLI succeeds without fc-match, preserves content and Arial, and retains approval gates', () => {
  const root = mkdtempSync(join(tmpdir(), 'jobfit-cli-'));
  mkdirSync(join(root, 'reports')); mkdirSync(join(root, 'data')); mkdirSync(join(root, 'config'));
  writeFileSync(join(root, 'cv.md'), cv);
  writeFileSync(join(root, 'config', 'profile.yml'), 'name: Fictional Candidate\n');
  const input = spec('B', [req('r1', 'Coordinate implementation projects', ['f1'])], [fact('f1', 'Coordinated implementation projects with operations teams')]);
  const evaluated = { canonical_job_id: 'fixture:1', canonical_url: input.job.canonical_url, company: input.job.company, title: input.job.title, triage_result: 'PASS', primary_track: 'B', fit_score_100: 80, machine_score_5: 4, gap_severity: 'NONE', controlling_gap: 'None', recommendation: 'APPLY', evaluation_timestamp: '2026-09-23T12:00:00Z', rubric_version: '1.2', requirements: input.evaluation.requirements };
  writeFileSync(join(root, 'reports', '001-example.md'), reportFrom(input, 'Coordinate implementation projects').replace('requirement_importance:', 'score: 4\nrequirement_importance:') + '\n## Evaluation Handoff\n```json\n' + JSON.stringify(evaluated) + '\n```\n');
  const companion = persistHandoff(root, input.evaluation.report_path);
  const selected = selectedJob(root, companion, input.facts, 'APPLY');
  const inputPath = join(root, 'data', 'selected-job.json');
  writeFileSync(inputPath, JSON.stringify(selected));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const python = spawnSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' });
  assert.equal(python.status, 0, python.stderr);
  symlinkSync(python.stdout.trim(), join(bin, 'python3'));
  const env = { ...process.env, CAREER_OPS_ROOT: root, PATH: bin };
  assert.equal(spawnSync('fc-match', [], { env }).error?.code, 'ENOENT');
  const drafted = spawnSync(process.execPath, ['resume-tailoring.mjs', 'draft', inputPath, '--docx'], { env, encoding: 'utf8' });
  assert.equal(drafted.status, 0, drafted.stderr);
  const receipt = JSON.parse(drafted.stdout);
  assert.equal(receipt.state, 'draft');
  assert.equal(existsSync(join(receipt.directory, 'draft.docx')), true);
  assert.equal(existsSync(join(receipt.directory, 'final')), false);
  assert.equal(existsSync(join(receipt.directory, 'draft.pdf')), false);
  const savedDraft = JSON.parse(readFileSync(join(receipt.directory, 'draft.json'), 'utf8'));
  const expected = buildEngineDraft(selected, { cvText: cv, reportText: readFileSync(join(root, input.evaluation.report_path), 'utf8') });
  assert.deepEqual(expected.errors, []);
  assert.deepEqual(savedDraft.content, expected.draft.content);
  assert.deepEqual(savedDraft.ledger, expected.draft.ledger);
  assert.deepEqual(savedDraft.evidence_map, expected.draft.evidence_map);
  const header = JSON.parse(readFileSync(join(receipt.directory, 'contact.json'), 'utf8'));
  validateDocx(savedDraft, header, join(receipt.directory, 'draft.docx'));
  const inspect = spawnSync('python3', ['resume-tailoring/render_docx.py', '--inspect', join(receipt.directory, 'draft.docx')], { env, encoding: 'utf8' });
  assert.equal(inspect.status, 0, inspect.stderr);
  const fonts = [...JSON.parse(inspect.stdout).styles.matchAll(/:(?:ascii|hAnsi|cs)="([^"]+)"/g)].map(match => match[1]);
  assert.ok(fonts.length > 0);
  assert.ok(fonts.every(font => font === 'Arial'));
  const review = JSON.parse(readFileSync(join(receipt.directory, 'review.json'), 'utf8'));
  assert.equal(review.state, 'draft');
  const premature = spawnSync(process.execPath, ['resume-tailoring.mjs', 'approve', receipt.directory, '--human-approved=Reviewer'], { env, encoding: 'utf8' });
  assert.notEqual(premature.status, 0);
  assert.match(premature.stderr, /one-page PDF verification/);
});
