// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'
import { Workbench, useWorkbenchContentLifecycle } from '@worksplit/react'
import { Actions, Model, type BorderNode } from 'flexlayout-react'
import { useMemo } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../src/renderer/api'
import { editorLifecycle } from '../src/renderer/editor-lifecycle'
import { WorkspaceContext, useWorkspace } from '../src/renderer/workspace-context'
import { StudioSession } from '../src/renderer/workbench-session'
import { studioDocument } from '../src/renderer/workbench-routes'
import { App } from '../src/renderer/app'

vi.mock('../src/renderer/api', () => ({
	onDesktopConnectionChange: vi.fn(),
	api: { getTree: vi.fn(), readFile: vi.fn(), writeFile: vi.fn(), listProjects: vi.fn() },
}))
vi.mock('../src/renderer/assistant', () => ({ AssistantPanel: () => <div>Assistant</div> }))
vi.mock('../src/renderer/panes', () => ({
	FilePane: ({ path }: { path: string }) => <Editor path={path} />,
	FormPane: ({ entry }: { entry: string }) => <Editor path={entry} />,
	PreviewPane: () => <div>Preview</div>,
}))
function Editor({ path }: { path: string }) {
	const workspace = useWorkspace()
	useWorkbenchContentLifecycle(
		useMemo(() => editorLifecycle(workspace, path, 'file'), [workspace, path]),
	)
	return <div data-testid={`editor-${path}`}>{path}</div>
}
const sessions: StudioSession[] = []
function setup() {
	const session = new StudioSession({ id: 'project', name: 'Project', root: '/project' })
	sessions.push(session)
	return session
}
beforeEach(() => {
	vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
		() => new DOMRect(0, 0, 1000, 800),
	)
	vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000)
	vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(800)
	vi.stubGlobal(
		'ResizeObserver',
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	)
	vi.stubGlobal('scrollTo', vi.fn())
	vi.stubGlobal(
		'matchMedia',
		vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })),
	)
	vi.mocked(api.getTree).mockResolvedValue({
		project: { id: 'project', name: 'Project', root: '/project' },
		revision: 'r1',
		entries: [{ path: 'notes', kind: 'directory', version: 'v1', size: 0 }],
		documents: [],
		config: { name: 'Project', fonts: [] },
	})
})
afterEach(async () => {
	cleanup()
	await Promise.all(sessions.splice(0).map((session) => session.dispose()))
	vi.restoreAllMocks()
	vi.resetAllMocks()
	vi.unstubAllGlobals()
})

