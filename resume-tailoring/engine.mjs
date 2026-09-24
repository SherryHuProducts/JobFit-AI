// Resume Tailoring Engine V1.1 — Provenance Classification Bug Fix.
// JobFit AI draft engine. Facts are verified against primary user-authored text.
// A V1.2 requirement map guides selection but never becomes a source of CV facts.
import { createHash } from 'node:crypto';
import { load as loadYaml } from 'js-yaml';
import { resolveSourceStatement, provenanceAllowsLevel } from './provenance.mjs';

export const LEVELS = Object.freeze({
  direct_professional: 5,
  transferable_professional: 4,
  portfolio_hands_on: 3,
  academic_training: 2,
  in_progress: 1,
});
export const IMPORTANCE = Object.freeze({ critical: 5, high: 4, meaningful: 3, preferred: 2, low_signal: 1 });
const KINDS = new Set(['summary', 'experience', 'skill', 'project', 'education', 'certification']);
const TRACKS = new Set(['A', 'B', 'C', 'cross']);
const GAP = new Set(['missing', 'gap', 'unsupported']);
const MATCH = Object.freeze({ strong: 'supported', partial: 'partial', missing: 'missing', na: 'unsupported' });
const GLUE = new Set('a an and as at by for from in into of on or the to with across through using via while'.split(' '));
const CONTEXT = new Set('not no never without planned planning proposed learning progress assisted assist supported support contributed contribute helped participated participate team company group prototype portfolio academic training estimated approximately about around roughly projected target pilot simulated demo up-to exposure familiar designed only limited supervised supervision internal sandbox test testing partial draft pending experimental'.split(' '));
const SECTION_ORDER = {
  A: ['experience', 'skill', 'project', 'education', 'certification'],
  B: ['experience', 'project', 'skill', 'education', 'certification'],
  C: ['experience', 'skill', 'project', 'education', 'certification'],
};
const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const words = value => (clean(value).toLowerCase().replace(/\b(?:didn't|doesn't|don't|wasn't|weren't|isn't|aren't|hasn't|haven't|hadn't|can't|cannot)\b/g, ' not ').match(/[\p{L}\p{N}+#]+/gu) || []);
const canonical = value => clean(value).replace(/^[-*•]\s*/, '').replace(/[*_`]/g, '').replace(/[“”]/g, '"').replace(/[’]/g, "'");
const hash = value => createHash('sha256').update(value).digest('hex');
const issue = (code, id, detail) => ({ code, id, detail });

export function machineRequirements(reportText) {
  const section = reportText.match(/^## Machine Summary\s*$([\s\S]*?)(?=^## |$(?![\s\S]))/m)?.[1] || '';
  const yaml = section.match(/```(?:yaml|yml)\s*\n([\s\S]*?)```/i)?.[1];
  if (!yaml) return null;
  try {
    const parsed = loadYaml(yaml);
    return Array.isArray(parsed?.requirement_importance) ? parsed.requirement_importance : null;
  } catch { return null; }
}

export function sourceStatement(source, quote) {
  return resolveSourceStatement(source, quote);
}

export function sourceSection(source, quote) {
  return sourceStatement(source, quote)?.heading ?? null;
}

// Deliberately conservative: a rewritten claim can delete source words, but
// substantive words must retain their source order. This avoids changing who
// did what by permuting a sentence. Meaningful synonyms need a confirmed
// primary source phrase first.
export function verifyClaim(claim, sourceStatementText) {
  const source = canonical(sourceStatementText);
  const target = canonical(claim);
  if (!target) return ['empty claim'];
  const available = new Map();
  for (const token of words(source)) available.set(token, (available.get(token) || 0) + 1);
  const extras = [];
  for (const token of words(target)) {
    if (GLUE.has(token)) continue;
    const n = available.get(token) || 0;
    if (n) available.set(token, n - 1);
    else extras.push(token);
  }
  const sourceNums = source.match(/(?:[$€£]\s*)?\d[\d,.%+kmb-]*/gi) || [];
  const targetNums = target.match(/(?:[$€£]\s*)?\d[\d,.%+kmb-]*/gi) || [];
  for (const number of targetNums) if (!sourceNums.includes(number)) extras.push(number);
  const targetSet = new Set(words(target));
  for (const token of words(source)) if (CONTEXT.has(token) && !targetSet.has(token)) extras.push(`context:${token}`);
  const sourceOrder = words(source).filter(token => !GLUE.has(token));
  const targetOrder = words(target).filter(token => !GLUE.has(token));
  let cursor = 0;
  for (const token of targetOrder) {
    const next = sourceOrder.indexOf(token, cursor);
    if (next < 0) { extras.push(`order:${token}`); break; }
    cursor = next + 1;
  }
  return [...new Set(extras)].map(token => `unsupported term or metric: ${token}`);
}

function metadataSupported(fact, cvText) {
  const labels = ['organization', 'role', 'dates'];
  return labels.filter(label => fact[label] && !cvText.includes(String(fact[label])));
}

function relevance(fact, requirement) {
  const a = new Set(words(fact.source_quote).filter(w => w.length > 2 && !GLUE.has(w)));
  const b = words(requirement.text).filter(w => w.length > 2 && !GLUE.has(w));
  return b.length ? b.filter(w => a.has(w)).length / b.length : 0;
}

export function buildDraft(input, { cvText, reportText }) {
  const errors = [], warnings = [];
  if (!input || typeof input !== 'object') throw new Error('input must be an object');
  const job = input.job || {};
  const evaluation = input.evaluation || {};
  if (!job.selected_by_human || !clean(job.company) || !clean(job.title) || !clean(job.canonical_url)) errors.push(issue('selection', 'job', 'a human-selected job with company, title, and canonical URL is required'));
  try { const url = new URL(job.canonical_url); if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error(); } catch { errors.push(issue('job_url', 'job', 'canonical URL must be public HTTP(S)')); }
  if (!TRACKS.has(evaluation.track)) errors.push(issue('track', 'evaluation', 'track must be A, B, C, or cross'));
  if (!clean(evaluation.report_path) || !clean(reportText) || !clean(evaluation.rubric_version).includes('1.2')) errors.push(issue('evaluation', 'evaluation', 'an existing V1.2 report is required'));
  if (!Array.isArray(evaluation.requirements) || !evaluation.requirements.length) errors.push(issue('requirements', 'evaluation', 'V1.2 requirement rows are required'));
  const machineRows = machineRequirements(reportText);
  if (!machineRows?.length) errors.push(issue('machine_summary', 'evaluation', 'V1.2 report requires non-empty Machine Summary requirement_importance rows'));
  if (!clean(cvText)) errors.push(issue('source', 'cv.md', 'cv.md is empty'));
  if (errors.length) return { errors, warnings, draft: null };

  const reqs = evaluation.requirements.map((r, index) => {
    const id = clean(r.id) || `r${index + 1}`;
    if (!clean(r.text) || !IMPORTANCE[r.importance] || !['supported', 'partial', 'missing', 'unsupported'].includes(clean(r.status).toLowerCase())) errors.push(issue('requirement', id, 'text, importance, and V1.2 match status required'));
    const row = machineRows.find(m => clean(m.requirement).toLowerCase() === clean(r.text).toLowerCase());
    if (!row || row.importance !== r.importance || MATCH[row.match] !== clean(r.status).toLowerCase()) errors.push(issue('evaluation_trace', id, 'requirement, importance, or match differs from V1.2 Machine Summary'));
    if (r.evidence_level && !LEVELS[r.evidence_level]) errors.push(issue('evaluation_level', id, 'invalid V1.2 evidence level'));
    return { id, text: clean(r.text), importance: r.importance, status: clean(r.status).toLowerCase(), evidence_level: r.evidence_level || null, evidence_ids: Array.isArray(r.evidence_ids) ? r.evidence_ids : [] };
  });
  const mappedNames = new Set(reqs.map(r => r.text.toLowerCase()));
  if (reqs.length !== machineRows.length || mappedNames.size !== machineRows.length || machineRows.some(row => !mappedNames.has(clean(row.requirement).toLowerCase()))) errors.push(issue('evaluation_coverage', 'evaluation', 'all distinct V1.2 Machine Summary requirements must be mapped, including gaps'));
  const ids = new Set();
  const facts = (input.facts || []).map(raw => {
    const f = { ...raw, id: clean(raw.id), source_quote: clean(raw.source_quote), claim: clean(raw.claim || raw.source_quote), level: clean(raw.level), kind: clean(raw.kind), tracks: raw.tracks || [] };
    if (!f.id || ids.has(f.id)) errors.push(issue('fact_id', f.id, 'missing or duplicate fact ID'));
    ids.add(f.id);
    const source = sourceStatement(cvText, f.source_quote);
    const heading = source?.heading;
    if (!source) errors.push(issue('source_quote', f.id, 'exact source quote not found in a cv.md statement'));
    if (!LEVELS[f.level] || !provenanceAllowsLevel(source?.provenance, f.level)) errors.push(issue('evidence_level', f.id, `level does not match source section: ${heading || 'none'}`));
    if (source?.provenance_review_required) errors.push(issue('evidence_context', f.id, `source provenance requires review: ${source.provenance}`));
    if (!KINDS.has(f.kind)) errors.push(issue('kind', f.id, 'unsupported content kind'));
    if (!Array.isArray(f.tracks) || f.tracks.some(t => !['A', 'B', 'C'].includes(t))) errors.push(issue('tracks', f.id, 'tracks must be A/B/C array'));
    for (const label of metadataSupported(f, cvText)) errors.push(issue('metadata', f.id, `${label} not present in cv.md`));
    for (const detail of verifyClaim(f.claim, source?.statement || '')) errors.push(issue('claim', f.id, detail));
    return { ...f, source_heading: heading, source_provenance: source?.provenance, source_heading_path: source?.heading_path, source_location: source?.source_location, source_statement: source?.statement || null, transformation: f.claim === f.source_quote ? 'select' : 'compress' };
  });
  const byId = new Map(facts.map(f => [f.id, f]));
  const map = reqs.map(r => {
    const gap = GAP.has(r.status);
    const linked = r.evidence_ids.map(id => byId.get(id)).filter(Boolean);
    for (const id of r.evidence_ids) if (!byId.has(id)) errors.push(issue('evidence_reference', r.id, `unknown fact ID: ${id}`));
    if (gap && linked.length) errors.push(issue('gap_conflict', r.id, 'a documented gap cannot support a positive resume claim'));
    if (r.evidence_level && linked.some(f => LEVELS[f.level] > LEVELS[r.evidence_level])) errors.push(issue('evaluation_level', r.id, 'fact evidence level exceeds the V1.2 finding'));
    return { ...r, evidence: linked.map(f => ({ fact_id: f.id, level: f.level, source_heading: f.source_heading, source_experience: [f.role, f.organization].filter(Boolean).join(' — ') || null, source_quote: f.source_quote, source_statement: f.source_statement })), include: !gap && linked.length > 0, reason: gap ? 'documented evaluation gap; deliberately unclaimed' : linked.length ? 'supported' : 'no documented evidence; deliberately unclaimed' };
  });
  if (errors.length) return { errors, warnings, draft: null };

  const scored = facts.map(f => {
    const matches = map.filter(r => r.include && r.evidence.some(e => e.fact_id === f.id));
    const strongest = matches.reduce((n, r) => Math.max(n, IMPORTANCE[r.importance]), 0);
    const relevanceScore = matches.reduce((n, r) => Math.max(n, relevance(f, r)), 0);
    const trackBonus = evaluation.track === 'cross' ? (f.tracks.length ? 1 : 0) : f.tracks.includes(evaluation.track) ? 1 : 0;
    return { ...f, priority: strongest * 100 + LEVELS[f.level] * 10 + relevanceScore * 5 + trackBonus, requirement_ids: matches.map(r => r.id) };
  }).filter(f => f.requirement_ids.length);
  scored.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
  const limits = input.layout?.max_items || { summary: 1, experience: 7, skill: 5, project: 3, education: 2, certification: 2 };
  const selected = [], omitted = [], counts = {};
  for (const f of scored) {
    const cap = Math.min(12, Math.max(0, Number(limits[f.kind] ?? 3)));
    if ((counts[f.kind] || 0) < cap) { selected.push(f); counts[f.kind] = (counts[f.kind] || 0) + 1; }
    else omitted.push({ fact_id: f.id, reason: 'one-page content budget' });
  }
  const selectedIds = new Set(selected.map(f => f.id));
  for (const row of map) {
    if (row.include && !row.evidence.some(e => selectedIds.has(e.fact_id))) {
      row.include = false;
      row.reason = 'supported evidence omitted by one-page content budget';
    }
  }
  if (!selected.length) warnings.push(issue('empty_resume', 'draft', 'no supported claims selected'));
  for (const r of map.filter(row => GAP.has(row.status) && IMPORTANCE[row.importance] >= IMPORTANCE.high)) {
    for (const f of selected) {
      if (canonical(f.claim).toLowerCase().includes(r.text.toLowerCase())) errors.push(issue('gap_claim', f.id, `claim repeats documented ${r.importance} gap ${r.id}`));
    }
  }
  if (errors.length) return { errors, warnings, draft: null };
  const strengths = ['A', 'B', 'C'].map(track => ({ track, score: selected.filter(f => f.tracks.includes(track)).reduce((n, f) => n + f.priority, 0) })).sort((a, b) => b.score - a.score);
  const layoutTrack = evaluation.track === 'cross' ? strengths[0].track : evaluation.track;
  const section_order = SECTION_ORDER[layoutTrack];
  const content = Object.fromEntries(['summary', ...section_order].map(kind => [kind, selected.filter(f => f.kind === kind).map(f => ({ id: f.id, text: canonical(f.claim), organization: f.organization || '', role: f.role || '', dates: f.dates || '', level: f.level }))]));
  const ledger = selected.map(f => ({ claim_id: f.id, resume_claim: canonical(f.claim), source_file: 'cv.md', source_quote: f.source_quote, source_statement: f.source_statement, source_heading: f.source_heading, source_provenance: f.source_provenance, source_heading_path: f.source_heading_path, source_location: f.source_location, evidence_level: f.level, transformation: f.transformation, requirement_ids: f.requirement_ids, verification_status: 'source_verified', priority: f.priority }));
  const draft = { schema_version: 1, job: { company: clean(job.company), title: clean(job.title), canonical_url: clean(job.canonical_url) }, evaluation: { report_path: evaluation.report_path, rubric_version: evaluation.rubric_version, track: evaluation.track }, source_hashes: { cv_sha256: hash(cvText), report_sha256: hash(reportText) }, evidence_map: map, content: { section_order, sections: content }, ledger, omitted, review: { state: 'draft', approved_at: null, approved_by: null }, warnings };
  return { errors, warnings, draft };
}
