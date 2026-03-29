# Catalogue Expert Playbook

## Purpose
Generate the store policy pack and initialize learning.

## Command
`catalog expert generate --industry <industry> --business-name "<name>"`

## Inspect
- `.catalog/policy/catalog-policy.md`
- `.catalog/policy/catalog-policy.json`
- `.catalog/learning/catalog-learning.md`

## Agent behavior
- Explain what was generated.
- Ask the user to review the policy files before running downstream modules.
- Do not invent provider credentials; direct the user to `catalog auth set` and `catalog config`.
