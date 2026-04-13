# @pluxel/ops

`@pluxel/ops` is Pluxel's schema-first control-plane kernel. Runtime, RPC, CLI, and external tool protocols all reuse the same op definition.

## Public op

```ts
import { cli, createSpace, defineOp, typebox } from '@pluxel/ops'

const ops = createSpace()

ops.register(
	defineOp({
		id: 'plugin.config.patch',
		doc: {
			title: 'Patch Plugin Config',
			description: 'Validate and persist a config patch for one plugin.',
			usage: 'plugin config patch --name <plugin> -- <json>',
			examples: ['plugin config patch --name demo -- {"basic":{"enabled":true}}'],
			tags: ['plugin', 'config'],
		},
		input: typebox.obj({
			name: typebox.Type.String({ minLength: 1, description: 'Plugin name.' }),
			patch: typebox.Type.Record(typebox.Type.String(), typebox.Type.Unknown(), {
				description: 'Config patch object to persist.',
			}),
		}),
		output: typebox.obj({
			ok: typebox.Type.Boolean(),
		}),
		cli: {
			triggers: ['plugin config patch'],
			tail: cli.tail.json('patch'),
		},
		tool: {
			name: 'plugin.config.patch',
		},
		async execute(input) {
			return { ok: true }
		},
	}),
)
```

## Authoring rules

- Use `defineOp({ ... })`. The object form is the canonical API.
- Use TypeBox only.
- Put all human and LLM guidance in `doc`.
- Add `tool: { name }` only when the op should be exposed as a tool.
- Keep `tool.name` stable and lower-case dotted / kebab.
- For tool-visible object input, every field needs a schema `description`.
- Keep `cli` parse-only: `triggers` and `tail`.

## Execution model

- `ctx.ops.invoke(...)`, CLI dispatch, and tool protocol adapters all execute the same op.
- Validation stays on the canonical op boundary.
- Tool-facing help is compiled from `doc` and input schema descriptions; adapters should not invent a second help model.

See [DESIGN.md](./DESIGN.md) for the design rationale.
