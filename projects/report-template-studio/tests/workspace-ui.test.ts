import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { serialize } from 'capnweb'
import type { CompileResult, DocumentDescription, PreviewResult } from '../src/shared/contracts'
import { WorkspaceController } from '../src/renderer/workspace'
import { api, onDesktopConnectionChange } from '../src/renderer/api'
import { editorLifecycle } from '../src/renderer/editor-lifecycle'

vi.mock('../src/renderer/source-navigation', () => ({ isPaneVisible: () => true }))

vi.mock('../src/renderer/api', () => ({
	onDesktopConnectionChange: vi.fn(),
	api: {
		describeDocument: vi.fn(),
		getInput: vi.fn(),
		setInput: vi.fn(),
		compile: vi.fn(),
		getPreview: vi.fn(),
		writeFile: vi.fn(),
		getTree: vi.fn(),
	},
}))
const target = { projectId: 'project', entry: 'main/main.ts' }
const description: DocumentDescription = {
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
			meta: { label: 'Title' },
			control: 'text',
		},
	],
}
const result = (title: string, clientRevision = 0): CompileResult => ({
	clientRevision,
	...target,
	name: 'Main',
	template: 'main/main.typ',
	revision: title,
	sourceRevision: 'source',
	data: { title },
	pageCount: 1,
	pages: [{ page: 1, width: 595, height: 842 }],
	outline: [],
	diagnostics: [],
	elapsedMs: 1,
})
const preview = (revision: string, clientRevision = 0): PreviewResult => ({
	clientRevision,
	...target,
	revision,
	sourceRevision: 'source',
	sourceVersions: { 'main/main.typ': 'typ-version' },
	preview: {
		sessionId: 'session',
		revision: 1,
		format: 'vector',
		compilerVersion: '0.7.0',
		data: new Uint8Array([1, 2, 3]),
		navigation: { pages: [], points: [], outline: [] },
	},
})
async function settle() {
	for (let count = 0; count < 12; count++) await Promise.resolve()
}
const createWorkspace = () =>
	new WorkspaceController({ id: 'project', name: 'Project', root: '/project' })
