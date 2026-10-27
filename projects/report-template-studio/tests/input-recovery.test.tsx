// @vitest-environment jsdom
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Editor } from '@tiptap/core'
import { NodeSelection } from '@tiptap/pm/state'
import { undo } from '@tiptap/pm/history'
import { MantineProvider } from '@mantine/core'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { InputStore } from '../src/backend/inputs'
import { validateEditorDraft } from '../src/backend/editor-config'
import type { EditorDraft, EditorDescription } from '../src/shared/contracts'
import { api } from '../src/renderer/api'
import { FilePane, FormPane } from '../src/renderer/panes'
import { WorkspaceController } from '../src/renderer/workspace'
import { WorkspaceContext } from '../src/renderer/workspace-context'
import { editorLifecycle } from '../src/renderer/editor-lifecycle'

vi.mock('@worksplit/react', () => ({ useWorkbenchContentLifecycle: () => {} }))
vi.mock('../src/renderer/code-editor', () => ({
	CodeEditor: () => <textarea aria-label="Code editor keyboard target" />,
}))
vi.mock('../src/renderer/preview', () => ({ Preview: () => null }))
vi.mock('../src/renderer/api', () => ({
	onDesktopConnectionChange: vi.fn(),
	api: {
		describeDocument: vi.fn(),
		getInput: vi.fn(),
		attachBodyEditor: vi.fn(async () => ({ close: async () => {} })),
		setInput: vi.fn(),
		compile: vi.fn(),
		getPreview: vi.fn(),
	},
}))

const target = { projectId: 'project', entry: 'main/main.ts' }
const content = (text: string) => ({
	type: 'doc',
	content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
})
const description: EditorDescription = {
	templateId: target.entry,
	templateRevision: 'source',
	regions: [{ id: 'body' }],
	fields: [],
	defaults: { body: content('初始正文') },
}
const draft = (text: string): EditorDraft => ({
	formatVersion: 1,
	templateId: target.entry,
	templateRevision: 'source',
	regions: { body: content(text) },
})
let directory: string
let store: InputStore
let workspace: WorkspaceController
let currentDescription: EditorDescription
let hidePopover: PropertyDescriptor | undefined

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), 'studio-input-recovery-'))
	store = new InputStore(directory)
	workspace = new WorkspaceController({ id: 'project', name: 'Project', root: '/project' })
	currentDescription = description
	vi.stubGlobal(
		'ResizeObserver',
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	)
	vi.stubGlobal(
		'matchMedia',
		vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })),
	)
	hidePopover = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'hidePopover')
	// jsdom lacks popovers; these cases only dismiss an unopened component menu.
	Object.defineProperty(HTMLElement.prototype, 'hidePopover', {
		configurable: true,
		value() {},
	})
	vi.mocked(api.describeDocument).mockResolvedValue({
		...target,
		name: 'Main',
		template: 'main/main.typ',
		sourceRevision: 'source',
		defaults: { title: 'default' },
		fields: [
			{
				kind: 'string',
				path: 'title',
				name: 'title',
				depth: 0,
				required: true,
				meta: { label: '标题' },
				control: 'text',
			},
		],
		editor: description,
	})
	vi.mocked(api.getInput).mockImplementation(() => store.get(target.projectId, target.entry))
	vi.mocked(api.setInput).mockImplementation(async (input) => {
		validateEditorDraft(currentDescription, input.editor, input.data)
		return store.set(input.projectId, input.entry, input)
	})
	vi.mocked(api.compile).mockImplementation(async (input) => {
		validateEditorDraft(currentDescription, input.editor, input.data)
		return {
			...target,
			name: 'Main',
			template: 'main/main.typ',
			sourceRevision: 'source',
			revision: `compiled-${input.clientRevision}`,
			clientRevision: input.clientRevision,
			data: input.data,
			pageCount: 1,
			pages: [],
			outline: [],
			diagnostics: [],
			elapsedMs: 0,
		}
	})
	vi.mocked(api.getPreview).mockImplementation(async ({ revision }) => ({
		...target,
		revision,
		sourceRevision: 'source',
		clientRevision: Number(revision.split('-').at(-1)),
		sourceVersions: { 'main/main.typ': 'source' },
		preview: {
			sessionId: 'session',
			revision: 1,
			format: 'vector',
			compilerVersion: '0.7.0',
			data: new Uint8Array(),
			navigation: { pages: [], points: [], outline: [] },
		},
	}))
})
afterEach(async () => {
	try {
		cleanup()
		workspace.dispose()
	} finally {
		if (hidePopover) Object.defineProperty(HTMLElement.prototype, 'hidePopover', hidePopover)
		else Reflect.deleteProperty(HTMLElement.prototype, 'hidePopover')
		vi.unstubAllGlobals()
		vi.restoreAllMocks()
		vi.resetAllMocks()
		await rm(directory, { recursive: true, force: true })
	}
})
async function open(editor?: EditorDraft) {
	const saved = await store.set(target.projectId, target.entry, {
		data: { title: '原始数据' },
		editor,
		expectedVersion: null,
	})
	workspace.retainDocument(target.entry)
	await workspace.compile(target.entry)
	return saved
}
async function mountBody() {
	render(
		<MantineProvider>
			<WorkspaceContext.Provider value={workspace}>
				<FormPane entry={target.entry} />
			</WorkspaceContext.Provider>
		</MantineProvider>,
	)
	fireEvent.click(screen.getByText('正文', { exact: true }))
}

