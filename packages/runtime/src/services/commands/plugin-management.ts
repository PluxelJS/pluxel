import { CommandError, defineCommand, type AnyCommand } from '@pluxel/commands'
import { Type, obj } from '@pluxel/commands/typebox'
import type { Context } from '@pluxel/core'
import { applyStatusActions } from '../../api/usecases/pluginStatus'
import { pluginStatus, pluginsList, type PluginStatusSnapshot } from '../../api/usecases/plugins'
import type { PluginStatusAction } from '../../web/protocol'

const pluginNameInput = obj({
	name: Type.String({ minLength: 1, description: 'Canonical plugin name.' }),
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
	name: Type.String(),
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

function requirePlugin(ctx: Context, name: string): PluginStatusSnapshot {
	const snapshot = pluginStatus(ctx, name)
	if (snapshot) return snapshot
	throw new CommandError('INPUT_VALIDATION', 'Plugin was not found', {
		message: `Plugin not found: ${name}`,
		details: {
			issues: [{ path: ['name'], code: 'plugin_not_found', message: 'Plugin was not found' }],
		},
	})
}

async function mutatePlugin(
	ctx: Context,
	name: string,
	action: PluginStatusAction,
): Promise<PluginStatusSnapshot> {
	const result = await applyStatusActions(ctx, [{ name, action }])
	const mutation = result.results[0]
	if (mutation?.ok) return requirePlugin(ctx, name)

	if (mutation?.code === 'plugin_not_found') return requirePlugin(ctx, name)
	const causeCode =
		mutation?.code ?? (result.commitError ? 'commit_failed' : 'plugin_operation_failed')
	throw new CommandError('DEPENDENCY', 'Plugin operation failed', {
		message: mutation?.error ?? result.commitError ?? `Plugin ${action} failed: ${name}`,
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
		input: pluginNameInput,
		output: pluginSnapshot,
		execute: ({ name }) => mutatePlugin(ctx, name, action),
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
			input: pluginNameInput,
			output: pluginSnapshot,
			execute: ({ name }) => requirePlugin(ctx, name),
		}),
		mutationCommand(ctx, 'start'),
		mutationCommand(ctx, 'stop'),
		mutationCommand(ctx, 'restart'),
	]
}
