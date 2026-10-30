// @vitest-environment jsdom
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Editor } from '@tiptap/core'
import { NodeSelection } from '@tiptap/pm/state'
import { createTypstSourceProject } from '@pluxel/plugin-typst/source'
import { MantineProvider } from '@mantine/core'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { InputStore } from '../src/backend/inputs'
import { WorkspaceStore } from '../src/backend/store'
import { validateEditorDraft } from '../src/backend/editor-config'
import type { EditorDraft, EditorDescription } from '../src/shared/contracts'
import { api } from '../src/renderer/api'
import { FilePane, FormPane } from '../src/renderer/panes'
import { WorkspaceController } from '../src/renderer/workspace'
import { WorkspaceContext } from '../src/renderer/workspace-context'
import { editorLifecycle } from '../src/renderer/editor-lifecycle'

vi.mock('@pluxel/plugin-typst/source/browser', async () => {
	const sourceModule = await import('@pluxel/plugin-typst/source')
	return {
		createTypstSourceProject: async (
			options: Parameters<typeof sourceModule.createTypstSourceProject>[0],
		) => sourceModule.createTypstSourceProject(options),
	}
})

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
const bodyPath = 'main/body.typ'
const description: EditorDescription = { sources: [{ path: bodyPath }] }
let initialFiles: Record<string, string>
const draft = (text: string, data = { title: '原始数据' }): EditorDraft => ({
	files: {
		...initialFiles,
		[bodyPath]: text,
		'main/data.json': JSON.stringify(data, null, 2) + '\n',
	},
})
const content = (text: string) => ({
	...workspace.documents.get(target.entry)!.editor!.files,
	[bodyPath]: text,
})
let directory: string
let store: InputStore
let sourceStore: WorkspaceStore
let workspace: WorkspaceController
let currentDescription: EditorDescription
let hidePopover: PropertyDescriptor | undefined
const rangeGeometry = ['getClientRects', 'getBoundingClientRect'] as const
let rangeDescriptors: (PropertyDescriptor | undefined)[]

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), 'studio-input-recovery-'))
	const root = join(directory, 'workspace')
	await mkdir(join(root, 'main'), { recursive: true })
	initialFiles = {
		'studio.json': JSON.stringify({ name: 'Project', fonts: [] }),
		'main/main.ts': 'export default {}',
		'main/main.typ': '#include "body.typ"',
		'main/main.editor.json': JSON.stringify({ sources: [{ path: 'body.typ' }] }),
		'main/blocks.typ': '#let chart(title: "渠道收入") = rect(width: 100%, height: 12pt)[#title]',
		[bodyPath]: '初始正文',
		'main/data.json': JSON.stringify({ title: '原始数据' }, null, 2) + '\n',
	}
	await Promise.all(
		Object.entries(initialFiles).map(([path, source]) => writeFile(join(root, path), source)),
	)
	sourceStore = new WorkspaceStore(join(directory, 'app'), directory)
	await sourceStore.initialize()
	const project = await sourceStore.open(root)
	target.projectId = project.id
	store = new InputStore(sourceStore)
	workspace = new WorkspaceController(project)
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
	// jsdom has no layout. Selection identity is verified here; real scrolling is covered by Electron.
	rangeDescriptors = rangeGeometry.map((name) =>
		Object.getOwnPropertyDescriptor(Range.prototype, name),
	)
	Object.defineProperties(Range.prototype, {
		getClientRects: { configurable: true, value: () => [] },
		getBoundingClientRect: { configurable: true, value: () => new DOMRect() },
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
		validateEditorDraft(currentDescription, input.editor)
		return store.set(input.projectId, input.entry, input)
	})
	vi.mocked(api.compile).mockImplementation(async (input) => {
		validateEditorDraft(currentDescription, input.editor)
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
		for (const [index, name] of rangeGeometry.entries()) {
			const descriptor = rangeDescriptors[index]
			if (descriptor) Object.defineProperty(Range.prototype, name, descriptor)
			else Reflect.deleteProperty(Range.prototype, name)
		}
		vi.unstubAllGlobals()
		vi.restoreAllMocks()
		vi.resetAllMocks()
		await rm(directory, { recursive: true, force: true })
	}
})
async function open(editor?: EditorDraft) {
	const initial = await store.get(target.projectId, target.entry)
	const saved = await store.set(target.projectId, target.entry, {
		data: { title: '原始数据' },
		editor,
		expectedVersion: initial.storageVersion,
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
	const box = await screen.findByRole('textbox', { name: '正文源码 main/body.typ' })
	const editor = (box as HTMLElement & { editor: Editor }).editor
	const saveFile = vi.spyOn(workspace, 'save')
	const saveInput = vi.spyOn(workspace, 'saveInput')
	act(() => editor.commands.setTextSelection({ from: 1, to: 5 }))
	fireEvent.keyDown(box, { key: 'S', code: 'KeyS', keyCode: 83, ctrlKey: true, shiftKey: true })
	expect(editor.isActive('strike')).toBe(true)
	expect(workspace.documents.get(target.entry)?.editor?.files[bodyPath]).toContain('#strike[')
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
	await waitFor(() => {
		expect(api.setInput).toHaveBeenCalled()
		expect(workspace.documents.get(target.entry)?.inputSaving).toBe(false)
	})
	const saved = await store.get(target.projectId, target.entry)
	expect(saved.editor!.files[bodyPath]).toContain('#strike[')
	expect(createTypstSourceProject({ files: saved.editor!.files }).open(bodyPath).document).toEqual(
		createTypstSourceProject({ files: workspace.documents.get(target.entry)!.editor!.files }).open(
			bodyPath,
		).document,
	)
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

it.each([bodyPath, 'main/data.json'])(
	'shows the input owner save state and persists %s through the file shortcut',
	async (path) => {
		await open(draft('初始正文'))
		const file = await sourceStore.readFile(target.projectId, path)
		workspace.files.set(path, {
			...file,
			saved: file.content,
			dirty: false,
			saving: false,
			token: 0,
			external: 0,
		})
		render(
			<MantineProvider>
				<WorkspaceContext.Provider value={workspace}>
					<FilePane path={path} />
				</WorkspaceContext.Provider>
			</MantineProvider>,
		)
		const text = path.endsWith('.json') ? '{"title":"文件页保存的数据"}' : '文件页保存的正文'
		act(() => workspace.edit(path, text))
		expect(screen.getByRole('status').textContent).toBe('待保存')
		await act(async () => {
			fireEvent.keyDown(screen.getByRole('textbox', { name: 'Code editor keyboard target' }), {
				key: 's',
				ctrlKey: true,
			})
		})
		await waitFor(() => expect(screen.getByRole('status').textContent).toBe('已保存'))
		const saved = await store.get(target.projectId, target.entry)
		expect(saved.editor!.files[path]).toBe(text)
		expect(workspace.files.get(path)).toMatchObject({ saved: text, content: text, dirty: false })
	},
)

it.each(['从磁盘重新载入整份报表', '放弃整份报表草稿'])(
	'%s confirms and replaces both data and body from the file menu',
	async (action) => {
		const original = await open(draft('初始正文'))
		const file = await sourceStore.readFile(target.projectId, bodyPath)
		workspace.files.set(bodyPath, {
			...file,
			content: '本地正文',
			saved: file.content,
			dirty: false,
			saving: false,
			token: 1,
			external: 0,
		})
		workspace.documents.set(target.entry, {
			...workspace.documents.get(target.entry)!,
			data: { title: '本地数据' },
			editor: draft('本地正文', { title: '本地数据' }),
			inputDirty: true,
		})
		const saved = await store.set(target.projectId, target.entry, {
			data: { title: '磁盘数据' },
			editor: draft('磁盘正文', { title: '磁盘数据' }),
			expectedVersion: original.storageVersion,
		})
		const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
		render(
			<MantineProvider>
				<WorkspaceContext.Provider value={workspace}>
					<FilePane path={bodyPath} />
				</WorkspaceContext.Provider>
			</MantineProvider>,
		)
		fireEvent.click(screen.getByRole('button', { name: '文件操作' }))
		await act(async () => {
			fireEvent.click(await screen.findByRole('menuitem', { name: action }))
		})
		expect(confirm).toHaveBeenCalledWith(expect.stringContaining('全部数据与正文'))
		await waitFor(() => expect(workspace.documents.get(target.entry)?.inputDirty).toBe(false))
		expect(workspace.documents.get(target.entry)).toMatchObject({
			data: saved.data,
			editor: saved.editor,
			inputConflict: undefined,
		})
		expect(workspace.files.get(bodyPath)).toMatchObject({ content: '磁盘正文', saved: '磁盘正文' })
	},
)

it('opens existing authored source without resetting the saved data or creating a separate draft', async () => {
	const previous = await open()
	await mountBody()
	const body = await screen.findByRole('textbox', { name: '正文源码 main/body.typ' })
	expect(body.textContent).toBe('初始正文')
	expect(screen.queryByRole('button', { name: '初始化正文' })).toBeNull()
	expect(screen.queryByRole('button', { name: '切换客户' })).toBeNull()
	await act(() => workspace.saveInput(target.entry))
	const saved = await store.get(target.projectId, target.entry)
	expect(saved).toEqual(previous)
	expect(saved.editor).toEqual(draft('初始正文'))
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
	workspace.writeSources(target.entry, content('新正文'))
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
	workspace.writeSources(target.entry, content('本地正文'))
	await workspace.saveInput(target.entry)
	expect(workspace.documents.get(target.entry)?.inputConflict).toEqual(other)
	expect(workspace.documents.get(target.entry)?.editor).toEqual(draft('本地正文'))
	expect(workspace.documents.get(target.entry)?.storageVersion).toBe(original.storageVersion)
	const latest = await store.set(target.projectId, target.entry, {
		data: { title: '更新的远端数据' },
		editor: draft('更新的远端正文', { title: '更新的远端数据' }),
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
	workspace.writeSources(target.entry, content('第一次正文'))
	const saving = workspace.saveInput(target.entry)
	await waitFor(() => expect(complete).toBeTypeOf('function'))
	const committed = await store.get(target.projectId, target.entry)
	await workspace.writeData(target.entry, { title: '继续输入的数据' })
	workspace.writeSources(target.entry, content('继续输入的正文'))
	complete(committed)
	await saving
	expect(workspace.documents.get(target.entry)).toMatchObject({
		data: { title: '继续输入的数据' },
		editor: draft('继续输入的正文', { title: '继续输入的数据' }),
		storageVersion: committed.storageVersion,
		inputDirty: true,
		inputError: undefined,
	})
	await workspace.saveInput(target.entry)
	expect(await store.get(target.projectId, target.entry)).toMatchObject({
		data: { title: '继续输入的数据' },
		editor: draft('继续输入的正文', { title: '继续输入的数据' }),
	})
})

it('keeps a captured source candidate valid when its unchanged draft finishes autosaving', async () => {
	await open(draft('初始正文'))
	await mountBody()
	const box = await screen.findByRole('textbox', { name: '正文源码 main/body.typ' })
	const editor = (box as HTMLElement & { editor: Editor }).editor
	workspace.tree = await sourceStore.tree(target.projectId)
	act(() => editor.commands.insertContentAt(1, { type: 'text', text: '本地修改' }))
	fireEvent.click(screen.getByRole('button', { name: '固定候选目标' }))
	fireEvent.change(screen.getByRole('textbox', { name: 'Typst 候选' }), {
		target: { value: '保存后仍有效的候选' },
	})
	const observe = () => {
		const state = workspace.documents.get(target.entry)!
		return {
			projectRevision: workspace.sourceProjects.get(target.entry)!.revision,
			inputToken: state.inputToken,
			sourceRevision: state.description?.sourceRevision,
			treeRevision: workspace.tree?.revision,
			storageVersion: state.storageVersion,
		}
	}
	const before = observe(),
		identity = workspace.draftRevision(target.entry)
	await act(() => workspace.saveInput(target.entry))
	workspace.tree = await sourceStore.tree(target.projectId)
	act(() => workspace.emit())
	const after = observe()
	expect(after.projectRevision).toBe(before.projectRevision)
	expect(after.inputToken).toBe(before.inputToken)
	expect(after.sourceRevision).toBe(before.sourceRevision)
	expect(after.storageVersion).not.toBe(before.storageVersion)
	expect(after.treeRevision).not.toBe(before.treeRevision)
	expect(workspace.draftRevision(target.entry)).toBe(identity)
	fireEvent.click(screen.getByRole('button', { name: '查看修改预览' }))
	fireEvent.click(screen.getByRole('button', { name: '接纳候选' }))
	expect(editor.getText()).toBe('保存后仍有效的候选')
})

it('loads the chosen saved draft through the UI and replaces editors, candidates and navigation', async () => {
	const original = await open(draft('初始正文'))
	await mountBody()
	const box = await screen.findByRole('textbox', { name: '正文源码 main/body.typ' })
	const editor = (box as HTMLElement & { editor: Editor }).editor
	act(() => {
		editor.commands.insertContent('本地修改')
	})
	fireEvent.click(screen.getByRole('button', { name: '固定候选目标' }))
	fireEvent.change(screen.getByRole('textbox', { name: 'Typst 候选' }), {
		target: { value: '旧候选' },
	})
	fireEvent.click(screen.getByRole('button', { name: '查看修改预览' }))
	expect((screen.getByRole('button', { name: '接纳候选' }) as HTMLButtonElement).disabled).toBe(
		false,
	)
	const oldRevision = workspace.draftRevision(target.entry)
	const oldPreview = workspace.documents.get(target.entry)!.preview!
	workspace.bodyLocation = { entry: target.entry, path: bodyPath, from: 0, to: 2, serial: 1 }
	const other = await store.set(target.projectId, target.entry, {
		data: { title: '远端数据' },
		editor: draft('远端正文', { title: '远端数据' }),
		expectedVersion: original.storageVersion,
	})
	await act(() => workspace.saveInput(target.entry))
	expect(screen.getByText('填写数据与正文存在保存冲突')).toBeTruthy()
	expect(workspace.documents.get(target.entry)?.editor).not.toEqual(other.editor)
	fireEvent.click(screen.getByRole('button', { name: '载入已保存版本，放弃本地修改' }))
	await waitFor(() =>
		expect(screen.getByRole('textbox', { name: '正文源码 main/body.typ' }).textContent).toBe(
			'远端正文',
		),
	)
	expect(editor.isDestroyed).toBe(true)
	expect((screen.getByRole('textbox', { name: 'Typst 候选' }) as HTMLTextAreaElement).value).toBe(
		'',
	)
	expect((screen.getByRole('button', { name: '接纳候选' }) as HTMLButtonElement).disabled).toBe(
		true,
	)
	expect(workspace.bodyLocation).toBeUndefined()
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

it('round-trips styled source candidates beside components and navigates the first atom', async () => {
	currentDescription = {
		...description,
		components: [
			{
				module: 'main/blocks.typ',
				name: 'chart',
				label: '渠道图表',
				parameters: { title: { type: 'string' } },
			},
		],
	}
	const originalDescription = await api.describeDocument(target)
	vi.mocked(api.describeDocument).mockResolvedValue({
		...originalDescription,
		editor: currentDescription,
	})
	const source =
		'#import "blocks.typ": chart\n#chart(title: "渠道收入")\n\n#text(fill: rgb("#dc2626"), size: 12pt)[需要改写的分析]\n\n#box(width: 100%)[保留口径]'
	await open(draft(source))
	await mountBody()
	const box = await screen.findByRole('textbox', { name: '正文源码 main/body.typ' })
	const editor = (box as HTMLElement & { editor: Editor }).editor
	const original = editor.getJSON()
	expect(editor.state.doc.child(0).isAtom).toBe(true)
	expect(original.content!.some((node) => node.type === 'typstComponent')).toBe(true)
	let paragraph = -1
	editor.state.doc.forEach((node, offset) => {
		if (node.textContent === '需要改写的分析') paragraph = offset
	})
	expect(paragraph).toBeGreaterThan(0)
	act(() => editor.commands.setTextSelection({ from: paragraph + 1, to: paragraph + 8 }))
	fireEvent.change(screen.getByRole('combobox', { name: '候选范围' }), {
		target: { value: 'selection' },
	})
	fireEvent.click(screen.getByRole('button', { name: '固定候选目标' }))
	const candidate = () => screen.getByRole('textbox', { name: 'Typst 候选' }) as HTMLTextAreaElement
	expect(candidate().value).toContain('size: 12pt')
	fireEvent.change(candidate(), { target: { value: '不可接纳的旧文字' } })
	fireEvent.click(screen.getByRole('button', { name: '固定候选目标' }))
	expect(candidate().value).toBe('不可接纳的旧文字')
	fireEvent.click(screen.getByRole('button', { name: '用原文替换候选' }))
	expect(candidate().value).toContain('需要改写的分析')
	fireEvent.click(screen.getByRole('button', { name: '查看修改预览' }))
	const replacement = '#text(fill: rgb("#16a34a"), size: 14pt)[*新的分析*：收入已达标。]'
	fireEvent.change(candidate(), { target: { value: replacement } })
	expect((screen.getByRole('button', { name: '接纳候选' }) as HTMLButtonElement).disabled).toBe(
		true,
	)
	expect(editor.getJSON()).toEqual(original)
	fireEvent.click(screen.getByRole('button', { name: '查看修改预览' }))
	fireEvent.click(screen.getByRole('button', { name: '接纳候选' }))
	await waitFor(() => expect(editor.state.doc.textContent).toContain('新的分析：收入已达标。'))
	const changed = workspace.documents.get(target.entry)!.editor!.files[bodyPath]!
	expect(changed).toBe(
		source.replace('#text(fill: rgb("#dc2626"), size: 12pt)[需要改写的分析]', replacement),
	)
	expect(editor.getJSON().content![0]).toEqual(original.content![0])
	expect(editor.getJSON().content![1]).toEqual(original.content![1])
	expect(editor.getJSON().content!.at(-1)).toEqual(original.content!.at(-1))
	fireEvent.keyDown(box, { key: 'z', code: 'KeyZ', ctrlKey: true })
	expect(editor.getJSON()).toEqual(original)
	expect(workspace.documents.get(target.entry)!.editor!.files[bodyPath]).toBe(source)
	await act(async () => {
		workspace.bodyLocation = {
			entry: target.entry,
			path: bodyPath,
			from: 0,
			to: 1,
			serial: 1,
		}
		await workspace.writeData(target.entry, { title: '导航后的数据' })
	})
	expect(editor.state.selection).toBeInstanceOf(NodeSelection)
	expect(editor.state.selection.from).toBe(0)
	expect((editor.state.selection as NodeSelection).node.attrs.source).toBe(
		'#import "blocks.typ": chart',
	)
})
