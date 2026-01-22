/**
 * Decorator for injectable classes. Every registered service must
 * be decorated because without decorators Typescript won't emit
 * constructor metadata.
 * @returns
 */
export const Service = (): ClassDecorator => {
	return (target) => target
}
