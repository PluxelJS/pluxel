type Factory = (startup: never) => unknown
type ExtraFields<A, D> = A extends unknown ? Exclude<keyof A, keyof D> : never

/** Each entry supplies the startup context and result shape of its driver. */
export type ApplicationDefinition<F extends Factory> = <const T extends F>(
	factory: T &
		(ExtraFields<Awaited<ReturnType<T>>, Awaited<ReturnType<F>>> extends never ? unknown : never),
) => T

export function declareApplication<T extends Factory>(factory: T): T {
	if (typeof factory !== 'function') throw new TypeError('[host] Application must be a factory')
	if (arguments.length !== 1)
		throw new TypeError('[host] defineHostApplication expects one application factory')
	return factory
}
