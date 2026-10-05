import { realpathSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import {
	normalizePath,
	createServer,
	loadConfigFromFile,
	mergeConfig,
	type InlineConfig,
	type ViteDevServer,
} from 'vite'
import { PRODUCTION_SESSION_PLUGIN } from './profile'
import { closeHostViteSession, observeViteShutdown } from './internal/host-session'

/**
 * Own a production Vite session. Resolves after initial catalog, artifacts, Host startup report and
 * installed listener are ready. Plugin init failures remain observable lifecycle facts.
 * Abort closes admission and waits for accepted work; it does not roll back module side effects.
 */
export async function runViteApplication(
	options: Readonly<{ root: string; configFile: string; signal?: AbortSignal }>,
): Promise<Readonly<{ close(): Promise<void> }>> {
	const { root: inputRoot, configFile, signal } = options
	if (typeof inputRoot !== 'string' || !isAbsolute(inputRoot))
		throw new TypeError('[host-vite/run] root must be absolute')
	if (typeof configFile !== 'string' || !configFile.trim())
		throw new TypeError('[host-vite/run] configFile is required')
	for (const key of Object.keys(options))
		if (!['root', 'configFile', 'signal'].includes(key))
			throw new TypeError(`[host-vite/run] unsupported ${key}`)
	if (process.env.NODE_ENV !== undefined && process.env.NODE_ENV !== 'production')
		throw new TypeError(
			'[host-vite/run] production Vite requires a fresh NODE_ENV=production process',
		)
	process.env.NODE_ENV = 'production'
	signal?.throwIfAborted()
	const root = realpathSync(inputRoot)
	let server: ViteDevServer | undefined
	let starting: Promise<ViteDevServer> | undefined
	let closing: Promise<void> | undefined
	const hookFailures: unknown[] = []
	const close = (): Promise<void> =>
		(closing ??= (async () => {
			signal?.removeEventListener('abort', onAbort)
			const errors: unknown[] = []
			const initialDrain = server && closeHostViteSession(server)
			const observedDrain = initialDrain?.catch((error) => {
				errors.push(error)
			})
			// Acquisition can still finish after abort. Its original caller owns the startup error.
			await starting?.catch(() => {})
			try {
				await (observedDrain ?? (server && closeHostViteSession(server)))
			} catch (error) {
				errors.push(error)
			}
			if (server) {
				// DevEnvironment.close() also discards plugin failures. Close the owned containers
				// after Host work drains, then let Vite release its runner and transport resources.
				const results = await Promise.allSettled(
					Object.values(server.environments).map((environment) =>
						environment.pluginContainer.close(),
					),
				)
				for (const result of results) if (result.status === 'rejected') errors.push(result.reason)
				try {
					await server.close()
				} catch (error) {
					errors.push(error)
				}
			}
			errors.push(...hookFailures)
			const failures = [...new Set(errors)]
			if (failures.length > 0)
				throw new AggregateError(failures, '[host-vite/run] shutdown failed', {
					cause: failures[0],
				})
		})())
	const onAbort = (): void => {
		void close().catch(() => {})
	}
	signal?.addEventListener('abort', onAbort, { once: true })
	try {
		starting = (async () => {
			const loaded = await loadConfigFromFile(
				{ command: 'serve', mode: 'production', isSsrBuild: false, isPreview: false },
				resolve(root, configFile),
				root,
				undefined,
				undefined,
				'native',
			)
			if (!loaded) throw new TypeError('[host-vite/run] Vite configuration is required')
			if (
				loaded.config.root !== undefined &&
				normalizePath(realpathSync(resolve(loaded.config.root))) !== normalizePath(root)
			)
				throw new TypeError('[host-vite/run] Vite config conflicts with the execution root')
			const plugins = await observeViteShutdown(loaded.config.plugins ?? [], (error) =>
				hookFailures.push(error),
			)
			return createServer(
				mergeConfig({ ...loaded.config, plugins: [plugins] }, {
					root,
					configFile: false,
					mode: 'production',
					appType: 'custom',
					server: { middlewareMode: true, hmr: false },
					plugins: [
						{
							name: PRODUCTION_SESSION_PLUGIN,
							enforce: 'pre',
							config(config) {
								if (
									config.root !== undefined &&
									normalizePath(realpathSync(resolve(config.root))) !== normalizePath(root)
								)
									throw new TypeError(
										'[host-vite/run] Vite config conflicts with the execution root',
									)
								return {
									root,
									mode: 'production',
									define: { 'process.env.NODE_ENV': '"production"' },
									server: { middlewareMode: true, hmr: false },
								}
							},
							configResolved(config) {
								// Config hooks run after our production defaults. Reject overrides before Vite
								// acquires transports; silently restoring them would hide a conflicting contract.
								for (const [field, valid] of [
									['server.hmr', config.server.hmr === false],
									['server.middlewareMode', config.server.middlewareMode === true],
									[
										'define[process.env.NODE_ENV]',
										config.define['process.env.NODE_ENV'] === '"production"',
									],
								] as const)
									if (!valid)
										throw new TypeError(
											`[host-vite/run] Vite config conflicts with production ${field}`,
										)
								if (normalizePath(realpathSync(config.root)) !== normalizePath(root))
									throw new TypeError(
										'[host-vite/run] Vite config conflicts with the execution root',
									)
								if (config.plugins.filter((plugin) => plugin.name === 'pluxel:host').length !== 1)
									throw new TypeError(
										'[host-vite/run] configure exactly one host() or vitePreset() entry',
									)
							},
							configureServer(value) {
								server = value
								if (closing) {
									signal?.throwIfAborted()
									throw new Error('[host-vite/run] session closed during startup')
								}
							},
						},
					],
				} satisfies InlineConfig),
			)
		})()
		server = await starting
		if (closing || signal?.aborted) {
			signal?.throwIfAborted()
			throw new Error('[host-vite/run] session closed during startup')
		}
		return Object.freeze({ close })
	} catch (error) {
		const [cleanup] = await Promise.allSettled([close()])
		if (cleanup.status === 'rejected')
			throw new AggregateError(
				[error, cleanup.reason],
				'[host-vite/run] startup and cleanup failed',
				{
					cause: error,
				},
			)
		throw error
	}
}
