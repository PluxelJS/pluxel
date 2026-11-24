import { installOwnerViewService } from '@pluxel/core/host'
import { pluginDefinitionIndexKey, pluginNodeAddressEqual } from '@pluxel/core'
import { startHost, type PluginApplyReport, type PluginHost } from '@pluxel/host/embedded'
import { rules as initialRules } from './catalog'
import { LinkCleaner } from './cleaner'
import { createConfigStorage } from './config-storage'
import { readPreferences } from './preferences'
import { ruleKeys } from './rules'

function checkReport(report: PluginApplyReport) {
	const messages = report.reconciliation.map((issue) => issue.message)
	if (report.core.status === 'committed') {
		for (const issue of report.core.summary.lifecycleReport.issues) messages.push(issue.message)
	}
	if (messages.length > 0) throw new Error(messages.join('\n'))
}

let rules = initialRules
const start = () =>
	startHost(async () => {
		const choices = await readPreferences()
		return {
			services: [
				{
					name: 'LinkCleaner',
					provides: [
						installOwnerViewService(LinkCleaner, {
							createRoot: () => new LinkCleaner(),
							createView: (cleaner) => cleaner,
						}),
					],
				},
			],
			plugins: ruleKeys.map((key) => ({ plugin: rules[key], autoStart: choices[key] })),
			config: { document: { storage: createConfigStorage } },
			policy: { mode: 'saved-first', document: false },
		}
	})
let pageHost: PluginHost | undefined

// Page operations, external preference changes and accepted Vite edits share one queue.
let pending = Promise.resolve()
let closed = false
export function withHost<T>(action: (host: PluginHost, rules: typeof initialRules) => Promise<T>) {
	if (closed) return Promise.reject(new Error('扩展页已关闭'))
	const task = pending.then(async () => {
		pageHost ??= await start()
		return action(pageHost, rules)
	})
	pending = task.then(
		() => undefined,
		() => undefined,
	)
	return task
}

export const cleanLink = (link: string) =>
	withHost(async (host) => {
		const output = host.ctx.service(LinkCleaner).clean(link)
		const entries = host.catalog().byDefinition
		return {
			link: output.link,
			changed: output.changed.map(
				(key) =>
					entries.get(pluginDefinitionIndexKey(rules[key].address()))!.candidate.declaration
						.displayName,
			),
		}
	})

export const applyPreferences = () =>
	withHost(async (host) => {
		const choices = await readPreferences()
		const { statuses } = await host.status()
		for (const key of ruleKeys) {
			const address = rules[key].nodeAddress()
			const current = statuses.find((node) => pluginNodeAddressEqual(node.address, address))
			if (!current) throw new Error(`未找到清理插件：${key}`)
			const enabled = choices[key]
			if (enabled !== current.autoStart) checkReport(await host.setAutoStart(address, enabled))
			// The user's switch controls both the next startup and the current session.
			if (enabled !== (current.lifecycleState === 'running'))
				checkReport(enabled ? await host.startNode(address) : await host.stopNode(address))
		}
	})

export async function close() {
	closed = true
	await pending
	await pageHost?.close()
}

export const catalogUpdates = new EventTarget()
if (import.meta.hot) {
	const { closeOnHotReload } = await import('@pluxel/host-vite/hmr')
	await closeOnHotReload(import.meta.hot, { close })
	import.meta.hot.accept('./catalog', async (next) => {
		try {
			if (!next) throw new Error('插件更新求值失败，请查看 Vite 日志。')
			const candidate = next.rules
			await withHost(async (host) => {
				checkReport(
					await host.updateCatalog(Object.values(candidate), {
						onGraphCommitted() {
							rules = candidate
						},
					}),
				)
			})
			catalogUpdates.dispatchEvent(new Event('updated'))
		} catch (error) {
			catalogUpdates.dispatchEvent(new CustomEvent('updated', { detail: String(error) }))
		}
	})
}
