import { type Context } from '@pluxel/runtime/test'

export function createLoggerPluginContext(root: Context, name: string, id = name): Context {
	const ctx = root.extend({ name }) as Context
	Object.defineProperty(ctx, 'pluginInfo', {
		value: { id },
		configurable: true,
		writable: true,
	})
	return ctx
}
