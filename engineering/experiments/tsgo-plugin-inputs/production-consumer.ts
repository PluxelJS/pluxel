import { BasePlugin, Plugin, type PluginNodeAddress } from '@pluxel/core'
import type { LogReadOptions } from '@pluxel/core/logging'
import { defineHostApplication, envBinding, fileBinding } from '@pluxel/host'
import type { PluginDescriptor, PluginInstance, ScriptSdk } from '@pluxel/agent-sdk/host'
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

type Equal<Left, Right> =
	(<T>() => T extends Left ? 1 : 2) extends <T>() => T extends Right ? 1 : 2 ? true : false
type Assert<Value extends true> = Value
const sourceAddress = ExamplePlugin.nodeAddress()
type SourceAddress = typeof sourceAddress
type GeneratedInstance = { preview(): string }
declare const generated: PluginDescriptor<
	{ enabled: boolean },
	{ enabled: boolean },
	GeneratedInstance
>
type GeneratedAddress = ReturnType<typeof generated.nodeAddress>

/** Exercise the published declaration associations without workspace source conditions. */
export type ControlTypeChecks = readonly [
	Assert<Equal<PluginInstance<SourceAddress>, ExamplePlugin>>,
	Assert<Equal<PluginInstance<GeneratedAddress>, GeneratedInstance>>,
	Assert<
		Equal<PluginInstance<SourceAddress | GeneratedAddress>, ExamplePlugin | GeneratedInstance>
	>,
	Assert<Equal<PluginInstance<SourceAddress | PluginNodeAddress>, never>>,
	Assert<Equal<Parameters<ScriptSdk['logs']['read']>[1], LogReadOptions | undefined>>,
	Assert<
		Equal<
			Parameters<ScriptSdk['logs']['wait']>[1],
			LogReadOptions & Readonly<{ timeoutMs: number }>
		>
	>,
]

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

export default defineHostApplication(async () => ({
	plugins: [
		{
			plugin: ExamplePlugin,
			envBindings: [
				envBinding({
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
				envBinding({
					vault: { schema: ExampleCredentials, mapping: { credentials: { token: 'TOKEN' } } },
				}),
			],
			fileBindings: [
				fileBinding({
					config: { schema: ExampleConfig, path: './config.json' },
					vault: { schema: ExampleCredentials, paths: { credentials: './credential.json' } },
				}),
			],
		},
	],
}))

envBinding({
	// @ts-expect-error Unknown configuration property cannot widen the schema.
	config: { schema: ExampleConfig, mapping: { missing: 'BAD' } },
})
envBinding({
	// @ts-expect-error Mapping follows input object rather than transformed number.
	config: { schema: ExampleConfig, mapping: { payload: { length: 'BAD' } } },
})
envBinding({
	// @ts-expect-error Arrays are whole JSON inputs.
	config: { schema: ExampleConfig, mapping: { labels: { zero: 'BAD' } } },
})
envBinding({
	// @ts-expect-error Dynamic records below the root are whole JSON inputs.
	config: { schema: ExampleConfig, mapping: { options: { arbitrary: 'BAD' } } },
})
envBinding({
	// @ts-expect-error Vault root keys are schema-checked.
	vault: { schema: ExampleCredentials, mapping: { wrongKey: 'BAD' } },
})
envBinding({
	// @ts-expect-error Vault record fields are schema-checked.
	vault: { schema: ExampleCredentials, mapping: { credentials: { password: 'BAD' } } },
})
// @ts-expect-error Vault root cannot become one JSON binding.
envBinding({ vault: { schema: ExampleCredentials, mapping: 'BAD' } })
fileBinding({
	// @ts-expect-error File paths must use declared Vault record keys.
	vault: { schema: ExampleCredentials, paths: { wrongKey: './bad.json' } },
})
