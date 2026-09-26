import { defineHostService } from '@pluxel/host'
import { Commands } from '../commands'
import { defineCommand, Result, type AnyCommand, type CommandFailure } from '@pluxel/commands'
import { Type, obj } from '@pluxel/commands/typebox'
import { formatPluginNodeReference, type Context, type PluginNodeAddress } from '@pluxel/core'
import { applyLifecycleCommands, setAutoStart } from './api/usecases/pluginStatus'
import { pluginStatus, pluginStatusOverview } from './api/usecases/plugins'
import type { PluginLifecycleCommand, PluginStatusSnapshot } from './web/protocol'

const pluginEntryAddress = Type.Union([
	obj({
		kind: Type.Literal('package-root'),
		packageName: Type.String({ minLength: 1 }),
	}),
	obj({
		kind: Type.Literal('source-entry'),
		sourceSpace: Type.String({ minLength: 1 }),
		path: Type.String({ minLength: 1 }),
	}),
])

const pluginDefinitionAddress = obj({
	entry: pluginEntryAddress,
	exportName: Type.String({ minLength: 1 }),
})

const pluginNodeAddress = Type.Union([
	obj({
		definition: pluginDefinitionAddress,
		variant: Type.Literal('default'),
	}),
	obj({
		definition: pluginDefinitionAddress,
		variant: Type.Literal('fork'),
		forkId: Type.String({ minLength: 1 }),
	}),
])

const pluginAddressInput = obj({
	address: pluginNodeAddress,
})

function mutableUpdateBatch(batch: NonNullable<PluginStatusSnapshot['recentUpdate']>['batch']) {
	const { error, ...result } = batch
	return {
		...result,
		...(error ? { error: { ...error, importChain: [...error.importChain] } } : {}),
	}
}

function mutablePluginSnapshot(snapshot: PluginStatusSnapshot) {
	return {
		...snapshot,
		recentUpdate: snapshot.recentUpdate
			? {
					batch: mutableUpdateBatch(snapshot.recentUpdate.batch),
					lifecycle: snapshot.recentUpdate.lifecycle
						? { issues: snapshot.recentUpdate.lifecycle.issues.map((issue) => ({ ...issue })) }
						: null,
				}
			: null,
		issues: snapshot.issues.map((issue) => ({ ...issue })),
	}
}

function mutablePluginsOutput(output: import('./api/usecases/plugins').PluginStatusOverview) {
	return {
		plugins: output.plugins.map(mutablePluginSnapshot),
		summary: { ...output.summary },
	}
}

async function requirePlugin(
	ctx: Context,
	address: PluginNodeAddress,
): Promise<Result<PluginStatusSnapshot, CommandFailure>> {
	const snapshot = await pluginStatus(ctx, address)
	if (snapshot) return Result.ok(snapshot)
	return Result.err({
		code: 'REJECTED',
		reason: 'plugin_not_found',
		message: `Plugin not found: ${formatPluginNodeReference(address)}`,
	})
}

async function updatedPlugin(ctx: Context, address: PluginNodeAddress) {
	const snapshot = await requirePlugin(ctx, address)
	return snapshot.isErr() ? snapshot : Result.ok(mutablePluginSnapshot(snapshot.value))
}

async function mutatePlugin(
	ctx: Context,
	address: PluginNodeAddress,
	action: PluginLifecycleCommand,
) {
	const result = await applyLifecycleCommands(ctx, [{ address, command: action }])
	const mutation = result.results[0]
	if (!mutation) throw new Error('[runtime:commands] status mutation omitted its result')
	if (mutation.ok === true) return updatedPlugin(ctx, address)
	if (mutation.code === 'plugin_not_found') return updatedPlugin(ctx, address)
	return Result.err({
		code: 'DEPENDENCY',
		message: mutation.error ?? `Plugin ${action} failed: ${formatPluginNodeReference(address)}`,
		cause: mutation,
	} satisfies CommandFailure)
}

function lifecycleCommand(ctx: Context, action: PluginLifecycleCommand): AnyCommand {
	const label = action[0]!.toUpperCase() + action.slice(1)
	return defineCommand({
		name: `plugin.${action}`,
		description: `${label} one plugin through the runtime lifecycle.`,
		input: pluginAddressInput,
		execute: ({ address }) => mutatePlugin(ctx, address, action),
	})
}

function autoStartCommand(ctx: Context): AnyCommand {
	return defineCommand({
		name: 'plugin.auto-start.set',
		description: 'Set durable cold-boot policy without changing this process session.',
		input: obj({ address: pluginNodeAddress, autoStart: Type.Boolean() }),
		async execute({ address, autoStart }) {
			const result = await setAutoStart(ctx, [{ address, autoStart }])
			const mutation = result.results[0]
			if (!mutation) throw new Error('[runtime:commands] auto-start mutation omitted its result')
			if (mutation.ok === true) {
				return updatedPlugin(ctx, address)
			}
			if (mutation.code === 'plugin_not_found') {
				return updatedPlugin(ctx, address)
			}
			return Result.err({
				code: 'DEPENDENCY',
				message:
					mutation.error ??
					`Plugin auto-start update failed: ${formatPluginNodeReference(address)}`,
				cause: mutation,
			} satisfies CommandFailure)
		},
	})
}

function createPluginManagementCommands(ctx: Context): readonly AnyCommand[] {
	return [
		defineCommand({
			name: 'plugin.list',
			description: 'List plugins known to this runtime and their current lifecycle status.',
			input: obj({}),
			execute: async () => Result.ok(mutablePluginsOutput(await pluginStatusOverview(ctx))),
		}),
		defineCommand({
			name: 'plugin.status.get',
			description: 'Read the current lifecycle status of one plugin.',
			input: pluginAddressInput,
			execute: ({ address }) => updatedPlugin(ctx, address),
		}),
		autoStartCommand(ctx),
		lifecycleCommand(ctx, 'start'),
		lifecycleCommand(ctx, 'stop'),
		lifecycleCommand(ctx, 'restart'),
	]
}

/** Publish Host inspection and lifecycle commands into an explicitly installed command catalog. */
export function managementCommands() {
	return defineHostService({
		name: 'Management commands',
		requires: { commands: Commands },
		capabilities: [],
		prepare({ ctx }) {
			const catalog = ctx.require(Commands)
			for (const command of createPluginManagementCommands(ctx)) catalog.register(command)
		},
	})
}
