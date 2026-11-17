// @vitest-environment jsdom

import type { PluginNodeAddress } from '@pluxel/core'
import type {
	WorkbenchContentLayoutEntry,
	WorkbenchLayout,
	WorkbenchLayoutEntry,
	WorkbenchShortcut,
} from '@pluxel/workbench/client'
import { Workbench } from '@worksplit/react'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceSession } from '../src/app/workbench/session'
import { ActivityRail } from '../src/app/workbench/ActivityRail'
import { WorkspaceNavigation } from '../src/app/workbench/WorkspaceNavigation'
import { resolveSidebarShortcut } from '../src/app/workbench/sidebarShortcuts'
import {
	WorkspacePersistence,
	WorkspaceRestoreError,
	WorkspaceSnapshotStorage,
	workspaceStorageKey,
} from '../src/app/workbench/snapshot'
import { prepareNativeWorkbenchDom, renderWorkspace } from './helpers/native-workbench'
import {
	compileWorkbenchSnapshot,
	type WorkbenchTargetSnapshot,
} from '../src/workbench/client-snapshot'
import { buildPluginDetailHref, buildWorkbenchHref } from '../src/workbench/paths'
import { createWorkbenchRouteDirectory } from '../src/workbench/route-directory'

const source = vi.hoisted(() => ({ snapshot: undefined as WorkbenchTargetSnapshot | undefined }))
vi.mock('../src/workbench/runtime', async (importOriginal) => ({
	...(await importOriginal<typeof import('../src/workbench/runtime')>()),
	useWorkbenchTargetSnapshot: () => source.snapshot,
}))
vi.mock('../src/app/plugins/pluginOverview', () => ({
	usePluginOverview: () => ({ overview: null, isLoading: false }),
}))

vi.mock('../src/app/log_viewer/LogPreview', () => ({ LogPreview: () => null }))
vi.mock('../src/app/log_viewer/LogsPage', () => ({
	LogsPage: () => <div>Sidebar preference document</div>,
}))
vi.mock('@mantine/modals', async (importOriginal) => ({
	...(await importOriginal<typeof import('@mantine/modals')>()),
	openConfirmModal: ({ onConfirm }: { onConfirm: () => void }) => onConfirm(),
}))

const marketNode: PluginNodeAddress = {
	definition: {
		entry: { kind: 'package-root', packageName: '@example/market' },
		exportName: 'MarketPlugin',
	},
	variant: 'default',
}
const east: PluginNodeAddress = {
	definition: {
		entry: { kind: 'package-root', packageName: '@example/accounts' },
		exportName: 'AccountsPlugin',
	},
	variant: 'fork',
	forkId: 'east',
}
const west: PluginNodeAddress = { ...east, forkId: 'west' }
const market: WorkbenchShortcut = { target: marketNode, entryKey: 'market' }
const eastAccount: WorkbenchShortcut = {
	target: east,
	entryKey: 'account',
	location: '/accounts/alice',
}
const westAccount: WorkbenchShortcut = { ...eastAccount, target: west }
const sessions = new Set<WorkspaceSession>()
const roots = new Set<Root>()

function publication(
	target: PluginNodeAddress,
	key: string,
	placement: WorkbenchLayoutEntry['placement'],
): WorkbenchContentLayoutEntry {
	const descriptor = { kind: 'content' as const, owner: target.definition, key }
	return {
		descriptor,
		target: { node: target, displayName: target.definition.exportName },
		definitionRevisions: { target: 1 },
		placement,
		contentRef: { profile: 1, digest: 'a'.repeat(64), descriptor },
	}
}

function layout(entries: readonly WorkbenchLayoutEntry[]): WorkbenchLayout {
	return { profile: 1, revision: 1, target: null, entries }
}

function resolve(shortcut: WorkbenchShortcut, entries: readonly WorkbenchLayoutEntry[]) {
	return resolveSidebarShortcut(shortcut, layout(entries), createWorkbenchRouteDirectory(entries))
}

beforeEach(() => {
	prepareNativeWorkbenchDom()
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
	window.localStorage.clear()
	source.snapshot = compileWorkbenchSnapshot(null, layout([]))
})
afterEach(async () => {
	await act(async () => {
		for (const root of roots) root.unmount()
		roots.clear()
		for (const session of sessions) await session.dispose()
		sessions.clear()
	})
	document.body.replaceChildren()
	window.localStorage.clear()
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
	vi.useRealTimers()
})

async function mount(initialShortcuts: readonly WorkbenchShortcut[] = [market]) {
	const session = new WorkspaceSession({ basepath: '/', initialShortcuts })
	sessions.add(session)
	const { root } = await renderWorkspace(
		session,
		<>
			<WorkspacePersistence />
			<Workbench instance={session.workbench} />
		</>,
	)
	roots.add(root)
	await act(async () => {
		const started = await session.start('/logs', false)
		expect(started.status).toBe('applied')
	})
	return {
		session,
		async close() {
			await act(async () => {
				root.unmount()
				roots.delete(root)
				await session.dispose()
				sessions.delete(session)
			})
		},
	}
}

