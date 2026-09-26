# Repository Instructions for Coding Agents

For source locations and application bindings, use [inspect](docs/development/inspection.md).
For isolated regression coverage, use [Plugin tests](docs/development/testing.md).
Other task entry points: [development guide](docs/development/index.md).

## Keep code and examples direct

Use original API names unless an alias resolves a conflict or clarifies an ambiguous source.
Avoid importing a value again just for its type, or adding aliases and wrappers with no distinct contract or behavior.
Documentation should show the shortest complete use of the existing contract.

## Framework changes

Pluxel currently serves the local repositories in this workspace. Update known callers together when changing a contract; do not retain compatibility aliases, old-format readers, or startup migration paths for hypothetical external consumers. Convert existing local data once when necessary, then remove the conversion code.

Before creating or changing a public library API, configuration contract, public type, error contract, extension point, or resource lifecycle, read:

- `.agents/rules/library-api-design.md`

This is a reusable decision guide, not a substitute for repository-specific constraints. Project constraints, existing public contracts, and domain conventions take precedence over its defaults.

Before changing plugin APIs, runtime capabilities, lifecycle, Context services, Vite/Rolldown integration, or package boundaries, read:

1. `engineering/DESIGN_PRINCIPLES.md`
2. `engineering/PLUGIN_SYSTEM.md`
3. the relevant domain document linked from `engineering/README.md`

Treat those documents as current engineering constraints. User-facing behavior must also be reflected in `docs/`; proposals and historical notes are not current API authority.

For local Plugin failure contracts, follow [Better Result guidance and official examples](docs/api/better-result.md).
Model caller-recoverable domain failures explicitly; preserve native SDK contracts, decisions, receipts and lifecycle failures.

For a user-visible change to a public package, add a pending `.tegami/*.md` changelog with explicit
package bump types and at least one Markdown heading. Internal-only refactors, tests, and documentation
changes do not require empty changelogs. Do not edit package versions or `.tegami/publish-lock.yaml`
manually; Tegami owns version and internal dependency updates.

## Working with a running development runtime

For live runtime inspection or changes, coding agents must read and use the
[development console](docs/development/dev-console.md) against the existing Vite process. This includes configuration edits, Workbench RPC, Plugin methods,
lifecycle operations, and runtime logs. Discover the instance first, then pin its `--root` and
`--instance` on subsequent commands. Submit ordinary TypeScript export functions and inspect the
run result, domain/application reports, and relevant logs. Use test hosts for isolated regression
coverage; they do not represent the state of an already running application.
