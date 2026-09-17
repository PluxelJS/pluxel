/** Pin the owner carried by an ordinary service view without freezing its mutable local state. */
export function pinOwnerContext<TContext>(target: object, ctx: TContext): void {
	Object.defineProperty(target, 'ctx', {
		value: ctx,
		writable: false,
		enumerable: true,
		configurable: false,
	})
}
