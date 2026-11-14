import type { PluginDefinitionAddress, PluginNodeAddress } from '@pluxel/core'
import type { LogFilter, LogReadOptions } from '@pluxel/core/logging'

type RawConfig = Readonly<Record<string, unknown>>
declare const pluginTypes: unique symbol

type PluginTypes<I, O extends object, S extends object> = Readonly<{
	input: I
	output: O
	instance: S
}>

interface DescriptorData {
	readonly format: 1
	readonly definition: PluginDefinitionAddress
	readonly contracts: Readonly<{ config: string | null; instance: string }>
	readonly [pluginTypes]: unknown
}

/**
 * Generated, data-only reference to a Plugin definition and its public contracts.
 * I is schema input, O is validated output, and S is the canonical Plugin class's
 * instance type, including its inherited public members and nominal identities.
 * A Plugin without configuration uses never for both I and O. The private marker
 * is declaration-only; generated JavaScript contains no symbol or implementation.
 */
export interface PluginDescriptor<
	I = RawConfig,
	O extends object = RawConfig,
	S extends object = object,
> extends DescriptorData {
	readonly contracts: Readonly<{
		config: [I] extends [never] ? null : string
		instance: string
	}>
	readonly [pluginTypes]: Readonly<{
		signature: PluginTypes<I, O, S>
		invariant: (value: PluginTypes<I, O, S>) => PluginTypes<I, O, S>
	}>
}

/** A descriptor selects its default node. Select forks through the reference's fork(). */
export type PluginTypedTarget = DescriptorData

/** Management also accepts an address discovered at runtime. */
export type PluginTarget = PluginTypedTarget | PluginNodeAddress

type TypesOf<T extends PluginTypedTarget> = T[typeof pluginTypes] extends {
	signature: infer S extends PluginTypes<unknown, object, object>
}
	? S
	: never

export type PluginConfigInput<T extends PluginTypedTarget> = TypesOf<T>['input']
export type PluginConfigOutput<T extends PluginTypedTarget> = TypesOf<T>['output']
export type PluginInstance<T extends PluginTypedTarget> = [TypesOf<T>] extends [never]
	? object
	: TypesOf<T>['instance']

type ConfigAssociation<T extends PluginTypedTarget> =
	TypesOf<T> extends infer S
		? S extends PluginTypes<infer I, infer O, object>
			? Readonly<{
					input: I
					output: O
					invariant: (input: I, output: O) => readonly [I, O]
				}>
			: never
		: never
type IsUnion<T, Whole = T> = T extends Whole ? ([Whole] extends [T] ? false : true) : never

/** Internal admission: mutation input must retain one configuration association. */
export type SinglePluginConfig<T extends PluginTypedTarget> =
	true extends IsUnion<ConfigAssociation<T>> ? never : unknown
type HasNoConfig<T extends PluginTypedTarget> = [TypesOf<T>] extends [never]
	? true
	: TypesOf<T> extends infer S
		? S extends PluginTypes<infer I, object, object>
			? [I] extends [never]
				? true
				: false
			: true
		: never
/** Internal admission: every possible target must declare configuration. */
export type ConfiguredPlugin<T extends PluginTypedTarget> =
	true extends HasNoConfig<T> ? never : unknown

/** Logging keeps the native filter shape and normalizes only the Plugin target. */
export type ScriptLogReadOptions = Omit<LogReadOptions, 'filter'> &
	Readonly<{ filter?: Omit<LogFilter, 'plugin'> & Readonly<{ plugin?: PluginTarget }> }>