it('lets the real body editor apply strikethrough while plain save keys still persist the draft', async () => {
	await open(draft('初始正文'))
	await mountBody()
	const box = await screen.findByRole('textbox', { name: '正文区域 body' })
	const editor = (box as HTMLElement & { editor: Editor }).editor
	const saveFile = vi.spyOn(workspace, 'save')
	const saveInput = vi.spyOn(workspace, 'saveInput')
	act(() => editor.commands.setTextSelection({ from: 1, to: 5 }))
	fireEvent.keyDown(box, { key: 'S', code: 'KeyS', keyCode: 83, ctrlKey: true, shiftKey: true })
	expect(editor.isActive('strike')).toBe(true)
	for (const modifiers of [
		{ ctrlKey: true, altKey: true },
		{ metaKey: true, shiftKey: true },
		{ metaKey: true, altKey: true },
		{ ctrlKey: true, isComposing: true },
	])
		fireEvent.keyDown(box, { key: 's', code: 'KeyS', ...modifiers })
	expect(saveFile).not.toHaveBeenCalled()
	expect(saveInput).not.toHaveBeenCalled()
	await act(async () => {
		fireEvent.keyDown(box, { key: 's', code: 'KeyS', ctrlKey: true })
	})
	expect(saveFile).toHaveBeenCalledWith(target.entry)
	expect(saveInput).toHaveBeenCalledWith(target.entry)
	await waitFor(() => expect(api.setInput).toHaveBeenCalled())
	const saved = await store.get(target.projectId, target.entry)
	expect(saved.editor?.regions.body).toEqual(editor.getJSON())
})

it('keeps modified and composition keys available inside file editors and saves only plain Mod-S', () => {
	const path = 'main/main.typ'
	workspace.files.set(path, {
		path,
		content: 'Source',
		saved: 'Source',
		version: 'v1',
		dirty: false,
		saving: false,
		token: 0,
		external: 0,
	})
	const save = vi.spyOn(workspace, 'save').mockResolvedValue(undefined)
	render(
		<MantineProvider>
			<WorkspaceContext.Provider value={workspace}>
				<FilePane path={path} />
			</WorkspaceContext.Provider>
		</MantineProvider>,
	)
	const input = screen.getByRole('textbox', { name: 'Code editor keyboard target' })
	for (const modifier of ['ctrlKey', 'metaKey']) {
		for (const extra of [{ shiftKey: true }, { altKey: true }, { isComposing: true }])
			expect(fireEvent.keyDown(input, { key: 's', [modifier]: true, ...extra })).toBe(true)
		expect(save).not.toHaveBeenCalled()
		expect(fireEvent.keyDown(input, { key: 's', [modifier]: true })).toBe(false)
		expect(save).toHaveBeenCalledExactlyOnceWith(path)
		save.mockClear()
	}
})

