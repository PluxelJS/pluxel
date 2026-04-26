import { cli } from '@pluxel/ops'
import { Type, obj } from '@pluxel/ops/typebox'

import type { RuntimeOperation } from '../../services/ops/OpsService'
import {
	pluginConfigGet,
	pluginConfigPatch,
	pluginConfigPatchField,
	pluginConfigReset,
	pluginConfigValidate,
	pluginSchema,
} from '../usecases/pluginConfig'
import { defineRuntimeOp, messageOf, runConfigBatch } from './helpers'
import {
	configBatchResultSchema,
	configFieldEntrySchema,
	configPatchEntrySchema,
	configResetEntrySchema,
	configResultSchema,
	pluginNameSchema,
	schemaResultSchema,
} from './schemas'

function configInternalError(error: unknown) {
	return {
		ok: false as const,
		code: 'internal_error',
		message: messageOf(error),
	}
}

const pluginSchemaGetOp = defineRuntimeOp({
	id: 'plugin.schema',
	doc: {
		title: 'Get Plugin Schema',
		description: 'Read plugin config schema source and defaults.',
	},
	input: obj({
		name: pluginNameSchema,
	}),
	output: schemaResultSchema,
	exposure: { rpc: true },
	policy: { idempotent: true },
	tool: true,
	cli: {
		triggers: ['plugin schema'],
	},
	async execute(input, opCtx) {
		return await pluginSchema(opCtx.runtime, input.name)
	},
})

const pluginConfigGetOp = defineRuntimeOp({
	id: 'plugin.config.get',
	doc: {
		title: 'Get Plugin Config',
		description: 'Read saved config and defaults for one plugin.',
	},
	input: obj({
		name: pluginNameSchema,
	}),
	output: configResultSchema,
	exposure: { rpc: true },
	policy: { idempotent: true },
	tool: true,
	cli: {
		triggers: ['plugin config get'],
	},
	async execute(input, opCtx) {
		return await pluginConfigGet(opCtx.runtime, input.name)
	},
})

const pluginsConfigGetOp = defineRuntimeOp({
	id: 'plugins.config.get',
	doc: {
		title: 'Get Plugin Configs',
		description:
			'Read saved config for multiple plugins in one call. Results preserve input order.',
	},
	input: obj({
		names: Type.Array(pluginNameSchema, {
			minItems: 1,
			description: 'Plugin names to load in order.',
		}),
	}),
	output: configBatchResultSchema,
	exposure: { rpc: true },
	policy: { idempotent: true },
	tool: true,
	cli: {
		triggers: ['plugins config get'],
		tail: cli.tail.json('names'),
	},
	async execute(input, opCtx) {
		return await runConfigBatch(
			input.names.map((name) => ({ name })),
			async (entry) => await pluginConfigGet(opCtx.runtime, entry.name),
			(_entry, error) => configInternalError(error),
		)
	},
})

const pluginConfigValidateOp = defineRuntimeOp({
	id: 'plugin.config.validate',
	doc: {
		title: 'Validate Plugin Config',
		description: 'Validate a patch for one plugin without saving it.',
	},
	input: obj({
		name: pluginNameSchema,
		patch: Type.Record(Type.String(), Type.Unknown(), {
			description: 'Config patch object to validate.',
		}),
	}),
	output: configResultSchema,
	exposure: { rpc: true },
	policy: { idempotent: true },
	tool: true,
	cli: {
		triggers: ['plugin config validate'],
		tail: cli.tail.json('patch'),
	},
	async execute(input, opCtx) {
		return await pluginConfigValidate(opCtx.runtime, input.name, input.patch)
	},
})

const pluginsConfigValidateOp = defineRuntimeOp({
	id: 'plugins.config.validate',
	doc: {
		title: 'Validate Plugin Configs',
		description:
			'Validate config patches for multiple plugins. Entries run in order and do not mutate persisted config.',
	},
	input: obj({
		entries: Type.Array(configPatchEntrySchema, {
			minItems: 1,
			description: 'Ordered config validation entries.',
		}),
	}),
	output: configBatchResultSchema,
	exposure: { rpc: true },
	policy: { idempotent: true },
	tool: true,
	cli: {
		triggers: ['plugins config validate'],
		tail: cli.tail.json('entries'),
	},
	async execute(input, opCtx) {
		return await runConfigBatch(
			input.entries,
			async (entry) => await pluginConfigValidate(opCtx.runtime, entry.name, entry.patch),
			(_entry, error) => configInternalError(error),
		)
	},
})

const pluginConfigPatchOp = defineRuntimeOp({
	id: 'plugin.config.patch',
	doc: {
		title: 'Patch Plugin Config',
		description: 'Validate and persist a config patch for one plugin.',
	},
	input: obj({
		name: pluginNameSchema,
		patch: Type.Record(Type.String(), Type.Unknown(), {
			description: 'Config patch object to persist.',
		}),
	}),
	output: configResultSchema,
	exposure: { rpc: true },
	policy: { mutating: true, audit: ['plugin-config'] },
	tool: true,
	cli: {
		triggers: ['plugin config patch'],
		tail: cli.tail.json('patch'),
	},
	async execute(input, opCtx) {
		return await pluginConfigPatch(opCtx.runtime, input.name, input.patch)
	},
})

