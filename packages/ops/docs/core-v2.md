# Ops Core V2 Design

## Summary

`@pluxel/ops` is a lightweight operation kernel:

> documented schema function + validation + registry

The core package should not become a transport framework or host policy layer. Transport bindings, cataloging, owner, lifetime, confirmation, audit, grouping, and permissions live outside the kernel.

Reason: every surface eventually crosses the ops execution path, so the shared core should stay small, predictable, and cheap.

## API Shape

V2 authoring should prefer required fields over behavior assembled from optional flags.

```ts
const status = defineOp({
	id: 'plugin.status.get',

	doc: {
		title: 'Get plugin status',
		description: 'Read one plugin status.',
	},

	input: obj({
		name: Type.String(),
	}),

	output: obj({
		running: Type.Boolean(),
	}),

	async run(input, ctx) {
		return { running: true }
	},
})
```

Required:

- `id`
- `doc.title`
- `doc.description`
- `input`
- `output`
- `run`

Optional:

- `validate`
- `validateOutput`

Do not add kernel-level `transport`, `exposure`, `policy`, `confirm`, `audit`, `owner`, `lifetime`, or `group`.

Naming rule:

- default APIs choose the safe/result-shaped behavior;
- `Raw` suffix means throwing or otherwise lower-level behavior;
- do not add `Safe` suffixes for the default path.

## Type Model

`defineOp` should infer input and output types from schemas:

```ts
type Operation<I, O, Ctx> = {
	id: string
	descriptor: OpDescriptor
	invoke(candidate: unknown, ctx: Ctx): Promise<OpResult<O>>
	invokeRaw(candidate: unknown, ctx: Ctx): Promise<O>
}
```

Author-facing `run` receives normalized typed input. Public invocation receives unknown candidate input and owns validation.

```ts
defineOp({
	input: obj({ name: Type.String() }),
	output: obj({ ok: Type.Boolean() }),
	async run(input, ctx) {
		input.name // string
		return { ok: true }
	},
})
```

This separates two concerns:

- `run(input, ctx)` is the typed implementation function.
- `invoke(candidate, ctx)` is the untrusted execution boundary.
- `invokeRaw(candidate, ctx)` is the throwing variant for adapters that prefer exceptions.

`Ctx` is generic and call-scoped. The kernel may define a small base context, and hosts can extend it:

```ts
type OpContext = {
	signal?: AbortSignal
	deadlineMs?: number
	now?: number
	meta?: Record<string, unknown>
}
```

Guidelines:

- Put cancellation, deadlines, deterministic time, and request metadata in base `ctx`.
- Hosts may extend `ctx` with request-scoped handles.
- Do not put owner, lifetime, CLI bindings, or host UI policy in core `ctx`.
- `Registry<Ctx>` and adapters should preserve the same `Ctx` type so every surface reaches the same typed execution boundary.

## Descriptor

The descriptor is only the stable public summary of the operation:

```ts
type OpDescriptor = {
	id: string
	doc: {
		title: string
		description: string
	}
	schemas: {
		input: JsonSchema
		output: JsonSchema
	}
}
```

It must not include live parser modules, owner metadata, carrier bindings, host UI metadata, caches, or execution policy.

Why: descriptors should be safe to serialize, cache, and project. Adapters may read descriptors, but descriptors should not know adapters.

## Validation

JSON Schema covers shape. Validators cover constraints schema cannot express cleanly.

```ts
const setScale = defineOp({
	id: 'plugin.scale.set',
	doc: {
		title: 'Set plugin scale',
		description: 'Update plugin worker scale.',
	},
	input: obj({
		min: Type.Integer(),
		max: Type.Integer(),
	}),
	output: obj({
		ok: Type.Boolean(),
	}),
	validate(input) {
		if (input.min > input.max) {
			return issue('min must be less than or equal to max', { path: ['min'] })
		}
	},
	async run() {
		return { ok: true }
	},
})
```

```ts
type Validator<T, Ctx> = (
	value: T,
	ctx: Ctx,
) => void | Issue | Issue[] | Promise<void | Issue | Issue[]>
```

Execution order:

```txt
candidate
 -> input schema validation / normalization
 -> validate(input, ctx)
 -> run(input, ctx)
 -> output schema validation / normalization
 -> validateOutput(output, ctx)
```

Validators return structured issues. They do not implement prompts, permissions, audit, transport behavior, or UI policy.

## Registry

The registry should be boring:

```ts
const registry = createRegistry()

const registration = registry.register(status)
registry.get('plugin.status.get')
registry.list()
registry.invoke('plugin.status.get', { name: 'demo' }, ctx)
registry.invokeRaw('plugin.status.get', { name: 'demo' }, ctx)
registration.dispose()
```

```ts
type Registration = {
	id: string
	dispose(): void
}
```

Kernel responsibilities:

- duplicate id rejection;
- id lookup;
- descriptor / operation listing;
- invocation;
- structured errors/results;
- registration disposal.

Not kernel responsibilities:

- owner indexes;
- carrier indexes;
- catalog filtering;
- lifecycle cleanup;
- group persistence.

## Invocation And Errors

Default invocation should be safe and result-shaped:

```ts
const result = await registry.invoke(id, input, ctx)
```

```ts
type OpResult<T> = { ok: true; value: T } | { ok: false; error: OpError }
```

Throwing invocation is still useful for internal code and transports that already use exception control flow:

```ts
const value = await registry.invokeRaw(id, input, ctx)
```

Rules:

- `invoke` never throws for expected op errors such as not found or validation failure.
- `invokeRaw` throws the same structured `OpError`.
- both methods share the same validation pipeline and error codes.
- adapters should default to `invoke` unless their transport boundary already standardizes thrown errors.

## Non-Goals

The V2 kernel does not provide transport DSLs, exposure flags, UI schema, confirm/audit/permission policy, owner/lifetime, catalog grouping, group persistence, or plugin dependency contracts.
