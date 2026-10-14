// @vitest-environment jsdom

import { StrictMode, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Workbench } from '@worksplit/react'
import { Actions, Model } from 'flexlayout-react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceSession, defaultWorkspaceLayout } from '../src/app/workbench/session'
import {
	WorkspacePersistence,
	WorkspaceSnapshotStorage,
	WorkspaceRestoreError,
	workspaceStorageKey,
} from '../src/app/workbench/snapshot'
import {
	prepareNativeWorkbenchDom,
	WorkspaceProviders,
	openDocument,
} from './helpers/native-workbench'

vi.mock('../src/app/log_viewer/LogPreview', () => ({ LogPreview: () => null }))
vi.mock('../src/app/log_viewer/LogsPage', () => ({
	LogsPage: () => <input aria-label="日志过滤" defaultValue="error" />,
}))
vi.mock('../src/app/security/SecurityScreen', () => ({
	SecurityScreen: () => <input aria-label="安全配置" />,
}))
vi.mock('../src/app/workbench/WorkspaceNavigation', () => ({ WorkspaceNavigation: () => null }))

const roots: Root[] = []
const workspaces: WorkspaceSession[] = []
beforeEach(() => {
	prepareNativeWorkbenchDom()
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
	window.localStorage.clear()
})
afterEach(async () => {
	await act(async () => {
		for (const root of roots.splice(0)) root.unmount()
		for (const session of workspaces.splice(0)) await session.dispose()
	})
	document.body.replaceChildren()
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
	vi.useRealTimers()
})

async function mount(
	options: { strict?: boolean; storage?: WorkspaceSnapshotStorage; basepath?: string } = {},
) {
	const workspace = new WorkspaceSession({
		storage: options.storage,
		basepath: options.basepath ?? '/',
	})
	workspaces.push(workspace)
	const container = document.body.appendChild(document.createElement('div'))
	const root = createRoot(container)
	roots.push(root)
	const content = (
		<WorkspaceProviders session={workspace}>
			<WorkspacePersistence />
			<Workbench workbench={workspace.workbench} />
		</WorkspaceProviders>
	)
	await act(async () => {
		root.render(options.strict ? <StrictMode>{content}</StrictMode> : content)
		await workspace.start(`${workspace.basepath === '/' ? '' : workspace.basepath}/logs`, false)
	})
	return { workspace, root, container }
}
const saved = (basepath = '/') =>
	JSON.parse(window.localStorage.getItem(workspaceStorageKey(basepath))!)