async function flushPreferences() {
	await act(async () => vi.advanceTimersByTime(180))
}

describe('user sidebar shortcuts in the native workspace snapshot', () => {
	it('adopts Host defaults on the first visit and saves them with native layout preferences', async () => {
		const { session } = await mount()
		expect(session.sidebarShortcuts()).toEqual([market])
		expect(session.isSidebarShortcut(structuredClone(market))).toBe(true)
		await flushPreferences()
		const raw = window.localStorage.getItem(workspaceStorageKey('/'))
		expect(raw).not.toBeNull()
		const snapshot = JSON.parse(raw!)
		expect(
			snapshot.layout.borders.find((border: { location: string }) => border.location === 'left'),
		).toMatchObject({ config: { shortcuts: [market] } })
	})

	it('keeps one shortcut per exact owner and entry while distinguishing forks', async () => {
		const { session } = await mount([])
		await act(async () => {
			await session.setSidebarShortcut(eastAccount, true)
			await session.setSidebarShortcut(structuredClone(eastAccount), true)
			await session.setSidebarShortcut(westAccount, true)
		})
		expect(session.sidebarShortcuts()).toEqual([eastAccount, westAccount])
		await act(async () => session.setSidebarShortcut(structuredClone(eastAccount), false))
		expect(session.isSidebarShortcut(eastAccount)).toBe(false)
		expect(session.isSidebarShortcut(westAccount)).toBe(true)
		expect(session.sidebarShortcuts()).toEqual([westAccount])
	})

	it('restores user additions and removals instead of merging changed Host defaults', async () => {
		const first = await mount()
		await act(async () => {
			await first.session.setSidebarShortcut(eastAccount, true)
			await first.session.setSidebarShortcut(market, false)
		})
		await flushPreferences()
		await first.close()
		const { session } = await mount([market, westAccount])
		expect(session.sidebarShortcuts()).toEqual([eastAccount])
		expect(session.isSidebarShortcut(market)).toBe(false)
		expect(session.isSidebarShortcut(westAccount)).toBe(false)
	})

	it('keeps an explicitly empty sidebar empty after saving and reopening', async () => {
		const first = await mount()
		await act(async () => first.session.setSidebarShortcut(market, false))
		expect(first.session.sidebarShortcuts()).toEqual([])
		await flushPreferences()
		await first.close()
		const { session } = await mount()
		expect(session.sidebarShortcuts()).toEqual([])
		expect(session.isSidebarShortcut(market)).toBe(false)
	})

	it('initializes a missing preference without discarding the saved native navigation mode', async () => {
		const first = await mount([])
		await act(async () => first.session.setNavigationMode('labels'))
		const snapshot = first.session.workbench.createSnapshot()
		await first.close()
		const border = snapshot.layout.borders!.find((candidate) => candidate.location === 'left')!
		delete border.config.shortcuts
		window.localStorage.setItem(workspaceStorageKey('/'), JSON.stringify(snapshot))
		const { session } = await mount()
		expect(session.sidebarShortcuts()).toEqual([market])
		expect(session.navigationMode()).toBe('labels')
	})

	it.each(['invalid target', 'duplicate identity'] as const)(
		'rejects %s in persisted preferences and preserves the original recovery data',
		async (corruption) => {
			const first = await mount()
			const snapshot = first.session.workbench.createSnapshot()
			await first.close()
			const border = snapshot.layout.borders!.find((candidate) => candidate.location === 'left')!
			border.config.shortcuts =
				corruption === 'invalid target'
					? [{ target: { variant: 'default' }, entryKey: 'market' }]
					: [market, structuredClone(market)]
			const raw = JSON.stringify(snapshot)
			const key = workspaceStorageKey('/')
			window.localStorage.setItem(key, raw)
			const storage = new WorkspaceSnapshotStorage(key)
			expect(
				() => new WorkspaceSession({ basepath: '/', storage, initialShortcuts: [market] }),
			).toThrow(WorkspaceRestoreError)
			expect(storage.blocked).toBe(true)
			storage.schedule()
			storage.retry()
			await flushPreferences()
			expect(window.localStorage.getItem(key)).toBe(raw)
		},
	)

	it('restores Host defaults only after the user explicitly resets the workspace layout', async () => {
		const first = await mount()
		await act(async () => {
			await first.session.setSidebarShortcut(eastAccount, true)
			await first.session.setSidebarShortcut(market, false)
		})
		await flushPreferences()
		const assign = vi.fn()
		const pageLocation = globalThis.location
		vi.stubGlobal('location', { assign })
		await act(async () => {
			expect(await first.session.resetLayout()).toBe(true)
		})
		expect(assign).toHaveBeenCalledWith('/')
		await first.close()
		vi.stubGlobal('location', pageLocation)
		const { session } = await mount()
		expect(session.sidebarShortcuts()).toEqual([market])
		expect(session.isSidebarShortcut(eastAccount)).toBe(false)
	})

	it('refreshes both the activity rail and application pin control after the user pins and removes an entry', async () => {
		const { session } = await mount([])
		source.snapshot = compileWorkbenchSnapshot(
			null,
			layout([
				publication(marketNode, 'market', {
					kind: 'route',
					path: '/market',
					title: 'Marketplace',
					navigation: { label: 'Marketplace' },
					frame: 'shell',
					order: 0,
				}),
			]),
		)
		const { root, container } = await renderWorkspace(
			session,
			<>
				<ActivityRail onShowPlugins={() => undefined} />
				<WorkspaceNavigation mode="publications" />
			</>,
		)
		roots.add(root)
		const rail = container.querySelector('nav[aria-label="工作区入口"]')!
		expect(rail.querySelector('button[aria-label="Marketplace"]')).toBeNull()
		const pin = container.querySelector<HTMLButtonElement>(
			'button[aria-label="固定到侧栏 Marketplace"]',
		)!
		expect(pin).not.toBeNull()
		await act(async () => pin.click())
		expect(session.sidebarShortcuts()).toEqual([market])
		expect(rail.querySelector('button[aria-label="Marketplace"]')).not.toBeNull()
		expect(
			container.querySelector('button[aria-label="取消侧栏固定 Marketplace"][aria-pressed="true"]'),
		).not.toBeNull()
		const remove = rail.querySelector<HTMLButtonElement>(
			'button[aria-label="取消侧栏固定 Marketplace"]',
		)!
		await act(async () => remove.click())
		expect(session.sidebarShortcuts()).toEqual([])
		expect(rail.querySelector('button[aria-label="Marketplace"]')).toBeNull()
		expect(
			container.querySelector('button[aria-label="固定到侧栏 Marketplace"][aria-pressed="false"]'),
		).not.toBeNull()
	})
})

