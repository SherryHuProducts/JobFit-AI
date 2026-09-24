import { readFileSync } from 'node:fs';
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const title = { summary: 'Professional Summary', experience: 'Professional Experience', skill: 'Technical Skills', project: 'Selected Projects', education: 'Education', certification: 'Certifications / Professional Development' };
export function renderHtml(draft, contact = {}) {
  const name = escape(contact.name || 'Resume Draft');
  const details = [contact.email, contact.phone, contact.location, contact.linkedin].filter(Boolean).map(escape).join(' · ');
  let body = `<header><h1>${name}</h1>${details ? `<div class="contact">${details}</div>` : ''}</header>`;
  for (const kind of ['summary', ...draft.content.section_order]) {
    const items = draft.content.sections[kind] || [];
    if (!items.length) continue;
    body += `<section><h2>${kind === 'skill' && draft.evaluation.track === 'C' ? 'Finance / Systems Skills' : title[kind]}</h2>`;
    if (kind === 'experience' || kind === 'project') {
      const groups = new Map();
      for (const item of items) {
        const key = [item.organization, item.role, item.dates].join('\u0000');
        if (!groups.has(key)) groups.set(key, { ...item, bullets: [] });
        groups.get(key).bullets.push(item.text);
      }
      for (const group of groups.values()) {
        const label = [group.role, group.organization].filter(Boolean).map(escape).join(' — ');
        body += `<div class="entry"><div class="entry-head"><span>${label || title[kind]}</span><span class="dates">${escape(group.dates)}</span></div><ul>`;
        for (const bullet of group.bullets) body += `<li>${escape(bullet)}</li>`;
        body += '</ul></div>';
      }
    } else {
      for (const item of items) body += `<p>${escape(item.text)}</p>`;
    }
    body += '</section>';
  }
  return readFileSync(new URL('./template.html', import.meta.url), 'utf8').replace('{{BODY}}', body);
}
