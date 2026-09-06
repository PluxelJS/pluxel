import { createHash } from 'node:crypto'
import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { normalizePath, type ViteDevServer } from 'vite'
import type { RootContext } from '@pluxel/core'
import { createDevConsoleScope } from '@pluxel/runtime/internal'
import {
	collectViteSsrImportFiles,
	importViteSsrModule,
	invalidateViteModuleGraphFiles,
	invalidateViteSsrModule,
} from './vite'
import { ConsoleExecutionError, DEV_CONSOLE_VALUE_BYTES } from './console/protocol'
import { startDevConsoleServer } from './console/server'

export type DevConsoleHost = Readonly<{ ctx: RootContext; epoch: string }>
export type DevConsoleAttachment = Readonly<{
	/** Abort old scopes and drain tracked resources; does not forcibly terminate arbitrary JavaScript. */
	hostChanged(): Promise<void>
	close(): Promise<void>
	/** Called before route evaluation/commit, never after a new Plugin namespace has been published. */
	invalidate(file: string): void
	/** Acknowledge a real Vite update at synchronous route queue admission; does not invalidate. */
	observed(file: string): void
	tracks(file: string): boolean
}>
export type AttachDevConsoleOptions = Readonly<{
	server: ViteDevServer
	getHost(): DevConsoleHost | undefined
	/** Drain the finite set of real updates admitted before this call, before evaluation. */
	prepare(file: string, signal: AbortSignal): Promise<void>
}>

/** Route-owned optional console. No listener, runner or log owner is installed until explicitly attached. */
export async function attachDevConsole(
	options: AttachDevConsoleOptions,
): Promise<DevConsoleAttachment> {
	const root = await realpath(options.server.config.root)
	const scripts = new Map<string, Map<string, string>>()
	const observedHashes = new Map<string, string>()
	const observationWaiters = new Set<() => void>()
	const tracks = (file: string) => {
		const path = normalizePath(file)
		return scripts.has(path) || [...scripts.values()].some((dependencies) => dependencies.has(path))
	}
	const scopes = new Set<ReturnType<typeof createDevConsoleScope>>()
	let closed = false
	const server = await startDevConsoleServer({
		root,
		inspect: () => ({ hostEpoch: options.getHost()?.epoch }),
		execute: async (input, run) => {
			run.signal.throwIfAborted()
			const file = normalizePath(input.file)
			let dependencies = scripts.get(file)
			if (!dependencies) {
				if (scripts.size >= 128)
					throw new ConsoleExecutionError(
						'script_limit_reached',
						'Reuse an existing script; this console already tracks 128 script entries',
					)
				dependencies = new Map()
				scripts.set(file, dependencies)
			}
			if ((await sourceHash(file)) !== input.sourceHash)
				throw new ConsoleExecutionError(
					'source_changed',
					'Script changed after submission; review and submit again',
				)
			// Real Vite watcher admission is the sole update authority. Never synthesize an HMR event:
			// its later real counterpart would invalidate an already published Plugin constructor.
			while (true) {
				run.signal.throwIfAborted()
				let wake!: () => void
				const observation = new Promise<void>((resolve) => {
					wake = resolve
				})
				observationWaiters.add(wake)
				const abort = () => wake()
				run.signal.addEventListener('abort', abort, { once: true })
				try {
					let pending = false
					for (const [dependency, previous] of dependencies) {
						const current = await sourceHash(dependency).catch(() => '')
						if (current !== previous && observedHashes.get(dependency) !== current) {
							pending = true
							break
						}
					}
					run.signal.throwIfAborted()
					if (!pending) break
					await observation
				} finally {
					observationWaiters.delete(wake)
					run.signal.removeEventListener('abort', abort)
				}
			}
			// First load also needs normal route admission; subsequent loads use the same module namespace.
			await options.prepare(file, run.signal)
			run.signal.throwIfAborted()
			const host = options.getHost()
			if (!host || closed)
				throw new ConsoleExecutionError('dev_unavailable', 'Dev host is not available')
			run.hostEpoch(host.epoch)
			if ((await sourceHash(file)) !== input.sourceHash)
				throw new ConsoleExecutionError(
					'source_changed',
					'Script changed while preparing execution',
				)
			const exports = await importViteSsrModule<Record<string, unknown>>(options.server, file)
			run.signal.throwIfAborted()
			if (options.getHost()?.epoch !== host.epoch)
				throw new ConsoleExecutionError('host_changed', 'Dev host changed during module loading')
			if ((await sourceHash(file)) !== input.sourceHash)
				throw new ConsoleExecutionError('source_changed', 'Script changed during module loading')
			const execute = exports[input.exportName]
			if (typeof execute !== 'function')
				throw new ConsoleExecutionError(
					'export_not_callable',
					`Export ${input.exportName} is not a function`,
				)
			const nextDependencies = new Map<string, string>()
			for (const dependency of collectViteSsrImportFiles(options.server, file)) {
				if (
					!isAbsolute(dependency) ||
					dependency.includes('\0') ||
					dependency.includes('/node_modules/')
				)
					continue
				if (nextDependencies.size >= 4096)
					throw new ConsoleExecutionError(
						'script_limit_reached',
						'Script dependency graph exceeds 4096 local files',
					)
				nextDependencies.set(dependency, await sourceHash(dependency))
			}
			scripts.set(file, nextDependencies)
			for (const dependency of observedHashes.keys())
				if (!tracks(dependency)) {
					observedHashes.delete(dependency)
				}
			run.signal.throwIfAborted()
			if (options.getHost()?.epoch !== host.epoch)
				throw new ConsoleExecutionError(
					'host_changed',
					'Dev host changed while loading dependencies',
				)
			const scope = createDevConsoleScope({ ctx: host.ctx, signal: run.signal })
			scopes.add(scope)
			const captureLogs = async (stage: 'before' | 'after') => {
				if (run.signal.aborted) return
				try {
					run.logCursor(stage, await scope.dev.logs.mark())
				} catch (error) {
					if (
						error &&
						typeof error === 'object' &&
						'code' in error &&
						error.code === 'logs_unavailable'
					)
						return
					throw error
				}
			}
			run.phase('execute')
			let result: unknown
			let executionError: unknown
			let failed = false
			try {
				run.revision('before', scope.snapshot())
				await captureLogs('before')
				result = await execute(
					scope.dev,
					Object.freeze({ id: input.runId, input: input.input, signal: run.signal }),
				)
			} catch (error) {
				failed = true
				executionError = error
			}
			try {
				run.revision('after', scope.snapshot())
				await captureLogs('after')
			} catch (error) {
				if (!failed) {
					failed = true
					executionError = error
				}
			}
			try {
				if (!failed) run.phase('cleanup')
				await scope.dispose()
			} catch (cleanupError) {
				if (failed)
					throw new AggregateError(
						[executionError, cleanupError],
						'Script execution and resource cleanup failed',
						{ cause: cleanupError },
					)
				throw cleanupError
			} finally {
				scopes.delete(scope)
			}
			if (failed) throw executionError
			return result
		},
	})
	const disposeScopes = async () => {
		const results = await Promise.allSettled([...scopes].map((scope) => scope.dispose()))
		const errors = results.flatMap((result) =>
			result.status === 'rejected' ? [result.reason] : [],
		)
		if (errors.length > 0) throw new AggregateError(errors, 'Dev console resource cleanup failed')
	}
	let closeTask: Promise<void> | undefined
	return Object.freeze({
		tracks,
		invalidate(file: string) {
			if (!tracks(file)) return
			// The route owns publication. Never invalidate again after its new namespace has committed.
			invalidateViteModuleGraphFiles(options.server, [file])
			invalidateViteSsrModule(options.server, file)
		},
		observed(file: string) {
			const path = normalizePath(file)
			if (!tracks(path)) return
			let hash = ''
			try {
				hash = observedSourceHash(path)
			} catch {
				/* Deletions still follow the normal route removal path. */
			}
			observedHashes.set(path, hash)
			for (const wake of observationWaiters) wake()
		},

		async hostChanged() {
			server.executor.abortAll('host_changed')
			await disposeScopes()
		},
		close() {
			return (closeTask ??= (async () => {
				closed = true
				try {
					await server.close()
				} finally {
					await disposeScopes()
					scripts.clear()
					observedHashes.clear()
					observationWaiters.clear()
				}
			})())
		},
	})
}

