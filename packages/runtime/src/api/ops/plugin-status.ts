import { cli } from '@pluxel/ops'
import { Type, obj } from '@pluxel/ops/typebox'

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
	output: obj({
		plugins: Type.Array(pluginStatusSnapshotSchema),
		summary: obj({
			total: Type.Number(),
			running: Type.Number(),
			stopped: Type.Number(),
			disabled: Type.Number(),
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
	input: obj({
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
	input: obj({
		actions: Type.Array(
			obj({
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
		input: obj({
			name: pluginNameSchema,
		}),
		output: obj({
			ok: Type.Boolean(),
			name: Type.String(),
			error: Type.Optional(Type.String()),
			commitError: Type.Optional(Type.String()),
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
					typeof first?.error === 'string' ? first.error : (batch.commitError ?? `${action} failed`)
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
	input: obj({
		name: pluginNameSchema,
		stage: Type.String({
			minLength: 1,
			description: 'Lifecycle stage to wait for.',
		}),
		timeoutMs: Type.Optional(
			Type.Number({
				minimum: 0,
				description: 'Maximum wait time in milliseconds.',
			}),
		),
		pollMs: Type.Optional(
			Type.Number({
				minimum: 20,
				description: 'Polling interval in milliseconds.',
			}),
		),
	}),
	output: Type.Union([
		obj({
			ok: Type.Literal(true),
			name: Type.String(),
			stage: Type.String(),
			status: pluginStatusSnapshotSchema,
		}),
		obj({
			ok: Type.Literal(false),
			name: Type.String(),
			stage: Type.String(),
			code: Type.String(),
			message: Type.String(),
			last: Type.Optional(pluginStatusSnapshotSchema),
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
