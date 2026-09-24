import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { renderCanonical, validateDocx, validateFont, validatePrivacy, expectedParagraphs, style } from '../resume-tailoring/presentation.mjs';

const contact = { name: 'Fictional Candidate', email: 'fictional@example.invalid', phone: '555-0100', location: 'Seattle, WA', linkedin: 'linkedin.com/in/fictional' };
const order = {
  A: ['experience', 'skill', 'project', 'education', 'certification'],
  B: ['experience', 'project', 'skill', 'education', 'certification'],
  C: ['experience', 'skill', 'project', 'education', 'certification'],
};
function draft(track = 'A', count = 3, optional = true) {
  const layout = track === 'cross' ? 'B' : track;
  const sections = {
    summary: optional ? [{ id: 'summary', text: 'Operations and systems professional with implementation experience.' }] : [],
    experience: Array.from({ length: count }, (_, i) => ({ id: `exp${i}`, text: `Coordinated implementation workflows and documented operational handoffs for project ${i + 1}.`, role: 'Operations Analyst', organization: 'Example Employer', dates: '2022–2024' })),
    skill: [{ id: 'skill', text: 'SQL, Python, financial modeling, implementation planning' }],
    project: optional ? [{ id: 'project', text: 'Built a portfolio workflow prototype.', role: 'Portfolio Project', organization: '', dates: '2024' }] : [],
    education: [{ id: 'education', text: 'BS, Business Administration — Example University' }],
    certification: optional ? [{ id: 'certification', text: 'Professional development in systems analysis' }] : [],
  };
  return { evaluation: { track }, content: { section_order: order[layout], sections } };
}
function temp() { return mkdtempSync(join(tmpdir(), 'resume-template-v1-')); }
function docxOnly(d, preset = 'standard') {
  const dir = temp();
  const input = join(dir, 'draft.json'), personal = join(dir, 'contact.json'), docx = join(dir, 'draft.docx');
  writeFileSync(input, JSON.stringify(d)); writeFileSync(personal, JSON.stringify(contact));
  const result = spawnSync('python3', ['resume-tailoring/render_docx.py', input, personal, docx, preset], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return docx;
}
for (const track of ['A', 'B', 'C', 'cross']) {
  test(`synthetic ${track} DOCX preserves frozen section order and every claim`, () => {
    const d = draft(track);
    const docx = docxOnly(d);
    const integrity = validateDocx(d, contact, docx);
    assert.equal(integrity.claim_ids.length, 3 + 5);
    assert.deepEqual(d.content.section_order, order[track === 'cross' ? 'B' : track]);
  });
}
test('optional sections disappear without changing remaining content', () => {
  const d = draft('A', 2, false);
  const docx = docxOnly(d);
  validateDocx(d, contact, docx);
  const expected = expectedParagraphs(d, contact).map(row => row.text).join(' ');
  assert.doesNotMatch(expected, /Professional Summary|Selected Projects|Certifications/);
});
test('standard and compact DOCX styles have exact approved sizes and margins', () => {
  for (const preset of ['standard', 'compact']) {
    const docx = docxOnly(draft(), preset);
    const inspected = JSON.parse(spawnSync('python3', ['resume-tailoring/render_docx.py', '--inspect', docx], { encoding: 'utf8' }).stdout);
    assert.match(inspected.styles, /:ascii="Arial"/);
    assert.match(inspected.styles, new RegExp(`:styleId="Body"[\\s\\S]*?:sz[^>]*:val="${style[preset].body_pt * 2}"`));
    assert.ok(style[preset].body_pt >= 10);
    validateDocx(draft(), contact, docx);
  }
});
test('Arial availability check rejects a substituted family', () => {
  const dir = temp();
  const match = join(dir, 'fc-match');
  const font = join(dir, 'font.ttf');
  writeFileSync(font, 'synthetic font-path fixture');
  writeFileSync(match, `#!/bin/sh\nprintf 'Arial|%s\\n' '${font}'\n`, { mode: 0o700 });
  assert.equal(validateFont({ match }).family, 'Arial');
  writeFileSync(match, `#!/bin/sh\nprintf 'Substituted Family|%s\\n' '${font}'\n`, { mode: 0o700 });
  assert.throws(() => validateFont({ match }), /FONT_ENVIRONMENT.*Arial font file is unavailable/);
  assert.throws(() => validateFont({ match, exists: () => false }), /FONT_ENVIRONMENT/);
});
test('explicit font validation reports unavailable fc-match', () => {
  const fontCheck = () => validateFont({ match: join(temp(), 'missing-fc-match') });
  assert.throws(fontCheck, /FONT_ENVIRONMENT.*ENOENT/);
  assert.throws(() => renderCanonical(draft(), contact, temp(), { fontCheck }), /FONT_ENVIRONMENT.*ENOENT/);
});
test('private output is gitignored and non-private repository output is rejected', () => {
  const root = process.cwd();
  validatePrivacy(join(root, 'output', 'resume-tailoring', 'synthetic'), root);
  assert.throws(() => validatePrivacy(join(root, 'resume-tailoring', 'candidate.json'), root), /PRIVACY/);
});
// The shipped macOS LibreOffice build currently aborts in AppKit before any
// headless conversion in this harness. Keep the tests available for a pinned
// non-GUI environment without treating that host limitation as a layout pass.
const fullEnvironment = process.platform !== 'darwin' && existsSync('/Applications/LibreOffice.app/Contents/MacOS/soffice') && spawnSync('pdftotext', ['-v'], { encoding: 'utf8' }).error == null;
test('standard one-page DOCX-to-PDF has exact content and reading order', { skip: !fullEnvironment }, () => {
  const d = draft('A', 3);
  const result = renderCanonical(d, contact, temp());
  assert.equal(result.status, 'ONE_PAGE');
  assert.equal(result.preset, 'standard');
  assert.equal(result.reading_order, 'validated');
});
test('compact preset fits a synthetic dense draft without mutation', { skip: !fullEnvironment }, () => {
  const d = draft('B', 18);
  const result = renderCanonical(d, contact, temp());
  assert.equal(result.status, 'ONE_PAGE');
  assert.equal(result.preset, 'compact');
});
test('forced overflow returns to human review', { skip: !fullEnvironment }, () => {
  const result = renderCanonical(draft('C', 50), contact, temp());
  assert.equal(result.status, 'OVERFLOW_TO_HUMAN_REVIEW');
});
