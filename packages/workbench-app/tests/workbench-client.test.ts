import { describe, expect, it, vi } from 'vitest'
import type { PluginNodeAddressSnapshot } from '@pluxel/core'
import type {
	WorkbenchBundle,
	WorkbenchCatalog,
	WorkbenchLayout,
	WorkbenchLayoutItem,
} from '@pluxel/runtime/workbench'
import { WorkbenchClientRuntime } from '../src/workbench/client'

const botAddress = {
	definition: {
		entry: { kind: 'source-entry', source: 'tests/BotPlugin.ts' },
		exportName: 'BotPlugin',
	},
	instance: 'default',
} as const satisfies PluginNodeAddressSnapshot
const botDescriptor = {
	address: botAddress,
	displayName: 'BotPlugin',
	rootExportName: 'BotPlugin',
} as const

const bundle = (hash: string): WorkbenchBundle => ({
	owner: botDescriptor,
	remoteName: 'bot',
	remoteEntryUrl: '/bot/remoteEntry.js',
	exposedModule: 'workbench',
	sourceHash: hash,
	compiledAt: 1,
})

function item(input: {
	id: string
	view: string
	placement: 'plugin.tabs' | 'plugin.routes'
	fingerprint: string
	path?: string
}): WorkbenchLayoutItem {
	return {
		id: input.id,
		viewId: input.view,
		owner: botDescriptor,
		target: botDescriptor,
		contractFingerprint: input.fingerprint,
		placement: input.placement,
		view: { kind: 'remote', export: input.view },
		priority: 0,
		meta: input.path
			? { route: { path: input.path, title: input.view, addToNav: false } }
			: { label: input.view },
		model: {},
	}
}

function layout(revision: number, fingerprint: string): WorkbenchLayout {
	return {
		revision,
		target: botDescriptor,
		items: [
			item({ id: 'panel', view: 'Panel', placement: 'plugin.tabs', fingerprint }),
			item({
				id: 'account',
				view: 'Account',
				placement: 'plugin.routes',
				fingerprint,
				path: '/accounts/:accountId',
			}),
		],
	}
}

function fixture() {
	let revision = 1
	let fingerprint = 'fp-1'
	let invalidated: (() => void) | undefined
	const close = vi.fn()
	const pluginLayout = vi.fn(async () => layout(revision, fingerprint))
	const transport = {
		links: { workbenchEvents: () => '/events' },
		http: {
			workbench: {
				pluginLayout,
				globalLayout: async () => ({ revision, target: null, items: [] }),
				catalog: async (): Promise<WorkbenchCatalog> => ({
					revision,
					bundles: [bundle(`hash-${revision}`)],
					states: [],
				}),
			},
		},
		createSse: () => ({
			onOpen: () => () => {},
			onError: () => () => {},
			ns: () => ({
				on: (listener: () => void) => {
					invalidated = listener
					return () => {}
				},
			}),
			close,
		}),
	} as never
	return {
		transport,
		close,
		pluginLayout,
		invalidate(nextRevision: number, nextFingerprint: string) {
			revision = nextRevision
			fingerprint = nextFingerprint
			invalidated?.()
		},
	}
}

async function ready(runtime: WorkbenchClientRuntime) {
	if (runtime.getSnapshot(botAddress).state === 'ready') return
	await new Promise<void>((resolve) => {
		const unsubscribe = runtime.subscribe(botAddress, () => {
			if (runtime.getSnapshot(botAddress).state !== 'ready') return
			unsubscribe()
			resolve()
		})
	})
}

