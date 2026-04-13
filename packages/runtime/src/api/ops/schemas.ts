import { typebox } from '@pluxel/ops'

export const pluginNameSchema = typebox.Type.String({
	minLength: 1,
	description: 'Plugin name.',
})
export const pluginActionSchema = typebox.Type.Union([
	typebox.Type.Literal('start'),
	typebox.Type.Literal('stop'),
	typebox.Type.Literal('restart'),
	typebox.Type.Literal('enable'),
	typebox.Type.Literal('disable'),
], {
	description: 'Lifecycle action to apply.',
})

export const pluginSourceSchema = typebox.openObj({
	kind: typebox.Type.String(),
	moduleId: typebox.Type.Optional(typebox.Type.Union([typebox.Type.String(), typebox.Type.Null()])),
	packageName: typebox.Type.Optional(typebox.Type.Union([typebox.Type.String(), typebox.Type.Null()])),
	version: typebox.Type.Optional(typebox.Type.Union([typebox.Type.String(), typebox.Type.Null()])),
	tag: typebox.Type.Optional(typebox.Type.Union([typebox.Type.String(), typebox.Type.Null()])),
})

export const pluginStatusSnapshotSchema = typebox.obj({
	name: typebox.Type.String(),
	isRunning: typebox.Type.Boolean(),
	isEnabled: typebox.Type.Boolean(),
	lifecycleStage: typebox.Type.String(),
	source: pluginSourceSchema,
})

export const pluginStatusOutputSchema = typebox.Type.Union([
	typebox.obj({
		ok: typebox.Type.Literal(true),
		status: pluginStatusSnapshotSchema,
	}),
	typebox.obj({
		ok: typebox.Type.Literal(false),
		code: typebox.Type.String(),
		message: typebox.Type.String(),
	}),
])

export const pluginStatusActionResultSchema = typebox.obj({
	name: typebox.Type.String(),
	ok: typebox.Type.Boolean(),
	code: typebox.Type.Optional(typebox.Type.String()),
	error: typebox.Type.Optional(typebox.Type.String()),
	isRunning: typebox.Type.Optional(typebox.Type.Boolean()),
	isEnabled: typebox.Type.Optional(typebox.Type.Boolean()),
	lifecycleStage: typebox.Type.Optional(typebox.Type.String()),
	source: typebox.Type.Optional(pluginSourceSchema),
})

export const pluginDependencyRefSchema = typebox.openObj({
	name: typebox.Type.Optional(typebox.Type.String()),
})

export const pluginDependencyOptionSchema = typebox.obj({
	name: typebox.Type.String(),
	isRunning: typebox.Type.Boolean(),
	isEnabled: typebox.Type.Boolean(),
})

export const pluginDependencyStateSchema = typebox.obj({
	index: typebox.Type.Number(),
	token: typebox.Type.String(),
	kind: typebox.Type.Union([
		typebox.Type.Literal('plugin'),
		typebox.Type.Literal('base'),
		typebox.Type.Literal('forkable'),
	]),
	effective: typebox.Type.String(),
	isRunning: typebox.Type.Boolean(),
	selected: typebox.Type.Union([typebox.Type.String(), typebox.Type.Null()]),
	baseProvider: typebox.Type.Union([typebox.Type.String(), typebox.Type.Null()]),
	options: typebox.Type.Array(pluginDependencyOptionSchema),
})

export const pluginDependencyMutationResultSchema = typebox.obj({
	ok: typebox.Type.Boolean(),
	code: typebox.Type.Optional(typebox.Type.String()),
	error: typebox.Type.Optional(typebox.Type.String()),
})

export const baseProviderInfoSchema = typebox.Type.Union([
	typebox.Type.Null(),
	typebox.obj({
		baseToken: typebox.Type.String(),
		currentDefault: typebox.Type.Union([typebox.Type.String(), typebox.Type.Null()]),
		isDefault: typebox.Type.Boolean(),
		providers: typebox.Type.Array(pluginDependencyOptionSchema),
	}),
])

export const ensureForkResultSchema = typebox.obj({
	ok: typebox.Type.Boolean(),
	forkName: typebox.Type.Optional(typebox.Type.String()),
	code: typebox.Type.Optional(typebox.Type.String()),
	error: typebox.Type.Optional(typebox.Type.String()),
})

export const pluginStatusBatchOutputSchema = typebox.obj({
	ok: typebox.Type.Boolean(),
	results: typebox.Type.Array(pluginStatusActionResultSchema),
	commitError: typebox.Type.Optional(typebox.Type.String()),
})

export const configResultSchema = typebox.Type.Union([
	typebox.obj({
		ok: typebox.Type.Literal(true),
		saved: typebox.Type.Boolean(),
		config: typebox.Type.Record(typebox.Type.String(), typebox.Type.Unknown()),
		defaults: typebox.Type.Record(typebox.Type.String(), typebox.Type.Unknown()),
	}),
	typebox.obj({
		ok: typebox.Type.Literal(false),
		code: typebox.Type.String(),
		message: typebox.Type.String(),
		errors: typebox.Type.Optional(typebox.Type.Unknown()),
		defaults: typebox.Type.Optional(
			typebox.Type.Record(typebox.Type.String(), typebox.Type.Unknown()),
		),
	}),
])

export const configBatchEntrySchema = typebox.obj({
	name: typebox.Type.String(),
	result: configResultSchema,
})

export const configBatchResultSchema = typebox.obj({
	ok: typebox.Type.Boolean(),
	items: typebox.Type.Array(configBatchEntrySchema),
})

export const schemaResultSchema = typebox.Type.Union([
	typebox.obj({
		ok: typebox.Type.Literal(true),
		schemaSource: typebox.Type.Record(typebox.Type.String(), typebox.Type.String()),
		defaults: typebox.Type.Record(typebox.Type.String(), typebox.Type.Unknown()),
		layout: typebox.Type.Optional(
			typebox.Type.Union([typebox.Type.Null(), typebox.Type.Array(typebox.Type.Unknown())]),
		),
	}),
	typebox.obj({
		ok: typebox.Type.Literal(false),
		code: typebox.Type.String(),
		message: typebox.Type.String(),
	}),
])

export const emptyInputSchema = typebox.obj({})

export const configPatchEntrySchema = typebox.obj({
	name: pluginNameSchema,
	patch: typebox.Type.Record(typebox.Type.String(), typebox.Type.Unknown(), {
		description: 'Config patch object to validate or persist.',
	}),
})

export const configResetEntrySchema = typebox.obj({
	name: pluginNameSchema,
	keys: typebox.Type.Optional(typebox.Type.Array(typebox.Type.String(), {
		description: 'Config keys to reset. Omit to reset all keys.',
	})),
})

export const configFieldEntrySchema = typebox.obj({
	name: pluginNameSchema,
	schemaKey: typebox.Type.String({ minLength: 1, description: 'Top-level config schema key.' }),
	fieldPath: typebox.Type.String({ minLength: 1, description: 'Dot-path inside the selected schema section.' }),
	value: typebox.Type.Unknown({ description: 'Value to write at the target field path.' }),
})

export const runtimeOpsDescriptorSchema = typebox.Type.Array(
	typebox.openObj({
		id: typebox.Type.String(),
		doc: typebox.openObj({}),
		exposure: typebox.openObj({}),
		policy: typebox.openObj({}),
		schemas: typebox.openObj({}),
		params: typebox.Type.Optional(typebox.Type.Array(typebox.openObj({}))),
		transports: typebox.openObj({}),
	}),
)
