# Mode: resume-tailoring — Resume Tailoring Engine V1.1

Run only after Scanner → Triage → completed Rubric V1.2 → explicit human selection of one job. This mode does not change fit scoring, gaps, recommendation, or application status. Never submit an application.

## Inputs

- An archived selected JD and an existing V1.2 report under the private data root.
- `cv.md` as the primary fact source. Confirm Master Career Facts into `cv.md` before using them. Raw documents in `documents/` or `source_resumes/` cannot directly supply claims.
- A validated `.handoff.json` companion to the original numbered report. Missing or inconsistent handoffs block drafting.
- A private JSON array of proposed facts, still subject to the existing evidence and claim gates.

## Completed evaluation persistence

Save the original numbered V1.2 report first. Do not create another evaluation or rescore it. Keep `## Machine Summary` and its frozen schema unchanged. At evaluation completion, save a separate `## Evaluation Handoff` section in the **same report**, containing one fenced `json` object with these explicit evaluated values:

- `canonical_job_id`, `canonical_url`, `company`, `title`: copy discovery identity unchanged.
- `triage_result`, `primary_track`, `fit_score_100`, `machine_score_5`, `gap_severity`, `controlling_gap`, `recommendation`: copy the completed evaluation unchanged.
- `evaluation_timestamp`: original ISO timestamp with timezone; `rubric_version`: `"1.2"`.
- `requirements`: all ordered rows with `id`, `text`, `importance`, `status`, `evidence_level` when recorded, and `evidence_ids` (explicitly empty when no evidence). Preserve references and text. Match encoding is `strong` → `supported`, `partial` → `partial`, `missing` → `missing`, `na` → `unsupported`.

These are persistence fields, not additional Machine Summary fields. Never infer missing values, evidence references, identity, or timestamps. For an older report lacking this section, stop for review and copy only recorded evaluation values into the original report; never repeat the evaluation to manufacture missing data. Keep report prose and this section consistent.

```bash
node evaluation-handoff.mjs persist reports/NUMBER-company.md
node evaluation-handoff.mjs validate reports/NUMBER-company.handoff.json
```

Persistence validates required fields and Machine Summary rows/score, then binds the companion to the report's actual path and SHA-256. It performs no human selection, resume generation, or application action.

## Explicit human APPLY

Only after the human says APPLY for this exact job:

```bash
node evaluation-handoff.mjs select reports/NUMBER-company.handoff.json data/company-facts.json APPLY > data/company-selected-job.json
```

This transfers requirement rows and evidence references automatically without modification; it does not generate a resume. DON'T APPLY stops here without creating selected-job input. Facts are proposed separately from `cv.md`; requirement evidence IDs must resolve to those facts. The selected-job input is revalidated against its handoff on every draft invocation.

Every `source_quote` and any factual metadata must occur in `cv.md`. A fact's level may not exceed its V1.2 row's level. The full `cv.md` statement containing the quote is the authoritative boundary for claim validation; the shorter quote is only a locator. The ledger records both. The engine deliberately permits only source words (plus neutral glue) in rewritten claims; add a confirmed equivalent phrase to `cv.md` if a defensible synonym is needed.

## Draft

```bash
node resume-tailoring.mjs draft data/selected-job.json --docx --pdf
```

Without `--pdf`, the engine writes structured content, HTML, the JD–evidence map, claim ledger, and a review record with `state: draft`; `--docx` adds a DOCX preview. `--pdf` renders a one-page PDF preview and rejects overflow. DOCX pagination must be visually reviewed because the built-in writer cannot measure Word pagination. Drafts and versions live under the ignored `output/resume-tailoring/` directory. The stable template is `resume-tailoring/template.html`; its matching DOCX typography is in `resume-tailoring/render_docx.py`.

Review the HTML/PDF and `claim-ledger.json`. Report what was selected, compressed or omitted, which terminology changed, and which requirements remain unclaimed. Do not mark a draft approved on the agent's own initiative. `verify-cv-facts.mjs` is an additional gate, not proof that all claims are supported; the source-span ledger is mandatory.

## Human approval

Only after the human approves the exact rendered draft, run:

```bash
node resume-tailoring.mjs approve output/resume-tailoring/EXACT-DRAFT/v001 --human-approved=REVIEWER
```

Approval requires a verified one-page PDF and unchanged `cv.md` and V1.2 report hashes. It copies the reviewed formats into that version's private `final/` directory and records the reviewer/time. It never submits an application.

## Evidence rules

SELECT, PRIORITIZE, REFRAME, COMPRESS only. Do not invent, upgrade, misrepresent, or turn a documented gap into a positive claim. Portfolio stays portfolio; academic stays academic; in-progress stays in-progress. Team outcomes retain team attribution. Metrics must appear in the verified source phrase with their context. Unsupported wording is blocked rather than silently fixed.

## V1.1 provenance classification

V1.1 changes only source-provenance resolution. Resolve evidence from the heading ancestry, explicit classification and local completion context in `cv.md`; employer and role headings inherit their enclosing provenance. Incidental title/activity words such as Project, Training and Learning do not establish evidence class. Delivering training during employment is employment; completing coursework is academic/training evidence. Unknown, conflicting or duplicate source matches fail closed. Preserve source location and heading ancestry in the claim ledger. Claim-verification semantics, evidence ceilings, requirement mapping and content prioritization remain unchanged.