beforeEach(() => {
	vi.mocked(api.describeDocument).mockResolvedValue(description)
	vi.mocked(api.getInput).mockResolvedValue({ data: {}, storageVersion: null })
	vi.mocked(api.setInput).mockImplementation(async ({ data, editor }) => ({
		data,
		editor,
		storageVersion: 'saved-version',
	}))
	vi.mocked(api.compile).mockImplementation(async ({ data, clientRevision }) =>
		result(String(data.title ?? 'default'), clientRevision),
	)
	vi.mocked(api.getPreview).mockImplementation(async ({ revision }) =>
		preview(revision, vi.mocked(api.compile).mock.calls.at(-1)?.[0].clientRevision ?? 0),
	)
})
afterEach(() => {
	vi.useRealTimers()
	vi.resetAllMocks()
})
describe('workspace explicit form input and preview ownership', () => {
	it('preserves edits made during the initial draft read and waits for its storage version before saving', async () => {
		vi.useFakeTimers()
		let loaded!: (value: Awaited<ReturnType<typeof api.getInput>>) => void
		vi.mocked(api.getInput).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					loaded = resolve
				}),
		)
		const workspace = createWorkspace()
		workspace.retainDocument(target.entry)
		await settle()
		await workspace.writeData(target.entry, { title: 'new draft' })
		await vi.advanceTimersByTimeAsync(450)
		expect(api.setInput).not.toHaveBeenCalled()
		const editor = {
			formatVersion: 1 as const,
			templateId: target.entry,
			templateRevision: 'source',
			regions: { body: { type: 'doc', content: [{ type: 'paragraph' }] } },
		}
		loaded({ data: { title: 'stored draft' }, editor, storageVersion: 'stored-version' })
		await settle()
		expect(workspace.documents.get(target.entry)).toMatchObject({
			data: { title: 'new draft' },
			editor,
			inputLoaded: true,
			storageVersion: 'stored-version',
		})
		await workspace.saveInput(target.entry)
		expect(api.setInput).toHaveBeenLastCalledWith({
			...target,
			data: { title: 'new draft' },
			editor,
			expectedVersion: 'stored-version',
		})
		workspace.dispose()
	})
	it('sends native ProseMirror JSON attributes through the actual RPC serializer', async () => {
		const workspace = createWorkspace()
		workspace.retainDocument(target.entry)
		await settle()
		const document = workspace.documents.get(target.entry)!
		workspace.documents.set(target.entry, {
			...document,
			editor: {
				formatVersion: 1,
				templateId: target.entry,
				templateRevision: 'source',
				regions: { body: { type: 'doc', content: [{ type: 'paragraph' }] } },
			},
		})
		const attrs = Object.assign(Object.create(null), { level: 2 })
		await workspace.writeRegion(target.entry, 'body', {
			type: 'doc',
			content: [{ type: 'heading', attrs, content: [{ type: 'text', text: '原生正文' }] }],
		})
		vi.mocked(api.setInput).mockImplementation(async (input) => {
			expect(() => serialize(input)).not.toThrow()
			return { data: input.data, editor: input.editor, storageVersion: 'saved' }
		})
		await workspace.saveInput(target.entry)
		expect(workspace.documents.get(target.entry)?.inputError).toBeUndefined()
		expect(
			workspace.documents.get(target.entry)?.editor?.regions.body?.content?.[0]?.attrs,
		).toEqual({ level: 2 })
		workspace.dispose()
	})
	it('includes unsaved template and resource edits in candidate identity', async () => {
		const workspace = createWorkspace()
		workspace.retainDocument(target.entry)
		await settle()
		const before = workspace.draftRevision(target.entry)
		workspace.files.set('main/main.typ', {
			path: 'main/main.typ',
			content: 'saved',
			saved: 'saved',
			version: 'v1',
			dirty: false,
			saving: false,
			token: 0,
			external: 0,
		})
		expect(workspace.draftRevision(target.entry)).toBe(before)
		workspace.edit('main/main.typ', 'unsaved template')
		expect(workspace.draftRevision(target.entry)).not.toBe(before)
		workspace.dispose()
	})
	it('keeps schema output separate from raw input and coalesces edits to the latest snapshot', async () => {
		vi.useFakeTimers()
		let complete!: (value: CompileResult) => void
		vi.mocked(api.compile).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					complete = resolve
				}),
		)
		vi.mocked(api.compile).mockImplementation(async ({ data, clientRevision }) =>
			result(`${data.title} transformed`, clientRevision),
		)
		const workspace = createWorkspace()
		workspace.retainDocument(target.entry)
		await settle()
		await workspace.writeData(target.entry, { title: 'first' })
		await workspace.writeData(target.entry, { title: 'second' })
		await workspace.writeData(target.entry, { title: 'third' })
		await vi.advanceTimersByTimeAsync(180)
		expect(api.compile).toHaveBeenCalledTimes(1)
		complete(result('old transformed', 0))
		await settle()
		expect(api.compile).toHaveBeenCalledTimes(2)
		expect(api.compile).toHaveBeenLastCalledWith({
			...target,
			data: { title: 'third' },
			editor: undefined,
			clientRevision: 3,
		})
		expect(api.getPreview).not.toHaveBeenCalledWith({ ...target, revision: 'old transformed' })
		expect(workspace.documents.get(target.entry)).toMatchObject({
			data: { title: 'third' },
			result: { data: { title: 'third transformed' }, clientRevision: 3 },
		})
		await workspace.saveInput(target.entry)
		expect(api.setInput).toHaveBeenLastCalledWith({
			...target,
			data: { title: 'third' },
			editor: undefined,
			expectedVersion: null,
		})
		workspace.dispose()
	})
	it('routes generated hits to a region and rejects old async source requests', async () => {
		const workspace = createWorkspace()
		workspace.retainDocument(target.entry)
		await settle()
		workspace.files.set('main/main.typ', {
			path: 'main/main.typ',
			content: 'source',
			saved: 'source',
			version: 'typ-version',
			dirty: false,
			saving: false,
			token: 0,
			external: 0,
		})
		const current = workspace.documents.get(target.entry)!
		const shown = current.preview!
		shown.generatedMapping = [
			{
				kind: 'text',
				snapshotRevision: 0,
				regionId: 'body',
				path: '_editor/regions/body.typ',
				from: 0,
				to: 10,
				startOffset: 4,
				endOffset: 20,
				range: { start: { line: 2, column: 1 }, end: { line: 3, column: 1 } },
			},
		]
		const point = {
			path: '_editor/regions/body.typ',
			line: 2,
			column: 3,
			endLine: 2,
			endColumn: 6,
			page: 1,
			x: 0,
			y: 0,
			width: 10,
			height: 10,
		}
		let open!: (value: boolean) => void
		const openSource = vi.fn(
			() =>
				new Promise<boolean>((resolve) => {
					open = resolve
				}),
		)
		workspace.connectSourceNavigation(openSource)
		await workspace.revealSource(shown, point)
		expect(workspace.regionLocation).toMatchObject({
			entry: target.entry,
			regionId: 'body',
			from: 0,
			to: 10,
		})
		expect(openSource).not.toHaveBeenCalled()
		shown.generatedMapping = [
			{
				...shown.generatedMapping[0]!,
				kind: 'atom',
				path: '_editor/blocks/body/note-1.typ',
				from: 0,
				to: 1,
				sourceStartLine: 2,
			},
		]
		await workspace.revealSource(shown, { ...point, path: '_editor/blocks/body/note-1.typ' })
		expect(workspace.regionLocation).toMatchObject({
			entry: target.entry,
			regionId: 'body',
			from: 0,
			to: 1,
			source: { line: 1, column: 3 },
		})
		expect(openSource).not.toHaveBeenCalled()
		current.inputDirty = true
		current.inputSaving = true
		expect(workspace.isNavigationCurrent(shown)).toBe(true)
		const navigating = workspace.revealSource(shown, { ...point, path: 'main/main.typ' })
		await workspace.writeData(target.entry, { title: 'changed while source opens' })
		open(true)
		await navigating
		expect(workspace.location).toBeUndefined()
		expect(workspace.isNavigationCurrent(shown)).toBe(false)
		workspace.dispose()
	})
	it('moves only the host-selected visible preview when imported source belongs to two reports', async () => {
		const workspace = createWorkspace()
		workspace.retainDocument(target.entry)
		await settle()
		workspace.files.set('main/main.typ', {
			path: 'main/main.typ',
			content: '',
			saved: '',
			version: 'typ-version',
			dirty: false,
			saving: false,
			token: 0,
			external: 0,
		})
		const current = workspace.documents.get(target.entry)!
		const shown = current.preview!
		const point = {
			path: 'main/main.typ',
			line: 1,
			column: 1,
			endLine: 1,
			endColumn: 5,
			page: 1,
			x: 0,
			y: 0,
			width: 10,
			height: 10,
		}
		shown.preview = {
			...shown.preview,
			navigation: { ...shown.preview.navigation, points: [point] },
		}
		const other = { ...shown, entry: 'other/other.ts' }
		workspace.documents.set(other.entry, { ...current, entry: other.entry, preview: other })
		const reveal = vi.fn(() => true),
			revealOther = vi.fn(() => true)
		workspace.registerPreview({
			entry: shown.entry,
			element: {} as HTMLElement,
			result: () => shown,
			reveal,
		})
		workspace.registerPreview({
			entry: other.entry,
			element: {} as HTMLElement,
			result: () => other,
			reveal: revealOther,
		})
		workspace.revealPreview(point)
		expect(reveal).not.toHaveBeenCalled()
		expect(revealOther).not.toHaveBeenCalled()
		workspace.preferPreview(other.entry)
		workspace.revealPreview(point)
		expect(revealOther).toHaveBeenCalledOnce()
		expect(reveal).not.toHaveBeenCalled()
		workspace.dispose()
	})
	it('recompiles after replacement without replaying failed writes or discarding drafts', async () => {
		vi.useFakeTimers()
		let connectionChanged!: (connected: boolean) => void
		const unsubscribe = vi.fn()
		vi.mocked(onDesktopConnectionChange).mockImplementation((listener) => {
			connectionChanged = listener
			return unsubscribe
		})
		const workspace = createWorkspace()
		vi.mocked(api.getTree).mockResolvedValue({
			project: workspace.project,
			revision: 'tree',
			entries: [],
			documents: [],
			config: { name: 'Project', fonts: [] },
		})
		workspace.start()
		workspace.start()
		expect(onDesktopConnectionChange).toHaveBeenCalledTimes(1)
		await settle()
		const release = workspace.retainDocument(target.entry)
		await settle()
		const previousPreview = workspace.documents.get(target.entry)!.preview
		connectionChanged(false)
		expect(workspace.documents.get(target.entry)?.result).toBeUndefined()
		expect(workspace.documents.get(target.entry)?.preview).toBe(previousPreview)
		vi.mocked(api.compile).mockResolvedValueOnce(result('replacement'))
		connectionChanged(true)
		await settle()
		expect(workspace.documents.get(target.entry)?.result?.revision).toBe('replacement')
		expect(api.setInput).not.toHaveBeenCalled()
		vi.mocked(api.setInput).mockRejectedValueOnce(new Error('connection lost'))
		await workspace.writeData(target.entry, { title: 'unsaved draft' })
		await vi.advanceTimersByTimeAsync(400)
		const calls = vi.mocked(api.compile).mock.calls.length
		connectionChanged(false)
		connectionChanged(true)
		await settle()
		expect(workspace.documents.get(target.entry)).toMatchObject({
			data: { title: 'unsaved draft' },
			inputDirty: true,
		})
		expect(api.compile).toHaveBeenCalledTimes(calls + 1)
		expect(api.setInput).toHaveBeenCalledTimes(1)
		// The last view can close while failed input remains owned by the workspace.
		release()
		await settle()
		connectionChanged(true)
		await settle()
		expect(api.compile).toHaveBeenCalledTimes(calls + 1)
		await workspace.saveInput(target.entry)
		expect(workspace.documents.has(target.entry)).toBe(false)
		connectionChanged(true)
		await settle()
		expect(workspace.documents.has(target.entry)).toBe(false)
		expect(api.compile).toHaveBeenCalledTimes(calls + 1)
		workspace.dispose()
		expect(unsubscribe).toHaveBeenCalledOnce()
	})
	it('shares a report across views, survives effect replay and releases the last clean output', async () => {
		const workspace = createWorkspace()
		const releaseForm = workspace.retainDocument(target.entry)
		const releasePreview = workspace.retainDocument(target.entry)
		await settle()
		const document = workspace.documents.get(target.entry)
		releaseForm()
		releasePreview()
		const reconnect = workspace.retainDocument(target.entry)
		await settle()
		expect(workspace.documents.get(target.entry)).toBe(document)
		expect(api.compile).toHaveBeenCalledTimes(1)
		reconnect()
		reconnect()
		await settle()
		expect(workspace.documents.has(target.entry)).toBe(false)
		workspace.dispose()
	})
	it('does not let a released compilation replace a reopened report', async () => {
		let complete!: (value: CompileResult) => void
		vi.mocked(api.compile).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					complete = resolve
				}),
		)
		const workspace = createWorkspace()
		const release = workspace.retainDocument(target.entry)
		await settle()
		release()
		await settle()
		workspace.retainDocument(target.entry)
		await settle()
		complete(result('stale'))
		await settle()
		expect(workspace.documents.get(target.entry)?.result?.revision).toBe('default')
		expect(api.getPreview).not.toHaveBeenCalledWith({ ...target, revision: 'stale' })
		workspace.dispose()
	})
	it('keeps dirty unmounted input until a successful explicit retry without compiling unused output', async () => {
		vi.useFakeTimers()
		const workspace = createWorkspace()
		const release = workspace.retainDocument(target.entry)
		await settle()
		await workspace.writeData(target.entry, { title: 'unsaved' })
		release()
		vi.mocked(api.setInput).mockRejectedValueOnce(new Error('disk full'))
		await vi.advanceTimersByTimeAsync(400)
		expect(workspace.isDirty()).toBe(true)
		expect(workspace.documents.get(target.entry)?.data).toEqual({ title: 'unsaved' })
		await workspace.saveInput(target.entry)
		expect(workspace.isDirty()).toBe(false)
		expect(workspace.documents.size).toBe(0)
		expect(api.compile).toHaveBeenCalledTimes(1)
		workspace.dispose()
	})
	it('polls only retained reports and preserves an operation error after a successful refresh', async () => {
		const workspace = createWorkspace()
		const release = workspace.retainDocument(target.entry)
		await settle()
		release()
		await settle()
		vi.mocked(api.getTree).mockResolvedValue({
			project: { id: 'project', name: 'Project', root: '/project' },
			revision: 'changed',
			entries: [],
			documents: [],
			config: { name: 'Project', fonts: [] },
		})
		workspace.error = 'File operation failed'
		await workspace.refresh()
		expect(workspace.error).toBe('File operation failed')
		expect(api.compile).toHaveBeenCalledTimes(1)
		workspace.dispose()
	})
	it('refuses closing shared unsaved source and only discards through an explicit resource action', async () => {
		const workspace = createWorkspace()
		workspace.files.set(target.entry, {
			path: target.entry,
			content: 'draft',
			saved: 'saved',
			version: 'old',
			dirty: true,
			saving: false,
			token: 1,
			external: 0,
			missing: true,
		})
		const form = editorLifecycle(workspace, target.entry, 'form')
		const file = editorLifecycle(workspace, target.entry, 'file')
		expect(await form.beforeLeave!('close', { id: 'form', from: '/form' })).toBe(false)
		expect(file.isDirty!()).toBe(true)
		expect(workspace.files.get(target.entry)?.content).toBe('draft')
		expect(form.dispose).toBeUndefined()
		const revision = file.getCloseRevision!()
		await workspace.discard(target.entry)
		expect(file.getCloseRevision!()).not.toBe(revision)
		expect(await file.beforeLeave!('close', { id: 'file', from: '/file' })).toBe(true)
		expect(workspace.files.get(target.entry)?.content).toBe('saved')
		workspace.dispose()
	})
	it('saves outside files, serializes edits and ignores stale compile data', async () => {
		vi.useFakeTimers()
		let release: ((value: CompileResult) => void) | undefined
		vi.mocked(api.compile).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					release = resolve
				}),
		)
		const workspace = createWorkspace()
		workspace.retainDocument(target.entry)
		await settle()
		expect(api.compile).toHaveBeenCalledWith({
			...target,
			data: { title: 'default' },
			editor: undefined,
			clientRevision: 0,
		})
		await workspace.writeData(target.entry, { title: 'first' })
		release!(result('stale'))
		await settle()
		expect(workspace.documents.get(target.entry)?.data.title).toBe('first')
		expect(api.getPreview).not.toHaveBeenCalledWith({ ...target, revision: 'stale' })
		await workspace.writeData(target.entry, { title: 'latest' })
		await vi.advanceTimersByTimeAsync(400)
		expect(api.setInput).toHaveBeenCalledTimes(1)
		expect(api.setInput).toHaveBeenCalledWith({
			...target,
			data: { title: 'latest' },
			editor: undefined,
			expectedVersion: null,
		})
		expect(api.compile).toHaveBeenLastCalledWith({
			...target,
			data: { title: 'latest' },
			editor: undefined,
			clientRevision: 2,
		})
		expect(api.getInput).toHaveBeenCalledTimes(1)
		expect(api.writeFile).not.toHaveBeenCalled()
		expect(workspace.documents.get(target.entry)).toMatchObject({
			inputDirty: false,
			data: { title: 'latest' },
		})
		workspace.dispose()
	})
	it('retains failed input for an explicit retry', async () => {
		vi.useFakeTimers()
		vi.mocked(api.setInput).mockRejectedValue(new Error('disk full'))
		const workspace = createWorkspace()
		workspace.retainDocument(target.entry)
		await settle()
		await workspace.writeData(target.entry, { title: 'unsaved' })
		await vi.advanceTimersByTimeAsync(400)
		expect(workspace.documents.get(target.entry)).toMatchObject({
			inputDirty: true,
			data: { title: 'unsaved' },
			inputError: expect.stringContaining('disk full'),
		})
		expect(api.compile).toHaveBeenCalledTimes(2)
		expect(workspace.documents.get(target.entry)?.result?.clientRevision).toBe(1)
		workspace.dispose()
	})
	it('does not mistake an absent empty record for a confirmed save after failure', async () => {
		vi.mocked(api.setInput).mockRejectedValue(new Error('disk full'))
		const workspace = createWorkspace()
		workspace.retainDocument(target.entry)
		await settle()
		await workspace.writeData(target.entry, {})
		await workspace.saveInput(target.entry)
		expect(workspace.documents.get(target.entry)).toMatchObject({
			data: {},
			storageVersion: null,
			inputDirty: true,
			inputError: expect.stringContaining('disk full'),
		})
		workspace.dispose()
	})
	it('keeps the last preview after a competing revision without retrying the compile', async () => {
		const workspace = createWorkspace()
		workspace.retainDocument(target.entry)
		await settle()
		const previous = workspace.documents.get(target.entry)!
		expect(previous.preview?.preview.data).toBeInstanceOf(Uint8Array)
		vi.mocked(api.getPreview).mockRejectedValueOnce({
			code: 'REVISION_CONFLICT',
			message: 'Another client compiled',
		})
		await workspace.compile(target.entry)
		const next = workspace.documents.get(target.entry)!
		expect(next.result).toBe(previous.result)
		expect(next.preview).toBe(previous.preview)
		expect(next.error).toContain('预览版本已改变')
		expect(workspace.isNavigationCurrent(next.preview!)).toBe(false)
		expect(api.compile).toHaveBeenCalledTimes(2)
		await settle()
		expect(api.compile).toHaveBeenCalledTimes(2)
		workspace.dispose()
	})
	it('describes fields when the explicit input is invalid and preserves the editable data', async () => {
		vi.mocked(api.getInput).mockResolvedValue({ data: { title: 0 }, storageVersion: 'existing' })
		const issues = [{ path: ['title'], rule: 'string', message: 'Expected string' }]
		vi.mocked(api.compile).mockRejectedValue({
			code: 'INPUT_INVALID',
			message: 'Invalid data',
			issues,
		})
		const workspace = createWorkspace()
		workspace.retainDocument(target.entry)
		await settle()
		expect(workspace.documents.get(target.entry)).toMatchObject({
			fields: description.fields,
			data: { title: 0 },
			error: 'Invalid data',
			busy: false,
		})
		expect(api.getPreview).not.toHaveBeenCalled()
		workspace.dispose()
	})
	it('preserves a file draft when a serializable conflict crosses RPC', async () => {
		const workspace = createWorkspace()
		workspace.files.set('note.typ', {
			path: 'note.typ',
			content: 'draft',
			version: 'old',
			saved: 'saved',
			dirty: true,
			saving: false,
			token: 1,
			external: 0,
		})
		vi.mocked(api.writeFile).mockRejectedValue({
			code: 'REVISION_CONFLICT',
			message: 'File changed',
		})
		await workspace.save('note.typ')
		expect(workspace.files.get('note.typ')).toMatchObject({
			content: 'draft',
			dirty: true,
			saving: false,
			error: expect.stringContaining('保存冲突'),
		})
		workspace.dispose()
	})
})
