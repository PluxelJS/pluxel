import { cli, typebox } from '@pluxel/ops'

import type { RuntimeOperation } from '../../services/ops/OpsService'
import { applyStatusActions } from '../usecases/pluginStatus'
import { pluginStatus, pluginsList } from '../usecases/plugins'
import { pluginWaitForStage } from '../usecases/pluginWait'
import { defineRuntimeOp } from './helpers'
import {
	emptyInputSchema,
	pluginActionSchema,
	pluginNameSchema,
	pluginStatusBatchOutputSchema,
	pluginStatusOutputSchema,
	pluginStatusSnapshotSchema,
} from './schemas'

const pluginsListOp = defineRuntimeOp({
	id: 'plugins.list',
	doc: {
		title: 'List Plugins',
		description:
			'List registered plugins with current running/enabled state. This is the canonical read API for plugin inventory.',
	},
	input: emptyInputSchema,
	output: typebox.obj({
		plugins: typebox.Type.Array(pluginStatusSnapshotSchema),
		summary: typebox.obj({
			total: typebox.Type.Number(),
			running: typebox.Type.Number(),
			stopped: typebox.Type.Number(),
			disabled: typebox.Type.Number(),
		}),
	}),
	exposure: { rpc: true },
	policy: { idempotent: true },
	tool: true,
	cli: {
		triggers: ['plugins list'],
	},
	async execute(_input, opCtx) {
		return pluginsList(opCtx.runtime)
	},
})

const pluginStatusGetOp = defineRuntimeOp({
	id: 'plugin.status',
	doc: {
		title: 'Get Plugin Status',
		description: 'Read a single plugin lifecycle snapshot by name.',
	},
	input: typebox.obj({
		name: pluginNameSchema,
	}),
	output: pluginStatusOutputSchema,
	exposure: { rpc: true },
	policy: { idempotent: true },
	tool: true,
	cli: {
		triggers: ['plugin status'],
	},
	async execute(input, opCtx) {
		const status = pluginStatus(opCtx.runtime, input.name)
		if (!status) {
			return {
				ok: false as const,
				code: 'plugin_not_found',
				message: `Plugin not found: ${input.name}`,
			}
		}
		return {
			ok: true as const,
			status,
		}
	},
})

const pluginsStatusApplyOp = defineRuntimeOp({
	id: 'plugins.status.apply',
	doc: {
		title: 'Apply Plugin Status Actions',
		description:
			'Apply one or more start/stop/restart/enable/disable actions in order, then perform one registry commit at the end.',
	},
	input: typebox.obj({
		actions: typebox.Type.Array(
			typebox.obj({
				name: pluginNameSchema,
				action: pluginActionSchema,
			}),
			{ minItems: 1, description: 'Ordered lifecycle actions to apply.' },
		),
	}),
	output: pluginStatusBatchOutputSchema,
	exposure: { rpc: true },
	policy: { mutating: true, audit: ['plugin-status'] },
	tool: true,
	cli: {
		triggers: ['plugins status apply'],
		tail: cli.tail.json('actions'),
	},
	async execute(input, opCtx) {
		return await applyStatusActions(opCtx.runtime, input.actions)
	},
})

function createSingleStatusActionOp(action: 'start' | 'stop' | 'restart' | 'enable' | 'disable') {
	return defineRuntimeOp({
		id: `plugin.${action}`,
		doc: {
			title: `${action[0]!.toUpperCase()}${action.slice(1)} Plugin`,
			description: `${action[0]!.toUpperCase()}${action.slice(1)} one plugin by name.`,
		},
		input: typebox.obj({
			name: pluginNameSchema,
		}),
		output: typebox.obj({
			ok: typebox.Type.Boolean(),
			name: typebox.Type.String(),
			error: typebox.Type.Optional(typebox.Type.String()),
			commitError: typebox.Type.Optional(typebox.Type.String()),
		}),
		exposure: { rpc: true },
		policy: { mutating: true, audit: ['plugin-status'] },
		tool: true,
		cli: {
			triggers: [`plugin ${action}`],
		},
		async execute(input, opCtx) {
			const batch = await applyStatusActions(opCtx.runtime, [{ name: input.name, action }])
			const first = batch.results[0]
			if (!batch.ok) {
				const error =
					typeof first?.error === 'string'
						? first.error
						: batch.commitError ?? `${action} failed`
				return {
					ok: false,
					name: input.name,
					error,
					...(batch.commitError ? { commitError: batch.commitError } : {}),
				}
			}
			return {
				ok: Boolean(first?.ok),
				name: input.name,
				...(typeof first?.error === 'string' ? { error: first.error } : {}),
			}
		},
	})
}

const pluginWaitForStageOp = defineRuntimeOp({
	id: 'plugin.wait-for-stage',
	doc: {
		title: 'Wait For Plugin Stage',
		description: 'Poll until a plugin reaches the requested lifecycle stage or timeout.',
	},
	input: typebox.obj({
		name: pluginNameSchema,
		stage: typebox.Type.String({
			minLength: 1,
			description: 'Lifecycle stage to wait for.',
		}),
		timeoutMs: typebox.Type.Optional(
			typebox.Type.Number({
				minimum: 0,
				description: 'Maximum wait time in milliseconds.',
			}),
		),
		pollMs: typebox.Type.Optional(
			typebox.Type.Number({
				minimum: 20,
				description: 'Polling interval in milliseconds.',
			}),
		),
	}),
	output: typebox.Type.Union([
		typebox.obj({
			ok: typebox.Type.Literal(true),
			name: typebox.Type.String(),
			stage: typebox.Type.String(),
			status: pluginStatusSnapshotSchema,
		}),
		typebox.obj({
			ok: typebox.Type.Literal(false),
			name: typebox.Type.String(),
			stage: typebox.Type.String(),
			code: typebox.Type.String(),
			message: typebox.Type.String(),
			last: typebox.Type.Optional(pluginStatusSnapshotSchema),
		}),
	]),
	exposure: { rpc: true },
	policy: { idempotent: true },
	tool: true,
	cli: {
		triggers: ['plugin wait'],
	},
	async execute(input, opCtx) {
		return await pluginWaitForStage(opCtx.runtime, input)
	},
})

export const pluginStatusOps: readonly RuntimeOperation[] = Object.freeze([
	pluginsListOp,
	pluginStatusGetOp,
	pluginsStatusApplyOp,
	createSingleStatusActionOp('start'),
	createSingleStatusActionOp('stop'),
	createSingleStatusActionOp('restart'),
	createSingleStatusActionOp('enable'),
	createSingleStatusActionOp('disable'),
	pluginWaitForStageOp,
])
