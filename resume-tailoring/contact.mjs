// Presentation adapter: candidate facts are read verbatim, never inferred.
export function candidateContact(profile = {}) {
  const candidate = profile?.candidate || {};
  const fields = { name: 'full_name', email: 'email', phone: 'phone', location: 'location', linkedin: 'linkedin' };
  const contact = {}, warnings = [];
  for (const [target, source] of Object.entries(fields)) {
    const value = candidate[source];
    contact[target] = typeof value === 'string' && value.trim() ? value : '';
    if (!contact[target]) warnings.push(`HUMAN REVIEW: candidate.${source} is missing or invalid; omitted from resume header.`);
  }
  return { contact, warnings };
}
