import { Type, obj, openObj } from '@pluxel/ops/typebox'

export const pluginNameSchema = Type.String({
	minLength: 1,
	description: 'Plugin name.',
})
export const pluginActionSchema = Type.Union(
	[
		Type.Literal('start'),
		Type.Literal('stop'),
		Type.Literal('restart'),
		Type.Literal('enable'),
		Type.Literal('disable'),
	],
	{
		description: 'Lifecycle action to apply.',
	},
)

export const pluginSourceSchema = openObj({
	kind: Type.String(),
	moduleId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	packageName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	version: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	tag: Type.Optional(Type.Union([Type.String(), Type.Null()])),
})

export const pluginStatusSnapshotSchema = obj({
	name: Type.String(),
	isRunning: Type.Boolean(),
	isEnabled: Type.Boolean(),
	lifecycleStage: Type.String(),
	source: pluginSourceSchema,
})

export const pluginStatusOutputSchema = Type.Union([
	obj({
		ok: Type.Literal(true),
		status: pluginStatusSnapshotSchema,
	}),
	obj({
		ok: Type.Literal(false),
		code: Type.String(),
		message: Type.String(),
	}),
])

export const pluginStatusActionResultSchema = obj({
	name: Type.String(),
	ok: Type.Boolean(),
	code: Type.Optional(Type.String()),
	error: Type.Optional(Type.String()),
	isRunning: Type.Optional(Type.Boolean()),
	isEnabled: Type.Optional(Type.Boolean()),
	lifecycleStage: Type.Optional(Type.String()),
	source: Type.Optional(pluginSourceSchema),
})

export const pluginDependencyRefSchema = openObj({
	name: Type.Optional(Type.String()),
})

export const pluginDependencyOptionSchema = obj({
	name: Type.String(),
	isRunning: Type.Boolean(),
	isEnabled: Type.Boolean(),
})

export const pluginDependencyStateSchema = obj({
	index: Type.Number(),
	token: Type.String(),
	kind: Type.Union([Type.Literal('plugin'), Type.Literal('base'), Type.Literal('forkable')]),
	effective: Type.String(),
	isRunning: Type.Boolean(),
	selected: Type.Union([Type.String(), Type.Null()]),
	baseProvider: Type.Union([Type.String(), Type.Null()]),
	options: Type.Array(pluginDependencyOptionSchema),
})

export const pluginDependencyMutationResultSchema = obj({
	ok: Type.Boolean(),
	code: Type.Optional(Type.String()),
	error: Type.Optional(Type.String()),
})

export const baseProviderInfoSchema = Type.Union([
	Type.Null(),
	obj({
		baseToken: Type.String(),
		currentDefault: Type.Union([Type.String(), Type.Null()]),
		isDefault: Type.Boolean(),
		providers: Type.Array(pluginDependencyOptionSchema),
	}),
])

export const ensureForkResultSchema = obj({
	ok: Type.Boolean(),
	forkName: Type.Optional(Type.String()),
	code: Type.Optional(Type.String()),
	error: Type.Optional(Type.String()),
})

export const pluginStatusBatchOutputSchema = obj({
	ok: Type.Boolean(),
	results: Type.Array(pluginStatusActionResultSchema),
	commitError: Type.Optional(Type.String()),
})

export const configResultSchema = Type.Union([
	obj({
		ok: Type.Literal(true),
		saved: Type.Boolean(),
		config: Type.Record(Type.String(), Type.Unknown()),
		defaults: Type.Record(Type.String(), Type.Unknown()),
	}),
	obj({
		ok: Type.Literal(false),
		code: Type.String(),
		message: Type.String(),
		errors: Type.Optional(Type.Unknown()),
		defaults: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	}),
])

export const configBatchEntrySchema = obj({
	name: Type.String(),
	result: configResultSchema,
})

export const configBatchResultSchema = obj({
	ok: Type.Boolean(),
	items: Type.Array(configBatchEntrySchema),
})

export const schemaResultSchema = Type.Union([
	obj({
		ok: Type.Literal(true),
		schemaSource: Type.Record(Type.String(), Type.String()),
		defaults: Type.Record(Type.String(), Type.Unknown()),
		layout: Type.Optional(Type.Union([Type.Null(), Type.Array(Type.Unknown())])),
	}),
	obj({
		ok: Type.Literal(false),
		code: Type.String(),
		message: Type.String(),
	}),
])

export const emptyInputSchema = obj({})

export const configPatchEntrySchema = obj({
	name: pluginNameSchema,
	patch: Type.Record(Type.String(), Type.Unknown(), {
		description: 'Config patch object to validate or persist.',
	}),
})

export const configResetEntrySchema = obj({
	name: pluginNameSchema,
	keys: Type.Optional(
		Type.Array(Type.String(), {
			description: 'Config keys to reset. Omit to reset all keys.',
		}),
	),
})

export const configFieldEntrySchema = obj({
	name: pluginNameSchema,
	schemaKey: Type.String({ minLength: 1, description: 'Top-level config schema key.' }),
	fieldPath: Type.String({
		minLength: 1,
		description: 'Dot-path inside the selected schema section.',
	}),
	value: Type.Unknown({ description: 'Value to write at the target field path.' }),
})

export const runtimeOpsDescriptorSchema = Type.Array(
	openObj({
		id: Type.String(),
		doc: openObj({}),
		exposure: openObj({}),
		policy: openObj({}),
		schemas: openObj({}),
		params: Type.Optional(Type.Array(openObj({}))),
		transports: openObj({}),
	}),
)
