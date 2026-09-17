import type { PluginHost } from '@pluxel/host'
import type { PluginSourceVitePipeline } from '@pluxel/rolldown/vite'
import type { ViteDevServer } from 'vite'

export type HostDevelopmentCandidate = Readonly<{ commit(): unknown; rollback(): void }>
export type HostDevelopmentAttachment = Readonly<{
	dispose?(): void | Promise<void>
	/** True only for source files owned by this attachment. */
	tracks?(file: string): boolean
	/** Prepare privately; Host commits only after its catalog accepts this same candidate. */
	prepareCandidate?(): Promise<HostDevelopmentCandidate>
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
): Promise<
	Readonly<{ tracks(file: string): boolean; prepareCandidate(): Promise<HostDevelopmentCandidate> }>
> {
	const attachments: HostDevelopmentAttachment[] = []
	for (const plugin of server.config.plugins) {
		const api = (plugin.api as Partial<HostDevelopmentPluginApi> | undefined)?.pluxelHost
		if (!api) continue
		if (typeof api.attach !== 'function')
			throw new TypeError(`[host-dev] ${plugin.name}: api.pluxelHost.attach must be a function`)
		const result = await api.attach({ host, server, semantics })
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
				await dispose()
				throw error
			}
		}
		attachments.push(attachment)
	}
	return Object.freeze({
		tracks: (file: string) => attachments.some((attachment) => attachment.tracks?.(file) === true),
		async prepareCandidate() {
			const prepared: HostDevelopmentCandidate[] = []
			try {
				for (const attachment of attachments) {
					const candidate = await attachment.prepareCandidate?.()
					if (candidate) prepared.push(candidate)
				}
			} catch (error) {
				for (const candidate of prepared.toReversed()) candidate.rollback()
				throw error
			}
			let state: 'prepared' | 'committed' | 'discarded' = 'prepared'
			return Object.freeze({
				commit() {
					if (state !== 'prepared') return
					state = 'committed'
					for (const candidate of prepared) candidate.commit()
				},
				rollback() {
					if (state !== 'prepared') return
					state = 'discarded'
					for (const candidate of prepared.toReversed()) candidate.rollback()
				},
			})
		},
	})
}
