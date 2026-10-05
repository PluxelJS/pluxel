import { resolve } from 'node:path'
import type { PluginConstructor } from '@pluxel/core'
import type { PluginSource } from '@pluxel/host/sources'
import { openPluginSources, type PluginSourceChange } from './source-session'
import {
	pluginSourceCovers,
	pluginSourceKey,
	collectPluginModuleExports,
} from '@pluxel/host/internal'
import type { ViteDevServer } from 'vite'
import { collectHostImportFiles, importHostModule } from './environment'

type ApplicationSources = {
	plugins: readonly PluginConstructor[]
	sources?: readonly PluginSource[]
}
type SourceSession = Awaited<ReturnType<typeof openPluginSources>>
type SourceSlot = {
	declarations: readonly PluginSource[]
	abort: AbortController
	opening: Promise<SourceSession>
	session?: SourceSession
	state: 'pending' | 'active' | 'closed'
	buffered: Map<string, PluginSourceChange>
	closing?: Promise<void>
}

export type HostSourceCandidate<T extends ApplicationSources> = Readonly<{
	application: Omit<T, 'plugins'> & { plugins: readonly PluginConstructor[] }
	declarationsChanged: boolean
	files: Set<string>
	sourceFiles: Set<string>
	sourceModules: Set<string>
	/** Switches source admission before draining the previous watcher. Idempotent. */
	accept(): Promise<void>
	/** Releases only candidate-owned discovery. Does not undo an accepted catalog. */
	reject(): Promise<void>
}>

/** Stages source discovery alongside module evaluation; catalog acceptance remains the Host's decision. */
export function createHostSourceEvaluator(options: {
	server: ViteDevServer
	root: string
	onChange(change: PluginSourceChange): void
	onError(error: unknown): void
	/** Records separate evaluation roots before loading can fail. */
	onEntry?(path: string): void
}) {
	let active: SourceSlot | undefined
	let closed = false
	let closing: Promise<void> | undefined
	const slots = new Set<SourceSlot>()
	const closeSlot = (slot: SourceSlot): Promise<void> => {
		slot.state = 'closed'
		slot.abort.abort()
		return (slot.closing ??= (async () => {
			try {
				const session = await slot.opening.catch((): undefined => undefined)
				await session?.close()
			} finally {
				slots.delete(slot)
			}
		})())
	}
	const openSlot = (declarations: readonly PluginSource[]): SourceSlot => {
		const slot = {
			declarations: Object.freeze([...declarations]),
			abort: new AbortController(),
			state: 'pending',
			buffered: new Map(),
		} as SourceSlot
		slots.add(slot)
		slot.opening = openPluginSources({
			root: options.root,
			sources: declarations,
			signal: slot.abort.signal,
			onError(error) {
				if (slot.state !== 'closed' && !closed) options.onError(error)
			},
			onChange(change) {
				if (slot.state === 'closed' || closed) return
				if (slot.state === 'active') options.onChange(change)
				else slot.buffered.set(change.path, change)
			},
		}).then((session) => {
			slot.session = session
			return session
		})
		return slot
	}
	return {
		/** True for declared entry paths, including absent paths and currently staged declarations. */
		covers(path: string): boolean {
			return [...slots].some(
				(slot) =>
					slot.state !== 'closed' &&
					(slot.session
						? slot.session.covers(path)
						: slot.declarations.some((source) =>
								pluginSourceCovers({
									source,
									root: options.root,
									requirement: { kind: 'file', path },
								}),
							)),
			)
		},
		async evaluate<T extends ApplicationSources>(input: {
			application: T
			entryFiles: ReadonlySet<string>
		}): Promise<HostSourceCandidate<T>> {
			if (closed) throw new Error('[host-vite] source evaluator is closed')
			const declarations = input.application.sources ?? []
			for (const declaration of declarations)
				if (declaration.kind === 'file') options.onEntry?.(resolve(options.root, declaration.path))
			const slot =
				active && sameSources(active.declarations, declarations) ? active : openSlot(declarations)
			const owned = slot !== active
			let settled = false
			try {
				const session = await slot.opening
				const entries = await session.entries()
				// Changes before the snapshot are already represented by it.
				if (owned) slot.buffered.clear()
				const sourceFiles = new Set(entries)
				const sourceModules = new Set<string>()
				const files = new Set(input.entryFiles)
				const plugins = [...input.application.plugins]
				const seen = new Set(plugins)
				for (const path of entries) {
					options.onEntry?.(path)
					const namespace = await importHostModule(options.server, path)
					const definitions = collectPluginModuleExports(namespace)
					if (definitions.length === 0)
						throw new TypeError(
							`[host-vite] Plugin source exports no lowered Plugin definitions: ${path}`,
						)
					for (const plugin of definitions)
						if (!seen.has(plugin)) {
							seen.add(plugin)
							plugins.push(plugin)
						}
					for (const file of collectHostImportFiles(options.server, path)) {
						files.add(file)
						sourceModules.add(file)
					}
				}
				if (closed || slot.state === 'closed')
					throw new Error('[host-vite] source evaluation closed')
				return {
					application: { ...input.application, plugins },
					declarationsChanged: owned,
					files,
					sourceFiles,
					sourceModules,
					async accept() {
						if (settled) return
						settled = true
						if (!owned) return
						if (closed) {
							await closeSlot(slot)
							return
						}
						const previous = active
						active = slot
						slot.state = 'active'
						for (const change of slot.buffered.values()) options.onChange(change)
						slot.buffered.clear()
						if (previous) await closeSlot(previous)
					},
					async reject() {
						if (settled) return
						settled = true
						if (owned) await closeSlot(slot)
					},
				}
			} catch (error) {
				if (owned) {
					const [cleanup] = await Promise.allSettled([closeSlot(slot)])
					if (cleanup.status === 'rejected' && cleanup.reason !== error)
						throw new AggregateError(
							[error, cleanup.reason],
							'[host-vite] source evaluation and cleanup failed',
							{ cause: error },
						)
				}
				throw error
			}
		},
		close(): Promise<void> {
			closed = true
			return (closing ??= (async () => {
				const results = await Promise.allSettled([...slots].map(closeSlot))
				const errors = results.flatMap((result) =>
					result.status === 'rejected' ? [result.reason] : [],
				)
				if (errors.length > 0)
					throw new AggregateError(errors, '[host-vite] source evaluator shutdown failed')
			})())
		},
	}
}

function sameSources(left: readonly PluginSource[], right: readonly PluginSource[]): boolean {
	return (
		left.length === right.length &&
		left.every(
			(source, index) =>
				source === right[index] || pluginSourceKey(source) === pluginSourceKey(right[index]!),
		)
	)
}
