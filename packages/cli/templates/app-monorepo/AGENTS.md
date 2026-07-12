# Repository instructions for coding agents

Before changing files under `plugins/`, plugin-facing contracts, Pluxel host configuration, or
`oxlint.config.ts`, read `docs/PLUXEL_PLUGIN_GUIDE.md`.

Keep these boundaries intact:

- required plugin dependencies belong in constructors; optional integrations use `plugins.use()`;
- business HTTP must work with Web Management disabled;
- deployable web and host policy stay in `web/`; shared neutral logic stays in `packages/domain`;
- run `pnpm verify` after changes and do not bypass Pluxel lint rules without a documented reason.
