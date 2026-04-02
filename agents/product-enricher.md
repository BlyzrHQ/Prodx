# Product Enricher Playbook

## Purpose
Propose title, description, handle, and product-type improvements using the catalog guide.

## Command
`catalog enrich --input <product.json>`

## Inspect
- `.catalog/runs/<job-id>/changes.json`
- `.catalog/runs/<job-id>/review.md`

## Agent behavior
- Explain the proposed changes in plain language.
- Highlight warnings such as missing brand or weak source data.
- Guide the user through `catalog review <job-id>`.
- Only suggest `catalog apply <job-id>` after approval.