describe('Studio project operations through the public Worksplit API', () => {
	it('runs workspace shortcuts only after the focused content has had a chance to consume them', async () => {
		vi.mocked(api.listProjects).mockResolvedValue([
			{ id: 'project', name: 'Project', root: '/project' },
		])
		const start = vi.spyOn(StudioSession.prototype, 'start')
		render(
			<MantineProvider>
				<App />
			</MantineProvider>,
		)
		fireEvent.click(await screen.findByText('Project', { exact: true }))
		await screen.findByRole('textbox', { name: '筛选文件和文件夹' })
		await waitFor(() => expect(start).toHaveBeenCalledOnce())
		const opened = start.mock.contexts[0]
		if (!(opened instanceof StudioSession))
			throw new Error('The app did not start a Studio session')
		sessions.push(opened)
		const search = screen.getByRole('button', { name: '搜索代码视图' })
		const explorer = screen.getByRole('button', { name: '资源管理器' })
		// Native editors such as ProseMirror and Monaco handle keys below React's root.
		// Exercise actual DOM propagation into App's window listener, without either editor engine.
		const input = document.createElement('textarea')
		document.querySelector('.workbench-column')!.append(input)
		const consume = vi.fn((event: KeyboardEvent) => event.preventDefault())
		input.addEventListener('keydown', consume)
		fireEvent.click(search)
		for (const modifiers of [{ ctrlKey: true }, { metaKey: true }]) {
			for (const binding of [
				{ key: 'E', shiftKey: true },
				{ key: 'F', shiftKey: true },
				{ key: 'p' },
			])
				fireEvent.keyDown(input, { ...modifiers, ...binding })
		}
		expect(consume).toHaveBeenCalledTimes(6)
		expect(search.getAttribute('aria-pressed')).toBe('true')
		input.removeEventListener('keydown', consume)
		expect(
			fireEvent.keyDown(input, { key: 'E', ctrlKey: true, shiftKey: true, isComposing: true }),
		).toBe(true)
		expect(search.getAttribute('aria-pressed')).toBe('true')
		fireEvent.keyDown(input, { key: 'E', ctrlKey: true, shiftKey: true })
		expect(explorer.getAttribute('aria-pressed')).toBe('true')
		fireEvent.keyDown(input, { key: 'F', metaKey: true, shiftKey: true })
		expect(search.getAttribute('aria-pressed')).toBe('true')
		fireEvent.keyDown(input, { key: 'p', ctrlKey: true })
		expect(explorer.getAttribute('aria-pressed')).toBe('true')
		fireEvent.click(search)
		const query = screen.getByRole('textbox', { name: '搜索代码' })
		query.addEventListener('keydown', consume)
		fireEvent.keyDown(query, { key: 'Escape' })
		expect(search.getAttribute('aria-pressed')).toBe('true')
		query.removeEventListener('keydown', consume)
		fireEvent.keyDown(query, { key: 'Escape' })
		expect(explorer.getAttribute('aria-pressed')).toBe('true')
	})

	it('shares startup work and does not open reports after the project shuts down', async () => {
		const session = setup()
		let resolveTree!: (tree: Awaited<ReturnType<typeof api.getTree>>) => void
		vi.mocked(api.getTree).mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveTree = resolve
				}),
		)
		const starting = session.start()
		expect(session.start()).toBe(starting)
		await vi.waitFor(() => expect(api.getTree).toHaveBeenCalledOnce())
		await session.dispose()
		resolveTree({
			project: session.project,
			revision: 'late',
			entries: [],
			documents: [],
			config: { name: 'Project', fonts: [] },
		})
		await starting
		expect(session.workbench.getDocuments()).toEqual([])
		expect(session.workspace.tree).toBeUndefined()
	})
	it('keeps every tab when a later shared draft refuses a batch close', async () => {
		const session = setup()
		await session.workbench.start('/')
		session.workspace.files.set('second.typ', {
			path: 'second.typ',
			content: 'draft',
			saved: '',
			version: 'v1',
			dirty: true,
			saving: false,
			token: 1,
			external: 0,
			missing: true,
		})
		render(
			<WorkspaceContext.Provider value={session.workspace}>
				<Workbench workbench={session.workbench} />
			</WorkspaceContext.Provider>,
		)
		await act(async () => {
			await session.open('file', 'first.typ')
		})
		await screen.findByTestId('editor-first.typ')
		await act(async () => {
			await session.open('file', 'second.typ')
		})
		await screen.findByTestId('editor-second.typ')
		const before = session.workbench.getDocuments().map((document) => document.id)
		await act(async () => expect(await session.closeDocuments()).toBe(false))
		expect(session.workbench.getDocuments().map((document) => document.id)).toEqual(before)
		expect(session.workspace.files.get('second.typ')?.content).toBe('draft')
		await act(async () => {
			await session.workspace.discard('second.typ')
			expect(await session.closeDocuments()).toBe(true)
		})
		expect(session.workbench.getDocuments()).toEqual([])
	})
	it('does not open a preview after form navigation was superseded', async () => {
		const session = setup()
		const open = vi.spyOn(session.workbench, 'open').mockResolvedValueOnce({ status: 'superseded' })
		await session.openReport('main/main.ts')
		expect(open).toHaveBeenCalledTimes(1)
		expect(session.workbench.getDocuments()).toEqual([])
	})
	it('reopens duplicate instances after a filesystem failure and restores the active resource', async () => {
		const session = setup()
		await session.workbench.start('/')
		await session.open('file', 'notes/a.typ')
		await session.open('file', 'notes/a.typ', { newInstance: true })
		const before = new Set(session.workbench.getDocuments().map((document) => document.id))
		const failure = new Error('permission denied')
		const action = vi.fn().mockRejectedValue(failure)
		await expect(session.mutate('notes', 'renamed', action)).rejects.toMatchObject({
			cause: failure,
			errors: [failure],
		})
		expect(action).toHaveBeenCalledWith('v1')
		const reopened = session.workbench.getDocuments()
		expect(reopened).toHaveLength(2)
		expect(reopened.every((document) => !before.has(document.id))).toBe(true)
		expect(reopened.map((document) => studioDocument(document.href))).toEqual([
			{ kind: 'file', path: 'notes/a.typ' },
			{ kind: 'file', path: 'notes/a.typ' },
		])
		expect(session.workbench.getActiveDocument()?.id).toBe(reopened[1]!.id)
	})
	it('cancels filesystem mutation when affected input could not be saved', async () => {
		const session = setup()
		session.workspace.files.set('notes/a.typ', {
			path: 'notes/a.typ',
			content: 'draft',
			saved: '',
			version: 'v1',
			dirty: true,
			saving: false,
			token: 1,
			external: 0,
			missing: true,
		})
		const action = vi.fn()
		await expect(session.mutate('notes', undefined, action)).rejects.toThrow('未保存')
		expect(action).not.toHaveBeenCalled()
	})
	it('does not mutate using a stale tree when the prerequisite refresh fails', async () => {
		const session = setup()
		await session.workspace.refresh()
		vi.mocked(api.getTree).mockRejectedValueOnce(new Error('unavailable'))
		const action = vi.fn()
		await expect(session.mutate('notes', undefined, action)).rejects.toThrow('无法刷新项目')
		expect(action).not.toHaveBeenCalled()
	})
	it('renames with the saved version when an older refresh finishes after the write', async () => {
		const session = setup()
		const path = 'scratch/note.typ'
		const oldTree = {
			project: session.project,
			revision: 'before-write',
			entries: [{ path, kind: 'file' as const, version: 'v1', size: 1 }],
			documents: [],
			config: { name: 'Project', fonts: [] },
		}
		let diskTree = {
			...oldTree,
			revision: 'after-write',
			entries: [{ ...oldTree.entries[0]!, version: 'v2' }],
		}
		session.workspace.tree = oldTree
		session.workspace.files.set(path, {
			path,
			content: 'Edited',
			saved: 'Original',
			version: 'v1',
			dirty: true,
			saving: false,
			token: 1,
			external: 0,
		})
		let finishOldRead!: (tree: typeof oldTree) => void
		vi.mocked(api.getTree)
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						finishOldRead = resolve
					}),
			)
			.mockImplementation(async () => structuredClone(diskTree))
		vi.mocked(api.readFile).mockImplementation(async ({ path: filePath }) => ({
			path: filePath,
			content: 'Edited',
			version: 'v2',
		}))
		vi.mocked(api.writeFile).mockResolvedValue({ path, content: 'Edited', version: 'v2' })
		const polling = session.workspace.refresh()
		const saving = session.workspace.save(path)
		await vi.waitFor(() => expect(session.workspace.files.get(path)?.version).toBe('v2'))
		const action = vi.fn(async (version: string) => {
			if (version !== 'v2') throw new Error('File changed; reload before editing')
			diskTree = {
				...diskTree,
				revision: 'renamed',
				entries: [{ ...diskTree.entries[0]!, path: 'scratch/renamed.typ' }],
			}
		})
		const mutation = session.mutate(path, 'scratch/renamed.typ', action)
		for (let index = 0; index < 12; index++) await Promise.resolve()
		expect(action).not.toHaveBeenCalled()
		finishOldRead(oldTree)
		await expect(mutation).resolves.toBeUndefined()
		await Promise.all([saving, polling])
		expect(action).toHaveBeenCalledExactlyOnceWith('v2')
		expect(session.workspace.tree?.revision).toBe('renamed')
	})
	it('reveals, moves and reopens the assistant without changing the active document', async () => {
		const session = setup()
		await session.workbench.start('/')
		await session.open('file', 'notes/a.typ')
		const active = session.workbench.getActiveDocument()?.id
		await session.workbench.dispatch(Actions.updateNodeAttributes('border_bottom', { show: false }))
		await session.showAssistant()
		let model = Model.fromJson(session.workbench.getLayout())
		expect((model.getNodeById('border_bottom') as BorderNode).isShowing()).toBe(true)
		await session.showAssistant('right')
		model = Model.fromJson(session.workbench.getLayout())
		expect(model.getNodeById('assistant')?.getParent()?.getId()).toBe('border_right')
		await session.closeAssistant()
		await session.showAssistant()
		expect(session.workbench.getActiveDocument()?.id).toBe(active)
		expect(session.workbench.getDocuments()).toHaveLength(1)
	})
	it('rejects malformed resource projections instead of fabricating paths', () => {
		expect(() => studioDocument('/file?path=%7B%22x%22%3A1%7D')).toThrow('相对路径')
		expect(() => studioDocument('/form?entry=../outside.ts')).toThrow('相对路径')
		expect(() => studioDocument('/unknown?path=a.typ')).toThrow('未知')
	})
})
