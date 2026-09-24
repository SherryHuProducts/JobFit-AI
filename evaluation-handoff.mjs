#!/usr/bin/env node
// Persistence adapter only: no evaluation, scoring, claims, or application actions.
import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute, basename, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { load } from 'js-yaml';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { machineRequirements, IMPORTANCE, LEVELS } from './resume-tailoring/engine.mjs';
const hash = text => createHash('sha256').update(text).digest('hex');
const fail = message => { throw new Error(`EVALUATION_HANDOFF: ${message}`); };
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
function section(text, heading, language) {
  const sections = text.split(`## ${heading}\n`);
  if (sections.length !== 2) fail(`exactly one ${heading} section required`);
  const body = sections[1].split(/^## /m)[0];
  const match = body.match(new RegExp('^```' + language + '\\s*\\n([\\s\\S]*?)^```', 'm'));
  if (!match) fail(`${heading} requires a ${language} block`);
  return match[1];
}
export function readEvaluation(root, reportPath) {
  const base = realpathSync(resolve(root, 'reports'));
  const path = realpathSync(resolve(root, reportPath));
  const rel = relative(base, path);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || !/^\d+-.*\.md$/.test(basename(path))) fail('existing numbered report under reports/ required');
  const text = readFileSync(path, 'utf8');
  const data = JSON.parse(section(text, 'Evaluation Handoff', 'json'));
  if (!data || typeof data !== 'object' || Array.isArray(data)) fail('evaluation block must be an object');
  for (const key of ['schema_version', 'report_path', 'report_sha256']) if (key in data) fail(`${key} is adapter-owned`);
  const keys = ['canonical_job_id', 'canonical_url', 'company', 'title', 'triage_result', 'primary_track', 'controlling_gap', 'recommendation', 'evaluation_timestamp', 'rubric_version'];
  for (const key of keys) if (!nonempty(data[key])) fail(`missing ${key}`);
  if (data.rubric_version !== '1.2' || !['A', 'B', 'C', 'cross'].includes(data.primary_track)) fail('invalid rubric version or track');
  if (!['NONE', 'MEANINGFUL', 'HIGH', 'CRITICAL'].includes(data.gap_severity)) fail('invalid Gap Severity');
  if (!Number.isFinite(data.fit_score_100) || data.fit_score_100 < 0 || data.fit_score_100 > 100 || !Number.isFinite(data.machine_score_5) || data.machine_score_5 < 0 || data.machine_score_5 > 5) fail('missing or invalid scores');
  if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(data.evaluation_timestamp) || !Number.isFinite(Date.parse(data.evaluation_timestamp))) fail('invalid evaluation timestamp');
  const url = new URL(data.canonical_url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) fail('invalid canonical URL');
  // Identity is supplied by discovery; bind it to its exact URL, never derive a new ID.
  const machine = load(section(text, 'Machine Summary', '(?:yaml|yml)'));
  if (machine.score !== data.machine_score_5) fail('Machine Summary score mismatch');
  for (const [key, field] of [['company', 'company'], ['title', 'title'], ['role', 'title'], ['url', 'canonical_url'], ['canonical_url', 'canonical_url']]) {
    if (machine[key] !== undefined && machine[key] !== data[field]) fail(`Machine Summary ${key} mismatch`);
  }
  const rows = machineRequirements(text);
  if (!Array.isArray(data.requirements) || !data.requirements.length || rows?.length !== data.requirements.length) fail('all requirement rows required');
  const ids = new Set(), names = new Set();
  const statuses = { strong: 'supported', partial: 'partial', missing: 'missing', na: 'unsupported' };
  for (const [i, row] of data.requirements.entries()) {
    if (!nonempty(row.id) || ids.has(row.id) || !nonempty(row.text) || names.has(row.text) || !IMPORTANCE[row.importance] || !Array.isArray(row.evidence_ids) || row.evidence_ids.some(id => !nonempty(id)) || (row.evidence_level != null && !LEVELS[row.evidence_level])) fail('invalid requirement/evidence references');
    ids.add(row.id); names.add(row.text);
    if (rows[i].requirement !== row.text || rows[i].importance !== row.importance || statuses[rows[i].match] !== row.status) fail('requirement rows disagree with Machine Summary');
  }
  if ('selected_by_human' in data || 'human_decision' in data) fail('human decision must remain separate');
  return { schema_version: 1, ...data, report_path: relative(realpathSync(root), path), report_sha256: hash(text) };
}
export function persistHandoff(root, reportPath) {
  const artifact = readEvaluation(root, reportPath);
  const path = resolve(root, artifact.report_path.replace(/\.md$/, '.handoff.json'));
  writeFileSync(path, JSON.stringify(artifact, null, 2) + '\n', { mode: 0o600 });
  return path;
}
export function validateHandoff(root, artifactPath) {
  const artifact = JSON.parse(readFileSync(resolve(root, artifactPath), 'utf8'));
  const expected = readEvaluation(root, artifact.report_path);
  if (!isDeepStrictEqual(artifact, expected)) fail('artifact inconsistent with saved report/path/hash');
  if (realpathSync(resolve(root, artifactPath)) !== realpathSync(resolve(root, expected.report_path.replace(/\.md$/, '.handoff.json')))) fail('companion path mismatch');
  return artifact;
}
export function selectedJob(root, artifactPath, facts, decision) {
  if (decision !== 'APPLY') fail('explicit human APPLY required');
  const a = validateHandoff(root, artifactPath);
  if (!Array.isArray(facts)) fail('facts must be an array for existing claim verification');
  return { handoff_path: relative(resolve(root), resolve(root, artifactPath)), human_decision: 'APPLY',
    job: { canonical_job_id: a.canonical_job_id, canonical_url: a.canonical_url, company: a.company, title: a.title, selected_by_human: true },
    evaluation: { report_path: a.report_path, rubric_version: a.rubric_version, track: a.primary_track, requirements: structuredClone(a.requirements) }, facts };
}
export function validateSelectedJob(root, input) {
  if (!input.handoff_path) fail('missing handoff artifact');
  const expected = selectedJob(root, input.handoff_path, input.facts, input.human_decision);
  if (!isDeepStrictEqual(input.job, expected.job) || !isDeepStrictEqual(input.evaluation, expected.evaluation)) fail('selected job inconsistent with handoff');
}
if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  try {
    const [command, path, factsPath, decision] = process.argv.slice(2), root = getCareerOpsRoot();
    if (command === 'persist') console.log(persistHandoff(root, path));
    else if (command === 'validate') console.log(JSON.stringify(validateHandoff(root, path), null, 2));
    else if (command === 'select') console.log(JSON.stringify(selectedJob(root, path, JSON.parse(readFileSync(factsPath, 'utf8')), decision), null, 2));
    else fail('usage: persist REPORT | validate COMPANION | select COMPANION FACTS_JSON APPLY');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
