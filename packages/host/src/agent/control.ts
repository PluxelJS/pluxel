import type {
	PluginDefinitionAddress,
	PluginNodeAddress,
	PluginDefaultNodeAddress,
	PluginForkNodeAddress,
	PluginInstanceNodeAddress,
} from '@pluxel/core'

type RawConfig = Readonly<Record<string, unknown>>
declare const pluginTypes: unique symbol

type PluginTypes<I, O extends object, S extends object> = Readonly<{
	input: I
	output: O
	instance: S
}>

/** Address with generated configuration and instance associations. Evidence is bound to this exact value. */
export type PluginControlNodeAddress<
	I = RawConfig,
	O extends object = RawConfig,
	S extends object = object,
	A extends PluginNodeAddress = PluginNodeAddress,
> = A &
	Readonly<{
		[pluginTypes]: Readonly<{
			signature: PluginTypes<I, O, S>
			invariant: (value: PluginTypes<I, O, S>) => PluginTypes<I, O, S>
		}>
	}>

/** Generated identity provider. Its standard methods never load, create or start a Plugin. */
export interface PluginDescriptor<
	I = RawConfig,
	O extends object = RawConfig,
	S extends object = object,
> {
	readonly definitionAddress: () => PluginDefinitionAddress
	readonly nodeAddress: {
		(): PluginControlNodeAddress<I, O, S, PluginDefaultNodeAddress>
		(forkId: string): PluginControlNodeAddress<I, O, S, PluginForkNodeAddress>
		(forkId?: string): PluginControlNodeAddress<I, O, S>
	}
}

export type PluginTypedNodeAddress = PluginNodeAddress & Readonly<{ [pluginTypes]: unknown }>

type TypesOf<T extends PluginTypedNodeAddress> = T[typeof pluginTypes] extends {
	signature: infer S extends PluginTypes<unknown, object, object>
}
	? S
	: never

export type PluginConfigInput<T extends PluginTypedNodeAddress> = TypesOf<T>['input']
export type PluginConfigOutput<T extends PluginTypedNodeAddress> = TypesOf<T>['output']
/** @internal The common execution evidence admitted by the public instance selector. */
export type PluginAddressEvidence<T extends PluginNodeAddress> = T extends PluginTypedNodeAddress
	? Readonly<{
			kind: 'control'
			target: T
			instance: [TypesOf<T>] extends [never] ? object : TypesOf<T>['instance']
		}>
	: T extends PluginInstanceNodeAddress<infer S>
		? Readonly<{ kind: 'constructor'; target: T; instance: S }>
		: never

/** Instance declared by a source or generated address; every union branch must retain evidence. */
export type PluginInstance<T extends PluginNodeAddress> = [T] extends [
	PluginAddressEvidence<T>['target'],
]
	? PluginAddressEvidence<T>['instance']
	: never

type ConfigAssociation<T extends PluginTypedNodeAddress> =
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
export type SinglePluginConfig<T extends PluginTypedNodeAddress> =
	true extends IsUnion<ConfigAssociation<T>> ? never : unknown
type HasNoConfig<T extends PluginTypedNodeAddress> = [TypesOf<T>] extends [never]
	? true
	: TypesOf<T> extends infer S
		? S extends PluginTypes<infer I, object, object>
			? [I] extends [never]
				? true
				: false
			: true
		: never
/** Internal admission: every possible target must declare configuration. */
export type ConfiguredPlugin<T extends PluginTypedNodeAddress> =
	true extends HasNoConfig<T> ? never : unknown
