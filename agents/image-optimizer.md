# Image Optimizer Playbook

## Purpose
Review image readiness and prepare image search or image quality tasks.

## Command
`catalog image --input <product.json>`

## Inspect
- `.catalog/runs/<job-id>/result.json`
- `.catalog/runs/<job-id>/review.md`

## Agent behavior
- State whether the product has images or needs search/review.
- Mention which providers are expected from runtime config.
- Keep this review-first; do not pretend live image updates already happened.
