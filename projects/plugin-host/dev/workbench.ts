import type { Script } from '@pluxel/agent-sdk/host'
import { openLocalWorkbenchEntry, WorkbenchHost } from '@pluxel/workbench/server'
import { consumeWorkbenchValue, readWorkbenchLayout } from '@pluxel/workbench/client'
import { RpcStub } from 'capnweb'
import { formatPluginNodeRoute } from '@pluxel/core'
import { ReportStudioPlugin } from '../src/showcase/ReportStudio'
import { ReportStudioWorkbench } from '../src/showcase/ReportStudio.workbench'
import { PackageManagerPlugin } from '@pluxel/plugin-package-manager'

const principal = { provider: 'development-console', subject: 'workbench-migration-validation' }

/** Read real publications and exercise a bounded, explicitly owned RPC activation. */
export default (async (sdk, run) => {
	const studio = await sdk.plugin(ReportStudioPlugin.nodeAddress()).status()
	if (!studio) throw new Error('ReportStudioPlugin is not registered')
	const session = sdk.ctx.service(WorkbenchHost).createSession(principal, () => {})
	try {
		using target = new RpcStub(session.target)
		const layout = await readWorkbenchLayout(target, { target: null })
		const targetLayout = await readWorkbenchLayout(target, { target: studio.address })
		using opened = await openLocalWorkbenchEntry(sdk.ctx.service(WorkbenchHost), {
			target: studio.address,
			entry: ReportStudioWorkbench.studio,
			principal,
			location: '/architecture-lab',
			signal: run.signal,
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
}) satisfies Script

/** Stop/restart are explicit online operations, used to verify browser epoch invalidation. */
export const stopStudio = (async (sdk) => {
	const { stop, status } = sdk.plugin(ReportStudioPlugin.nodeAddress())
	const report = await stop()
	const current = await status()
	return { report, current }
}) satisfies Script
export const startStudio = (async (sdk) => {
	const { start, status } = sdk.plugin(ReportStudioPlugin.nodeAddress())
	const report = await start()
	const current = await status()
	return { report, current }
}) satisfies Script

/** Compare authoritative package snapshots before/after browser-only input drafts. */
export const packageManagerSnapshot = (async (sdk) => {
	const { instance } = await sdk.plugin(PackageManagerPlugin.nodeAddress()).instance()
	return instance.snapshot()
}) satisfies Script

/** Render through the current Workbench publication, keeping online operations on this console. */
export const renderReport = (async (sdk, run) => {
	const input = run.input
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
	using opened = await openLocalWorkbenchEntry(sdk.ctx.service(WorkbenchHost), {
		target: ReportStudioPlugin.nodeAddress(),
		entry: ReportStudioWorkbench.studio,
		principal,
		location: '/architecture-lab',
		signal: run.signal,
	})
	return await consumeWorkbenchValue(
		opened.api.generateDto({ title: input.title, engine }),
		'Report Studio artifact',
	)
}) satisfies Script
