import { dirname, resolve } from 'node:path'
import { createHost, resolveHostApplication, prepareHostApplication } from '@pluxel/host'
import { requirePluginService } from '@pluxel/core/internal'
import { StudioPlugin } from '@report-template-studio/app/plugin'
import { StudioRpcCarrier } from '../rpc/carrier.js'
import type { StudioMessagePort } from '../rpc/message-port.js'
import type { DesktopApi } from '../shared/contracts.js'
import application from './application.ts'

export interface BackendConfig {
	/** Application state directory. Template project roots are selected through the business API. */
	root: string
	/** Bundled financial-document-assets directory, including seed templates and fonts. */
	assetsRoot: string
	/** Optional same-user IPC discovery directory shared with external clients. */
	discoveryDirectory?: string
}
export interface StudioBackend {
	readonly api: DesktopApi
	/** Reports current readiness immediately and each replacement generation. Unsubscribe to stop. */
	onReady(listener: () => void): () => void
	connectDesktopPort(port: StudioMessagePort, options?: { native?: boolean }): () => void
	close(): Promise<void>
}

/** One long-lived Host; only local IPC is accepted, without Electron or an HTTP listener. */
export async function startBackend(config: BackendConfig): Promise<StudioBackend> {
	const carrier = await StudioRpcCarrier.create(config)
	let host: Awaited<ReturnType<typeof createHost>> | undefined
	try {
		const resolved = await resolveHostApplication(application, {
			root: dirname(resolve(config.assetsRoot)),
			mode: 'production',
			env: process.env,
			bindings: { ...config, root: carrier.root },
		})
		host = await createHost({
			plugins: resolved.plugins,
			services: resolved.services,
			config: resolved.config,
			configRecords: resolved.configRecords,
			state: resolved.state,
			vaultBindings: resolved.vaultBindings,
		})
		await prepareHostApplication(resolved, host)
		const report = await host.start()
		if (
			report.reconciliation.length > 0 ||
			(report.core.status === 'committed' && !report.core.summary.lifecycleReport.ok)
		)
			throw new Error(`Studio failed to start: ${JSON.stringify(report)}`)
		const registry = requirePluginService(host.ctx)
		const plugin = registry.getInstance(StudioPlugin)
		if (!plugin) throw new Error('StudioPlugin did not become ready')
		carrier.setApi(plugin, () => registry.getInstance(StudioPlugin))
		await carrier.publish()
		return {
			get api() {
				return carrier.api
			},
			connectDesktopPort: (port, options) => carrier.connectDesktopPort(port, options),
			onReady: (listener) => carrier.onReady(listener),
			close: () => carrier.close(() => host!.close()),
		}
	} catch (error) {
		await carrier.close(() => host?.close() ?? Promise.resolve())
		throw error
	}
}
