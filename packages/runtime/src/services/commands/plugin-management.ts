import { CommandError, defineCommand, type AnyCommand } from '@pluxel/commands'
import { Type, obj } from '@pluxel/commands/typebox'
import { formatPluginNodeReference, type Context, type PluginNodeAddress } from '@pluxel/core'
import { applyLifecycleCommands, setAutoStart } from '../../api/usecases/pluginStatus'
import { pluginStatus, pluginStatusOverview } from '../../api/usecases/plugins'
import type { PluginLifecycleCommand, PluginStatusSnapshot } from '../../web/protocol'

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
	autoStart: Type.Boolean(),
	sessionIntent: Type.Union([Type.Literal('inherit'), Type.Literal('run'), Type.Literal('stop')]),
	desiredState: Type.Union([Type.Literal('running'), Type.Literal('stopped')]),
	activationReason: Type.Union([
		Type.Literal('auto-start'),
		Type.Literal('session'),
		Type.Literal('dependency'),
		Type.Null(),
	]),
	lifecycleState: Type.Union([Type.Literal('running'), Type.Literal('stopped')]),
	availability: Type.Union([Type.Literal('available'), Type.Literal('unavailable')]),
	issues: Type.Array(
		obj({
			id: Type.String(),
			code: Type.Union([
				Type.Literal('consumer_unavailable'),
				Type.Literal('requirement_removed'),
				Type.Literal('provider_unavailable'),
				Type.Literal('provider_incompatible'),
				Type.Literal('fork_not_allowed'),
				Type.Literal('fork_default_forbidden'),
				Type.Literal('provider_default_requires_abstract'),
				Type.Literal('explicit_binding_invalid'),
				Type.Literal('missing_required_provider'),
				Type.Literal('definition_unavailable'),
			]),
			message: Type.String(),
		}),
	),
	source: pluginSource,
})

const pluginsOutput = obj({
	plugins: Type.Array(pluginSnapshot),
	summary: obj({
		total: Type.Integer({ minimum: 0 }),
		running: Type.Integer({ minimum: 0 }),
		stopped: Type.Integer({ minimum: 0 }),
		autoStart: Type.Integer({ minimum: 0 }),
	}),
})

function mutablePluginSnapshot(snapshot: PluginStatusSnapshot) {
	return {
		...snapshot,
		issues: snapshot.issues.map((issue) => ({ ...issue })),
	}
}

function mutablePluginsOutput(output: import('../../api/usecases/plugins').PluginStatusOverview) {
	return {
		plugins: output.plugins.map(mutablePluginSnapshot),
		summary: { ...output.summary },
	}
}

async function requirePlugin(
	ctx: Context,
	address: PluginNodeAddress,
): Promise<PluginStatusSnapshot> {
	const snapshot = await pluginStatus(ctx, address)
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
	action: PluginLifecycleCommand,
): Promise<ReturnType<typeof mutablePluginSnapshot>> {
	const result = await applyLifecycleCommands(ctx, [{ address, command: action }])
	const mutation = result.results[0]
	if (!mutation) {
		throw new Error('[runtime:commands] status mutation omitted its result')
	}
	if (mutation?.ok === true) return mutablePluginSnapshot(await requirePlugin(ctx, address))

	if (mutation?.code === 'plugin_not_found') {
		return mutablePluginSnapshot(await requirePlugin(ctx, address))
	}
	throw new CommandError('DEPENDENCY', 'Plugin operation failed', {
		message: mutation.error ?? `Plugin ${action} failed: ${formatPluginNodeReference(address)}`,
		details: {
			service: 'pluginLifecycle',
			command: `plugin.${action}`,
			retryable: action !== 'stop',
			causeCode: mutation.code,
		},
	})
}

function lifecycleCommand(ctx: Context, action: PluginLifecycleCommand): AnyCommand {
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

function autoStartCommand(ctx: Context): AnyCommand {
	return defineCommand({
		name: 'plugin.auto-start.set',
		title: 'Set plugin auto-start',
		description: 'Set durable cold-boot policy without changing this process session.',
		behavior: {
			kind: 'mutation',
			destructive: false,
			idempotent: true,
			world: 'open',
		},
		input: obj({ address: pluginNodeAddress, autoStart: Type.Boolean() }),
		output: pluginSnapshot,
		async execute({ address, autoStart }) {
			const result = await setAutoStart(ctx, [{ address, autoStart }])
			const mutation = result.results[0]
			if (mutation?.ok === true) return mutablePluginSnapshot(await requirePlugin(ctx, address))
			if (mutation?.code === 'plugin_not_found') {
				return mutablePluginSnapshot(await requirePlugin(ctx, address))
			}
			throw new CommandError('DEPENDENCY', 'Plugin auto-start update failed', {
				message:
					mutation?.error ??
					`Plugin auto-start update failed: ${formatPluginNodeReference(address)}`,
				details: {
					service: 'pluginLifecycle',
					command: 'plugin.auto-start.set',
					retryable: true,
					causeCode: mutation?.code,
				},
			})
		},
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
			execute: async () => mutablePluginsOutput(await pluginStatusOverview(ctx)),
		}),
		defineCommand({
			name: 'plugin.status.get',
			title: 'Get plugin status',
			description: 'Read the current lifecycle status of one plugin.',
			behavior: { kind: 'query', world: 'closed' },
			input: pluginAddressInput,
			output: pluginSnapshot,
			execute: async ({ address }) => mutablePluginSnapshot(await requirePlugin(ctx, address)),
		}),
		autoStartCommand(ctx),
		lifecycleCommand(ctx, 'start'),
		lifecycleCommand(ctx, 'stop'),
		lifecycleCommand(ctx, 'restart'),
	]
}
