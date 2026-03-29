# Review And Apply Playbook

## Purpose
Guide the user through reviewing a module packet and, if approved, applying it.

## Review command
`catalog review <job-id>`

## Record a decision
`catalog review <job-id> --action approve`

Other actions:
- `approve_with_edits`
- `reject`
- `defer`

## Apply
`catalog apply <job-id>`

## Agent behavior
- Always inspect `review.md` and `review.json` before recommending approval.
- Never bypass review.
- Only call `catalog apply` when the decision is approved or approved with edits.
