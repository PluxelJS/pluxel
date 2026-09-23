import { BasePlugin, Plugin } from '@pluxel/core'
import { defineConfig, envBinding, fileBinding } from '@pluxel/host'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import * as v from 'valibot'

export const ExampleConfig = v.object({
	mode: v.optional(v.picklist(['dev', 'prod']), 'dev'),
	payload: v.pipe(
		v.object({ raw: v.string() }),
		v.transform((value) => value.raw.length),
	),
	transport: v.optional(v.object({ endpoint: v.string() })),
	labels: v.array(v.string()),
	options: v.record(v.string(), v.number()),
})
export const ExampleCredentials = v.object({ credentials: v.object({ token: v.string() }) })
@Plugin()
export class ExamplePlugin extends BasePlugin {
	private readonly settings = this.configs.use(ExampleConfig)
	readPayloadLength(): number {
		return this.settings.payload
	}
}

const input: StandardSchemaV1.InferInput<typeof ExampleConfig> = {
	payload: { raw: '42' },
	labels: [],
	options: {},
}
const output: StandardSchemaV1.InferOutput<typeof ExampleConfig> = {
	mode: 'dev',
	payload: 2,
	labels: [],
	options: {},
}
void input
void output
const invalidInput: StandardSchemaV1.InferInput<typeof ExampleConfig> = {
	// @ts-expect-error Input uses the pre-transform object.
	payload: 2,
	labels: [],
	options: {},
}
// @ts-expect-error Schema defaults are required in normalized output.
const invalidOutput: StandardSchemaV1.InferOutput<typeof ExampleConfig> = {
	payload: 2,
	labels: [],
	options: {},
}
void invalidInput
void invalidOutput

export default defineConfig(async () => ({
	plugins: [ExamplePlugin],
	envBindings: [
		envBinding(ExamplePlugin, {
			config: {
				schema: ExampleConfig,
				mapping: {
					payload: { raw: 'RAW' },
					transport: { endpoint: 'ENDPOINT' },
					labels: 'LABELS',
					options: 'OPTIONS',
				},
			},
		}),
		envBinding(ExamplePlugin, {
			vault: { schema: ExampleCredentials, mapping: { credentials: { token: 'TOKEN' } } },
		}),
	],
	fileBindings: [
		fileBinding(ExamplePlugin, {
			config: { schema: ExampleConfig, path: './config.json' },
			vault: { schema: ExampleCredentials, paths: { credentials: './credential.json' } },
		}),
	],
}))

// @ts-expect-error Unknown configuration property cannot widen the schema.
envBinding(ExamplePlugin, { config: { schema: ExampleConfig, mapping: { missing: 'BAD' } } })
envBinding(ExamplePlugin, {
	// @ts-expect-error Mapping follows input object rather than transformed number.
	config: { schema: ExampleConfig, mapping: { payload: { length: 'BAD' } } },
})
envBinding(ExamplePlugin, {
	// @ts-expect-error Arrays are whole JSON inputs.
	config: { schema: ExampleConfig, mapping: { labels: { zero: 'BAD' } } },
})
envBinding(ExamplePlugin, {
	// @ts-expect-error Dynamic records below the root are whole JSON inputs.
	config: { schema: ExampleConfig, mapping: { options: { arbitrary: 'BAD' } } },
})
// @ts-expect-error Vault root keys are schema-checked.
envBinding(ExamplePlugin, { vault: { schema: ExampleCredentials, mapping: { wrongKey: 'BAD' } } })
envBinding(ExamplePlugin, {
	// @ts-expect-error Vault record fields are schema-checked.
	vault: { schema: ExampleCredentials, mapping: { credentials: { password: 'BAD' } } },
})
// @ts-expect-error Vault root cannot become one JSON binding.
envBinding(ExamplePlugin, { vault: { schema: ExampleCredentials, mapping: 'BAD' } })
fileBinding(ExamplePlugin, {
	// @ts-expect-error File paths must use declared Vault record keys.
	vault: { schema: ExampleCredentials, paths: { wrongKey: './bad.json' } },
})
