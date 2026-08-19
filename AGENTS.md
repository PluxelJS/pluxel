# Repository Instructions for Coding Agents

Before creating or changing a public library API, configuration contract, public type, error contract, extension point, or resource lifecycle, read:

- `.agents/rules/library-api-design.md`

This is a reusable decision guide, not a substitute for repository-specific constraints. Project constraints, existing public contracts, and domain conventions take precedence over its defaults.

Before changing plugin APIs, runtime capabilities, lifecycle, Context services, Vite/Rolldown integration, or package boundaries, read:

1. `engineering/DESIGN_PRINCIPLES.md`
2. `engineering/PLUGIN_SYSTEM.md`
3. the relevant domain document linked from `engineering/README.md`

Treat those documents as current engineering constraints. User-facing behavior must also be reflected in `docs/`; proposals and historical notes are not current API authority.

For a user-visible change to a public package, add a pending `.tegami/*.md` changelog with explicit
package bump types and at least one Markdown heading. Internal-only refactors, tests, and documentation
changes do not require empty changelogs. Do not edit package versions or `.tegami/publish-lock.yaml`
manually; Tegami owns version and internal dependency updates.
