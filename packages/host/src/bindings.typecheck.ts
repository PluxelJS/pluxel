import type { PluginConstructor } from '@pluxel/core'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import * as v from 'valibot'
import { defineHostApplication } from './node-application'
import { envBinding, fileBinding } from './bindings'

const config = v.object({
	enabled: v.optional(v.boolean(), false),
	nested: v.object({ count: v.number() }),
	values: v.array(v.string()),
	dynamic: v.record(v.string(), v.string()),
	transformed: v.pipe(
		v.object({ raw: v.string() }),
		v.transform((value) => value.raw.length),
	),
})
const vault = v.object({ credentials: v.object({ token: v.string(), expires: v.number() }) })
declare const Plugin: PluginConstructor
declare const nonValibotSchema: StandardSchemaV1

envBinding({
	config: {
		// @ts-expect-error Host input projection requires a Valibot schema.
		schema: nonValibotSchema,
		mapping: 'CONFIG',
	},
})
fileBinding({
	config: {
		// @ts-expect-error File bindings also require a Valibot schema.
		schema: nonValibotSchema,
		path: 'config.json',
	},
})

defineHostApplication(() => ({
	plugins: [
		{
			plugin: Plugin,
			envBindings: [
				envBinding({
					config: {
						schema: config,
						mapping: {
							nested: { count: 'COUNT' },
							values: 'VALUES',
							dynamic: 'DYNAMIC',
							transformed: { raw: 'RAW' },
						},
					},
					vault: { schema: vault, mapping: { credentials: { token: 'TOKEN', expires: 'EXPIRY' } } },
				}),
			],
			fileBindings: [
				fileBinding({
					config: { schema: config, path: 'config.json' },
					vault: { schema: vault, paths: { credentials: 'credential.json' } },
				}),
			],
		},
	],
}))

envBinding({
	config: {
		schema: config,
		mapping: {
			// @ts-expect-error Unknown config key.
			typo: 'VALUE',
		},
	},
})
envBinding({
	config: {
		schema: config,
		mapping: {
			// @ts-expect-error Arrays must be transported as JSON.
			values: { 0: 'FIRST' },
		},
	},
})
envBinding({
	config: {
		schema: config,
		mapping: {
			// @ts-expect-error Dynamic records must be transported as JSON below the Vault root.
			dynamic: { arbitrary: 'VALUE' },
		},
	},
})
envBinding({
	config: {
		schema: config,
		mapping: {
			transformed: {
				// @ts-expect-error Mapping follows input fields, not output.
				length: 'LENGTH',
			},
		},
	},
})
envBinding({
	vault: {
		schema: vault,
		mapping: {
			credentials: {
				// @ts-expect-error Unknown credential field.
				wrong: 'TOKEN',
			},
		},
	},
})
envBinding({
	vault: {
		schema: vault,
		mapping: {
			// @ts-expect-error Unknown record key.
			other: 'TOKEN',
		},
	},
})
fileBinding({
	vault: {
		schema: vault,
		paths: {
			// @ts-expect-error Unknown file record key.
			other: 'credential.json',
		},
	},
})
envBinding({
	vault: {
		schema: v.record(v.string(), v.object({ token: v.string() })),
		mapping: { account: { token: 'TOKEN' } },
	},
})

// @ts-expect-error Deployment references use a full node address, not an implementation.
envBinding(Plugin, { config: { schema: config, mapping: 'CONFIG' } })
// @ts-expect-error File inputs use the same node address selection.
fileBinding(Plugin, { config: { schema: config, path: 'config.json' } })
