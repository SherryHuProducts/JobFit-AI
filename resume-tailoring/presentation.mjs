// Canonical Professional Resume Template V1.0: DOCX is authoritative.
import { readFileSync, writeFileSync, copyFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const style = JSON.parse(readFileSync(new URL('./style-v1.json', import.meta.url), 'utf8'));
const script = new URL('./render_docx.py', import.meta.url).pathname;
const titles = { summary: 'Professional Summary', experience: 'Professional Experience', skill: 'Technical Skills', project: 'Selected Projects', education: 'Education', certification: 'Certifications / Professional Development' };
const normalize = value => String(value).replace(/[•\u2022]/g, ' ').replace(/\s+/g, ' ').trim();
function command(bin, args, options = {}) {
  const result = spawnSync(bin, args, { encoding: 'utf8', ...options });
  if (result.error || result.status !== 0) throw new Error(`${bin} failed: ${result.error?.message || (result.stderr || result.stdout).trim() || result.status}`);
  return result.stdout;
}
export function validateFont({ match = 'fc-match', exists = existsSync } = {}) {
  let output;
  try { output = command(match, ['-f', '%{family}|%{file}\n', style.font, '-s']); }
  catch (error) { throw new Error(`FONT_ENVIRONMENT: fc-match/Arial unavailable: ${error.message}`); }
  const [family, path] = output.split('\n')[0].split('|');
  if (!family?.split(',').map(x => x.trim()).includes(style.font) || !path || !exists(path)) {
    throw new Error(`FONT_ENVIRONMENT: Arial font file is unavailable; install Arial before canonical rendering (resolved: ${family || 'none'})`);
  }
  return { family: style.font, path };
}
export function expectedParagraphs(draft, contact) {
  const out = [{ text: contact.name || 'Resume Draft', claim_id: null }];
  const details = ['email', 'phone', 'location', 'linkedin'].filter(key => contact[key]).map(key => String(contact[key])).join(' · ');
  if (details) out.push({ text: details, claim_id: null });
  for (const kind of ['summary', ...draft.content.section_order]) {
    const items = draft.content.sections[kind] || [];
    if (!items.length) continue;
    out.push({ text: kind === 'skill' && draft.evaluation.track === 'C' ? 'Finance / Systems Skills' : titles[kind], claim_id: null });
    if (kind === 'experience' || kind === 'project') {
      let previous = null;
      for (const item of items) {
        const key = [item.role || '', item.organization || '', item.dates || ''];
        const identity = key.join('\u0000');
        if (identity !== previous) {
          const label = key.slice(0, 2).filter(Boolean).join(' — ') || titles[kind];
          out.push({ text: label + (key[2] ? `\t${key[2]}` : ''), claim_id: null });
          previous = identity;
        }
        out.push({ text: item.text, claim_id: String(item.id).replace(/[^\p{L}\p{N}_]/gu, '_').slice(0, 38) });
      }
    } else for (const item of items) out.push({ text: item.text, claim_id: String(item.id).replace(/[^\p{L}\p{N}_]/gu, '_').slice(0, 38) });
  }
  return out;
}
export function validateDocx(draft, contact, docxPath) {
  const inspected = JSON.parse(command('python3', [script, '--inspect', docxPath]));
  const expected = expectedParagraphs(draft, contact);
  if (inspected.paragraphs.length !== expected.length) throw new Error('CONTENT_INTEGRITY: DOCX paragraph count differs from structured input');
  for (let i = 0; i < expected.length; i++) {
    const actual = inspected.paragraphs[i];
    if (normalize(actual.text) !== normalize(expected[i].text) || actual.claim_id !== expected[i].claim_id) {
      throw new Error(`CONTENT_INTEGRITY: DOCX paragraph/claim ID mismatch at position ${i}`);
    }
  }
  if (/<w:tbl[ >]|<w:drawing[ >]|<w:pict[ >]/.test(inspected.styles)) throw new Error('ATS_STRUCTURE: unsupported layout element');
  return { paragraphs: expected.length, claim_ids: expected.filter(row => row.claim_id).map(row => row.claim_id) };
}
export function validatePdf(draft, contact, pdfPath) {
  const expected = expectedParagraphs(draft, contact);
  const extracted = normalize(command('pdftotext', ['-raw', '-nopgbrk', pdfPath, '-']));
  let cursor = 0;
  for (let i = 0; i < expected.length; i++) {
    const text = normalize(expected[i].text);
    const found = extracted.indexOf(text, cursor);
    if (found < 0) throw new Error(`ATS_CONTENT_INTEGRITY: PDF missing or out-of-order paragraph ${i}`);
    if (normalize(extracted.slice(cursor, found))) throw new Error(`ATS_CONTENT_INTEGRITY: unexpected PDF text before paragraph ${i}`);
    cursor = found + text.length;
  }
  if (normalize(extracted.slice(cursor))) throw new Error('ATS_CONTENT_INTEGRITY: unexpected trailing PDF text');
  const fonts = command('pdffonts', [pdfPath]);
  const used = fonts.split('\n').slice(2).filter(Boolean);
  if (!used.length || used.some(line => !/Arial/i.test(line) || !/\s+yes\s+/.test(line))) {
    throw new Error('FONT_ENVIRONMENT: PDF did not embed Arial; possible font substitution');
  }
  return { paragraphs: expected.length, font: 'Arial', reading_order: 'validated' };
}
function pdfPages(path) {
  const info = command('pdfinfo', [path]);
  const pages = Number(info.match(/^Pages:\s+(\d+)/m)?.[1]);
  if (!Number.isInteger(pages) || pages < 1) throw new Error('PDF_VALIDATION: page count unavailable');
  return pages;
}
function libreOffice() {
  const candidates = ['/Applications/LibreOffice.app/Contents/MacOS/soffice', 'soffice'];
  for (const binary of candidates) {
    try {
      const version = command(binary, ['--version']).trim();
      if (!version.includes(style.libreoffice_version)) throw new Error(`expected ${style.libreoffice_version}, found ${version}`);
      return { binary, version };
    } catch (error) {
      if (error.message.includes('expected')) throw new Error(`PDF_ENVIRONMENT: pinned LibreOffice version mismatch: ${error.message}`);
    }
  }
  throw new Error(`PDF_ENVIRONMENT: LibreOffice ${style.libreoffice_version} unavailable`);
}
export function validatePrivacy(path, repoRoot) {
  const target = resolve(path), root = resolve(repoRoot);
  if (target === root || target.startsWith(root + '/')) {
    const check = spawnSync('git', ['check-ignore', '-q', target], { cwd: root });
    if (check.status !== 0) throw new Error(`PRIVACY: candidate artifact path is not gitignored: ${target}`);
  } else if (!target.startsWith(resolve(tmpdir()) + '/') && !target.startsWith('/private/tmp/')) {
    throw new Error('PRIVACY: output must be in ignored repository output or private temporary storage');
  }
}
export function renderCanonical(draft, contact, dir, { repoRoot = process.cwd(), fontCheck = validateFont } = {}) {
  validatePrivacy(dir, repoRoot);
  fontCheck();
  const lo = libreOffice();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const draftPath = join(dir, 'structured-input.json'), contactPath = join(dir, 'contact-input.json');
  writeFileSync(draftPath, JSON.stringify(draft), { mode: 0o600 });
  writeFileSync(contactPath, JSON.stringify(contact), { mode: 0o600 });
  for (const preset of ['standard', 'compact']) {
    const docx = join(dir, `${preset}.docx`), pdf = join(dir, `${preset}.pdf`);
    command('python3', [script, draftPath, contactPath, docx, preset]);
    chmodSync(docx, 0o600);
    validateDocx(draft, contact, docx);
    const profile = mkdtempSync(join(dir, '.lo-profile-'));
    command(lo.binary, ['--headless', `-env:UserInstallation=file://${profile}`, '--convert-to', 'pdf', '--outdir', dir, docx], { env: { ...process.env, HOME: profile, TMPDIR: '/private/tmp', SAL_USE_VCLPLUGIN: 'svp' } });
    if (!existsSync(pdf)) throw new Error('PDF_ENVIRONMENT: LibreOffice did not produce PDF');
    chmodSync(pdf, 0o600);
    const pages = pdfPages(pdf);
    if (pages === 1) {
      const integrity = validatePdf(draft, contact, pdf);
      copyFileSync(docx, join(dir, 'draft.docx'));
      copyFileSync(pdf, join(dir, 'draft.pdf'));
      chmodSync(join(dir, 'draft.docx'), 0o600);
      chmodSync(join(dir, 'draft.pdf'), 0o600);
      return { status: 'ONE_PAGE', preset, pages, libreoffice: lo.version, ...integrity };
    }
  }
  return { status: 'OVERFLOW_TO_HUMAN_REVIEW', preset: 'compact', pages: pdfPages(join(dir, 'compact.pdf')), libreoffice: lo.version };
}
export { style };
