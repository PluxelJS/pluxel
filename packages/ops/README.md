# @pluxel/ops

Schema-first operation kernel for Pluxel control-plane actions.

One `defineOp` call produces one frozen descriptor. Runtime, RPC, CLI, MCP, docs, and tests project from that descriptor.

TypeBox helpers live at `@pluxel/ops/typebox` so schema code keeps the familiar TypeBox shape.

## Example

```ts
import { cli, createSpace, defineOp } from '@pluxel/ops'
import { Type, obj } from '@pluxel/ops/typebox'

const ops = createSpace()

ops.register(
	defineOp({
		id: 'plugin.config.patch',
		input: obj({
			name: Type.String({ description: 'Plugin name.' }),
			patch: Type.Record(Type.String(), Type.Unknown(), {
				description: 'Config patch object.',
			}),
		}),
		output: obj({ ok: Type.Boolean() }),
		doc: {
			title: 'Patch Plugin Config',
			description: 'Validate and persist a config patch.',
			usage: 'plugin config patch --name <plugin> -- <json>',
		},
		exposure: { rpc: true },
		policy: { mutating: true, audit: ['plugin-config'] },
		cli: { triggers: ['plugin config patch'], tail: cli.tail.json('patch') },
		tool: true,
		async execute() {
			return { ok: true }
		},
	}),
)

await ops.dispatch('plugin config patch --name demo -- {"basic":{"enabled":true}}')
await ops.invoke('plugin.config.patch', {
	name: 'demo',
	patch: { basic: { enabled: true } },
})
```

## Public Shape

- Author with `defineOp({ id, input, output, doc, exposure, policy, cli, tool, execute })`.
- Create a runtime surface with `createSpace()`.
- `Operation` exposes only `id`, `descriptor`, `run`, and `runSafe`.
- Descriptors are serializable public metadata. Live runtime objects stay hidden.

## Rules

- Import ops core from `@pluxel/ops`.
- Import `Type`, `obj`, and `openObj` from `@pluxel/ops/typebox`.
- Always declare both `input` and `output`.
- Keep operation ids and CLI triggers lowercase.
- Put user/tool help in `doc`.
- Put action semantics in `policy`.
- Use `exposure.rpc` for RPC visibility.
- Use `cli` only for parsing metadata.
- Use `tool: true` unless a deliberate external tool alias is needed.
- Describe every tool-visible object input field, including nested fields.
- Keep tool names unique in one registry.

See [DESIGN.md](./DESIGN.md) for architecture constraints.
