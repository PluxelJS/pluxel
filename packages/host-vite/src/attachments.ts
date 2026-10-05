import type { HostViteProfile } from './profile'
import type { PluginDefinitionAddress, PluginConstructor } from '@pluxel/core'
import type { PluginHost } from '@pluxel/host'
import type { PluginSourceVitePipeline } from '@pluxel/rolldown/vite'
import type { ViteDevServer } from 'vite'

/** Evaluated application catalog inputs; attachments must not infer candidates from the old Host catalog. */
export type HostViteCatalog = Readonly<{
	/** Verified compiled factory output, when the application uses modules delivery. */
	applicationModule?: string
	plugins: readonly PluginConstructor[]
	modules: Iterable<string>
	definitions: readonly PluginDefinitionAddress[]
}>

/** Both operations settle synchronously; asynchronous artifact work belongs to prepareCandidate. */
export type HostViteCandidate = Readonly<{ commit(): undefined; rollback(): undefined }>
type PreparedHostViteCandidate = {
	name: string
	commit?: () => unknown
	rollback(): unknown
}

/** Methods are captured with their creating owner when attach resolves. */
export type HostViteAttachment = Readonly<{
	dispose?(): void | Promise<void>
	/** Synchronous boolean, true only for source files owned by this attachment. */
	tracks?(file: string): boolean
	/** Prepare privately; commit synchronously at graph acceptance, before new Plugin startup. Roll back only before acceptance. */
	prepareCandidate?(catalog: HostViteCatalog): Promise<HostViteCandidate>
}>

/** Vite plugin API for resources attached after Host preparation and before Plugin activation. */
export type HostVitePluginApi = Readonly<{
	pluxelHost: Readonly<{
		/** Runs in resolved Vite plugin order for every Host, including replacement and compensation. */
		attach(
			input: Readonly<{
				host: PluginHost
				server: ViteDevServer
				/** Owned by the execution entry, including package selection and artifact strictness. */
				profile: HostViteProfile
				semantics: PluginSourceVitePipeline['semantics']
				/** Exact evaluated modules and selected definitions for this candidate. */
				catalog: HostViteCatalog
			}>,
		):
			| void
			| (() => void | Promise<void>)
			| HostViteAttachment
			| Promise<void | (() => void | Promise<void>) | HostViteAttachment>
	}>
}>

export async function attachHostVitePlugins(
	host: PluginHost,
	server: ViteDevServer,
	semantics: PluginSourceVitePipeline['semantics'],
	initialCatalog: HostViteCatalog,
	profile: HostViteProfile,
): Promise<
	Readonly<{
		tracks(file: string): boolean
		prepareCandidate(catalog: HostViteCatalog): Promise<HostViteCandidate>
	}>
