// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'
import { createWorkbench, Workbench, useContentController } from '@worksplit/react'
import { Actions } from 'flexlayout-react'
import { createContext, StrictMode, useContext } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../src/renderer/api'
import { FilePane } from '../src/renderer/panes'
import { WorkspaceController } from '../src/renderer/workspace'
import { WorkspaceContext } from '../src/renderer/workspace-context'
import { createStudioRouter } from '../src/renderer/workbench-routes'
import { editorLifecycle } from '../src/renderer/editor-lifecycle'
import { StudioSession } from '../src/renderer/workbench-session'

vi.mock('../src/renderer/code-editor', () => ({ CodeEditor: () => <div>Code editor</div> }))
vi.mock('../src/renderer/data-form', () => ({ DataForm: () => <div>Data form</div> }))
vi.mock('../src/renderer/body-editor', () => ({ BodyEditor: () => <div>Body editor</div> }))
vi.mock('../src/renderer/preview', () => ({ Preview: () => <div>Preview</div> }))
vi.mock('../src/renderer/assistant', () => ({ AssistantPanel: () => <div>Assistant</div> }))
vi.mock('../src/renderer/api', () => ({
	onDesktopConnectionChange: vi.fn(),
	api: { writeFile: vi.fn(), setInput: vi.fn() },
}))

const project = { id: 'project', name: 'Project', root: '/project' }
const entry = 'main/main.ts'
const disposals: (() => Promise<unknown>)[] = []

function setup() {
	const session = new StudioSession(project)
	disposals.push(() => session.dispose())
	const document = {
		entry,
		fields: [],
		data: { title: 'Saved' },
		diagnostics: [],
		busy: false,
		generation: 1,
		inputLoaded: true,
		storageVersion: 'v1',
	}
	session.workspace.documents.set(entry, document)
	return { session, document }
}

function observeRetains(workspace: WorkspaceController) {
	const retain = workspace.retainDocument.bind(workspace)
	const releases: ReturnType<typeof vi.fn<() => void>>[] = []
	vi.spyOn(workspace, 'retainDocument').mockImplementation((path) => {
		const release = vi.fn(retain(path))
		releases.push(release)
		return release
	})
	return releases
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
	vi.mocked(api.setInput).mockImplementation(async ({ data, editor }) => ({
		data,
		editor,
		storageVersion: 'saved',
	}))
})

afterEach(async () => {
	cleanup()
	await Promise.all(disposals.splice(0).map((dispose) => dispose()))
	vi.restoreAllMocks()
	vi.resetAllMocks()
	vi.unstubAllGlobals()
})

