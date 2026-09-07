/** Pin a service or scope to its Context without freezing its mutable implementation state. */
export function pinOwnerContext<TContext>(target: object, ctx: TContext): void {
	Object.defineProperty(target, 'ctx', {
		value: ctx,
		writable: false,
		enumerable: true,
		configurable: false,
	})
}
