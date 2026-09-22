import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadWebCandidates, rejectWebCandidate } from '../web-discovery.mjs';
import { normalizeUrlForDedup, normalizeRoleForDedup, buildTitleFilter } from '../scan.mjs';
import { readFileSync } from 'node:fs';
import { load as loadYaml } from 'js-yaml';

test('web intake preserves provenance, canonicalizes tracking URLs, and records invalid leads', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'career-ops-web-intake-')), 'hits.json');
  writeFileSync(file, JSON.stringify({ candidates: [
    { source: 'search:campfire', company: 'Campfire', title: 'Accounting Deployment Strategist',
      location: 'San Francisco', url: 'https://jobs.ashbyhq.com/campfire/abc?utm_source=search', posting_date: '2026-09-15' },
    { source: 'search:invalid', company: 'Campfire', title: 'Deployment Manager', url: 'file:///etc/passwd' },
  ] }));
  const result = loadWebCandidates(file, {
    normalizeUrl: normalizeUrlForDedup,
    normalizeCompany: s => s.toLowerCase(),
    normalizeTitle: normalizeRoleForDedup,
    discoveredAt: '2026-09-21T00:00:00Z',
  });
  assert.equal(result.jobs.length, 1);
  assert.equal(result.records.length, 2);
  assert.equal(result.jobs[0].url, 'https://jobs.ashbyhq.com/campfire/abc');
  assert.equal(result.records[0].source, 'search:campfire');
  assert.equal(result.records[0].posting_date, '2026-09-15');
  assert.equal(result.records[0].discovery_timestamp, '2026-09-21T00:00:00Z');
  assert.equal(result.records[1].rejection_stage, 'ingestion');
  rejectWebCandidate(result.jobs[0], 'title', 'no match');
  assert.equal(result.records[0].rejection_stage, 'title');
});

test('deployment discovery phrases admit the known roles without a bare deployment match', () => {
  const config = loadYaml(readFileSync(new URL('../portals.yml', import.meta.url), 'utf8'));
  const accepts = buildTitleFilter(config.title_filter);
  assert.equal(accepts('Accounting Deployment Strategist'), true);
  assert.equal(accepts('AI Deployment Manager - Builder'), true);
  assert.equal(accepts('Manager, AI Deployment Engineering (Southeast Asia)'), false);
  assert.equal(accepts('Kubernetes Deployment Engineer'), false);
  assert.equal(config.title_filter.positive.some(value => /^deployment$/i.test(value)), false);
  assert.ok(config.search_queries.some(item => item.enabled && item.query.includes('"Accounting Deployment"')));
});
