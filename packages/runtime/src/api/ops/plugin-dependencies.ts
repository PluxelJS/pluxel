import { typebox } from '@pluxel/ops'

import type { RuntimeOperation } from '../../services/plugin-interaction/OpsService'
import {
	inspectPluginBaseProvider,
	pluginBaseProviderSet,
	pluginDependencySetTarget,
	inspectPluginDependencies,
	listPluginDependencies,
} from '../usecases/pluginDependencies'
import { ensureFork } from '../usecases/pluginForks'
import { defineRuntimeOp } from './helpers'
import {
	baseProviderInfoSchema,
	ensureForkResultSchema,
	pluginDependencyMutationResultSchema,
	pluginDependencyRefSchema,
	pluginDependencyStateSchema,
	pluginNameSchema,
} from './schemas'

const pluginDependenciesListOp = defineRuntimeOp({
	id: 'plugin.dependencies.list',
	doc: {
		title: 'List Plugin Dependencies',
		description: 'List declared plugin dependencies for dependency planning.',
	},
	input: typebox.obj({
		name: pluginNameSchema,
	}),
	output: typebox.Type.Array(pluginDependencyRefSchema),
	exposure: { rpc: true },
	policy: { idempotent: true },
	tool: true,
	cli: {
		triggers: ['plugin dependencies list'],
	},
	async execute(input, opCtx) {
		return listPluginDependencies(opCtx.runtime, input.name)
	},
})

const pluginDependenciesInspectOp = defineRuntimeOp({
	id: 'plugin.dependencies.inspect',
	doc: {
		title: 'Inspect Plugin Dependencies',
		description:
			'Inspect dependency injection state for one plugin, including base and forkable override options.',
	},
	input: typebox.obj({
		name: pluginNameSchema,
	}),
	output: typebox.Type.Array(pluginDependencyStateSchema),
	exposure: { rpc: true },
	policy: { idempotent: true },
	tool: true,
	cli: {
		triggers: ['plugin dependencies inspect'],
	},
	async execute(input, opCtx) {
		return inspectPluginDependencies(opCtx.runtime, input.name)
	},
})

const pluginDependenciesSetTargetOp = defineRuntimeOp({
	id: 'plugin.dependencies.set-target',
	doc: {
		title: 'Set Plugin Dependency Target',
		description: 'Override one dependency slot to a specific plugin or clear the override.',
	},
	input: typebox.obj({
		name: pluginNameSchema,
		index: typebox.Type.Number({
			minimum: 0,
			description: 'Dependency slot index to override.',
		}),
		targetName: typebox.Type.Union([typebox.Type.String(), typebox.Type.Null()], {
			description: 'Plugin name to bind, or null to clear the override.',
		}),
	}),
	output: pluginDependencyMutationResultSchema,
	exposure: { rpc: true },
	policy: { mutating: true, audit: ['plugin-dependencies'] },
	tool: true,
	async execute(input, opCtx) {
		return await pluginDependencySetTarget(
			opCtx.runtime,
			input.name,
			input.index,
			input.targetName,
		)
	},
})

const pluginBaseProviderInspectOp = defineRuntimeOp({
	id: 'plugin.base-provider.inspect',
	doc: {
		title: 'Inspect Plugin Base Provider',
		description: 'Read the current global provider mapping for the plugin base token, if any.',
	},
	input: typebox.obj({
		name: pluginNameSchema,
	}),
	output: baseProviderInfoSchema,
	exposure: { rpc: true },
	policy: { idempotent: true },
	tool: true,
	cli: {
		triggers: ['plugin base-provider inspect'],
	},
	async execute(input, opCtx) {
		return inspectPluginBaseProvider(opCtx.runtime, input.name)
	},
})

const pluginBaseProviderSelectOp = defineRuntimeOp({
	id: 'plugin.base-provider.select',
	doc: {
		title: 'Select Plugin Base Provider',
		description: 'Set or clear the global default provider for a base token.',
	},
	input: typebox.obj({
		name: pluginNameSchema,
		baseToken: typebox.Type.String({
			minLength: 1,
			description: 'Base token to mutate.',
		}),
		providerName: typebox.Type.Union([typebox.Type.String(), typebox.Type.Null()], {
			description: 'Default provider plugin name, or null to clear it.',
		}),
	}),
	output: pluginDependencyMutationResultSchema,
	exposure: { rpc: true },
	policy: { mutating: true, audit: ['plugin-dependencies'] },
	tool: true,
	async execute(input, opCtx) {
		return await pluginBaseProviderSet(
			opCtx.runtime,
			input.name,
			input.baseToken,
			input.providerName,
		)
	},
})

const pluginForkEnsureOp = defineRuntimeOp({
	id: 'plugin.fork.ensure',
	doc: {
		title: 'Ensure Plugin Fork',
		description: 'Ensure a fork exists for a forkable plugin and optionally enable it.',
	},
	input: typebox.obj({
		baseName: typebox.Type.String({
			minLength: 1,
			description: 'Forkable base plugin name.',
		}),
		forkId: typebox.Type.String({
			minLength: 1,
			description: 'Stable fork identifier.',
		}),
		enable: typebox.Type.Optional(
			typebox.Type.Boolean({
				description: 'Whether to enable the fork after ensuring it exists.',
			}),
		),
	}),
	output: ensureForkResultSchema,
	exposure: { rpc: true },
	policy: { mutating: true, audit: ['plugin-dependencies'] },
	tool: true,
	cli: {
		triggers: ['plugin fork ensure'],
	},
	async execute(input, opCtx) {
		return await ensureFork(opCtx.runtime, input.baseName, input.forkId, {
			enable: input.enable,
		})
	},
})

export const pluginDependencyOps: readonly RuntimeOperation[] = Object.freeze([
	pluginDependenciesListOp,
	pluginDependenciesInspectOp,
	pluginDependenciesSetTargetOp,
	pluginBaseProviderInspectOp,
	pluginBaseProviderSelectOp,
	pluginForkEnsureOp,
])
