import type { ProjectScript } from '@pluxel/host-vite/project'
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
	const studio = await sdk.plugin(sdk.dev.address(ReportStudioPlugin)).status()
	if (!studio) throw new Error('ReportStudioPlugin is not registered')
	const session = sdk.dev.ctx.require(WorkbenchHost).createSession(principal, () => {})
	try {
		using target = new RpcStub(session.target)
		const layout = await readWorkbenchLayout(target, { target: null })
		const targetLayout = await readWorkbenchLayout(target, { target: studio.address })
		using opened = await openLocalWorkbenchEntry(sdk.dev.ctx, {
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
}) satisfies ProjectScript

/** Stop/restart are explicit online operations, used to verify browser epoch invalidation. */
export const stopStudio = (async (sdk) => {
	const { stop, status } = sdk.plugin(sdk.dev.address(ReportStudioPlugin))
	return { report: await stop(), current: await status() }
}) satisfies ProjectScript
export const startStudio = (async (sdk) => {
	const { start, status } = sdk.plugin(sdk.dev.address(ReportStudioPlugin))
	return { report: await start(), current: await status() }
}) satisfies ProjectScript

/** Compare authoritative package snapshots before/after browser-only input drafts. */
export const packageManagerSnapshot = ((sdk) =>
	sdk.dev.instance(PackageManagerPlugin).snapshot()) satisfies ProjectScript

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
	using opened = await openLocalWorkbenchEntry(sdk.dev.ctx, {
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
}) satisfies ProjectScript
