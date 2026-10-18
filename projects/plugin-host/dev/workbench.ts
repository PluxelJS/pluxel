import { defineDevConsole } from '@pluxel/host-vite/console'
import { openLocalWorkbenchEntry, WorkbenchHost } from '@pluxel/workbench/server'
import { consumeWorkbenchValue, readWorkbenchLayout } from '@pluxel/workbench/client'
import { RpcStub } from 'capnweb'
import { formatPluginNodeRoute, pluginNodeAddressOf } from '@pluxel/core'
import { ReportStudioPlugin } from '../src/showcase/ReportStudio'
import { ReportStudioWorkbench } from '../src/showcase/ReportStudio.workbench'
import { PackageManagerPlugin } from '@pluxel/plugin-package-manager'

const principal = { provider: 'development-console', subject: 'workbench-migration-validation' }

/** Read real publications and exercise a bounded, explicitly owned RPC activation. */
export default defineDevConsole(async (dev) => {
	const plugins = await dev.plugins.list()
	const studio = plugins.find((plugin) => plugin.rootExportName === 'ReportStudioPlugin')
	if (!studio) throw new Error('ReportStudioPlugin is not registered')
	const session = dev.ctx.require(WorkbenchHost).createSession(principal, () => {})
	try {
		using target = new RpcStub(session.target)
		const layout = await readWorkbenchLayout(target, { target: null })
		const targetLayout = await readWorkbenchLayout(target, { target: studio.address })
		using opened = await openLocalWorkbenchEntry(dev.ctx, {
			target: studio.address,
			entry: ReportStudioWorkbench.studio,
			principal,
			location: '/architecture-lab',
			signal: dev.signal,
		})
		return {
			studio,
			studioRoute: formatPluginNodeRoute(studio.address),
			layout: {
				revision: layout.revision,
				entries: layout.entries.map((entry) => ({
					descriptor: entry.descriptor,
					target: entry.target,
					placement: entry.placement,
				})),
			},
			targetLayout: {
				revision: targetLayout.revision,
				entries: targetLayout.entries.map((entry) => ({
					descriptor: entry.descriptor,
					target: entry.target,
					placement: entry.placement,
				})),
			},
			opened: {
				kind: opened.kind,
				params: opened.params,
				producer: opened.federatedViewRef.producer,
			},
			snapshot: await consumeWorkbenchValue(opened.api.snapshotDto(), 'Report Studio snapshot'),
		}
	} finally {
		session.dispose()
	}
})

/** Stop/restart are explicit online operations, used to verify browser epoch invalidation. */
export const stopStudio = defineDevConsole(async (dev) => ({
	report: await dev.plugins.stop(ReportStudioPlugin),
	current: await dev.plugins.status(ReportStudioPlugin),
}))
export const startStudio = defineDevConsole(async (dev) => ({
	report: await dev.plugins.start(ReportStudioPlugin),
	current: await dev.plugins.status(ReportStudioPlugin),
}))

/** Compare authoritative package snapshots before/after browser-only input drafts. */
export const packageManagerSnapshot = defineDevConsole((dev) =>
	dev.plugins.require(PackageManagerPlugin).snapshot(),
)

/** Render through the current Workbench publication, keeping online operations on this console. */
export const renderReport = defineDevConsole(async (dev) => {
	const input = dev.input
	if (
		!input ||
		typeof input !== 'object' ||
		!('title' in input) ||
		typeof input.title !== 'string' ||
		!('engine' in input) ||
		typeof input.engine !== 'string'
	) {
		throw new TypeError('renderReport requires { title, engine }')
	}
	const { SHOWCASE_ENGINES } = await import('../src/showcase/ReportStudio.contracts')
	const engine = SHOWCASE_ENGINES.find((candidate) => candidate === input.engine)
	if (!engine) throw new TypeError('Unknown rendering engine')
	using opened = await openLocalWorkbenchEntry(dev.ctx, {
		target: pluginNodeAddressOf(ReportStudioPlugin),
		entry: ReportStudioWorkbench.studio,
		principal,
		location: '/architecture-lab',
		signal: dev.signal,
	})
	return await consumeWorkbenchValue(
		opened.api.generateDto({ title: input.title, engine }),
		'Report Studio artifact',
	)
})
