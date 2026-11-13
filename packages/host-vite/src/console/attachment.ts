import { sourceHash, observedSourceHash } from './source'
import { realpath } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { normalizePath, type ViteDevServer } from 'vite'
import type { RootContext } from '@pluxel/core'
import {
	executeHostScript,
	ScriptExecutionError,
	type ScriptScope,
	type RunExecution,
} from '@pluxel/host/agent'
import { createProjectSdk } from '../project-sdk'
import {
	collectHostImportFiles,
	importHostModule,
	invalidateHostModuleGraphFiles,
	invalidateHostModule,
} from '../environment'
import { startProjectScriptServer } from './server'
import type { HostViteUpdateStatus } from '../driver'
import { readViteUrlOutput } from '../internal/vite-urls'

export type ProjectScriptHost = Readonly<{
	ctx: RootContext
	epoch: string
}>

export type ProjectScriptsAttachment = Readonly<{
	/** Abort old scopes and drain tracked resources; does not forcibly terminate arbitrary JavaScript. */
	hostChanged(): Promise<void>
	close(): Promise<void>
	/** Called before route evaluation/commit, never after a new Plugin namespace has been published. */
	invalidate(file: string): void
	/** Acknowledge a real Vite update at synchronous route queue admission; does not invalidate. */
	observed(file: string): void
	tracks(file: string): boolean
}>
export type AttachProjectScriptsOptions = Readonly<{
	server: ViteDevServer
	getHost(): ProjectScriptHost | undefined
	getApplicationStatus?(): Readonly<Record<string, unknown>>
	getUpdateStatus?(): HostViteUpdateStatus
	assertApplied?(): void
	control?(action: 'pause' | 'apply' | 'resume', run: RunExecution): Promise<unknown>
	/** Drain the finite set of real updates admitted before this call, before evaluation. */
	prepare(file: string, signal: AbortSignal): Promise<void>
}>

/** Route-owned optional console. No listener, runner or log owner is installed until explicitly attached. */
export async function attachProjectScripts(
	options: AttachProjectScriptsOptions,
): Promise<ProjectScriptsAttachment> {
	const root = await realpath(options.server.config.root)
	const scripts = new Map<string, Map<string, string>>()
	const observedHashes = new Map<string, string>()
	const observationWaiters = new Set<() => void>()
	const tracks = (file: string) => {
		const path = normalizePath(file)
		return scripts.has(path) || [...scripts.values()].some((dependencies) => dependencies.has(path))
	}
	const scopes = new Set<ScriptScope>()
	let closed = false
	const server = await startProjectScriptServer({
		root,
		control: options.control,
		inspect: () => ({
			hostEpoch: options.getHost()?.epoch,
			application: options.getApplicationStatus?.(),
			hmr: options.getUpdateStatus?.(),
			urlOutput: readViteUrlOutput(options.server),
		}),
		execute: async (input, run) => {
			run.signal.throwIfAborted()
			const code = input.code
			if (code.kind !== 'project')
				throw new ScriptExecutionError('loading_unavailable', 'Vite loads project modules')
			const file = normalizePath(code.file)
			let dependencies = scripts.get(file)
			if (!dependencies) {
				if (scripts.size >= 128)
					throw new ScriptExecutionError(
						'script_limit_reached',
						'Reuse an existing script; this console already tracks 128 script entries',
					)
				dependencies = new Map()
				scripts.set(file, dependencies)
			}
			if ((await sourceHash(file)) !== code.sourceHash)
				throw new ScriptExecutionError(
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
				throw new ScriptExecutionError('dev_unavailable', 'Dev host is not available')
			run.hostEpoch(host.epoch)
			if ((await sourceHash(file)) !== code.sourceHash)
				throw new ScriptExecutionError('source_changed', 'Script changed while preparing execution')
			options.assertApplied?.()
			const exports = await importHostModule<Record<string, unknown>>(options.server, file)
			options.assertApplied?.()
			run.signal.throwIfAborted()
			if (options.getHost()?.epoch !== host.epoch)
				throw new ScriptExecutionError('host_changed', 'Dev host changed during module loading')
			if ((await sourceHash(file)) !== code.sourceHash)
				throw new ScriptExecutionError('source_changed', 'Script changed during module loading')
			const execute = exports[code.exportName]
			if (typeof execute !== 'function')
				throw new ScriptExecutionError(
					'export_not_callable',
					`Export ${code.exportName} is not a function`,
				)
			const nextDependencies = new Map<string, string>()
			for (const dependency of collectHostImportFiles(options.server, file)) {
				if (
					!isAbsolute(dependency) ||
					dependency.includes('\0') ||
					dependency.includes('/node_modules/')
				)
					continue
				if (nextDependencies.size >= 4096)
					throw new ScriptExecutionError(
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
				throw new ScriptExecutionError(
					'host_changed',
					'Dev host changed while loading dependencies',
				)
			options.assertApplied?.()
			let borrowed: ScriptScope | undefined
			try {
				return await executeHostScript(
					{
						ctx: host.ctx,
						id: input.runId,
						input: input.input,
						script: execute as Parameters<typeof executeHostScript>[0]['script'],
						extendSdk(scope) {
							borrowed = scope
							scopes.add(scope)
							return createProjectSdk(host.ctx, scope)
						},
					},
					run,
				)
			} finally {
				if (borrowed) scopes.delete(borrowed)
			}
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
			invalidateHostModuleGraphFiles(options.server, [file])
			invalidateHostModule(options.server, file)
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
			server.executor.abortScripts('host_changed')
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
