// Canonical intake and audit records for externally discovered web-search hits.
// This module does not score jobs or bypass the scanner's objective filters.
import { readFileSync } from 'node:fs';

const clean = (value) => typeof value === 'string' ? value.trim() : '';

export function loadWebCandidates(filePath, { normalizeUrl, normalizeCompany, normalizeTitle, discoveredAt = new Date().toISOString() }) {
  const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  const input = Array.isArray(parsed) ? parsed : parsed?.candidates;
  if (!Array.isArray(input)) throw new Error('--web-candidates expects a JSON array or {"candidates": [...]}');
  const records = [];
  const jobs = [];
  for (const [index, raw] of input.entries()) {
    const source = clean(raw?.source) || clean(raw?.query);
    const company = clean(raw?.company);
    const title = clean(raw?.title);
    const location = clean(raw?.location);
    const suppliedUrl = clean(raw?.url) || clean(raw?.canonical_url);
    const postedAtRaw = clean(raw?.postedAt) || clean(raw?.posting_date);
    let canonicalUrl = '';
    let reason = '';
    try {
      const url = new URL(suppliedUrl);
      if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password) throw new Error('URL must be a public HTTP(S) posting');
      canonicalUrl = normalizeUrl(url.toString());
    } catch {
      reason = 'invalid posting URL';
    }
    if (!source || !company || !title) reason ||= 'source, company, and title are required';
    const postedAt = postedAtRaw && !Number.isNaN(Date.parse(postedAtRaw)) ? postedAtRaw : null;
    if (postedAtRaw && !postedAt) reason ||= 'invalid posting date';
    const identity = canonicalUrl
      ? `${canonicalUrl} | ${normalizeCompany(company)}::${normalizeTitle(title)}`
      : `${normalizeCompany(company)}::${normalizeTitle(title)}`;
    const record = {
      source, discovery_method: 'websearch', canonical_url: canonicalUrl,
      company, title, location, posting_date: postedAt,
      discovery_timestamp: discoveredAt, liveness_status: 'not_checked',
      deduplication_identity: identity,
      rejection_stage: reason ? 'ingestion' : null,
      rejection_reason: reason || null,
      input_index: index,
    };
    records.push(record);
    if (!reason) {
      jobs.push({
        source: 'websearch', company, title, location, url: canonicalUrl,
        postedAt: postedAt ? Date.parse(postedAt) : null,
        _webRecord: record,
      });
    }
  }
  return { records, jobs };
}

export function rejectWebCandidate(job, stage, reason) {
  if (!job?._webRecord) return;
  job._webRecord.rejection_stage = stage;
  job._webRecord.rejection_reason = reason;
}