describe('WorkbenchClientRuntime', () => {
	it('publishes one target snapshot for surfaces, routes, and module views', async () => {
		const source = fixture()
		const Panel = () => null
		const Account = () => null
		const runtime = new WorkbenchClientRuntime(source.transport, locale, async () => ({
			contractFingerprint: 'fp-1',
			views: { Panel, Account },
		}))
		const release = runtime.retain(botAddress)
		await ready(runtime)

		const snapshot = runtime.getSnapshot(botAddress)
		expect(snapshot.surfaces.get('plugin.tabs')?.map((entry) => entry.id)).toEqual(['panel'])
		expect(runtime.resolveRoute(botAddress, '/accounts/alerts%2Fcritical')?.params).toEqual({
			accountId: 'alerts/critical',
		})
		expect(runtime.view(botAddress, snapshot.layout!.items[0]!)).toBe(Panel)

		release()
		await Promise.resolve()
		expect(source.close).toHaveBeenCalledOnce()
	})

	it('reuses an in-flight target across React effect cleanup replay', async () => {
		const source = fixture()
		const loadModule = vi.fn(async () => ({
			contractFingerprint: 'fp-1',
			views: { Panel: () => null, Account: () => null },
		}))
		const runtime = new WorkbenchClientRuntime(source.transport, locale, loadModule)

		const releaseFirstEffect = runtime.retain(botAddress)
		releaseFirstEffect()
		const releaseReplayedEffect = runtime.retain(botAddress)
		await ready(runtime)
		await Promise.resolve()

		expect(source.pluginLayout).toHaveBeenCalledOnce()
		expect(loadModule).toHaveBeenCalledOnce()
		expect(runtime.getSnapshot(botAddress).state).toBe('ready')
		expect(source.close).not.toHaveBeenCalled()

		releaseReplayedEffect()
		await Promise.resolve()
		expect(source.close).toHaveBeenCalledOnce()
	})

	it('retains the last complete target revision when a replacement setup fails', async () => {
		const source = fixture()
		const cleanup = vi.fn()
		const OldPanel = () => null
		const runtime = new WorkbenchClientRuntime(source.transport, locale, async (artifact) => {
			if (artifact.sourceHash === 'hash-2') {
				return {
					contractFingerprint: 'fp-2',
					views: { Panel: () => null, Account: () => null },
					setup: () => {
						throw new Error('broken replacement')
					},
				}
			}
			return {
				contractFingerprint: 'fp-1',
				views: { Panel: OldPanel, Account: () => null },
				setup: () => cleanup,
			}
		})
		const release = runtime.retain(botAddress)
		await ready(runtime)
		source.invalidate(2, 'fp-2')
		await vi.waitFor(() => {
			expect(runtime.getSnapshot(botAddress).error?.message).toBe('broken replacement')
		})

		const snapshot = runtime.getSnapshot(botAddress)
		expect(snapshot.revision).toBe(1)
		expect(runtime.view(botAddress, snapshot.layout!.items[0]!)).toBe(OldPanel)
		expect(cleanup).not.toHaveBeenCalled()
		release()
		await Promise.resolve()
		expect(cleanup).toHaveBeenCalledOnce()
	})

	it('retains the last complete target revision when a replacement does not match its layout', async () => {
		const source = fixture()
		const cleanup = vi.fn()
		const OldPanel = () => null
		const runtime = new WorkbenchClientRuntime(source.transport, locale, async (artifact) => ({
			contractFingerprint: artifact.sourceHash === 'hash-2' ? 'stale-fingerprint' : 'fp-1',
			views: { Panel: OldPanel, Account: () => null },
			setup: () => cleanup,
		}))
		const release = runtime.retain(botAddress)
		await ready(runtime)
		source.invalidate(2, 'fp-2')
		await vi.waitFor(() => {
			expect(runtime.getSnapshot(botAddress).error?.message).toBe(
				'[workbench-ui] Contract mismatch for BotPlugin',
			)
		})

		const snapshot = runtime.getSnapshot(botAddress)
		expect(snapshot.revision).toBe(1)
		expect(runtime.view(botAddress, snapshot.layout!.items[0]!)).toBe(OldPanel)
		expect(cleanup).toHaveBeenCalledOnce()
		release()
		await Promise.resolve()
		expect(cleanup).toHaveBeenCalledTimes(2)
	})
})

const locale = {
	locale: 'en',
	setLocale: () => {},
	subscribe: () => () => {},
	formatDate: (value: Date | number) => String(value),
	formatNumber: (value: number) => String(value),
}
