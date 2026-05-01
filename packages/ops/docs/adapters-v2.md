# Ops Adapter V2 Design

## Summary

`@pluxel/ops` core should stay adapter-free. Outer facilities bind ops to concrete surfaces:

- CLI
- RPC
- MCP / tools
- runtime ownership and cleanup
- host catalog and toolsets

Rule:

> kernel does not know adapters; adapters know the kernel.

## Boundary Table

| Concern | Owner | Reason |
| --- | --- | --- |
| op shape | `@pluxel/ops` | Core execution contract. |
| schema validation | `@pluxel/ops` | Shared by every surface. |
| extra constraints | `@pluxel/ops` | Still part of execution correctness. |
| plugin owner | runtime | Owner is a Pluxel lifecycle concern. |
| cleanup / HMR | runtime | Cleanup belongs to `ctx.effects`. |
| CLI trigger | CLI adapter | Text entry is carrier-specific. |
| CLI parser/help | CLI adapter | LLM needs one official parser, not core pollution. |
| RPC exposure | RPC adapter | Transport visibility is not an op fact. |
| MCP tool name | MCP adapter | Tool naming is carrier-specific. |
| confirmation | host or surface | Interaction behavior varies by surface. |
| catalog | host read model | It joins live ops, owner, and adapter bindings. |
| toolsets | host read model | Saved grouping is preference, not registry state. |

## CLI Adapter

CLI is the official adapter layer, but it stays outside the kernel contract. In this repo it is exported by `@pluxel/ops` as adapter utilities; it must not add fields to `OpDescriptor`.

```ts
const cliAdapter = createCliAdapter()
cliAdapter.bind(status, {
	triggers: ['plugin status'],
})
```

Binding should be typed from the operation input:

```ts
type CliBinding<I> = {
	triggers: string[]
	params?: Partial<Record<keyof I & string, CliParamBinding>>
	tail?: CliTailBinding<I>
}
```

The binding describes how text becomes an input candidate. It does not change the op descriptor.

The CLI adapter owns:

- triggers and aliases;
- tokenization;
- schema-derived argument parsing;
- help text;
- dispatch;
- live parser modules such as parsebox.

The op descriptor provides:

- title;
- description;
- input schema;
- output schema;
- validation errors.

Dispatch still crosses the normal op pipeline:

```txt
text -> parse -> input validation -> validate -> run -> output validation
```

CLI dispatch follows the same safe/raw naming rule:

```ts
const result = await ctx.cli.dispatch('plugin status --name demo', ctx)
const value = await ctx.cli.dispatchRaw('plugin status --name demo', ctx)
```

`dispatch` returns `OpResult`; `dispatchRaw` throws structured `OpError`. Adapters should default to `invoke`/`dispatch` and use raw variants only when the surrounding transport already standardizes thrown errors.

## CLI Input Mapping

The default mapping should be schema-derived for object inputs:

```txt
plugin status --name demo
```

maps to:

```ts
{ name: 'demo' }
```

Core ops may use any JSON-compatible input schema. CLI flags are only the default mapping for object-shaped inputs. For primitive or unusual input schemas, the CLI adapter must provide an explicit parser binding or reject the binding.

For more natural LLM-facing commands, CLI binding may attach a parsebox tail parser:

```ts
cliAdapter.bind(updateConfig, {
	triggers: ['plugin config set'],
	tail: cli.tail.parsebox(module, 'Main'),
})
```

The parser should return an object patch for the op input:

```txt
plugin config set demo verbose:on retries:3
```

```ts
{ name: 'demo', verbose: true, retries: 3 }
```

Merge rules:

- schema-derived flags and parsebox patches merge into one candidate input;
- unknown patch keys are rejected against the input object schema;
- explicit flags win by rejecting conflicting parsebox keys;
- the merged candidate still goes through full input schema validation and `validate`.

Parsebox tail parsers should be typed as returning `Partial<I>` for the target op input. Parsebox modules and other live parser objects stay in CLI adapter metadata. The op descriptor does not expose tail metadata.

## Runtime Boundary

Plugin authors should see the small API:

```ts
this.ctx.ops.register(status)
```

Runtime can attach owner and lifetime internally:

```ts
ctx.ops.register(status, {
	owner: { kind: 'plugin', id: pluginId },
	lifetime: ctx.effects,
})
```

This keeps plugin authoring compact while keeping owner and lifecycle out of `@pluxel/ops`.

Runtime may extend the base context:

```ts
type RuntimeOpContext = OpContext & {
	runtime: PluxelContext
	source?: { kind: 'rpc' | 'cli' | 'mcp' | 'internal'; pluginId?: string }
}
```

## Other Adapters

RPC, MCP, tools, HTTP, and workbench actions follow the same rule:

```ts
ctx.rpc.expose(status)
ctx.mcp.bind(status, { name: 'plugin_status_get' })
ctx.workbench.bind(status)
```

Adapters may add their own metadata. They should not mutate the op or require adapter-specific fields in `defineOp`.

This matters because the same op may have different surface behavior. A workbench action may require confirmation; an internal caller may not. That is a surface decision, not an op fact.

## Host Read Models

Host catalog is a projection, not core registry data:

```ts
type RuntimeOpCatalogEntry = {
	id: string
	owner: RuntimeOpOwner
	descriptor: OpDescriptor
	bindings: {
		cli?: CliBindingSummary
		rpc?: RpcBindingSummary
		mcp?: McpBindingSummary
	}
	workbench: {
		mutating: boolean
		confirm: boolean
	}
}
```

Toolsets store host preference:

```ts
type OpsToolset = {
	toolsetId: string
	name: string
	description: string
	opIds: string[]
}
```

Toolsets do not create plugin dependencies. If a plugin stops, the live op disappears; saved ids may remain as missing references.

## Package Split

```txt
@pluxel/ops core
  defineOp / createRegistry / validation / OpError / OpResult

@pluxel/ops adapter utilities
  createCliAdapter / cli.tail / help / dispatch / tokenizer / parser / trigger index

@pluxel/runtime
  ctx.ops / owner / lifetime / plugin cleanup / catalog projection

host UI
  filters / toolsets / confirmation / display state
```