describe('Studio panes with real Worksplit content ownership', () => {
	it('releases each view once across React replay and retains shared output until the last view closes', async () => {
		const { session, document } = setup()
		const releases = observeRetains(session.workspace)
		await session.workbench.start({ href: '/' })
		render(
			<StrictMode>
				<MantineProvider>
					<WorkspaceContext.Provider value={session.workspace}>
						<Workbench instance={session.workbench} />
					</WorkspaceContext.Provider>
				</MantineProvider>
			</StrictMode>,
		)
		await act(async () => {
			await session.open('form', entry)
			await session.open('preview', entry)
		})
		await waitFor(() =>
			expect(releases.filter((release) => release.mock.calls.length === 0)).toHaveLength(2),
		)
		expect(session.workspace.documents.get(entry)).toBe(document)
		const form = session.workbench
			.getDocuments()
			.find((candidate) => candidate.href.startsWith('/form'))!
		const preview = session.workbench
			.getDocuments()
			.find((candidate) => candidate.href.startsWith('/preview'))!
		await act(async () => {
			expect(await session.workbench.close(form.id)).toMatchObject({
				status: 'applied',
				cleanupErrors: [],
			})
		})
		expect(session.workspace.documents.get(entry)).toBe(document)
		expect(releases.filter((release) => release.mock.calls.length === 0)).toHaveLength(1)
		await act(async () => {
			expect(await session.workbench.close(preview.id)).toMatchObject({
				status: 'applied',
				cleanupErrors: [],
			})
		})
		await waitFor(() => expect(session.workspace.documents.has(entry)).toBe(false))
		for (const release of releases) expect(release).toHaveBeenCalledOnce()
	})

	it('keeps a shared dirty draft and both view references when saving refuses close', async () => {
		const { session } = setup()
		const document = session.workspace.documents.get(entry)!
		document.inputDirty = true
		document.inputToken = 1
		document.data = { title: 'Unsaved shared draft' }
		vi.mocked(api.setInput).mockRejectedValueOnce(new Error('Disk full'))
		const releases = observeRetains(session.workspace)
		await session.workbench.start({ href: '/' })
		render(
			<MantineProvider>
				<WorkspaceContext.Provider value={session.workspace}>
					<Workbench instance={session.workbench} />
				</WorkspaceContext.Provider>
			</MantineProvider>,
		)
		await act(async () => {
			await session.open('form', entry)
			await session.open('preview', entry)
		})
		await waitFor(() => expect(releases).toHaveLength(2))
		const form = session.workbench
			.getDocuments()
			.find((candidate) => candidate.href.startsWith('/form'))!
		await act(async () => {
			expect(await session.workbench.close(form.id)).toEqual({
				status: 'denied',
				reason: 'decision',
			})
		})
		expect(session.workbench.getDocuments()).toHaveLength(2)
		expect(session.workspace.documents.get(entry)).toMatchObject({
			inputDirty: true,
			data: { title: 'Unsaved shared draft' },
			inputError: expect.stringContaining('Disk full'),
		})
		for (const release of releases) expect(release).not.toHaveBeenCalled()
		await act(async () => expect(await session.closeDocuments()).toBe(true))
		expect(api.setInput).toHaveBeenCalledTimes(2)
		await waitFor(() => expect(session.workspace.documents.has(entry)).toBe(false))
		for (const release of releases) expect(release).toHaveBeenCalledOnce()
	})

	it('invalidates an earlier approval when its pane switches to another path with the same draft token', async () => {
		const workspace = new WorkspaceController(project)
		for (const path of ['first.typ', 'replacement.typ', 'last.typ'])
			workspace.files.set(path, {
				path,
				content: `Draft ${path}`,
				saved: '',
				version: 'v1',
				dirty: true,
				saving: false,
				token: 0,
				external: 0,
			})
		let finishLast!: () => void
		vi.mocked(api.writeFile).mockImplementation(async ({ path, content }) => {
			if (path === 'last.typ')
				await new Promise<void>((resolve) => {
					finishLast = resolve
				})
			return { path, content, version: 'v2' }
		})
		const Target = createContext('first.typ')
		function OwnedFile({ path }: { path: string }) {
			useContentController(editorLifecycle(workspace, path, 'file'))
			return <FilePane path={path} />
		}
		function FirstPane() {
			return <OwnedFile path={useContext(Target)} />
		}
		const workbench = createWorkbench({
			createRouter: createStudioRouter,
			home: { href: '/', mode: 'empty' },
			initial: {
				layout: {
					layout: {
						type: 'row',
						children: ['first', 'last'].map((id) => ({
							type: 'tabset',
							children: [{ type: 'tab', id, component: id, name: id }],
						})),
					},
				},
			},
			tools: {
				first: { render: () => <FirstPane /> },
				last: { render: () => <OwnedFile path="last.typ" /> },
			},
		})
		disposals.push(async () => {
			await workbench.dispose()
			workspace.dispose()
		})
		const view = (path: string, currentWorkspace: WorkspaceController) => (
			<MantineProvider>
				<WorkspaceContext.Provider value={currentWorkspace}>
					<Target.Provider value={path}>
						<Workbench instance={workbench} />
					</Target.Provider>
				</WorkspaceContext.Provider>
			</MantineProvider>
		)
		await workbench.start()
		const rendered = render(view('first.typ', workspace))
		let closing!: ReturnType<typeof workbench.dispatch>
		await act(async () => {
			closing = workbench.dispatch(
				Actions.group([Actions.deleteTab('first'), Actions.deleteTab('last')]),
			)
		})
		await waitFor(() => expect(finishLast).toBeTypeOf('function'))
		expect(workspace.files.get('first.typ')?.dirty).toBe(false)
		rendered.rerender(view('replacement.typ', workspace))
		await act(async () => {
			finishLast()
			expect(await closing).toMatchObject({ status: 'denied', reason: 'state-changed' })
		})
		expect(
			workbench.getContainers().filter((container) => container.kind === 'tabset'),
		).toHaveLength(2)
		expect(workspace.files.get('replacement.typ')?.dirty).toBe(true)
	})
})