> {
	const attachments: Array<{ name: string; attachment: HostViteAttachment }> = []
	for (const plugin of server.config.plugins) {
		const api = (plugin.api as Partial<HostVitePluginApi> | undefined)?.pluxelHost
		if (!api) continue
		if (typeof api.attach !== 'function')
			throw new TypeError(`[host-vite] ${plugin.name}: api.pluxelHost.attach must be a function`)
		const result = await api.attach({ host, server, semantics, catalog: initialCatalog, profile })
		if (result === undefined) continue
		const attachment = typeof result === 'function' ? { dispose: result } : result
		if (!attachment || typeof attachment !== 'object') {
			throw new TypeError(
				`[host-vite] ${plugin.name}: attach must return cleanup or a development attachment`,
			)
		}
		const disposeCallback = attachment.dispose
		if (disposeCallback !== undefined && typeof disposeCallback !== 'function')
			throw new TypeError(`[host-vite] ${plugin.name}: attachment dispose must be a function`)
		if (disposeCallback) {
			const dispose = () => disposeCallback.call(attachment)
			try {
				host.ctx.effects.defer(dispose)
			} catch (error) {
				try {
					await dispose()
				} catch (cleanupError) {
					throw new AggregateError([error, cleanupError], '[host-vite] attachment cleanup failed', {
						cause: cleanupError,
					})
				}
				throw error
			}
		}
		const tracks = attachment.tracks
		const prepareCandidate = attachment.prepareCandidate
		if (
			(tracks !== undefined && typeof tracks !== 'function') ||
			(prepareCandidate !== undefined && typeof prepareCandidate !== 'function')
		)
			throw new TypeError(
				`[host-vite] ${plugin.name}: attachment tracks and prepareCandidate must be functions`,
			)
		attachments.push({
			name: plugin.name,
			attachment: {
				tracks: tracks?.bind(attachment),
				prepareCandidate: prepareCandidate?.bind(attachment),
			},
		})
	}
	const observeAsyncSettlement = (
		result: PromiseLike<unknown>,
		tag = 'InvalidViteCandidate',
	): void => {
		const settled = Promise.resolve(result).then((): undefined => undefined)
		// The invalid callback has already begun work. Supervise it immediately and drain it
		// with its creating Host, preserving a later rejection instead of leaking or awaiting commit.
		void settled.catch(() => {})
		host.ctx.effects.defer(() => settled, { tag, phase: 'shutdown' })
	}
	return Object.freeze({
		tracks: (file: string) =>
			attachments.some(({ name, attachment }) => {
				if (attachment.tracks === undefined) return false
				const result: unknown = attachment.tracks(file)
				if (typeof result === 'boolean') return result
				if (isPromiseLike(result)) observeAsyncSettlement(result, 'InvalidViteTracks')
				throw new TypeError(
					`[host-vite] ${name}: tracks(${file}) must return a boolean synchronously`,
				)
			}),
		async prepareCandidate(catalog) {
			const prepared: PreparedHostViteCandidate[] = []
			try {
				for (const { name, attachment } of attachments) {
					if (attachment.prepareCandidate === undefined) continue
					const candidate = await attachment.prepareCandidate(catalog)
					if (!candidate || typeof candidate !== 'object')
						throw new TypeError(
							`[host-vite] ${name}: prepareCandidate must return synchronous commit() and rollback()`,
						)
					const rollback = candidate.rollback
					if (typeof rollback !== 'function')
						throw new TypeError(
							`[host-vite] ${name}: prepareCandidate must return synchronous commit() and rollback()`,
						)
					const owned: PreparedHostViteCandidate = { name, rollback: rollback.bind(candidate) }
					prepared.push(owned)
					const commit = candidate.commit
					if (typeof commit !== 'function')
						throw new TypeError(
							`[host-vite] ${name}: prepareCandidate must return synchronous commit() and rollback()`,
						)
					owned.commit = commit.bind(candidate)
				}
			} catch (error) {
				const errors = settleCandidates(prepared.toReversed(), 'rollback', observeAsyncSettlement)
				if (errors.length > 0)
					throw new AggregateError(
						[error, ...errors],
						'[host-vite] candidate preparation cleanup failed',
						{ cause: error },
					)
				throw error
			}
			let state: 'prepared' | 'committed' | 'discarded' = 'prepared'
			return Object.freeze({
				commit(): undefined {
					if (state !== 'prepared') return
					state = 'committed'
					const errors = settleCandidates(prepared, 'commit', observeAsyncSettlement)
					if (errors.length > 0)
						throw new AggregateError(errors, '[host-vite] candidate commit failed', {
							cause: errors[0],
						})
				},
				rollback(): undefined {
					if (state !== 'prepared') return
					state = 'discarded'
					const errors = settleCandidates(prepared.toReversed(), 'rollback', observeAsyncSettlement)
					if (errors.length > 0)
						throw new AggregateError(errors, '[host-vite] candidate rollback failed', {
							cause: errors[0],
						})
				},
			})
		},
	})
}

function settleCandidates(
	candidates: readonly PreparedHostViteCandidate[],
	action: 'commit' | 'rollback',
	observeAsync: (result: PromiseLike<unknown>) => void,
): unknown[] {
	const errors: unknown[] = []
	for (const candidate of candidates) {
		const { name } = candidate
		try {
			const callback = candidate[action]
			if (callback === undefined)
				throw new TypeError(`[host-vite] ${name}: candidate ${action} is unavailable`)
			const result = callback()
			if (result !== undefined) {
				if (isPromiseLike(result)) observeAsync(result)
				throw new TypeError(
					`[host-vite] ${name}: candidate ${action} must return undefined synchronously`,
				)
			}
		} catch (error) {
			errors.push(error)
		}
	}
	return errors
}

function isPromiseLike(result: unknown): result is PromiseLike<unknown> {
	return (
		result !== null &&
		(typeof result === 'object' || typeof result === 'function') &&
		'then' in result &&
		typeof result.then === 'function'
	)
}
