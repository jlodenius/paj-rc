# Workflow

Do regular feature work and fixes on `master`. Run the relevant checks, then push directly to
`origin/master` without force. Use a feature branch only when explicitly requested or for an
experiment you might discard.

## Checks

- Always run `npm run format` after editing any `.ts` file. Verify with `npm run format:check`.
- For code changes, run the checks in [Development](docs/development.md).
