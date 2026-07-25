import { describe, expect, it, vi } from 'vitest'
import type {
	WorkbenchBundle,
	WorkbenchCatalog,
	WorkbenchLayout,
	WorkbenchLayoutItem,
} from '@pluxel/runtime/workbench'
import { WorkbenchClientRuntime } from '../src/workbench/client'

const bundle = (hash: string): WorkbenchBundle => ({
	pluginName: 'BotPlugin',
	remoteName: 'bot',
	manifestUrl: '/bot/mf-manifest.json',
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
		ownerPluginId: 'BotPlugin',
		targetPluginId: 'BotPlugin',
		contractFingerprint: input.fingerprint,
		placement: input.placement,
		view: { kind: 'remote', export: input.view },
		priority: 0,
		when: 'running',
		meta: input.path
			? { route: { path: input.path, title: input.view, addToNav: false } }
			: { label: input.view },
		model: {},
	}
}

function layout(revision: number, fingerprint: string): WorkbenchLayout {
	return {
		revision,
		targetPluginId: 'BotPlugin',
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
	const transport = {
		links: { workbenchEvents: () => '/events' },
		http: {
			workbench: {
				pluginLayout: async () => layout(revision, fingerprint),
				globalLayout: async () => ({ revision, targetPluginId: null, items: [] }),
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
		invalidate(nextRevision: number, nextFingerprint: string) {
			revision = nextRevision
			fingerprint = nextFingerprint
			invalidated?.()
		},
	}
}

async function ready(runtime: WorkbenchClientRuntime) {
	if (runtime.getSnapshot('BotPlugin').state === 'ready') return
	await new Promise<void>((resolve) => {
		const unsubscribe = runtime.subscribe('BotPlugin', () => {
			if (runtime.getSnapshot('BotPlugin').state !== 'ready') return
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
		const release = runtime.retain('BotPlugin')
		await ready(runtime)

		const snapshot = runtime.getSnapshot('BotPlugin')
		expect(snapshot.surfaces.get('plugin.tabs')?.map((entry) => entry.id)).toEqual(['panel'])
		expect(runtime.resolveRoute('BotPlugin', '/accounts/alerts%2Fcritical')?.params).toEqual({
			accountId: 'alerts/critical',
		})
		expect(runtime.view('BotPlugin', snapshot.layout!.items[0]!)).toBe(Panel)

		release()
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
		const release = runtime.retain('BotPlugin')
		await ready(runtime)
		source.invalidate(2, 'fp-2')
		await vi.waitFor(() => {
			expect(runtime.getSnapshot('BotPlugin').error?.message).toBe('broken replacement')
		})

		const snapshot = runtime.getSnapshot('BotPlugin')
		expect(snapshot.revision).toBe(1)
		expect(runtime.view('BotPlugin', snapshot.layout!.items[0]!)).toBe(OldPanel)
		expect(cleanup).not.toHaveBeenCalled()
		release()
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
		const release = runtime.retain('BotPlugin')
		await ready(runtime)
		source.invalidate(2, 'fp-2')
		await vi.waitFor(() => {
			expect(runtime.getSnapshot('BotPlugin').error?.message).toBe(
				'[workbench-ui] Contract mismatch for BotPlugin',
			)
		})

		const snapshot = runtime.getSnapshot('BotPlugin')
		expect(snapshot.revision).toBe(1)
		expect(runtime.view('BotPlugin', snapshot.layout!.items[0]!)).toBe(OldPanel)
		expect(cleanup).toHaveBeenCalledOnce()
		release()
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
