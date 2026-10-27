import { pluginNodeAddressOf } from '@pluxel/core'
import { createHost, type PluginHost } from '@pluxel/host/browser'
import { TypstPlugin } from '@pluxel/plugin-typst/wasm'
import compilerWasmUrl from '@myriaddreamin/typst-ts-web-compiler/wasm?url&no-inline'
import rendererWasmUrl from '@myriaddreamin/typst-ts-renderer/wasm?url&no-inline'
import fontUrl from '../../assets/fonts/LXGWWenKai-Regular.ttf?url&no-inline'
import { ReportPlugin } from './report-plugin'
import { ThemePlugin } from './theme-plugin'
import { ThemePlugin as ColorThemePlugin } from './theme-plugin?example-theme=color'
import type { ExampleRequest, ExampleResponse, ThemeVersion } from './protocol'

let host: PluginHost | undefined
let starting: Promise<void> | undefined
let replacing: Promise<void> | undefined

function send(message: ExampleResponse) {
	postMessage(message)
}

async function start() {
	host = await createHost({
		plugins: [TypstPlugin, ThemePlugin, ReportPlugin],
		state: { initial: { autoStart: [pluginNodeAddressOf(ReportPlugin)] } },
		configRecords: {
			initial: [
				{
					owner: pluginNodeAddressOf(TypstPlugin),
					config: {
						compilerWasmUrl: new URL(compilerWasmUrl, self.location.href).href,
						rendererWasmUrl: new URL(rendererWasmUrl, self.location.href).href,
						fontUrls: [new URL(fontUrl, self.location.href).href],
					},
				},
			],
		},
	})
	await host.start()
	const status = await host.status()
	if (status.summary.running !== 3) {
		throw new Error(
			status.statuses.flatMap((plugin) => plugin.issues.map((issue) => issue.message)).join('\n') ||
				'插件未全部启动。',
		)
	}
	send({ type: 'ready', plugins: status.statuses.map((plugin) => plugin.rootExportName) })
}

async function replace(theme: ThemeVersion) {
	await starting
	if (!host) throw new Error('Host 尚未启动。')
	const report = await host.updateCatalog([
		TypstPlugin,
		theme === 'color' ? ColorThemePlugin : ThemePlugin,
		ReportPlugin,
	])
	if (report.reconciliation.length > 0)
		throw new Error(report.reconciliation.map((issue) => issue.message).join('\n'))
	if (report.core.status !== 'committed') throw new Error('插件代码未发生替换。')
	const { pluginChanges, lifecycleReport } = report.core.summary
	if (!lifecycleReport.ok)
		throw new Error(lifecycleReport.issues.map((issue) => issue.message).join('\n'))
	const status = await host.status()
	if (status.summary.running !== 3) throw new Error('热替换后插件未全部运行。')
	const changed = new Set(
		pluginChanges.availabilityChanged.map((node) => node.definition.exportName),
	)
	send({
		type: 'replaced',
		theme,
		catalogRevision: report.catalogRevision,
		replaced: pluginChanges.replaced.map(({ to }) => to.definition.exportName),
		restarted: pluginChanges.restarted.map((node) => node.definition.exportName),
		retained: status.statuses
			.filter((plugin) => !changed.has(plugin.rootExportName))
			.map((plugin) => plugin.rootExportName),
	})
}

async function failed(error: unknown) {
	try {
		await host?.close()
	} finally {
		send({
			type: 'error',
			message: error instanceof Error ? error.message : String(error),
			fatal: true,
		})
	}
}

addEventListener('message', (event: MessageEvent<ExampleRequest>) => {
	if (event.data.type === 'start' && !starting) {
		starting = start().catch(failed)
	} else if (event.data.type === 'replace') {
		replacing = replace(event.data.theme).catch(failed)
	} else if (event.data.type === 'stop') {
		void (async () => {
			try {
				await starting
				await replacing
				await host?.close()
				send({ type: 'stopped' })
			} catch (error) {
				send({
					type: 'error',
					message: error instanceof Error ? error.message : String(error),
					fatal: true,
				})
			}
		})()
	}
})
