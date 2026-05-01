import type { Context } from '@pluxel/core'
import { type OpResult } from '@pluxel/ops'

import type { RuntimeOpSource } from '../../services/ops/OpsService'
import type { RuntimeOpCatalogEntry } from '../../web/protocol'
import { pluginConfigOps } from './plugin-config'
import { pluginDependencyOps } from './plugin-dependencies'
import { pluginStatusOps } from './plugin-status'

const RUNTIME_OPS_OWNER = 'runtime:ops'

function resolveRootContext(ctx: Context): Context {
	return (ctx.root ?? ctx) as Context
}

function listRegisteredRuntimeOpsCatalog(ctx: Context): RuntimeOpCatalogEntry[] {
	ensureRuntimeOpsRegistered(ctx)
	return resolveRootContext(ctx).ops.listCatalog({ carrier: 'rpc' })
}

async function invokeRegisteredRuntimeOp<O>(
	ctx: Context,
	id: string,
	input: unknown,
	source: RuntimeOpSource['kind'] = 'rpc',
): Promise<OpResult<O>> {
	ensureRuntimeOpsRegistered(ctx)
	return await resolveRootContext(ctx).ops.invoke<O>(id, input, {
		source: { kind: source },
	})
}

async function dispatchRegisteredRuntimeCommand<O>(
	ctx: Context,
	command: string,
	source: RuntimeOpSource['kind'] = 'cli',
): Promise<OpResult<O>> {
	ensureRuntimeOpsRegistered(ctx)
	return await resolveRootContext(ctx).ops.dispatch<O>(command, {
		source: { kind: source },
	})
}

const runtimeOps = Object.freeze([
	...pluginStatusOps,
	...pluginDependencyOps,
	...pluginConfigOps,
])

export function ensureRuntimeOpsRegistered(ctx: Context): void {
	const root = resolveRootContext(ctx)

	const ops = root.ops
	for (const op of runtimeOps) {
		if (ops.get(op.id)) continue
		ops.register(op, { owner: RUNTIME_OPS_OWNER })
	}
}

export function getRuntimeOpsCatalog(ctx: Context): RuntimeOpCatalogEntry[] {
	return listRegisteredRuntimeOpsCatalog(ctx)
}

export async function invokeRuntimeOp<O>(
	ctx: Context,
	id: string,
	input: unknown,
	source: RuntimeOpSource['kind'] = 'rpc',
): Promise<OpResult<O>> {
	return await invokeRegisteredRuntimeOp(ctx, id, input, source)
}

export async function dispatchRuntimeCommand<O>(
	ctx: Context,
	command: string,
	source: RuntimeOpSource['kind'] = 'cli',
): Promise<OpResult<O>> {
	return await dispatchRegisteredRuntimeCommand(ctx, command, source)
}