describe('sidebar shortcut resolution against current committed publications', () => {
	it('resolves the exact owner, fork and entry and uses its current label and icon', () => {
		const unrelated: PluginNodeAddress = { ...east, definition: marketNode.definition }
		const entries = [
			publication(west, 'account', { kind: 'tab', label: 'West account', order: 0 }),
			publication(unrelated, 'account', { kind: 'tab', label: 'Other plugin', order: 0 }),
			publication(east, 'another', { kind: 'tab', label: 'Other entry', order: 0 }),
			publication(east, 'account', { kind: 'tab', label: 'East account', icon: 'users', order: 0 }),
		]
		expect(resolve({ target: east, entryKey: 'account' }, entries)).toEqual({
			label: 'East account',
			icon: 'users',
			href: `${buildPluginDetailHref(east)}?entry=account`,
		})
	})

	it('keeps a withdrawn shortcut unavailable without substituting another fork or rewriting its identity', () => {
		const shortcut = structuredClone(eastAccount)
		const saved = JSON.stringify(shortcut)
		const active = publication(east, 'account', {
			kind: 'route',
			path: '/accounts/:id',
			title: 'Account',
			frame: 'shell',
			order: 0,
		})
		expect(resolve(shortcut, [active]).href).toBe('/accounts/alice')
		const replacement = publication(west, 'account', active.placement)
		const unavailable = resolve(shortcut, [replacement])
		expect(unavailable.href).toBeUndefined()
		expect(unavailable.unavailable).toBeTruthy()
		expect(JSON.stringify(shortcut)).toBe(saved)
	})

	it('opens a concrete parameter route and preserves the saved query and fragment', () => {
		const entry = publication(east, 'account', {
			kind: 'route',
			path: '/accounts/:id',
			title: 'Account',
			frame: 'shell',
			order: 0,
		})
		expect(
			resolve({ ...eastAccount, location: '/accounts/alice?view=events#latest' }, [entry]),
		).toEqual({ label: 'Account', href: '/accounts/alice?view=events#latest' })
	})

	it.each([undefined, '/accounts/:id', '/different/alice'])(
		'keeps an unbound or mismatched parameter route unavailable: %s',
		(location) => {
			const entry = publication(east, 'account', {
				kind: 'route',
				path: '/accounts/:id',
				title: 'Account',
				frame: 'shell',
				order: 0,
			})
			const result = resolve(
				{ target: east, entryKey: 'account', ...(location ? { location } : {}) },
				[entry],
			)
			expect(result.href).toBeUndefined()
			expect(result.unavailable).toBeTruthy()
		},
	)

	it('uses the canonical owner URL when a route conflicts and returns to the short URL after the conflict withdraws', () => {
		const entry = publication(east, 'account', {
			kind: 'route',
			path: '/accounts/:id',
			title: 'Account',
			frame: 'shell',
			order: 0,
		})
		const conflict = publication(west, 'account', entry.placement)
		expect(resolve(eastAccount, [conflict, entry]).href).toBe(
			buildWorkbenchHref(east, '/accounts/alice'),
		)
		expect(resolve(eastAccount, [entry]).href).toBe('/accounts/alice')
	})
})
