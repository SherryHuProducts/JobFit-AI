// V1.1: resolve evidence provenance from the source, never caller metadata.
const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const canonical = value => clean(value).replace(/^[-*•]\s*/, '').replace(/[*_`]/g, '').replace(/[“”]/g, '"').replace(/[’]/g, "'");
const label = value => clean(value).replace(/[*_`]/g, '').replace(/:$/, '').toLowerCase();

// Explicit section vocabulary used by cv.md and existing engine fixtures.
// Exact labels matter: Training Manager and Machine Learning Engineer are roles.
const sections = new Map([
  ...['professional experience', 'experience', 'employment', 'work history'].map(x => [x, 'professional']),
  ...['portfolio', 'projects', 'portfolio projects', 'portfolio / projects', 'portfolio technical skills'].map(x => [x, 'portfolio']),
  ...['education', 'academic', 'academic and training skills', 'academic and training', 'training', 'training / certification', 'education / academic', 'coursework', 'certification', 'certifications', 'certifications / professional development'].map(x => [x, 'academic']),
  ...['planned', 'planned / in progress', 'in progress', 'in-progress', 'architecture, design, and in-progress technologies'].map(x => [x, 'in_progress']),
  ...['skills', 'professional tools and skills', 'professional skills', 'technical skills'].map(x => [x, 'skills']),
  ...['summary', 'profile', 'professional summary'].map(x => [x, 'summary']),
]);
function sectionClass(text) { return sections.get(label(text)) || null; }
function classification(text) {
  const s = label(text);
  const classes = [];
  if (/\bportfolio\b|\bpersonal project\b/.test(s)) classes.push('portfolio');
  if (/\bacademic\b|\bcoursework\b|\btraining\b/.test(s)) classes.push('academic');
  if (/\bplanned\b|\bin.progress\b/.test(s)) classes.push('in_progress');
  if (/\bprofessional (?:employment|experience)\b/.test(s)) classes.push('professional');
  // Only explicit Classification labels use this vocabulary search.
  if (classes.includes('in_progress') && classes.length === 2) return 'in_progress';
  if (classes.length > 1) return 'conflicting';
  return classes[0] || sectionClass(s) || 'unresolved';
}

function combine(current, next) {
  if (!next) return current;
  if (current === 'conflicting' || next === 'conflicting' || current === 'unresolved' || next === 'unresolved') return 'conflicting';
  if (!current || current === next) return next;
  // Restrict employment/skills/summary with an explicit local provenance label.
  // A nested employment label must never promote portfolio or academic work.
  if (['professional', 'skills', 'summary'].includes(current)) return next;
  if (next === 'in_progress') return next;
  return 'conflicting';
}
function statementClass(statement) {
  const s = canonical(statement);
  // These describe the candidate's evidence context, not words in a job title
  // or the activity of delivering training/onboarding during employment.
  if (/^(?:planned|planning|proposed|learning)\b/i.test(s) || /\bin.progress\b/i.test(s) || /\b(?:is|remains?|still|status:)\s+(?:planned|proposed|incomplete)\b/i.test(s) || /\b(?:planned|proposed)\s*[.!]?$/i.test(s)) return 'in_progress';
  if (/^(?:completed|undertook|attended|enrolled in|studied)\s+(?:(?:an?|the|my)\s+)?(?:[a-z0-9+-]+\s+){0,5}(?:coursework|course|training|certification)(?:[.!]|$|\s+(?:in|on|at|through|with|for)\b)/i.test(s) || /^(?:coursework|academic|training)\s*:/i.test(s) || /\b(?:as part of|during|for|in) (?:an? |the |my )?(?:academic course|coursework|training course)\b/i.test(s)) return 'academic';
  if (/^(?:portfolio|personal project)\s*:/i.test(s) || /\b(?:in|for|as part of) (?:an? |the |my )?(?:portfolio|personal project)\b/i.test(s)) return 'portfolio';
  return null;
}

export function resolveSourceStatement(source, quote) {
  const q = clean(quote);
  if (!q) return null;
  const lines = source.split(/\r?\n/), stack = [], matches = [];
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const code = line.match(/^\s*(`{3,}|~{3,})/);
    if (code) { if (!fence) fence = code[1][0]; else if (fence === code[1][0]) fence = null; continue; }
    if (fence) continue;
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*$/);
    if (heading) {
      const depth = heading[1].length;
      while (stack.length && stack.at(-1).depth >= depth) stack.pop();
      stack.push({ depth, text: heading[2], line: i + 1, classification: sectionClass(heading[2]), marker: null });
      continue;
    }
    const explicit = line.match(/^\s*\*\*Classification:\*\*\s*(.+)$/i);
    const marker = line.match(/^\s*\*\*((?:V\d+(?:\.\d+)*\s+)?in progress|Completed(?: V\d+(?:\.\d+)*)?):\*\*\s*$/i);
    if (explicit || marker) {
      if (!stack.length) stack.push({ depth: 0, text: '', line: i + 1, classification: null, marker: null });
      if (explicit) stack.at(-1).classification = combine(stack.at(-1).classification, classification(explicit[1]));
      else stack.at(-1).marker = /in progress/i.test(marker[1]) ? 'in_progress' : null;
      continue;
    }
    // Preserve the existing full-statement boundary, including wrapped lines.
    const statement = [line];
    let end = i;
    for (let j = i + 1; j < lines.length && /^\s+\S/.test(lines[j]) && !/^\s*[-*•]\s/.test(lines[j]); j++) { statement.push(lines[j]); end = j; }
    if (statement.some(part => clean(part).includes(q))) {
      const text = canonical(statement.join(' '));
      let provenance = null;
      for (const h of stack) { provenance = combine(provenance, h.classification); provenance = combine(provenance, h.marker); }
      provenance = combine(provenance, statementClass(text)) || 'unresolved';
      matches.push({ heading: stack.at(-1)?.text.toLowerCase() || '', statement: text,
        heading_path: stack.filter(h => h.depth).map(({depth, text, line}) => ({depth, text, line})),
        source_location: { start_line: i + 1, end_line: end + 1 }, provenance,
        provenance_review_required: ['unresolved', 'conflicting'].includes(provenance) });
    }
    i = end;
  }
  if (!matches.length) return null;
  if (matches.length > 1) return { ...matches[0], provenance: 'ambiguous', provenance_review_required: true, matching_locations: matches.map(m => m.source_location) };
  return matches[0];
}
const allowed = {
  professional: ['direct_professional', 'transferable_professional'],
  portfolio: ['portfolio_hands_on', 'in_progress'],
  academic: ['academic_training', 'in_progress'],
  in_progress: ['in_progress'],
  skills: ['transferable_professional', 'portfolio_hands_on', 'academic_training', 'in_progress'],
  summary: ['transferable_professional', 'portfolio_hands_on', 'academic_training', 'in_progress'],
};
export function provenanceAllowsLevel(provenance, level) { return allowed[provenance]?.includes(level) || false; }
