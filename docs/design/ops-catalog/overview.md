# Ops Catalog Design

`@pluxel/ops` is the kernel: documented schema function, validation, registry, and `OpResult` execution. Runtime and host code own everything around that kernel.

## Runtime Model

`ctx.ops` wraps the core registry and adds:

- owner and plugin lifetime cleanup;
- adapter metadata for RPC, MCP, CLI, and workbench;
- catalog projection;
- host-owned toolsets.

The core descriptor remains `id`, `doc`, and `schemas`. It is not a UI schema, carrier map, owner index, policy object, or persistence model.

## Catalog

The host reads `opsCatalog()` instead of inspecting raw registry state. A catalog entry joins one live op with runtime metadata:

```ts
type RuntimeOpCatalogEntry = {
	id: string
	owner: string
	ownerKind: 'runtime' | 'plugin' | 'context'
	pluginId?: string
	descriptor: OpDescriptor
	bindings: {
		cli?: CliBindingSummary
		rpc?: { exposed: true }
		mcp?: { name: string }
	}
	workbench: {
		mutating: boolean
		confirm: boolean
	}
}
```

Rules:

- `/ops` executes only entries with `bindings.rpc`.
- MCP and CLI visibility come from adapter metadata.
- owner and lifecycle never enter `@pluxel/ops` core.
- plugin-owned entries disappear when the plugin effect scope is disposed.

## Toolsets

Toolsets are host preference, not registry state:

```ts
type OpsToolset = {
	toolsetId: string
	name: string
	description?: string
	opIds: string[]
}
```

They may contain ids for currently unavailable ops. They do not create plugin dependencies and are not pruned when plugins stop.

## RPC Surface

Catalog and toolsets are transport read models:

- `opsCatalog()`
- `opsToolsets()`
- `updateOpsToolsets(toolsets)`
- `resolveOpsToolset(toolsetId)`

Runtime control actions remain canonical ops and are invoked through `opsInvoke(id, input)` or `opsDispatch(command)`.