it('explicitly initializes regions for existing saved data through the form pane', async () => {
	const previous = await open()
	expect(workspace.documents.get(target.entry)?.error).toContain('Create a region draft explicitly')
	await mountBody()
	fireEvent.click(screen.getByRole('button', { name: '初始化正文' }))
	await waitFor(() =>
		expect(screen.getByRole('textbox', { name: '正文区域 body' }).textContent).toBe('初始正文'),
	)
	expect(screen.queryByRole('button', { name: '切换客户' })).toBeNull()
	await act(() => workspace.saveInput(target.entry))
	const saved = await store.get(target.projectId, target.entry)
	expect(saved.data).toEqual(previous.data)
	expect(saved.editor).toEqual(draft('初始正文'))
	expect(saved.storageVersion).not.toBe(previous.storageVersion)
	await act(() => workspace.compile(target.entry))
	expect(workspace.documents.get(target.entry)?.error).toBeUndefined()
})

it('confirms a complete committed draft after its save response is lost', async () => {
	await open(draft('初始正文'))
	vi.mocked(api.setInput).mockImplementationOnce(async (input) => {
		await store.set(input.projectId, input.entry, input)
		throw new Error('connection lost after commit')
	})
	await workspace.writeData(target.entry, { title: '新数据' })
	await workspace.writeRegion(target.entry, 'body', content('新正文'))
	await workspace.saveInput(target.entry)
	const saved = await store.get(target.projectId, target.entry)
	expect(workspace.documents.get(target.entry)).toMatchObject({
		data: saved.data,
		editor: saved.editor,
		storageVersion: saved.storageVersion,
		inputDirty: false,
		inputSaving: false,
		inputError: undefined,
		inputConflict: undefined,
	})
	expect(
		await editorLifecycle(workspace, target.entry, 'form').beforeLeave?.('close', {
			id: 'form',
			from: '/form',
		}),
	).toBe(true)
})

it('keeps local input and requires another decision if a writer changes the conflict snapshot', async () => {
	const original = await open(draft('初始正文'))
	const other = await store.set(target.projectId, target.entry, {
		data: original.data,
		editor: draft('远端正文'),
		expectedVersion: original.storageVersion,
	})
	await workspace.writeRegion(target.entry, 'body', content('本地正文'))
	await workspace.saveInput(target.entry)
	expect(workspace.documents.get(target.entry)?.inputConflict).toEqual(other)
	expect(workspace.documents.get(target.entry)?.editor).toEqual(draft('本地正文'))
	expect(workspace.documents.get(target.entry)?.storageVersion).toBe(original.storageVersion)
	const latest = await store.set(target.projectId, target.entry, {
		data: { title: '更新的远端数据' },
		editor: draft('更新的远端正文'),
		expectedVersion: other.storageVersion,
	})
	await workspace.resolveInputConflict(target.entry, 'local')
	expect(await store.get(target.projectId, target.entry)).toEqual(latest)
	expect(workspace.documents.get(target.entry)?.inputConflict).toEqual(latest)
	expect(workspace.documents.get(target.entry)?.storageVersion).toBe(original.storageVersion)
	await workspace.resolveInputConflict(target.entry, 'local')
	const resolved = await store.get(target.projectId, target.entry)
	expect(resolved.editor).toEqual(draft('本地正文'))
	expect(workspace.documents.get(target.entry)?.inputConflict).toBeUndefined()
	expect(workspace.documents.get(target.entry)?.inputDirty).toBe(false)
})

