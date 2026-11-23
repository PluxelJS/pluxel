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
import { WorkspaceSession } from '../../src/app/workbench/session'
import { ActivityRail } from '../../src/app/workbench/ActivityRail'
import { PinnedApplications } from '../../src/app/workbench/PinnedApplications'
import { WorkspaceNavigation } from '../../src/app/workbench/WorkspaceNavigation'
import { resolveSidebarShortcut, sidebarShortcutId } from '../../src/app/workbench/sidebarShortcuts'
import {
	WorkspacePersistence,
	WorkspaceRestoreError,
	WorkspaceSnapshotStorage,
	workspaceStorageKey,
} from '../../src/app/workbench/snapshot'
import { prepareNativeWorkbenchDom, renderWorkspace } from '../fixtures/native-workbench'
import {
	compileWorkbenchSnapshot,
	type WorkbenchTargetSnapshot,
} from '../../src/workbench/client-snapshot'
import { buildWorkbenchHref } from '../../src/workbench/paths'
import { createWorkbenchRouteDirectory } from '../../src/workbench/route-directory'

const source = vi.hoisted(() => ({ snapshot: undefined as WorkbenchTargetSnapshot | undefined }))
vi.mock('../../src/workbench/runtime', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../src/workbench/runtime')>()),
	useWorkbenchTargetSnapshot: () => source.snapshot,
}))
vi.mock('../../src/app/plugins/pluginOverview', () => ({
	usePluginOverview: () => ({ overview: null, isLoading: false }),
}))

vi.mock('../../src/app/log_viewer/LogPreview', () => ({ LogPreview: () => null }))
vi.mock('../../src/app/log_viewer/LogsPage', () => ({
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
	it('restores user additions, removals and order instead of merging changed Host defaults', async () => {
		const first = await mount()
		await act(async () => {
			await first.session.setSidebarShortcut(eastAccount, true)
			await first.session.setSidebarShortcut(westAccount, true)
			await first.session.setSidebarShortcut(market, false)
			await first.session.moveSidebarShortcut(
				sidebarShortcutId(westAccount),
				sidebarShortcutId(eastAccount),
			)
		})
		await flushPreferences()
		await first.close()
		const { session } = await mount([market, eastAccount, westAccount])
		expect(session.sidebarShortcuts()).toEqual([westAccount, eastAccount])
		expect(session.isSidebarShortcut(market)).toBe(false)
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

	it('keeps the pinned column, activity rail and catalog in sync through the leading pin controls', async () => {
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
				<PinnedApplications />
				<WorkspaceNavigation mode="publications" />
			</>,
		)
		roots.add(root)
		const rail = container.querySelector('nav[aria-label="工作区入口"]')!
		const pinned = container.querySelector('section[aria-label="已固定到侧栏"]')!
		const apps = rail.querySelector('a[aria-label="应用"]')
		expect(apps?.getAttribute('href')).toBe('/apps')
		expect(rail.querySelector('[role="separator"]')?.nextElementSibling).toBe(apps)
		expect(rail.querySelector('[aria-label="Marketplace"]')).toBeNull()
		expect(pinned.querySelector('[role="listitem"]')).toBeNull()
		const pin = container.querySelector<HTMLButtonElement>(
			'button[aria-label="固定到侧栏 Marketplace"]',
		)!
		expect(pin).not.toBeNull()
		const config = pin.nextElementSibling!
		expect(config.getAttribute('aria-label')).toBe('打开插件配置 MarketPlugin')
		expect(config.nextElementSibling?.getAttribute('aria-label')).toBe('Marketplace')
		await act(async () => pin.click())
		expect(session.sidebarShortcuts()).toEqual([market])
		expect(apps?.nextElementSibling?.getAttribute('aria-label')).toBe('Marketplace')
		expect(apps?.nextElementSibling?.getAttribute('href')).toBe('/market')
		expect(
			container.querySelector('button[aria-label="取消侧栏固定 Marketplace"][aria-pressed="true"]'),
		).not.toBeNull()
		expect(rail.querySelector('button[aria-label="取消侧栏固定 Marketplace"]')).toBeNull()
		const remove = pinned.querySelector<HTMLButtonElement>(
			'button[aria-label="取消侧栏固定 Marketplace"]',
		)!
		expect(remove.previousElementSibling?.getAttribute('aria-label')).toBe('排序 Marketplace')
		expect(remove.nextElementSibling?.getAttribute('aria-label')).toBe('Marketplace')
		expect(container.querySelector('[role="dialog"]')).toBeNull()
		await act(async () => remove.click())
		expect(session.sidebarShortcuts()).toEqual([])
		expect(rail.querySelector('[aria-label="Marketplace"]')).toBeNull()
		expect(pinned.querySelector('[role="listitem"]')).toBeNull()
		expect(
			container.querySelector('button[aria-label="固定到侧栏 Marketplace"][aria-pressed="false"]'),
		).not.toBeNull()
	})
})

describe('sidebar shortcut resolution against current committed publications', () => {
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
