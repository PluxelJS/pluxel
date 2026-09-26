import type { StandardSchemaV1 } from '@standard-schema/spec'
import * as v from 'valibot'

/** This experiment uses ordinary TS declarations. No generated class properties are needed. */
export type InputMapping<T> =
	| string
	| ([NonNullable<T>] extends [readonly unknown[]]
			? never
			: [NonNullable<T>] extends [object]
				? { readonly [K in keyof NonNullable<T>]?: InputMapping<NonNullable<T>[K]> }
				: never)

export type SchemaMapping<S extends StandardSchemaV1> = Readonly<{
	schema: S
	mapping: InputMapping<StandardSchemaV1.InferInput<S>>
}>

export function envBinding<
	P extends abstract new (...args: never[]) => object,
	C extends StandardSchemaV1,
	V extends StandardSchemaV1,
>(plugin: P, inputs: Readonly<{ config?: SchemaMapping<C>; vault?: SchemaMapping<V> }>) {
	return { plugin, ...inputs }
}

// The plugin and Host import this one value. There is no second config schema definition.
export const ExampleConfig = v.object({
	mode: v.optional(v.picklist(['dev', 'prod']), 'dev'),
	payload: v.pipe(
		v.object({ raw: v.string() }),
		v.transform((value) => value.raw.length),
	),
	transport: v.optional(v.object({ endpoint: v.string() })),
})
// The Host deployment binding owns this record schema; private KV remains business-validated.
export const ExampleCredentials = v.object({ credentials: v.object({ token: v.string() }) })

class DemoConfigs {
	use<S extends StandardSchemaV1>(_schema: S): StandardSchemaV1.InferOutput<S> {
		throw new Error('Declaration-only fixture; do not instantiate')
	}
}
export class ExamplePlugin {
	private readonly configs = new DemoConfigs()
	private readonly configuration = this.configs.use(ExampleConfig)
	readPayloadLength(): number {
		return this.configuration.payload
	}
}

export const binding = envBinding(ExamplePlugin, {
	config: {
		schema: ExampleConfig,
		mapping: {
			mode: 'APP_MODE',
			payload: { raw: 'APP_RAW' },
			transport: { endpoint: 'APP_ENDPOINT' },
		},
	},
	vault: { schema: ExampleCredentials, mapping: { credentials: { token: 'APP_TOKEN' } } },
})

/** Production Host passes candidate.declaration.config.owner.schema here before admitting bindings. */
export function assertDeclaredConfigSchema(
	candidateSchema: unknown,
	selected: Readonly<{ config?: Readonly<{ schema: StandardSchemaV1 }> }>,
): void {
	if (selected.config && selected.config.schema !== candidateSchema)
		throw new Error('The binding must reference the schema used by this.configs.use()')
}

/** Smaller independent helper: fix S before contextually typing its mapping. */
export function env<S extends StandardSchemaV1>(
	schema: S,
	mapping: InputMapping<StandardSchemaV1.InferInput<S>>,
) {
	return { kind: 'env' as const, schema, mapping }
}
export function jsonFile<S extends StandardSchemaV1>(schema: S, path: string) {
	return { kind: 'file' as const, schema, path }
}
export const smallBinding = {
	plugin: ExamplePlugin,
	config: env(ExampleConfig, {
		payload: { raw: 'APP_RAW' },
		transport: { endpoint: 'APP_ENDPOINT' },
	}),
	vault: { credentials: env(ExampleCredentials.entries.credentials, { token: 'APP_TOKEN' }) },
}