it('keeps edits made while confirming a lost save response dirty against the confirmed version', async () => {
	await open(draft('初始正文'))
	let complete!: (value: Awaited<ReturnType<typeof api.getInput>>) => void
	vi.mocked(api.getInput).mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				complete = resolve
			}),
	)
	vi.mocked(api.setInput).mockImplementationOnce(async (input) => {
		await store.set(input.projectId, input.entry, input)
		throw new Error('connection lost after commit')
	})
	await workspace.writeRegion(target.entry, 'body', content('第一次正文'))
	const saving = workspace.saveInput(target.entry)
	await waitFor(() => expect(complete).toBeTypeOf('function'))
	const committed = await store.get(target.projectId, target.entry)
	await workspace.writeData(target.entry, { title: '继续输入的数据' })
	await workspace.writeRegion(target.entry, 'body', content('继续输入的正文'))
	complete(committed)
	await saving
	expect(workspace.documents.get(target.entry)).toMatchObject({
		data: { title: '继续输入的数据' },
		editor: draft('继续输入的正文'),
		storageVersion: committed.storageVersion,
		inputDirty: true,
		inputError: undefined,
	})
	await workspace.saveInput(target.entry)
	expect(await store.get(target.projectId, target.entry)).toMatchObject({
		data: { title: '继续输入的数据' },
		editor: draft('继续输入的正文'),
	})
})

it('loads the chosen saved draft through the UI and replaces editors, candidates and navigation', async () => {
	const original = await open(draft('初始正文'))
	await mountBody()
	const box = await screen.findByRole('textbox', { name: '正文区域 body' })
	const editor = (box as HTMLElement & { editor: Editor }).editor
	act(() => {
		editor.commands.insertContent('本地修改')
	})
	fireEvent.click(screen.getByRole('button', { name: '固定候选目标' }))
	fireEvent.change(screen.getByRole('textbox', { name: 'Markdown 候选' }), {
		target: { value: '旧候选' },
	})
	fireEvent.click(screen.getByRole('button', { name: '查看修改预览' }))
	expect((screen.getByRole('button', { name: '接纳候选' }) as HTMLButtonElement).disabled).toBe(
		false,
	)
	const oldRevision = workspace.draftRevision(target.entry)
	const oldPreview = workspace.documents.get(target.entry)!.preview!
	workspace.regionLocation = { entry: target.entry, regionId: 'body', from: 0, to: 2, serial: 1 }
	const other = await store.set(target.projectId, target.entry, {
		data: { title: '远端数据' },
		editor: draft('远端正文'),
		expectedVersion: original.storageVersion,
	})
	await act(() => workspace.saveInput(target.entry))
	expect(screen.getByText('填写数据与正文存在保存冲突')).toBeTruthy()
	expect(workspace.documents.get(target.entry)?.editor).not.toEqual(other.editor)
	fireEvent.click(screen.getByRole('button', { name: '载入已保存版本，放弃本地修改' }))
	await waitFor(() =>
		expect(screen.getByRole('textbox', { name: '正文区域 body' }).textContent).toBe('远端正文'),
	)
	expect(editor.isDestroyed).toBe(true)
	expect(
		(screen.getByRole('textbox', { name: 'Markdown 候选' }) as HTMLTextAreaElement).value,
	).toBe('')
	expect((screen.getByRole('button', { name: '接纳候选' }) as HTMLButtonElement).disabled).toBe(
		true,
	)
	expect(workspace.regionLocation).toBeUndefined()
	expect(workspace.draftRevision(target.entry)).not.toBe(oldRevision)
	expect(workspace.isNavigationCurrent(oldPreview)).toBe(false)
	expect(workspace.documents.get(target.entry)).toMatchObject({
		data: other.data,
		editor: other.editor,
		storageVersion: other.storageVersion,
		inputDirty: false,
	})
	fireEvent.click(screen.getByText('表单', { exact: true }))
	expect((screen.getByRole('textbox', { name: '标题' }) as HTMLInputElement).value).toBe('远端数据')
})