describe('native Workbench snapshot persistence', () => {
	it('coalesces native changes into the latest snapshot without persisting draft, dirty or Router resources', async () => {
		const write = vi.spyOn(Storage.prototype, 'setItem')
		const { workspace } = await mount()
		const first = workspace.workbench.getActiveDocument()!.id
		const second = await openDocument(workspace, '/security')
		await act(async () => {
			await workspace.workbench.dispatch(Actions.addTabToNewGroup(first, 'Diagnostics', '#3366cc'))
			await workspace.workbench.dispatch(Actions.setTabPinned(second, true))
		})
		expect(write).not.toHaveBeenCalled()
		await act(async () => vi.advanceTimersByTime(180))
		expect(write).toHaveBeenCalledTimes(1)
		expect(saved()).toEqual(workspace.workbench.snapshot())
		const raw = JSON.stringify(saved())
		expect(raw).not.toMatch(/dirty|draft|router|openedHandle|RpcStub/)
		workspace.documents.get(first)!.remoteDirty = true
		workspace.notifyContentState()
		await act(async () => vi.advanceTimersByTime(180))
		expect(write).toHaveBeenCalledTimes(1)
	})

	it.each(['pagehide', 'visibilitychange', 'session teardown'])(
		'flushes pending native changes on %s and releases storage listeners',
		async (event) => {
			const write = vi.spyOn(Storage.prototype, 'setItem')
			const { workspace } = await mount()
			await openDocument(workspace, '/security')
			const snapshot = workspace.workbench.snapshot()
			await act(async () => {
				if (event === 'session teardown') await workspace.dispose()
				else if (event === 'visibilitychange') {
					vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
					document.dispatchEvent(new Event('visibilitychange'))
				} else window.dispatchEvent(new Event('pagehide'))
			})
			expect(write).toHaveBeenCalledTimes(1)
			expect(saved()).toEqual(snapshot)
			await act(async () => {
				vi.advanceTimersByTime(180)
				await workspace.dispose()
			})
			window.dispatchEvent(new Event('pagehide'))
			expect(write).toHaveBeenCalledTimes(1)
		},
	)

	it('does not repeat identical writes after StrictMode replay', async () => {
		const write = vi.spyOn(Storage.prototype, 'setItem')
		const { workspace } = await mount({ strict: true })
		await act(async () => vi.advanceTimersByTime(180))
		expect(write).toHaveBeenCalledTimes(1)
		workspace.storage.schedule()
		workspace.storage.schedule()
		await act(async () => vi.advanceTimersByTime(180))
		expect(write).toHaveBeenCalledTimes(1)
	})

	it('restores native groups, pin state and geometry from a new workspace-specific snapshot', async () => {
		const { workspace } = await mount({ basepath: '/__pluxel/workbench' })
		const first = workspace.workbench.getActiveDocument()!.id
		const second = await openDocument(workspace, '/security')
		await act(async () => {
			await workspace.workbench.dispatch(Actions.addTabToNewGroup(first, 'Research', '#3366cc'))
			await workspace.workbench.dispatch(Actions.setTabPinned(second, true))
			await workspace.workbench.dispatch(Actions.updateNodeAttributes('border_left', { size: 320 }))
		})
		workspace.storage.flush()
		const snapshot = saved('/__pluxel/workbench')
		const restored = new WorkspaceSession({ basepath: '/__pluxel/workbench' })
		workspaces.push(restored)
		expect(restored.workbench.snapshot()).toEqual(snapshot)
		const model = Model.fromJson(restored.workbench.getLayout())
		expect(model.getNodeById(second)?.toJson()).toMatchObject({ pinned: true })
		expect(model.getNodeById(first)?.getParent()?.toJson()).toMatchObject({
			type: 'tabgroup',
			name: 'Research',
			color: '#3366cc',
		})
		expect(model.getNodeById('border_left')?.toJson()).toMatchObject({ size: 320 })
		expect(window.localStorage.getItem(workspaceStorageKey('/'))).toBeNull()
	})

	it.each([
		'{invalid JSON',
		JSON.stringify({ version: 7, workspaceId: 'pluxel:/', layout: defaultWorkspaceLayout() }),
		JSON.stringify({
			version: 1,
			workspaceId: 'another-workspace',
			layout: defaultWorkspaceLayout(),
		}),
		JSON.stringify({ version: 1, workspaceId: 'pluxel:/', layout: { global: {}, layout: {} } }),
	])(
		'preserves malformed or incompatible restore data and reports an explicit recovery boundary: %s',
		(raw) => {
			const key = workspaceStorageKey('/')
			window.localStorage.setItem(key, raw)
			const storage = new WorkspaceSnapshotStorage(key)
			expect(() => new WorkspaceSession({ storage, basepath: '/' })).toThrow(WorkspaceRestoreError)
			expect(storage.blocked).toBe(true)
			expect(window.localStorage.getItem(key)).toBe(raw)
			storage.schedule()
			storage.retry()
			vi.advanceTimersByTime(180)
			expect(window.localStorage.getItem(key)).toBe(raw)
			expect(storage.reset()).toBe(true)
			expect(window.localStorage.getItem(key)).toBeNull()
			expect(storage.blocked).toBe(false)
		},
	)

	it('ignores the removed grid persistence key without reading or rewriting it', async () => {
		const legacy = '{"version":4,"state":{"tabs":[{"path":"/obsolete"}]}}'
		window.localStorage.setItem('pluxel:workbench:ui', legacy)
		const { workspace } = await mount()
		expect(workspace.workbench.getDocuments().map((document) => document.href)).toEqual(['/logs'])
		await act(async () => vi.advanceTimersByTime(180))
		expect(window.localStorage.getItem('pluxel:workbench:ui')).toBe(legacy)
		expect(saved().version).toBe(1)
	})

	it('keeps editing when storage is unavailable, publishes a bounded error and retries the latest snapshot', async () => {
		let available = false
		const backend = {
			getItem: vi.fn(() => {
				if (!available) throw new Error('storage unavailable')
				return null
			}),
			setItem: vi.fn((_key: string, _value: string) => {
				if (!available) throw new Error('storage unavailable')
			}),
			removeItem: vi.fn(),
		}
		const storage = new WorkspaceSnapshotStorage(workspaceStorageKey('/'), backend)
		const listener = vi.fn()
		storage.subscribe(listener)
		const { workspace, container } = await mount({ storage })
		expect(container.querySelector('[aria-label="日志过滤"]')).not.toBeNull()
		await act(async () => vi.advanceTimersByTime(180))
		expect(storage.getSnapshot()).toContain('storage unavailable')
		expect(listener).toHaveBeenCalledTimes(1)
		await openDocument(workspace, '/security')
		await act(async () => vi.advanceTimersByTime(180))
		expect(workspace.workbench.getDocuments()).toHaveLength(2)
		expect(listener).toHaveBeenCalledTimes(1)
		available = true
		storage.retry()
		expect(storage.getSnapshot()).toBeUndefined()
		expect(listener).toHaveBeenCalledTimes(2)
		expect(JSON.parse(backend.setItem.mock.calls.at(-1)![1])).toEqual(
			workspace.workbench.snapshot(),
		)
	})
})
