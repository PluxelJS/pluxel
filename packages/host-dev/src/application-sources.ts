import type { PluginConstructor } from '@pluxel/core'
import type { PluginSource, PluginSourceChange } from '@pluxel/host'
import { collectPluginModuleExports, openPluginSources } from '@pluxel/host/internal'
import type { ViteDevServer } from 'vite'
import { collectViteSsrImportFiles, importViteSsrModule } from './runner.ts'

type ApplicationSources = {
	plugins: readonly PluginConstructor[]
	sources?: readonly PluginSource[]
}
type SourceSession = Awaited<ReturnType<typeof openPluginSources>>
type SourceSlot = {
	declarations: readonly PluginSource[]
	abort: AbortController
	opening: Promise<SourceSession>
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
		})
		return slot
	}
	return {
		/** True for declared entry paths, including absent paths and currently staged declarations. */
		covers(path: string): boolean {
			return [...slots].some(
				(slot) =>
					slot.state !== 'closed' &&
					slot.declarations.some((source) =>
						source.covers({ root: options.root, requirement: { kind: 'file', path } }),
					),
			)
		},
		async evaluate<T extends ApplicationSources>(input: {
			application: T
			entryFiles: ReadonlySet<string>
		}): Promise<HostSourceCandidate<T>> {
			if (closed) throw new Error('[host-dev] source evaluator is closed')
			const declarations = input.application.sources ?? []
			const slot =
				active && sameSources(active.declarations, declarations) ? active : openSlot(declarations)
			const owned = slot !== active
			let settled = false
			try {
				const session = await slot.opening
				const entries = session.entries()
				// Changes before the snapshot are already represented by it.
				if (owned) slot.buffered.clear()
				const sourceFiles = new Set(entries)
				const sourceModules = new Set<string>()
				const files = new Set(input.entryFiles)
				const plugins = [...input.application.plugins]
				for (const path of entries) {
					options.onEntry?.(path)
					const namespace = await importViteSsrModule(options.server, path)
					plugins.push(...collectPluginModuleExports(namespace))
					for (const file of collectViteSsrImportFiles(options.server, path)) {
						files.add(file)
						sourceModules.add(file)
					}
				}
				if (closed || slot.state === 'closed')
					throw new Error('[host-dev] source evaluation closed')
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
					try {
						await closeSlot(slot)
					} catch (cleanupError) {
						if (cleanupError !== error)
							throw new AggregateError(
								[error, cleanupError],
								'[host-dev] source evaluation and cleanup failed',
								{ cause: cleanupError },
							)
					}
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
					throw new AggregateError(errors, '[host-dev] source evaluator shutdown failed')
			})())
		},
	}
}

function sameSources(left: readonly PluginSource[], right: readonly PluginSource[]): boolean {
	return (
		left.length === right.length &&
		left.every(
			(source, index) =>
				source === right[index] ||
				(typeof source.key === 'string' && source.key === right[index]?.key),
		)
	)
}
