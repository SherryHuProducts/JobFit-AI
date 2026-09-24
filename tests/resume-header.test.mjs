import test from 'node:test';
import assert from 'node:assert/strict';
import { candidateContact } from '../resume-tailoring/contact.mjs';
import { expectedParagraphs } from '../resume-tailoring/presentation.mjs';
test('intended candidate fields populate presentation header verbatim', () => {
  const candidate = {full_name:'Example Person', email:'person@example.invalid', phone:'555-0100', location:'Example City', linkedin:'https://linkedin.com/in/example'};
  const {contact, warnings} = candidateContact({candidate, name:'Wrong Person', email:'wrong@example.invalid'});
  assert.deepEqual(warnings, []);
  assert.deepEqual(contact, {name:candidate.full_name, email:candidate.email, phone:candidate.phone, location:candidate.location, linkedin:candidate.linkedin});
  const paragraphs = expectedParagraphs({content:{section_order:[], sections:{}}}, contact);
  assert.equal(paragraphs[0].text, candidate.full_name);
  for (const value of Object.values(candidate).slice(1)) assert.ok(paragraphs[1].text.includes(value));
});
test('missing candidate fields warn for human review without top-level fallback', () => {
  const {contact, warnings} = candidateContact({name:'Do not infer', email:'wrong@example.invalid'});
  assert.equal(warnings.length, 5);
  assert.ok(warnings.every(w => w.startsWith('HUMAN REVIEW: candidate.')));
  assert.ok(Object.values(contact).every(v => v === ''));
  assert.equal(candidateContact({candidate:{full_name:'Example'}}).warnings.length, 4);
});
