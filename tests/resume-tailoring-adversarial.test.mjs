// Permanent V1 evidence-integrity gate. All CVs, reports, and jobs are synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDraft, sourceStatement } from '../resume-tailoring/engine.mjs';

const requirement = 'Implementation work';
function fixture({ statement, quote, claim, section = 'Experience', level = 'transferable_professional', evaluationLevel = level, status = 'supported' }) {
  const cvText = `## ${section}\n- ${statement}\n`;
  const input = {
    job: { company: 'Fictional Co', title: 'Fictional Role', canonical_url: 'https://example.invalid/job', selected_by_human: true },
    evaluation: {
      report_path: 'reports/fictional.md', rubric_version: '1.2', track: 'B',
      requirements: [{ id: 'r1', text: requirement, importance: 'critical', status,
        evidence_ids: status === 'missing' ? [] : ['f1'], evidence_level: status === 'missing' ? null : evaluationLevel }],
    },
    facts: status === 'missing' ? [] : [{ id: 'f1', source_quote: quote, claim, level, kind: 'experience', tracks: ['B'] }],
  };
  const reportText = `## Machine Summary\n\`\`\`yaml\nrequirement_importance:\n  - requirement: ${requirement}\n    importance: critical\n    match: ${status === 'missing' ? 'missing' : 'strong'}\n\`\`\`\n`;
  return buildDraft(input, { cvText, reportText });
}

const historical = [
  ['A: team attribution cannot become individual delivery', 'Team delivered implementation projects.', 'delivered implementation projects', 'Delivered implementation projects.'],
  ['B: negation cannot become deployment', 'Did not deploy cloud tools.', 'deploy cloud tools', 'Deployed cloud tools.'],
  ['C: estimated pilot metric cannot become achieved result', 'Estimated 10% time saving in a pilot.', '10% time saving in a pilot', 'Achieved 10% time savings.'],
];
for (const [name, statement, quote, claim] of historical) {
  test(`historical adversarial ${name}`, () => {
    const result = fixture({ statement, quote, claim });
    assert.equal(result.draft, null);
    assert.equal(result.errors.some(error => error.code === 'source_quote'), false, JSON.stringify(result.errors));
    assert.ok(result.errors.some(error => error.code === 'claim'), JSON.stringify(result.errors));
  });
}
test('historical C: estimated pilot qualification preserved is allowed', () => {
  const statement = 'Estimated 10% time saving in a pilot.';
  const result = fixture({ statement, quote: '10% time saving in a pilot', claim: statement });
  assert.deepEqual(result.errors, []);
  assert.equal(result.draft.ledger[0].source_statement, statement);
});

const contextCases = [
  ['company attribution', 'Company delivered implementation projects.', 'delivered implementation projects', 'Delivered implementation projects.'],
  ['support versus ownership', 'Supported implementation projects.', 'implementation projects', 'Owned implementation projects.'],
  ['contribution versus ownership', 'Contributed to implementation projects.', 'implementation projects', 'Owned implementation projects.'],
  ['contraction negation', "Didn't deploy cloud tools.", 'deploy cloud tools', 'Deployed cloud tools.'],
  ['approximate metric', 'Approximately 10% time saving.', '10% time saving', '10% time saving.'],
  ['projected metric', 'Projected 10% time saving.', '10% time saving', '10% time saving.'],
  ['planned work', 'Planned deployment of cloud tools.', 'deployment of cloud tools', 'Deployed cloud tools.'],
  ['in-progress work', 'Cloud deployment in progress.', 'Cloud deployment', 'Cloud deployment.'],
  ['limited scope', 'Delivered implementation projects only in a pilot.', 'Delivered implementation projects', 'Delivered implementation projects.'],
];
for (const [name, statement, quote, claim] of contextCases) {
  test(`context regression: ${name}`, () => {
    const result = fixture({ statement, quote, claim, level: /planned|in-progress/.test(name) ? 'in_progress' : 'transferable_professional' });
    assert.equal(result.draft, null);
    assert.equal(result.errors.some(error => error.code === 'source_quote'), false, JSON.stringify(result.errors));
    assert.ok(result.errors.some(error => error.code === 'claim'), JSON.stringify(result.errors));
  });
}
test('wrapped statement retains later scope limitation', () => {
  const cvText = '## Experience\n- Delivered implementation projects\n  only in a simulated pilot.\n';
  const source = sourceStatement(cvText, 'Delivered implementation projects');
  assert.match(source.statement, /only in a simulated pilot/);
  const result = fixture({ statement: 'Delivered implementation projects\n  only in a simulated pilot.', quote: 'Delivered implementation projects', claim: 'Delivered implementation projects.' });
  assert.ok(result.errors.some(error => error.code === 'claim'), JSON.stringify(result.errors));
});
test('portfolio evidence cannot be classified as professional', () => {
  const result = fixture({ section: 'Projects', statement: 'Built a retrieval prototype.', quote: 'Built a retrieval prototype', claim: 'Built a retrieval prototype', level: 'direct_professional' });
  assert.ok(result.errors.some(error => error.code === 'evidence_level'));
});
test('academic/training evidence cannot be classified as professional', () => {
  const result = fixture({ section: 'Education', statement: 'Completed cloud deployment training.', quote: 'Completed cloud deployment training', claim: 'Completed cloud deployment training', level: 'direct_professional' });
  assert.ok(result.errors.some(error => error.code === 'evidence_level'));
});
test('transferable evidence cannot exceed the evaluation evidence level', () => {
  const result = fixture({ statement: 'Coordinated implementation projects.', quote: 'Coordinated implementation projects', claim: 'Coordinated implementation projects', level: 'direct_professional', evaluationLevel: 'transferable_professional' });
  assert.ok(result.errors.some(error => error.code === 'evaluation_level'));
});
test('Critical gap stays unclaimed', () => {
  const result = fixture({ statement: 'Coordinated implementation projects.', status: 'missing' });
  assert.deepEqual(result.errors, []);
  assert.equal(result.draft.evidence_map[0].include, false);
  assert.equal(result.draft.ledger.length, 0);
});
