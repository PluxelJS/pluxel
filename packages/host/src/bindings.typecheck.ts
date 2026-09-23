import type { PluginConstructor } from '@pluxel/core'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import * as v from 'valibot'
import { defineConfig } from './application'
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

envBinding(Plugin, {
	config: {
		// @ts-expect-error Host input projection requires a Valibot schema.
		schema: nonValibotSchema,
		mapping: 'CONFIG',
	},
})
fileBinding(Plugin, {
	config: {
		// @ts-expect-error File bindings also require a Valibot schema.
		schema: nonValibotSchema,
		path: 'config.json',
	},
})

defineConfig(() => ({
	plugins: [Plugin],
	envBindings: [
		envBinding(Plugin, {
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
		fileBinding(Plugin, {
			config: { schema: config, path: 'config.json' },
			vault: { schema: vault, paths: { credentials: 'credential.json' } },
		}),
	],
}))

envBinding(Plugin, {
	config: {
		schema: config,
		mapping: {
			// @ts-expect-error Unknown config key.
			typo: 'VALUE',
		},
	},
})
envBinding(Plugin, {
	config: {
		schema: config,
		mapping: {
			// @ts-expect-error Arrays must be transported as JSON.
			values: { 0: 'FIRST' },
		},
	},
})
envBinding(Plugin, {
	config: {
		schema: config,
		mapping: {
			// @ts-expect-error Dynamic records must be transported as JSON below the Vault root.
			dynamic: { arbitrary: 'VALUE' },
		},
	},
})
envBinding(Plugin, {
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
envBinding(Plugin, {
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
envBinding(Plugin, {
	vault: {
		schema: vault,
		mapping: {
			// @ts-expect-error Unknown record key.
			other: 'TOKEN',
		},
	},
})
fileBinding(Plugin, {
	vault: {
		schema: vault,
		paths: {
			// @ts-expect-error Unknown file record key.
			other: 'credential.json',
		},
	},
})
envBinding(Plugin, {
	vault: {
		schema: v.record(v.string(), v.object({ token: v.string() })),
		mapping: { account: { token: 'TOKEN' } },
	},
})
