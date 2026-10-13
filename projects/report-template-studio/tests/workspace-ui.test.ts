import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CompileResult, DocumentDescription, PreviewResult } from '../src/shared/contracts'
import { WorkspaceController } from '../src/renderer/workspace'
import { api, onDesktopConnectionChange } from '../src/renderer/api'
import { editorLifecycle } from '../src/renderer/editor-lifecycle'

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
const result = (title: string): CompileResult => ({
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
const preview = (revision: string): PreviewResult => ({
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
	vi.mocked(api.getInput).mockResolvedValue({ data: {} })
	vi.mocked(api.setInput).mockImplementation(async ({ data }) => ({ data }))
	vi.mocked(api.compile).mockImplementation(async ({ data }) =>
		result(String(data.title ?? 'default')),
	)
	vi.mocked(api.getPreview).mockImplementation(async ({ revision }) => preview(revision))
})
afterEach(() => {
	vi.useRealTimers()
	vi.resetAllMocks()
})
describe('workspace explicit form input and preview ownership', () => {
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
		expect(api.compile).toHaveBeenCalledTimes(calls)
		expect(api.setInput).toHaveBeenCalledTimes(1)
		// The last view can close while failed input remains owned by the workspace.
		release()
		await settle()
		connectionChanged(true)
		await settle()
		expect(api.compile).toHaveBeenCalledTimes(calls)
		await workspace.saveInput(target.entry)
		expect(workspace.documents.has(target.entry)).toBe(false)
		connectionChanged(true)
		await settle()
		expect(workspace.documents.has(target.entry)).toBe(false)
		expect(api.compile).toHaveBeenCalledTimes(calls)
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
		const current = workspace.documents.get(target.entry)
		complete(result('stale'))
		await settle()
		expect(workspace.documents.get(target.entry)).toBe(current)
		expect(current?.result?.revision).toBe('default')
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
		expect(api.compile).toHaveBeenCalledWith({ ...target, data: {} })
		await workspace.writeData(target.entry, { title: 'first' })
		release!(result('stale'))
		await settle()
		expect(workspace.documents.get(target.entry)?.data.title).toBe('first')
		expect(api.getPreview).not.toHaveBeenCalled()
		await workspace.writeData(target.entry, { title: 'latest' })
		await vi.advanceTimersByTimeAsync(400)
		expect(api.setInput).toHaveBeenCalledTimes(1)
		expect(api.setInput).toHaveBeenCalledWith({ ...target, data: { title: 'latest' } })
		expect(api.compile).toHaveBeenLastCalledWith({ ...target, data: { title: 'latest' } })
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
		expect(api.compile).toHaveBeenCalledTimes(1)
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
		vi.mocked(api.getInput).mockResolvedValue({ data: { title: 0 } })
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