const pluginsConfigSetOp = defineRuntimeOp({
	id: 'plugins.config.set',
	doc: {
		title: 'Set Plugin Configs',
		description:
			'Validate and persist config patches for multiple plugins. Entries run in order; there is no cross-plugin rollback.',
	},
	input: obj({
		entries: Type.Array(configPatchEntrySchema, {
			minItems: 1,
			description: 'Ordered config patch entries to persist.',
		}),
	}),
	output: configBatchResultSchema,
	exposure: { rpc: true },
	policy: { mutating: true, audit: ['plugin-config'] },
	tool: true,
	cli: {
		triggers: ['plugins config set'],
		tail: cli.tail.json('entries'),
	},
	async execute(input, opCtx) {
		return await runConfigBatch(
			input.entries,
			async (entry) => await pluginConfigPatch(opCtx.runtime, entry.name, entry.patch),
			(_entry, error) => configInternalError(error),
		)
	},
})

const pluginConfigPatchFieldOp = defineRuntimeOp({
	id: 'plugin.config.patch-field',
	doc: {
		title: 'Patch Plugin Config Field',
		description: 'Mutate a single nested config field and persist the resulting patch.',
	},
	input: obj({
		name: pluginNameSchema,
		schemaKey: Type.String({
			minLength: 1,
			description: 'Top-level config schema key.',
		}),
		fieldPath: Type.String({
			minLength: 1,
			description: 'Dot-path inside the selected schema section.',
		}),
		value: Type.Unknown({
			description: 'Value to write at the target field path.',
		}),
	}),
	output: configResultSchema,
	exposure: { rpc: true },
	policy: { mutating: true, audit: ['plugin-config'] },
	async execute(input, opCtx) {
		return await pluginConfigPatchField(opCtx.runtime, input.name, {
			schemaKey: input.schemaKey,
			fieldPath: input.fieldPath,
			value: input.value,
		})
	},
})

const pluginsConfigPatchFieldOp = defineRuntimeOp({
	id: 'plugins.config.patch-field',
	doc: {
		title: 'Patch Plugin Config Fields',
		description:
			'Mutate one nested field per entry for multiple plugins. Entries run in order; there is no cross-plugin rollback.',
	},
	input: obj({
		entries: Type.Array(configFieldEntrySchema, {
			minItems: 1,
			description: 'Ordered config field mutations.',
		}),
	}),
	output: configBatchResultSchema,
	exposure: { rpc: true },
	policy: { mutating: true, audit: ['plugin-config'] },
	tool: true,
	cli: {
		triggers: ['plugins config patch-field'],
		tail: cli.tail.json('entries'),
	},
	async execute(input, opCtx) {
		return await runConfigBatch(
			input.entries,
			async (entry) =>
				await pluginConfigPatchField(opCtx.runtime, entry.name, {
					schemaKey: entry.schemaKey,
					fieldPath: entry.fieldPath,
					value: entry.value,
				}),
			(_entry, error) => configInternalError(error),
		)
	},
})

const pluginConfigResetOp = defineRuntimeOp({
	id: 'plugin.config.reset',
	doc: {
		title: 'Reset Plugin Config',
		description: 'Reset selected config keys for one plugin, or all keys if omitted.',
	},
	input: obj({
		name: pluginNameSchema,
		keys: Type.Optional(
			Type.Array(Type.String(), {
				description: 'Config keys to reset. Omit to reset all keys.',
			}),
		),
	}),
	output: configResultSchema,
	exposure: { rpc: true },
	policy: { mutating: true, audit: ['plugin-config'] },
	tool: true,
	cli: {
		triggers: ['plugin config reset'],
	},
	async execute(input, opCtx) {
		return await pluginConfigReset(opCtx.runtime, input.name, input.keys)
	},
})

const pluginsConfigResetOp = defineRuntimeOp({
	id: 'plugins.config.reset',
	doc: {
		title: 'Reset Plugin Configs',
		description:
			'Reset selected config keys for multiple plugins. Entries run in order; there is no cross-plugin rollback.',
	},
	input: obj({
		entries: Type.Array(configResetEntrySchema, {
			minItems: 1,
			description: 'Ordered config reset entries.',
		}),
	}),
	output: configBatchResultSchema,
	exposure: { rpc: true },
	policy: { mutating: true, audit: ['plugin-config'] },
	tool: true,
	cli: {
		triggers: ['plugins config reset'],
		tail: cli.tail.json('entries'),
	},
	async execute(input, opCtx) {
		return await runConfigBatch(
			input.entries,
			async (entry) => await pluginConfigReset(opCtx.runtime, entry.name, entry.keys),
			(_entry, error) => configInternalError(error),
		)
	},
})

export const pluginConfigOps: readonly RuntimeOperation[] = Object.freeze([
	pluginSchemaGetOp,
	pluginConfigGetOp,
	pluginsConfigGetOp,
	pluginConfigValidateOp,
	pluginsConfigValidateOp,
	pluginConfigPatchOp,
	pluginsConfigSetOp,
	pluginConfigPatchFieldOp,
	pluginsConfigPatchFieldOp,
	pluginConfigResetOp,
	pluginsConfigResetOp,
])
