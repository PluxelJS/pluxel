// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { Workbench, useWorkbenchContentLifecycle } from '@worksplit/react'
import { Actions, Model, type BorderNode } from 'flexlayout-react'
import { useMemo } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../src/renderer/api'
import { editorLifecycle } from '../src/renderer/editor-lifecycle'
import { WorkspaceContext, useWorkspace } from '../src/renderer/workspace-context'
import { StudioSession } from '../src/renderer/workbench-session'
import { studioDocument } from '../src/renderer/workbench-routes'

vi.mock('../src/renderer/api', () => ({ api: { getTree: vi.fn(), writeFile: vi.fn() } }))
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

describe('Studio project operations through the packed Worksplit API', () => {
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
