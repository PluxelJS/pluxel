import type { PluginNodeAddress } from '@pluxel/core'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { Schema } from 'valibot-form'

/** Mapping leaves are explicit environment variable names, never values or defaults. */
export type InputMapping<T = unknown> =
	| string
	| ([NonNullable<T>] extends [readonly unknown[]]
			? never
			: [NonNullable<T>] extends [object]
				? string extends keyof NonNullable<T>
					? never
					: { readonly [K in keyof NonNullable<T>]?: InputMapping<NonNullable<T>[K]> }
				: unknown extends T
					? { readonly [key: string]: InputMapping }
					: never)

/** The root enumerates Vault record keys; a dynamic record remains allowed only at this root. */
export type VaultInputMapping<T> = [NonNullable<T>] extends [readonly unknown[]]
	? never
	: [NonNullable<T>] extends [object]
		? { readonly [K in keyof NonNullable<T>]?: InputMapping<NonNullable<T>[K]> }
		: never

type SchemaMapping<S extends Schema> = Readonly<{
	schema: S
	mapping: InputMapping<StandardSchemaV1.InferInput<S>>
}>
type VaultSchemaMapping<S extends Schema> = Readonly<{
	namespace?: string
	schema: S
	mapping: VaultInputMapping<StandardSchemaV1.InferInput<S>>
}>

/** Explicit schema-bearing deployment inputs. Use envBinding for schema-derived completion. */
export type HostEnvironmentBinding = Readonly<{
	config?: Readonly<{ schema: Schema; mapping: InputMapping }>
	vault?: Readonly<{
		namespace?: string
		schema: Schema
		mapping: Readonly<Record<string, InputMapping | undefined>>
	}>
}>
export type HostFileBinding = Readonly<{
	config?: Readonly<{ schema: Schema; path: string }>
	vault?: Readonly<{
		namespace?: string
		schema: Schema
		paths: Readonly<Record<string, string | undefined>>
	}>
}>

/** Select environment inputs from one imported config schema and one deployment Vault root schema. */
export function envBinding<C extends Schema, V extends Schema>(
	inputs: Readonly<{
		config?: SchemaMapping<C>
		vault?: VaultSchemaMapping<V>
	}>,
): HostEnvironmentBinding {
	return inputs as HostEnvironmentBinding
}

/** JSON files provide config declaration values and complete Vault records. */
export function fileBinding<C extends Schema, V extends Schema>(
	inputs: Readonly<{
		config?: Readonly<{ schema: C; path: string }>
		vault?: Readonly<{
			namespace?: string
			schema: V
			paths: { readonly [K in keyof StandardSchemaV1.InferInput<V>]?: string }
		}>
	}>,
): HostFileBinding {
	return inputs
}

export type OwnedInputBindings = Readonly<{
	envBindings: readonly (HostEnvironmentBinding & { plugin: PluginNodeAddress })[]
	fileBindings: readonly (HostFileBinding & { plugin: PluginNodeAddress })[]
}>
