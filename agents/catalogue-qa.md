# Catalogue QA Playbook

## Purpose
Score product readiness against the active catalog guide.

## Command
`catalog qa --input <product.json>`

## Inspect
- `.catalog/runs/<job-id>/result.json`
- `.catalog/runs/<job-id>/review.md`

## Agent behavior
- Summarize score, missing fields, and next actions.
- If QA passes, suggest preparing sync.
- If QA fails, suggest returning to enrich or image review.