it('round-trips styled candidate blocks beside components and navigates a first atom without losing its position', async () => {
	currentDescription = {
		...description,
		templates: [
			{ id: 'chart', label: '渠道图表', source: '#props.title', defaults: { title: '渠道收入' } },
		],
		sourceBlocks: true,
		defaults: {
			body: {
				type: 'doc',
				content: [
					{
						type: 'templateBlock',
						attrs: { id: 'chart-1', template: 'chart', props: { title: '渠道收入' }, dataPath: [] },
					},
					{
						type: 'paragraph',
						content: [
							{
								type: 'text',
								text: '需要改写的分析',
								marks: [{ type: 'textStyle', attrs: { color: '#dc2626', fontSize: '12pt' } }],
							},
						],
					},
					{ type: 'typstSource', attrs: { id: 'note-1', source: '#text(size: 8pt)[保留口径]' } },
				],
			},
		},
	}
	const originalDescription = await api.describeDocument(target)
	vi.mocked(api.describeDocument).mockResolvedValue({
		...originalDescription,
		editor: currentDescription,
	})
	await open({ ...draft('unused'), regions: currentDescription.defaults })
	await mountBody()
	const box = await screen.findByRole('textbox', { name: '正文区域 body' })
	const editor = (box as HTMLElement & { editor: Editor }).editor
	const original = editor.getJSON()
	act(() => {
		editor.commands.setTextSelection(4)
	})
	fireEvent.change(screen.getByRole('combobox', { name: '候选范围' }), {
		target: { value: 'selection' },
	})
	fireEvent.click(screen.getByRole('button', { name: '固定候选目标' }))
	expect(
		(screen.getByRole('textbox', { name: 'Markdown 候选' }) as HTMLTextAreaElement).value,
	).toContain('"fontSize":"12pt"')
	fireEvent.change(screen.getByRole('textbox', { name: 'Markdown 候选' }), {
		target: { value: '不可接纳的旧文字' },
	})
	fireEvent.click(screen.getByRole('button', { name: '固定候选目标' }))
	expect(
		(screen.getByRole('textbox', { name: 'Markdown 候选' }) as HTMLTextAreaElement).value,
	).toBe('不可接纳的旧文字')
	fireEvent.click(screen.getByRole('button', { name: '用原文替换候选' }))
	expect(
		(screen.getByRole('textbox', { name: 'Markdown 候选' }) as HTMLTextAreaElement).value,
	).toContain('需要改写的分析')
	fireEvent.click(screen.getByRole('button', { name: '查看修改预览' }))
	fireEvent.change(screen.getByRole('textbox', { name: 'Markdown 候选' }), {
		target: {
			value:
				'[textStyle {"color":"#16a34a","fontSize":"14pt","backgroundColor":"#fff2cc"}]**新的分析**[/textStyle]：收入已达标。',
		},
	})
	expect((screen.getByRole('button', { name: '接纳候选' }) as HTMLButtonElement).disabled).toBe(
		true,
	)
	expect(editor.getJSON()).toEqual(original)
	fireEvent.click(screen.getByRole('button', { name: '查看修改预览' }))
	fireEvent.click(screen.getByRole('button', { name: '接纳候选' }))
	await waitFor(() => expect(editor.state.doc.child(1).textContent).toBe('新的分析：收入已达标。'))
	expect(editor.getJSON().content![1]!.content![0]!.marks).toEqual(
		expect.arrayContaining([
			{ type: 'bold' },
			expect.objectContaining({
				type: 'textStyle',
				attrs: expect.objectContaining({
					color: '#16a34a',
					fontSize: '14pt',
					backgroundColor: '#fff2cc',
				}),
			}),
		]),
	)
	expect(editor.getJSON().content![0]).toEqual(original.content![0])
	expect(editor.getJSON().content![2]).toEqual(original.content![2])
	act(() => {
		expect(undo(editor.state, editor.view.dispatch)).toBe(true)
	})
	expect(editor.getJSON()).toEqual(original)
	await act(async () => {
		workspace.regionLocation = { entry: target.entry, regionId: 'body', from: 0, to: 1, serial: 1 }
		await workspace.writeData(target.entry, { title: '导航后的数据' })
	})
	expect(editor.state.selection).toBeInstanceOf(NodeSelection)
	expect(editor.state.selection.from).toBe(0)
	expect((editor.state.selection as NodeSelection).node.attrs.id).toBe('chart-1')
})
