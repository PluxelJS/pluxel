# @pluxel/ops

Lightweight operation kernel for Pluxel control-plane actions.

One `defineOp` call produces one documented schema function with validation and a serializable descriptor. Transport and host metadata live outside the core descriptor.

TypeBox helpers live at `@pluxel/ops/typebox` so schema code keeps the familiar TypeBox shape.

## Example

```ts
import { cli as opsCli, createCliAdapter, createRegistry, defineOp } from '@pluxel/ops'
import { Type, obj } from '@pluxel/ops/typebox'

const registry = createRegistry()
const cli = createCliAdapter()

const patchConfig = defineOp({
	id: 'plugin.config.patch',
	doc: {
		title: 'Patch Plugin Config',
		description: 'Validate and persist a config patch.',
	},
	input: obj({
		name: Type.String({ description: 'Plugin name.' }),
		patch: Type.Record(Type.String(), Type.Unknown(), {
			description: 'Config patch object.',
		}),
	}),
	output: obj({ ok: Type.Boolean() }),
	async run() {
		return { ok: true }
	},
})

registry.register(patchConfig)
cli.bind(patchConfig, {
	triggers: ['plugin config patch'],
	tail: opsCli.tail.json('patch'),
})

await cli.dispatch('plugin config patch --name demo -- {"basic":{"enabled":true}}')
await registry.invoke('plugin.config.patch', {
	name: 'demo',
	patch: { basic: { enabled: true } },
})
```

## Public Shape

- Author with `defineOp({ id, doc, input, output, validate, validateOutput, run })`.
- `Operation` exposes `id`, `descriptor`, `run`, `invoke`, and `invokeRaw`.
- `invoke` returns `OpResult`; `invokeRaw` throws `OpError`.
- Descriptors contain only `id`, `doc.title`, `doc.description`, and input/output schemas.

## Rules

- Import ops core from `@pluxel/ops`.
- Import `Type`, `obj`, and `openObj` from `@pluxel/ops/typebox`.
- Always declare both `input` and `output`.
- Always declare `doc.title` and `doc.description`.
- Keep operation ids lowercase.
- Put transport bindings in adapters or host metadata, not in `defineOp`.
- Keep owner, lifetime, cleanup, catalog, and grouping outside the core registry.

Design notes:

- [Core V2](./docs/core-v2.md): lightweight kernel contract.
