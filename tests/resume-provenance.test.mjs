import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDraft, sourceStatement } from '../resume-tailoring/engine.mjs';
import { provenanceAllowsLevel } from '../resume-tailoring/provenance.mjs';

function evaluate(cvText, quote, level = 'transferable_professional', extra = {}) {
  const input = {
    job: { company: 'Fixture', title: 'Fixture', canonical_url: 'https://example.invalid/job', selected_by_human: true },
    evaluation: { track: 'C', rubric_version: '1.2', report_path: 'reports/001-fixture.md', requirements: [
      { id: 'r', text: 'Analyze operations', importance: 'high', status: 'supported', evidence_level: level, evidence_ids: ['f'] },
    ] },
    facts: [{ id: 'f', source_quote: quote, claim: quote, kind: 'experience', level, tracks: ['C'], ...extra }],
  };
  return buildDraft(input, { cvText, reportText: '## Machine Summary\n```yaml\nrequirement_importance:\n  - requirement: Analyze operations\n    importance: high\n    match: strong\n```\n' });
}
// Synthetic employment facts exercise the production provenance shape.
const syntheticFacts = [
  'Supported the launch and scaling of a regional operations team across 42 client locations.',
  'Supported client onboarding and training without sole ownership of every account.',
  'Analyzed operational data and customer performance data.',
];
const employment = '# Synthetic CV\n## Professional experience\n### Example Media Ltd.\n#### Technical Project Manager | Part-time | October 2022–Present\n\n**Functional focus:** Client Operations / Technical Implementation\n\n' + syntheticFacts.map(q => `- ${q}`).join('\n');
for (const [i, quote] of syntheticFacts.entries()) test(`synthetic employment fact ${i + 1} retains employment provenance and exact wording`, () => {
  const result = evaluate(employment, quote);
  assert.deepEqual(result.errors, []);
  const row = result.draft.ledger[0];
  assert.equal(row.resume_claim, quote);
  assert.equal(row.source_provenance, 'professional');
  assert.equal(row.evidence_level, 'transferable_professional');
  assert.equal(row.source_location.start_line, i + 8);
  assert.deepEqual(row.source_heading_path.map(h => h.depth), [1,2,3,4]);
});
for (const title of ['Technical Project Manager','Training Manager','Machine Learning Engineer','Implementation Manager','Accountant','Onboarding Manager','Finance & Technical Operations Manager']) {
  for (const arrangement of ['Full-time','Part-time']) test(`${title} / ${arrangement} inherits professional ancestry`, () => {
    const quote = 'Analyzed operations data.';
    const cv = `## Professional Experience\n### Example Employer\n#### ${title} | ${arrangement} | 2022–Present\n- ${quote}`;
    assert.deepEqual(evaluate(cv,quote,'direct_professional').errors, []);
  });
}
test('concurrent employment does not alter provenance or leak role ancestry', () => {
  const cv = '## Employment\n### Employer A\n#### Accountant | Full-time | 2022–Present\n- Reconciled invoices.\n### Employer B\n#### Technical Project Manager | Part-time | 2022–Present\n- Delivered onboarding.';
  for (const q of ['Reconciled invoices.','Delivered onboarding.']) assert.deepEqual(evaluate(cv,q,'direct_professional').errors,[]);
  assert.equal(sourceStatement(cv,'Delivered onboarding.').heading_path.some(h=>h.text==='Employer A'),false);
});
for (const quote of ['Delivered customer training.','Supported creator onboarding.','Implemented training and onboarding workflows.','Completed customer training rollout.','Designed machine learning workflows.']) test(`employment activity stays professional: ${quote}`, () => {
  assert.deepEqual(evaluate(`## Employment\n- ${quote}`,quote,'direct_professional').errors,[]);
});
for (const section of ['Portfolio','Projects','Portfolio projects','Education','Academic','Training','Certification']) test(`${section} survives neutral and job-like subsections`, () => {
  const quote='Analyzed operations data.';
  const cv=`## ${section}\n### Example Employer\n#### Finance Manager\n- ${quote}`;
  const expected=/Portfolio|Projects/i.test(section)?'portfolio':'academic';
  assert.equal(sourceStatement(cv,quote).provenance,expected);
  assert.ok(evaluate(cv,quote).errors.some(e=>e.code==='evidence_level'));
});
for (const quote of ['Completed cloud deployment training.','Completed a finance systems course.','Coursework: Analyzed financial data.']) test(`course participation inside employment remains academic: ${quote}`, () => {
  const cv=`## Employment\n### Employer\n- ${quote}`;
  assert.equal(sourceStatement(cv,quote).provenance,'academic');
  assert.ok(evaluate(cv,quote).errors.some(e=>e.code==='evidence_level'));
  assert.deepEqual(evaluate(cv,quote,'academic_training').errors,[]);
});
for (const cv of [
  '## In Progress\n### Neutral Project\n- Implementing payment workflows.',
  '## Portfolio projects\n### Neutral Project\n**V1.1 in progress:**\n- Implementing payment workflows.',
  '## Employment\n### Employer\n#### Planned\n- Implementing payment workflows.',
]) test(`explicit incomplete structural context ${cv.split('\n')[0]} / ${cv.split('\n')[2]}`, () => {
  assert.equal(sourceStatement(cv,'Implementing payment workflows.').provenance,'in_progress');
  assert.ok(evaluate(cv,'Implementing payment workflows.').errors.some(e=>e.code==='evidence_level'));
  assert.deepEqual(evaluate(cv,'Implementing payment workflows.','in_progress').errors,[]);
});
test('explicit classification restricts employment and survives neutral children', () => {
  const cv='## Employment\n### Example\n**Classification:** Working local portfolio implementation.\n#### Payment Automation\n- Implemented payment workflows.';
  assert.equal(sourceStatement(cv,'Implemented payment workflows.').provenance,'portfolio');
  assert.ok(evaluate(cv,'Implemented payment workflows.').errors.length);
});
test('in-progress marker ends at sibling boundary without upgrading portfolio', () => {
  const cv='## Portfolio projects\n### First\n**V1.1 in progress:**\n- Learning cloud tools.\n### Second\n- Built a data model.';
  assert.equal(sourceStatement(cv,'Built a data model.').provenance,'portfolio');
});
for (const cv of [
  '## Portfolio\n### Professional Experience\n- Analyzed operations data.',
  '## Education\n### Employment\n- Analyzed operations data.',
  '## Employment\n**Classification:** Professional employment / portfolio.\n- Analyzed operations data.',
  '## Employment\n**Classification:** Unknown category.\n- Analyzed operations data.',
  '## Notes\n- Analyzed operations data.',
]) test(`unresolved/conflicting ancestry fails closed: ${cv.replaceAll('\n',' / ')}`, () => {
  const result=evaluate(cv,'Analyzed operations data.');
  assert.equal(result.draft,null);
  assert.ok(result.errors.some(e=>e.code==='evidence_context'));
});
for (const second of ['Employment','Portfolio']) test(`duplicate source matches fail closed even across ${second}`, () => {
  const cv=`## Employment\n### First\n- Analyzed operations data.\n## ${second}\n### Second\n- Analyzed operations data.`;
  const source=sourceStatement(cv,'Analyzed operations data.');
  assert.equal(source.provenance,'ambiguous');
  assert.equal(source.matching_locations.length,2);
  assert.equal(evaluate(cv,'Analyzed operations data.').draft,null);
});
test('caller-supplied provenance cannot override cv.md', () => {
  const result=evaluate('## Portfolio\n- Analyzed operations data.','Analyzed operations data.','transferable_professional',{provenance:'professional',source_provenance:'professional'});
  assert.equal(result.draft,null);
});
test('wrapped qualification retains full statement and start/end lines from continuation quote', () => {
  const cv='## Employment\n- Delivered workflows\n  only in a simulated pilot.';
  const source=sourceStatement(cv,'only in a simulated pilot.');
  assert.equal(source.statement,'Delivered workflows only in a simulated pilot.');
  assert.deepEqual(source.source_location,{start_line:2,end_line:3});
  assert.ok(evaluate(cv,'only in a simulated pilot.','transferable_professional',{claim:'Delivered workflows'}).errors.some(e=>e.code==='claim'));
});
test('fenced examples do not establish evidence or alter heading ancestry', () => {
  const cv='## Employment\n```md\n## Portfolio\n- Invented content.\n```\n- Delivered workflows.';
  assert.equal(sourceStatement(cv,'Invented content.'),null);
  assert.equal(sourceStatement(cv,'Delivered workflows.').provenance,'professional');
});
test('unknown provenance does not inherit permissive fallback', () => {
  for(const p of ['unresolved','ambiguous','conflicting',null]) assert.equal(provenanceAllowsLevel(p,'transferable_professional'),false);
});

for (const quote of ['Cloud deployment remains planned.', 'Payment integration is proposed.', 'Cloud deployment planned.']) test(`explicit incomplete statement remains restricted: ${quote}`, () => {
  const cv=`## Employment\n- ${quote}`;
  assert.equal(sourceStatement(cv,quote).provenance,'in_progress');
  assert.equal(evaluate(cv,quote).draft,null);
});
test('explicit portfolio classification with in-progress status retains the stronger restriction', () => {
  const cv='## Portfolio projects\n### Neutral\n**Classification:** Portfolio implementation, in progress.\n- Implementing payments.';
  assert.equal(sourceStatement(cv,'Implementing payments.').provenance,'in_progress');
});
