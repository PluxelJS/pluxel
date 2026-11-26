import { defineHostApplication, installOwnerViewService } from '@pluxel/host/application'
import { createWorkerHost } from '@pluxel/host/cloudflare'
import { closeOnHotReload } from '@pluxel/host-vite/hmr'
import { MarketDeployment } from './deployment'
import { MarketPlugin } from './market-plugin'

export let market = MarketPlugin

const application = defineHostApplication(({ env }) => ({
	name: 'Plugin Market',
	plugins: [{ plugin: market, autoStart: true }],
	services: [
		{
			name: 'Market deployment',
			provides: [
				installOwnerViewService(MarketDeployment, {
					createRoot: () => new MarketDeployment(env),
					createView: (deployment) => deployment,
				}),
			],
		},
	],
}))

export const host = createWorkerHost(application)
if (import.meta.hot) {
	await closeOnHotReload(import.meta.hot, host)
	import.meta.hot.accept('./market-plugin', async (next) => {
		if (!next?.MarketPlugin) throw new Error('Market plugin update failed to evaluate')
		const plugin: typeof MarketPlugin = next.MarketPlugin
		const report = await host.updateCatalog(() => [plugin], {
			onGraphCommitted() {
				market = plugin
			},
		})
		if (report?.reconciliation.length)
			throw new Error(report.reconciliation.map(({ message }) => message).join('\n'))
		if (report?.core.status === 'committed' && !report.core.summary.lifecycleReport.ok)
			throw new Error(
				report.core.summary.lifecycleReport.issues.map(({ message }) => message).join('\n'),
			)
	})
}
