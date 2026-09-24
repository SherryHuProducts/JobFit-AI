#!/usr/bin/env node
// JobFit AI: draft-only tailoring from V1.2 requirement rows and cv.md facts.
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, chmodSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, sep, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { verifyFacts } from './verify-cv-facts.mjs';
import { auditAts } from './verify-ats.mjs';
import { buildDraft } from './resume-tailoring/engine.mjs';
import { renderHtml } from './resume-tailoring/render.mjs';
import { renderCanonical, validateFont } from './resume-tailoring/presentation.mjs';
import { load as loadYaml } from 'js-yaml';
import { candidateContact } from './resume-tailoring/contact.mjs';
import { validateSelectedJob } from './evaluation-handoff.mjs';

const root = getCareerOpsRoot();
const sha = data => createHash('sha256').update(data).digest('hex');
const slug = value => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'job';
const within = (base, target) => { const rel = relative(base, target); return rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
function reportPath(raw) {
  const resolved = resolve(root, String(raw || ''));
  if (!within(join(root, 'reports'), resolved) || !resolved.endsWith('.md')) throw new Error('evaluation.report_path must be a Markdown file under private reports/');
  return resolved;
}
function contact() {
  const profilePath = join(root, 'config/profile.yml');
  if (!existsSync(profilePath)) return candidateContact();
  const profile = loadYaml(readFileSync(profilePath, 'utf8')) || {};
  return candidateContact(profile);
}
function outputDir(job) {
  const key = sha(job.canonical_url).slice(0, 10);
  return join(root, 'output', 'resume-tailoring', `${slug(job.company)}-${slug(job.title)}-${key}`);
}
function nextVersion(dir) {
  for (let n = 1; n < 1000; n++) if (!existsSync(join(dir, `v${String(n).padStart(3, '0')}`))) return `v${String(n).padStart(3, '0')}`;
  throw new Error('too many draft versions');
}
function save(path, value) { writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); }
function renderDocx(draftPath, contactPath, destination) {
  const script = new URL('./resume-tailoring/render_docx.py', import.meta.url).pathname;
  const result = spawnSync('python3', [script, draftPath, contactPath, destination], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`DOCX renderer failed: ${result.stderr || result.error?.message || result.status}`);
  chmodSync(destination, 0o600);
}
function pdfPageCount(buffer) {
  const pdf = buffer.toString('latin1');
  const objects = new Map();
  for (const match of pdf.matchAll(/(?:^|[\r\n])(\d+)\s+(\d+)\s+obj\b([\s\S]*?)\bendobj\b/g)) {
    const stream = match[3].search(/\bstream(?:\r?\n|\r)/);
    objects.set(`${match[1]} ${match[2]}`, stream === -1 ? match[3] : match[3].slice(0, stream));
  }
  const catalog = [...objects.values()].find(body => /\/Type\s*\/Catalog\b/.test(body));
  const pagesRef = catalog?.match(/\/Pages\s+(\d+)\s+(\d+)\s+R\b/);
  const pages = pagesRef ? objects.get(`${pagesRef[1]} ${pagesRef[2]}`) : null;
  const count = pages?.match(/\/Count\s+(\d+)\b/);
  if (!pages || !/\/Type\s*\/Pages\b/.test(pages) || !count) throw new Error('could not read PDF page count');
  return Number(count[1]);
}
async function draftCommand(inputPath, { docx = false, pdf = false } = {}) {
  const privateInput = resolve(inputPath);
  if (![join(root, 'data'), join(root, 'output'), join(root, 'private')].some(base => within(base, privateInput))) throw new Error('input JSON must be stored under private data/, output/, or private/');
  const input = readJson(privateInput);
  validateSelectedJob(root, input);
  const { contact: header, warnings: headerWarnings } = contact();
  const cvPath = join(root, 'cv.md');
  const cvText = readFileSync(cvPath, 'utf8');
  const reportText = readFileSync(reportPath(input.evaluation?.report_path), 'utf8');
  const result = buildDraft(input, { cvText, reportText });
  if (result.errors.length) throw new Error(`evidence validation failed:\n${result.errors.map(e => `${e.code} ${e.id}: ${e.detail}`).join('\n')}`);
  const html = renderHtml(result.draft, header);
  const profilePath = join(root, 'config/profile.yml');
  const factGate = verifyFacts(html, { sourcePaths: existsSync(profilePath) ? [cvPath, profilePath] : [cvPath], cwd: root });
  if (factGate.verdict === 'block') throw new Error(`existing fact gate blocked draft: ${factGate.invented.length} metric, ${factGate.unsupportedFacts.length} fact, ${factGate.forbidden.length} forbidden findings`);
  const ats = auditAts(html);
  const dir = join(outputDir(result.draft.job), nextVersion(outputDir(result.draft.job)));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  save(join(dir, 'draft.json'), result.draft);
  save(join(dir, 'evidence-map.json'), result.draft.evidence_map);
  save(join(dir, 'claim-ledger.json'), result.draft.ledger);
  save(join(dir, 'contact.json'), header);
  writeFileSync(join(dir, 'draft.html'), html, { mode: 0o600 });
  const reviewLines = [
    '# Resume draft review', '', ...headerWarnings, '',
    '## Emphasized',
    ...result.draft.ledger.map(row => `- ${row.resume_claim} (source: ${row.source_file}, ${row.evidence_level}; JD: ${row.requirement_ids.join(', ')})`),
    '', '## Compressed or omitted',
    ...(result.draft.omitted.length ? result.draft.omitted.map(row => `- ${row.fact_id}: ${row.reason}`) : ['- None within the current content budget.']),
    '', '## Wording changes',
    ...result.draft.ledger.filter(row => row.transformation !== 'select').map(row => `- Source: ${row.source_quote}\n  Draft: ${row.resume_claim}`),
    ...(result.draft.ledger.some(row => row.transformation !== 'select') ? [] : ['- No substantive terminology changed.']),
    '', '## Important requirements deliberately not claimed',
    ...result.draft.evidence_map.filter(row => !row.include).map(row => `- ${row.importance}: ${row.text} — ${row.reason}`),
    ...(result.draft.evidence_map.some(row => !row.include) ? [] : ['- None.']),
    '', 'Approval state: draft. Human review required.', '',
  ];
  writeFileSync(join(dir, 'review-summary.md'), reviewLines.join('\n'), { mode: 0o600 });
  save(join(dir, 'review.json'), { state: 'draft', approved_at: null, approved_by: null, draft_sha256: sha(JSON.stringify(result.draft)), html_sha256: sha(html), pdf_sha256: null, docx_sha256: null, pdf_pages: null, docx_page_count: 'unverified' });
  if (docx && !pdf) {
    validateFont();
    renderDocx(join(dir, 'draft.json'), join(dir, 'contact.json'), join(dir, 'draft.docx'));
  }
  if (docx && !pdf) { const review = readJson(join(dir, 'review.json')); review.docx_sha256 = sha(readFileSync(join(dir, 'draft.docx'))); save(join(dir, 'review.json'), review); }
  let pages = null;
  if (pdf) {
    const presentation = renderCanonical(result.draft, header, dir, { repoRoot: root });
    if (presentation.status === 'OVERFLOW_TO_HUMAN_REVIEW') return { directory: dir, state: presentation.status, pdf_pages: presentation.pages, preset: presentation.preset };
    pages = presentation.pages;
    const review = readJson(join(dir, 'review.json'));
    review.pdf_pages = pages;
    review.pdf_sha256 = sha(readFileSync(join(dir, 'draft.pdf')));
    review.docx_sha256 = sha(readFileSync(join(dir, 'draft.docx')));
    review.presentation_preset = presentation.preset;
    save(join(dir, 'review.json'), review);
  }
  return { directory: dir, state: 'draft', warnings: headerWarnings, selected_claims: result.draft.ledger.length, unclaimed_requirements: result.draft.evidence_map.filter(r => !r.include).map(r => ({ id: r.id, importance: r.importance, reason: r.reason })), ats_score: ats.score, pdf_pages: pages, docx_preview: docx, fact_gate: factGate.verdict };
}

