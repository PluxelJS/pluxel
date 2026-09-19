import type { PluginDefinitionAddress } from '@pluxel/core'
import type { PluginHost } from '@pluxel/host'
import type { PluginSourceVitePipeline } from '@pluxel/rolldown/vite'
import type { ViteDevServer } from 'vite'

/** Evaluated application catalog inputs; attachments must not infer candidates from the old Host catalog. */
export type HostDevelopmentCatalog = Readonly<{
	modules: Iterable<string>
	definitions: readonly PluginDefinitionAddress[]
}>

export type HostDevelopmentCandidate = Readonly<{ commit(): unknown; rollback(): void }>
export type HostDevelopmentAttachment = Readonly<{
	dispose?(): void | Promise<void>
	/** True only for source files owned by this attachment. */
	tracks?(file: string): boolean
	/** Prepare privately; commit synchronously at graph acceptance, before new Plugin startup. Roll back only before acceptance. */
	prepareCandidate?(catalog: HostDevelopmentCatalog): Promise<HostDevelopmentCandidate>
}>

/** Vite plugin API for resources attached after Host preparation and before Plugin activation. */
export type HostDevelopmentPluginApi = Readonly<{
	pluxelHost: Readonly<{
		/** Runs in resolved Vite plugin order for every Host, including replacement and compensation. */
		attach(
			input: Readonly<{
				host: PluginHost
				server: ViteDevServer
				semantics: PluginSourceVitePipeline['semantics']
				/** Exact evaluated modules and selected definitions for this candidate. */
				catalog: HostDevelopmentCatalog
			}>,
		):
			| void
			| (() => void | Promise<void>)
			| HostDevelopmentAttachment
			| Promise<void | (() => void | Promise<void>) | HostDevelopmentAttachment>
	}>
}>

export async function attachHostDevelopmentPlugins(
	host: PluginHost,
	server: ViteDevServer,
	semantics: PluginSourceVitePipeline['semantics'],
	initialCatalog: HostDevelopmentCatalog,
): Promise<
	Readonly<{
		tracks(file: string): boolean
		prepareCandidate(catalog: HostDevelopmentCatalog): Promise<HostDevelopmentCandidate>
	}>
> {
	const attachments: HostDevelopmentAttachment[] = []
	for (const plugin of server.config.plugins) {
		const api = (plugin.api as Partial<HostDevelopmentPluginApi> | undefined)?.pluxelHost
		if (!api) continue
		if (typeof api.attach !== 'function')
			throw new TypeError(`[host-dev] ${plugin.name}: api.pluxelHost.attach must be a function`)
		const result = await api.attach({ host, server, semantics, catalog: initialCatalog })
		if (result === undefined) continue
		const attachment = typeof result === 'function' ? { dispose: result } : result
		if (
			!attachment ||
			typeof attachment !== 'object' ||
			(attachment.dispose !== undefined && typeof attachment.dispose !== 'function') ||
			(attachment.prepareCandidate !== undefined &&
				typeof attachment.prepareCandidate !== 'function')
		) {
			throw new TypeError(
				`[host-dev] ${plugin.name}: attach must return cleanup or a development attachment`,
			)
		}
		if (attachment.dispose) {
			const dispose = () => attachment.dispose!()
			try {
				host.ctx.effects.defer(dispose)
			} catch (error) {
				try {
					await dispose()
				} catch (cleanupError) {
					throw new AggregateError([error, cleanupError], '[host-dev] attachment cleanup failed', {
						cause: cleanupError,
					})
				}
				throw error
			}
		}
		attachments.push(attachment)
	}
	return Object.freeze({
		tracks: (file: string) => attachments.some((attachment) => attachment.tracks?.(file) === true),
		async prepareCandidate(catalog) {
			const prepared: HostDevelopmentCandidate[] = []
			try {
				for (const attachment of attachments) {
					const candidate = await attachment.prepareCandidate?.(catalog)
					if (candidate) prepared.push(candidate)
				}
			} catch (error) {
				const errors = settleCandidates(prepared.toReversed(), 'rollback')
				if (errors.length > 0)
					throw new AggregateError(
						[error, ...errors],
						'[host-dev] candidate preparation cleanup failed',
						{ cause: error },
					)
				throw error
			}
			let state: 'prepared' | 'committed' | 'discarded' = 'prepared'
			return Object.freeze({
				commit() {
					if (state !== 'prepared') return
					state = 'committed'
					const errors = settleCandidates(prepared, 'commit')
					if (errors.length > 0)
						throw new AggregateError(errors, '[host-dev] candidate commit failed', {
							cause: errors[0],
						})
				},
				rollback() {
					if (state !== 'prepared') return
					state = 'discarded'
					const errors = settleCandidates(prepared.toReversed(), 'rollback')
					if (errors.length > 0)
						throw new AggregateError(errors, '[host-dev] candidate rollback failed', {
							cause: errors[0],
						})
				},
			})
		},
	})
}

function settleCandidates(
	candidates: readonly HostDevelopmentCandidate[],
	action: 'commit' | 'rollback',
): unknown[] {
	const errors: unknown[] = []
	for (const candidate of candidates) {
		try {
			candidate[action]()
		} catch (error) {
			errors.push(error)
		}
	}
	return errors
}
