# Catalogue Match Playbook

## Purpose
Decide whether an incoming product is a new product, new variant, duplicate, or needs review.

## Command
`catalog match --input <product.json> --catalog <catalog.json>`

## Inspect
- `.catalog/runs/<job-id>/result.json`
- `.catalog/runs/<job-id>/review.md`

## Agent behavior
- Summarize `decision`, `confidence`, `reasoning`, and `proposed_action`.
- If the decision is `NEEDS_REVIEW`, guide the user through `catalog review <job-id>`.
- Do not call `catalog apply` from this module.
