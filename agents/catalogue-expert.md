# Catalogue Expert Playbook

## Purpose
Generate the store guide pack and initialize learning.

## Command
`catalog expert generate --industry <industry> --business-name "<name>"`

## Inspect
- `.catalog/guide/catalog-guide.md`
- `.catalog/guide/catalog-guide.json`
- `.catalog/learning/catalog-learning.md`

## Agent behavior
- Explain what was generated.
- Ask the user to review the guide files before running downstream modules.
- Do not invent provider credentials; direct the user to `catalog auth set` and `catalog config`.
