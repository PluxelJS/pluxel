import type { PluginConstructor, PluginNodeAddress } from '@pluxel/core'
import { defineContextCapability } from '@pluxel/core/host'
import type { StandardSchemaV1 } from '@standard-schema/spec'

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

type SchemaMapping<S extends StandardSchemaV1> = Readonly<{
	schema: S
	mapping: InputMapping<StandardSchemaV1.InferInput<S>>
}>
type VaultSchemaMapping<S extends StandardSchemaV1> = Readonly<{
	schema: S
	mapping: VaultInputMapping<StandardSchemaV1.InferInput<S>>
}>

/** Explicit schema-bearing deployment inputs. Use envBinding for schema-derived completion. */
export type HostEnvironmentBinding<P extends PluginConstructor = PluginConstructor> = Readonly<{
	plugin: P
	namespace?: string
	config?: Readonly<{ schema: StandardSchemaV1; mapping: InputMapping }>
	vault?: Readonly<{
		schema: StandardSchemaV1
		mapping: Readonly<Record<string, InputMapping | undefined>>
	}>
}>
export type HostFileBinding<P extends PluginConstructor = PluginConstructor> = Readonly<{
	plugin: P
	namespace?: string
	config?: Readonly<{ schema: StandardSchemaV1; path: string }>
	vault?: Readonly<{
		schema: StandardSchemaV1
		paths: Readonly<Record<string, string | undefined>>
	}>
}>

/** Select environment inputs from one imported config schema and one deployment Vault root schema. */
export function envBinding<
	P extends PluginConstructor,
	C extends StandardSchemaV1,
	V extends StandardSchemaV1,
>(
	plugin: P,
	inputs: Readonly<{
		namespace?: string
		config?: SchemaMapping<C>
		vault?: VaultSchemaMapping<V>
	}>,
): HostEnvironmentBinding<P> {
	return { plugin, ...inputs } as HostEnvironmentBinding<P>
}

/** JSON files provide config base values and complete Vault records. */
export function fileBinding<
	P extends PluginConstructor,
	C extends StandardSchemaV1,
	V extends StandardSchemaV1,
>(
	plugin: P,
	inputs: Readonly<{
		namespace?: string
		config?: Readonly<{ schema: C; path: string }>
		vault?: Readonly<{
			schema: V
			paths: { readonly [K in keyof StandardSchemaV1.InferInput<V>]?: string }
		}>
	}>,
): HostFileBinding<P> {
	return { plugin, ...inputs }
}

export type HostVaultBindingRecord = Readonly<{
	owner: PluginNodeAddress
	namespace?: string
	key: string
	value: unknown
	source: 'env' | 'file'
}>

/** Root-only installation boundary. Plugins cannot replace deployment bindings. */
export const HostVaultBindings = defineContextCapability<{
	install(records: readonly HostVaultBindingRecord[]): void | Promise<void>
}>('host.vault-bindings', { access: 'root' })
