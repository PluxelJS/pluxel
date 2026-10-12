import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CompileResult, DocumentDescription, PreviewResult } from '../src/shared/contracts'
import { WorkspaceController } from '../src/renderer/workspace'
import { api } from '../src/renderer/api'

vi.mock('../src/renderer/api', () => ({
	api: {
		describeDocument: vi.fn(),
		getInput: vi.fn(),
		setInput: vi.fn(),
		compile: vi.fn(),
		getPreview: vi.fn(),
		writeFile: vi.fn(),
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
		workspace.ensureDocument(target.entry)
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
		workspace.ensureDocument(target.entry)
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
		workspace.ensureDocument(target.entry)
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
		workspace.ensureDocument(target.entry)
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
