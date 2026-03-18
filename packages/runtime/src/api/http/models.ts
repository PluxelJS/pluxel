import { t } from 'elysia'

export const pluginNameParams = t.Object({
	name: t.String({ minLength: 1 }),
})

export const extensionModuleParams = t.Object({
	plugin: t.String({ minLength: 1 }),
	file: t.String({ minLength: 1 }),
})

export const logStreamParams = t.Object({
	streamId: t.String({ minLength: 1 }),
})

const logFilterQueryShape = {
	name: t.Optional(t.String()),
	pluginId: t.Optional(t.String()),
	context: t.Optional(t.String()),
	displayName: t.Optional(t.String()),
	category: t.Optional(t.String()),
}

export const logRangeQuery = t.Object(
	{
		...logFilterQueryShape,
		epoch: t.Optional(t.String()),
		from: t.Optional(t.String()),
		limit: t.Optional(t.String()),
	},
	{ additionalProperties: true },
)

export const logFollowQuery = t.Object(
	{
		...logFilterQueryShape,
		epoch: t.Optional(t.String()),
		from: t.Optional(t.String()),
	},
	{ additionalProperties: true },
)

export const debugSchemaSourceQuery = t.Object(
	{
		filter: t.Optional(t.String()),
		q: t.Optional(t.String()),
	},
	{ additionalProperties: true },
)