function approveCommand(dir, humanName) {
  if (!humanName) throw new Error('approval requires --human-approved=<reviewer> after the human reviews this exact draft');
  const absolute = resolve(dir);
  if (!within(join(root, 'output', 'resume-tailoring'), absolute)) throw new Error('draft path must be under the private resume-tailoring output root');
  const draft = readJson(join(absolute, 'draft.json'));
  const review = readJson(join(absolute, 'review.json'));
  if (review.state !== 'draft' || review.draft_sha256 !== sha(JSON.stringify(draft))) throw new Error('draft/review state mismatch');
  if (review.pdf_pages !== 1 || !existsSync(join(absolute, 'draft.pdf'))) throw new Error('one-page PDF verification is required before approval');
  if (review.html_sha256 !== sha(readFileSync(join(absolute, 'draft.html'))) || review.pdf_sha256 !== sha(readFileSync(join(absolute, 'draft.pdf'))) || (review.docx_sha256 && review.docx_sha256 !== sha(readFileSync(join(absolute, 'draft.docx'))))) throw new Error('rendered draft changed after review; regenerate a new version');
  if (draft.source_hashes.cv_sha256 !== sha(readFileSync(join(root, 'cv.md'), 'utf8')) || draft.source_hashes.report_sha256 !== sha(readFileSync(reportPath(draft.evaluation.report_path), 'utf8'))) throw new Error('source files changed; regenerate and review a new draft');
  const finalDir = join(absolute, 'final');
  mkdirSync(finalDir, { recursive: true, mode: 0o700 });
  chmodSync(finalDir, 0o700);
  for (const extension of ['html', 'pdf', 'docx']) {
    const source = join(absolute, `draft.${extension}`);
    if (existsSync(source)) copyFileSync(source, join(finalDir, `resume.${extension}`));
  }
  save(join(absolute, 'review.json'), { ...review, state: 'approved', approved_at: new Date().toISOString(), approved_by: humanName });
  return { directory: finalDir, state: 'approved' };
}

async function main(args) {
  const [command, operand, ...flags] = args;
  if (command === 'draft' && operand) return draftCommand(operand, { docx: flags.includes('--docx'), pdf: flags.includes('--pdf') });
  if (command === 'approve' && operand) return approveCommand(operand, flags.find(x => x.startsWith('--human-approved='))?.slice(17));
  throw new Error('usage: node resume-tailoring.mjs draft input.json [--docx] [--pdf] | approve draft-directory --human-approved=NAME');
}
if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  main(process.argv.slice(2)).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
export { draftCommand, approveCommand, pdfPageCount };
