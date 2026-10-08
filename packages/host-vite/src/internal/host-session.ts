import type { HookHandler, Plugin, PluginOption, ViteDevServer } from 'vite'

// Vite waits for environment cleanup but discards rejected plugin shutdown hooks.
// The execution owner must observe the Host's own drain before releasing the runner.
// configureServer receives Vite's reflex proxy; createServer returns its underlying server.
// Both expose the same environment collection for this execution session.
const shutdown = new WeakMap<ViteDevServer['environments'], () => Promise<void>>()

export function installHostViteShutdown(server: ViteDevServer, close: () => Promise<void>): void {
	if (shutdown.has(server.environments))
		throw new Error('[host-vite] Host shutdown owner is already installed')
	shutdown.set(server.environments, close)
}

/**
 * Close Host update admission and drain its accepted work before releasing borrowed startup
 * bindings. The caller still owns server.close(). Repeated calls share the Host close result;
 * undefined means this server has not acquired a Host session (including incomplete startup).
 * Unlike Vite's closeBundle dispatch, the returned promise preserves Host cleanup failures.
 */
export function closeHostViteSession(server: ViteDevServer): Promise<void> | undefined {
	return shutdown.get(server.environments)?.()
}

/** Keep Vite's close hook ordering while supervising every failure through the execution owner. */
export async function observeViteShutdown(
	input: PluginOption,
	onError: (error: unknown) => void,
): Promise<PluginOption> {
	const plugin = await input
	if (!plugin) return plugin
	if (Array.isArray(plugin))
		return Promise.all(plugin.map((value) => observeViteShutdown(value, onError)))
	const declaration: Plugin = plugin
	const hook = declaration.closeBundle
	const apply = declaration.applyToEnvironment
	if (!hook && !apply) return plugin
	const copy: Plugin = { ...declaration }
	if (hook) {
		const handler = typeof hook === 'function' ? hook : hook.handler
		const observed: HookHandler<NonNullable<Plugin['closeBundle']>> = async function (...args) {
			try {
				await handler.apply(this, args)
			} catch (error) {
				onError(error)
			}
		}
		copy.closeBundle = typeof hook === 'function' ? observed : { ...hook, handler: observed }
	}
	if (apply)
		// Vite resolves this union before choosing a plugin; its declaration splits the Promise union.
		copy.applyToEnvironment = async function (this: Plugin, environment) {
			const selected = await apply.call(this, environment)
			return selected === true ? true : observeViteShutdown(selected, onError)
		} as Plugin['applyToEnvironment']
	return copy
}