async function sourceHash(file: string): Promise<string> {
	const handle = await open(file, 'r')
	try {
		const stat = await handle.stat()
		if (!stat.isFile())
			throw new ConsoleExecutionError('file_not_allowed', 'Expected a regular source file')
		const bytes = Buffer.alloc(DEV_CONSOLE_VALUE_BYTES + 1)
		let size = 0
		while (size < bytes.length) {
			const chunk = await handle.read(bytes, size, bytes.length - size, null)
			if (chunk.bytesRead === 0) break
			size += chunk.bytesRead
		}
		if (size > DEV_CONSOLE_VALUE_BYTES)
			throw new ConsoleExecutionError('source_too_large', 'Dev source file exceeds 1 MiB')
		return createHash('sha256').update(bytes.subarray(0, size)).digest('hex')
	} finally {
		await handle.close()
	}
}

/** Only called for a watched, already imported source. Bound work before the route's synchronous admission. */
function observedSourceHash(file: string): string {
	const descriptor = openSync(file, 'r')
	try {
		const stat = fstatSync(descriptor)
		if (!stat.isFile() || stat.size > DEV_CONSOLE_VALUE_BYTES)
			throw new ConsoleExecutionError(
				'source_too_large',
				'Dev source file is not a bounded regular file',
			)
		const bytes = Buffer.alloc(DEV_CONSOLE_VALUE_BYTES + 1)
		let size = 0
		while (size < bytes.length) {
			const count = readSync(descriptor, bytes, size, bytes.length - size, null)
			if (count === 0) break
			size += count
		}
		if (size > DEV_CONSOLE_VALUE_BYTES)
			throw new ConsoleExecutionError('source_too_large', 'Dev source file exceeds 1 MiB')
		return createHash('sha256').update(bytes.subarray(0, size)).digest('hex')
	} finally {
		closeSync(descriptor)
	}
}
