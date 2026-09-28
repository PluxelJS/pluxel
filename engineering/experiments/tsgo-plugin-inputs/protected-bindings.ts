import type { StandardSchemaV1 } from '@standard-schema/spec'
import * as v from 'valibot'

export declare const inputType: unique symbol
export type ConfigValue<S extends StandardSchemaV1> = StandardSchemaV1.InferOutput<S> & {
	readonly [inputType]?: StandardSchemaV1.InferInput<S>
}
export class Configs {
	use<S extends StandardSchemaV1>(_schema: S): ConfigValue<S> {
		throw new Error('Declaration-only fixture')
	}
}
export class Base {
	protected readonly configs = new Configs()
	declare protected readonly config: object
}
export class ProtectedPlugin extends Base {
	protected override readonly config = this.configs.use(
		v.object({
			mode: v.optional(v.picklist(['dev', 'prod']), 'dev'),
			payload: v.pipe(
				v.object({ raw: v.string() }),
				v.transform((value) => value.raw.length),
			),
		}),
	)
	read(): { mode: 'dev' | 'prod'; payload: number } {
		return this.config
	}
}
export class EmptyPlugin extends Base {}
export class ErasedPlugin extends Base {
	protected override readonly config: { mode: 'dev' | 'prod' } = this.configs.use(
		v.object({
			mode: v.optional(v.picklist(['dev', 'prod']), 'dev'),
		}),
	)
}
export type Constructor = abstract new (...args: never[]) => Base
// The indexed-access check accepts the InstanceType projection. Direct T['config'] does not.
export type ConfigInput<P extends Constructor> =
	typeof inputType extends keyof InstanceType<P>['config']
		? InstanceType<P>['config'] extends { readonly [inputType]?: infer I }
			? unknown extends I
				? never
				: I
			: never
		: never

export type InputMapping<T> =
	| string
	| ([NonNullable<T>] extends [readonly unknown[]]
			? never
			: [NonNullable<T>] extends [object]
				? { readonly [K in keyof NonNullable<T>]?: InputMapping<NonNullable<T>[K]> }
				: never)
export function envBinding<P extends Constructor>(
	plugin: P,
	mapping: {
		config?: NoInfer<[ConfigInput<P>] extends [never] ? never : InputMapping<ConfigInput<P>>>
	},
) {
	return { plugin, ...mapping }
}
