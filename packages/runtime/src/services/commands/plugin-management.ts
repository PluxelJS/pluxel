import { CommandError, defineCommand, type AnyCommand } from '@pluxel/commands'
import { Type, obj } from '@pluxel/commands/typebox'
import { formatPluginNodeReference, type Context, type PluginNodeAddress } from '@pluxel/core'
import { applyStatusActions } from '../../api/usecases/pluginStatus'
import { pluginStatus, pluginsList, type PluginStatusSnapshot } from '../../api/usecases/plugins'
import type { PluginStatusAction } from '../../web/protocol'

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

const pluginSource = Type.Union([
	obj({
		kind: Type.Literal('package'),
		moduleId: Type.String(),
		packageName: Type.String(),
		version: Type.Union([Type.String(), Type.Null()]),
		tag: Type.Union([Type.String(), Type.Null()]),
	}),
	obj({
		kind: Type.Literal('hmr'),
		moduleId: Type.String(),
		packageName: Type.Null(),
		version: Type.Null(),
		tag: Type.Null(),
	}),
	obj({
		kind: Type.Literal('unknown'),
		moduleId: Type.Null(),
		packageName: Type.Null(),
		version: Type.Null(),
		tag: Type.Null(),
	}),
])

const pluginSnapshot = obj({
	address: pluginNodeAddress,
	reference: Type.String(),
	route: Type.String(),
	label: obj({
		title: Type.String(),
		qualifier: Type.Optional(Type.String()),
		text: Type.String(),
	}),
	displayName: Type.String(),
	rootExportName: Type.String(),
	isRunning: Type.Boolean(),
	isEnabled: Type.Boolean(),
	lifecycleStage: Type.Union([
		Type.Literal('running'),
		Type.Literal('stopped'),
		Type.Literal('disabled'),
	]),
	source: pluginSource,
})

const pluginsOutput = obj({
	plugins: Type.Array(pluginSnapshot),
	summary: obj({
		total: Type.Integer({ minimum: 0 }),
		running: Type.Integer({ minimum: 0 }),
		stopped: Type.Integer({ minimum: 0 }),
		disabled: Type.Integer({ minimum: 0 }),
	}),
})

function requirePlugin(ctx: Context, address: PluginNodeAddress): PluginStatusSnapshot {
	const snapshot = pluginStatus(ctx, address)
	if (snapshot) return snapshot
	throw new CommandError('INPUT_VALIDATION', 'Plugin was not found', {
		message: `Plugin not found: ${formatPluginNodeReference(address)}`,
		details: {
			issues: [{ path: ['address'], code: 'plugin_not_found', message: 'Plugin was not found' }],
		},
	})
}

async function mutatePlugin(
	ctx: Context,
	address: PluginNodeAddress,
	action: PluginStatusAction,
): Promise<PluginStatusSnapshot> {
	const result = await applyStatusActions(ctx, [{ address, action }])
	const mutation = result.results[0]
	if (mutation?.ok) return requirePlugin(ctx, address)

	if (mutation?.code === 'plugin_not_found') return requirePlugin(ctx, address)
	const causeCode =
		mutation?.code ?? (result.commitError ? 'commit_failed' : 'plugin_operation_failed')
	throw new CommandError('DEPENDENCY', 'Plugin operation failed', {
		message:
			mutation?.error ??
			result.commitError ??
			`Plugin ${action} failed: ${formatPluginNodeReference(address)}`,
		details: {
			service: 'pluginLifecycle',
			command: `plugin.${action}`,
			retryable: action !== 'stop',
			causeCode,
		},
	})
}

function mutationCommand(ctx: Context, action: 'start' | 'stop' | 'restart'): AnyCommand {
	const label = action[0]!.toUpperCase() + action.slice(1)
	return defineCommand({
		name: `plugin.${action}`,
		title: `${label} plugin`,
		description: `${label} one plugin through the runtime lifecycle.`,
		behavior: {
			kind: 'mutation',
			destructive: false,
			idempotent: action !== 'restart',
			world: 'open',
		},
		input: pluginAddressInput,
		output: pluginSnapshot,
		execute: ({ address }) => mutatePlugin(ctx, address, action),
	})
}

export function createPluginManagementCommands(ctx: Context): readonly AnyCommand[] {
	return [
		defineCommand({
			name: 'plugin.list',
			title: 'List plugins',
			description: 'List plugins known to this runtime and their current lifecycle status.',
			behavior: { kind: 'query', world: 'closed' },
			input: obj({}),
			output: pluginsOutput,
			execute: () => pluginsList(ctx),
		}),
		defineCommand({
			name: 'plugin.status.get',
			title: 'Get plugin status',
			description: 'Read the current lifecycle status of one plugin.',
			behavior: { kind: 'query', world: 'closed' },
			input: pluginAddressInput,
			output: pluginSnapshot,
			execute: ({ address }) => requirePlugin(ctx, address),
		}),
		mutationCommand(ctx, 'start'),
		mutationCommand(ctx, 'stop'),
		mutationCommand(ctx, 'restart'),
	]
}
