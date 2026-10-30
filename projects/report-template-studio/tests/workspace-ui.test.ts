import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { serialize } from 'capnweb'
import { createTypstSourceEditor } from '@pluxel/plugin-typst/tiptap'
import { createTypstSourceProject, findTypstEditorPosition } from '@pluxel/plugin-typst/source'
import type { CompileResult, DocumentDescription, PreviewResult } from '../src/shared/contracts'
import { sourceFiles } from '../src/shared/source-files'
import { WorkspaceController } from '../src/renderer/workspace'
import { api, onDesktopConnectionChange } from '../src/renderer/api'
import { editorLifecycle } from '../src/renderer/editor-lifecycle'

vi.mock('../src/renderer/source-navigation', () => ({ isPaneVisible: () => true }))

vi.mock('../src/renderer/api', () => ({
	onDesktopConnectionChange: vi.fn(),
	api: {
		describeDocument: vi.fn(),
		getInput: vi.fn(),
		attachBodyEditor: vi.fn(async () => ({ close: async () => {} })),
		setInput: vi.fn(),
		compile: vi.fn(),
		getPreview: vi.fn(),
		writeFile: vi.fn(),
		readFile: vi.fn(),
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
	it.each(
		['main/body.typ', 'main/data.json'].flatMap((path) =>
			(['dirty', 'failed', 'inflight', 'external'] as const).map((phase) => ({ path, phase })),
		),
	)(
		'hands a file-first $path draft to the input owner after $phase saves',
		async ({ path, phase }) => {
			vi.useFakeTimers()
			const workspace = createWorkspace()
			let storageVersion = 'source'
			let disk = { 'main/body.typ': 'Original body', 'main/data.json': '{"title":"Original"}' }
			const changed = path.endsWith('.json') ? '{"title":"First draft"}' : 'First draft'
			const latest = path.endsWith('.json') ? '{"title":"Latest draft"}' : 'Latest draft'
			const input = () => ({
				data: JSON.parse(disk['main/data.json']),
				editor: { files: { ...disk } },
				storageVersion,
			})
			vi.mocked(api.getInput).mockImplementation(async () => input())
			vi.mocked(api.describeDocument).mockImplementation(async () => ({
				...description,
				sourceRevision: storageVersion,
				editor: { sources: [{ path: 'main/body.typ' }] },
			}))
			vi.mocked(api.compile).mockImplementation(async ({ data, clientRevision }) => ({
				...result(String(data.title), clientRevision),
				sourceRevision: storageVersion,
			}))
			vi.mocked(api.getTree).mockImplementation(async () => ({
				project: workspace.project,
				revision: storageVersion,
				documents: [],
				config: { name: 'Project', fonts: [] },
				entries: Object.keys(disk).map((filePath) => ({
					path: filePath,
					kind: 'file',
					size: 1,
					version: storageVersion,
				})),
			}))
			vi.mocked(api.readFile).mockImplementation(async ({ path: filePath }) => ({
				path: filePath,
				content: disk[filePath as keyof typeof disk],
				version: storageVersion,
			}))
			workspace.files.set(path, {
				path,
				content: disk[path as keyof typeof disk],
				saved: disk[path as keyof typeof disk],
				version: storageVersion,
				dirty: false,
				saving: false,
				token: 0,
				external: 0,
			})
			workspace.edit(path, changed)
			let finishWrite!: () => void
			let rawSave: Promise<void> | undefined
			if (phase === 'failed' || phase === 'external') {
				vi.mocked(api.writeFile).mockRejectedValueOnce(new Error('Raw save failed'))
				await workspace.save(path)
				if (phase === 'external') {
					disk = {
						...disk,
						[path]: path.endsWith('.json') ? '{"title":"External"}' : 'External body',
					}
					storageVersion = 'external'
				}
			} else if (phase === 'inflight') {
				vi.mocked(api.writeFile).mockImplementationOnce(
					() =>
						new Promise((resolve) => {
							finishWrite = () => {
								disk = { ...disk, [path]: changed }
								storageVersion = 'raw-saved'
								resolve({ path, content: changed, version: storageVersion })
							}
						}),
				)
				rawSave = workspace.save(path)
			}
			workspace.retainDocument(target.entry)
			await settle()
			expect(api.getInput).toHaveBeenCalledTimes(phase === 'inflight' ? 0 : 1)
			if (phase === 'inflight') {
				workspace.edit(path, latest)
				finishWrite()
				await rawSave
			}
			await workspace.compile(target.entry)
			const expected = phase === 'inflight' ? latest : changed
			expect(workspace.documents.get(target.entry)?.editor?.files[path]).toBe(expected)
			expect(workspace.files.get(path)).toMatchObject({
				content: expected,
				dirty: false,
				saving: false,
			})
			expect(workspace.documents.get(target.entry)?.inputDirty).toBe(true)
			expect(workspace.documents.get(target.entry)?.inputError).toBe(
				phase === 'failed' || phase === 'external' ? 'Error: Raw save failed' : undefined,
			)
			expect(workspace.documents.get(target.entry)?.inputConflict).toEqual(
				phase === 'external' ? input() : undefined,
			)
			const adopted = workspace.documents.get(target.entry)!
			const expectedCalls =
				phase === 'external'
					? []
					: [
							[
								{
									...target,
									data: adopted.data,
									editor: adopted.editor,
									expectedVersion: storageVersion,
								},
							],
						]
			const expectedDisk = phase === 'external' ? disk[path as keyof typeof disk] : expected
			vi.mocked(api.setInput).mockImplementation(async (request) => {
				disk = request.editor!.files as typeof disk
				storageVersion = 'input-saved'
				return input()
			})
			await workspace.save(path)
			expect(vi.mocked(api.setInput).mock.calls).toEqual(expectedCalls)
			expect(disk[path as keyof typeof disk]).toBe(expectedDisk)
			const writes = vi.mocked(api.writeFile).mock.calls.length
			await vi.advanceTimersByTimeAsync(700)
			expect(api.writeFile).toHaveBeenCalledTimes(writes)
			workspace.dispose()
		},
	)
	it('retains invalid file-first JSON under the raw file owner until it is repaired', async () => {
		vi.useFakeTimers()
		const workspace = createWorkspace()
		const path = 'main/data.json'
		workspace.files.set(path, {
			path,
			content: '{}',
			saved: '{}',
			version: 'original',
			dirty: false,
			saving: false,
			token: 0,
			external: 0,
		})
		vi.mocked(api.getInput).mockResolvedValue({
			data: {},
			editor: { files: { [path]: '{}' } },
			storageVersion: 'original',
		})
		workspace.edit(path, '{ invalid JSON draft')
		workspace.retainDocument(target.entry)
		await workspace.compile(target.entry)
		expect(workspace.files.get(path)).toMatchObject({
			content: '{ invalid JSON draft',
			dirty: true,
		})
		expect(workspace.inputOwner(path)).toBeUndefined()
		expect(workspace.documents.get(target.entry)).toMatchObject({
			error: expect.stringContaining('data.json 草稿不是有效 JSON 对象'),
		})
		expect(workspace.documents.get(target.entry)?.editor).toBeUndefined()
		expect(api.compile).not.toHaveBeenCalled()
		workspace.edit(path, '{"title":"Repaired draft"}')
		await workspace.compile(target.entry)
		expect(workspace.inputOwner(path)?.data).toEqual({ title: 'Repaired draft' })
		expect(workspace.inputOwner(path)?.editor?.files[path]).toBe('{"title":"Repaired draft"}')
		expect(workspace.files.get(path)?.dirty).toBe(false)
		workspace.dispose()
	})

	it('publishes new schema fields together with their input snapshot before users can edit them', async () => {
		const workspace = createWorkspace()
		workspace.retainDocument(target.entry)
		await workspace.compile(target.entry)
		const changed = {
			...description,
			sourceRevision: 'new-schema',
			fields: [...description.fields, { ...description.fields[0]!, path: 'extra', name: 'extra' }],
		}
		vi.mocked(api.describeDocument).mockResolvedValue(changed)
		let read!: (value: Awaited<ReturnType<typeof api.getInput>>) => void
		vi.mocked(api.getInput).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					read = resolve
				}),
		)
		vi.mocked(api.compile).mockImplementation(async ({ data, clientRevision }) => ({
			...result(String(data.title), clientRevision),
			sourceRevision: changed.sourceRevision,
		}))
		const compiling = workspace.compile(target.entry)
		await settle()
		expect(read).toBeTypeOf('function')
		expect(workspace.documents.get(target.entry)!.fields).toEqual(description.fields)
		read({
			data: { title: 'saved' },
			editor: { files: { 'main/main.ts': 'new schema', 'main/data.json': '{"title":"saved"}' } },
			storageVersion: 'new-schema-snapshot',
		})
		await compiling
		expect(workspace.documents.get(target.entry)!.fields).toEqual(changed.fields)
		await workspace.writeData(target.entry, { title: 'saved', extra: 'recovered' })
		await workspace.saveInput(target.entry)
		expect(api.setInput).toHaveBeenLastCalledWith(
			expect.objectContaining({
				expectedVersion: 'new-schema-snapshot',
				data: { title: 'saved', extra: 'recovered' },
				editor: {
					files: {
						'main/main.ts': 'new schema',
						'main/data.json': '{\n  "title": "saved",\n  "extra": "recovered"\n}\n',
					},
				},
			}),
		)
		expect(workspace.documents.get(target.entry)!.inputConflict).toBeUndefined()
		workspace.dispose()
	})
	it('does not revive a disconnected body lease after an in-flight save settles', async () => {
		vi.useFakeTimers()
		const workspace = createWorkspace()
		workspace.start()
		const release = workspace.retainDocument(target.entry)
		await workspace.compile(target.entry)
		workspace.documents.set(target.entry, {
			entry: target.entry,
			data: {},
			editor: { files: { 'main/body.typ': 'Original', 'main/data.json': '{}' } },
			inputLoaded: true,
			inputDirty: true,
			inputToken: 1,
			fields: [],
			busy: false,
			generation: 1,
			diagnostics: [],
		})
		let saved!: (value: Awaited<ReturnType<typeof api.getInput>>) => void
		vi.mocked(api.setInput).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					saved = resolve
				}),
		)
		const saving = workspace.saveInput(target.entry)
		const capturing = workspace.captureBody({ entry: target.entry })
		const rejected = capturing.catch((cause) => cause)
		vi.mocked(onDesktopConnectionChange).mock.calls.at(-1)![0](false)
		saved({
			data: {},
			editor: workspace.documents.get(target.entry)!.editor,
			storageVersion: 'saved',
		})
		await saving
		expect(await rejected).toMatchObject({ message: expect.stringContaining('连接已改变') })
		expect(workspace.documents.get(target.entry)?.bodyLocked).toBe(false)
		workspace.writeSources(target.entry, {
			'main/body.typ': 'Human edit after disconnect',
			'main/data.json': '{}',
		})
		expect(workspace.documents.get(target.entry)?.editor?.files['main/body.typ']).toBe(
			'Human edit after disconnect',
		)
		workspace.dispose()
		release()
	})
	it('retains the last preview as stale when a committed body cannot compile', async () => {
		const workspace = createWorkspace()
		const release = workspace.retainDocument(target.entry)
		await workspace.compile(target.entry)
		const current = workspace.documents.get(target.entry)!
		const files = {
			'main/body.typ': 'Original',
			'main/data.json': JSON.stringify({ title: 'default' }),
		}
		workspace.documents.set(target.entry, {
			...current,
			description: { ...description, editor: { sources: [{ path: 'main/body.typ' }] } },
			editor: { files },
		})
		const snapshot = (await workspace.captureBody({ entry: target.entry }))!
		const saved = {
			...snapshot.input,
			editor: { files: { ...files, 'main/body.typ': 'Committed body' } },
			storageVersion: 'committed',
		}
		await workspace.finishBody({
			entry: target.entry,
			lease: snapshot.lease,
			commit: {
				input: saved,
				patches: [{ path: 'main/body.typ', from: 0, to: 8, text: 'Committed body' }],
				data: { title: 'default' },
				previewError: 'Typst compilation failed',
			},
		})
		const after = workspace.documents.get(target.entry)!
		expect(after.editor).toEqual(saved.editor)
		expect(after.storageVersion).toBe('committed')
		expect(after.inputDirty).toBe(false)
		expect(after.bodyLocked).toBe(false)
		expect(after.result).toBe(current.result)
		expect(after.preview).toBe(current.preview)
		expect(after.error).toBe('Typst compilation failed')
		expect(workspace.isNavigationCurrent(after.preview!)).toBe(false)
		workspace.dispose()
		release()
	})
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
			files: {
				'main/body.typ': '初始正文',
				'main/data.json': JSON.stringify({ title: 'stored draft' }),
			},
		}
		const updatedEditor = {
			files: {
				...editor.files,
				'main/data.json': JSON.stringify({ title: 'new draft' }, null, 2) + '\n',
			},
		}
		loaded({ data: { title: 'stored draft' }, editor, storageVersion: 'stored-version' })
		await settle()
		expect(workspace.documents.get(target.entry)).toMatchObject({
			data: { title: 'new draft' },
			editor: updatedEditor,
			inputLoaded: true,
			storageVersion: 'stored-version',
		})
		await workspace.saveInput(target.entry)
		expect(api.setInput).toHaveBeenLastCalledWith({
			...target,
			data: { title: 'new draft' },
			editor: updatedEditor,
			expectedVersion: 'stored-version',
		})
		workspace.dispose()
	})
	it('sends authoritative source snapshots through the actual RPC serializer', async () => {
		const workspace = createWorkspace()
		workspace.retainDocument(target.entry)
		await settle()
		const files = { 'main/body.typ': '== 原生正文\n', 'main/data.json': '{}' }
		const project = createTypstSourceProject({ files })
		const current = workspace.documents.get(target.entry)!
		workspace.documents.set(target.entry, { ...current, editor: { files } })
		workspace.registerSourceProject(target.entry, project)
		const projection = project.open('main/body.typ')
		expect(
			project.edit({
				projection,
				document: {
					type: 'doc',
					content: [
						{
							type: 'heading',
							attrs: { level: 2 },
							content: [{ type: 'text', text: '经过真实投影修改' }],
						},
					],
				},
			}).ok,
		).toBe(true)
		vi.mocked(api.setInput).mockImplementation(async (input) => {
			expect(() => serialize(input)).not.toThrow()
			return { data: input.data, editor: input.editor, storageVersion: 'saved' }
		})
		await workspace.saveInput(target.entry)
		expect(api.setInput).toHaveBeenCalledOnce()
		expect(workspace.documents.get(target.entry)?.inputError).toBeUndefined()
		expect(workspace.documents.get(target.entry)?.editor?.files['main/body.typ']).toContain(
			'经过真实投影修改',
		)
		expect(Object.keys(workspace.documents.get(target.entry)!.editor!)).toEqual(['files'])
		workspace.dispose()
	})

	it('shares one pending source authority and undo history between split views', async () => {
		const workspace = createWorkspace()
		workspace.retainDocument(target.entry)
		await settle()
		const files = { 'main/body.typ': '原始正文', 'main/data.json': '{}' }
		const assets = [{ path: 'main/pixel.png', size: 3, bytes: new Uint8Array([137, 0, 255]) }]
		const project = createTypstSourceProject({ files: sourceFiles({ editor: { files }, assets }) })
		workspace.documents.set(target.entry, {
			...workspace.documents.get(target.entry)!,
			editor: { files },
			assets,
		})
		let ready!: (value: typeof project) => void
		const create = vi.fn(
			() =>
				new Promise<typeof project>((resolve) => {
					ready = resolve
				}),
		)
		const first = workspace.loadSourceProject(target.entry, 'same-source-config', create)
		const second = workspace.loadSourceProject(target.entry, 'same-source-config', create)
		expect(first).toBe(second)
		expect(create).toHaveBeenCalledOnce()
		await workspace.writeData(target.entry, { title: 'typed during initialization' })
		ready(project)
		const [leftProject, rightProject] = await Promise.all([first, second])
		expect(leftProject).toBe(rightProject)
		expect(leftProject.snapshot().files['main/pixel.png']).toEqual(assets[0]!.bytes)
		expect(JSON.parse(leftProject.snapshot().files['main/data.json'] as string)).toEqual({
			title: 'typed during initialization',
		})
		const left = createTypstSourceEditor({ project: leftProject, path: 'main/body.typ' })
		const right = createTypstSourceEditor({ project: rightProject, path: 'main/body.typ' })
		try {
			expect(left.commands.insertContentAt(1, { type: 'text', text: '共同编辑' })).toBe(true)
			expect(right.getJSON()).toEqual(left.getJSON())
			expect(workspace.documents.get(target.entry)?.editor?.files).not.toHaveProperty(
				'main/pixel.png',
			)
			expect(leftProject.snapshot().files['main/pixel.png']).toEqual(assets[0]!.bytes)
			expect(rightProject.canUndo).toBe(true)
			expect(rightProject.undo().ok).toBe(true)
			expect(left.state.doc.textContent).toBe('原始正文')
			expect(right.getJSON()).toEqual(left.getJSON())
			expect(workspace.documents.get(target.entry)?.editor?.files['main/body.typ']).toBe('原始正文')
		} finally {
			left.destroy()
			right.destroy()
			workspace.dispose()
		}
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
	it('keeps candidate identity across its own autosave but invalidates real source and resource changes', async () => {
		const workspace = createWorkspace()
		workspace.retainDocument(target.entry)
		await settle()
		const path = 'main/body.typ'
		const files = { [path]: 'Original', 'main/data.json': '{}' }
		workspace.documents.set(target.entry, {
			...workspace.documents.get(target.entry)!,
			editor: { files },
			description: { ...description, editor: { sources: [{ path }] } },
		})
		workspace.tree = {
			project: workspace.project,
			config: { name: 'Project', fonts: [] },
			documents: [],
			revision: 'old',
			entries: [
				{ path: 'main', kind: 'directory', size: 0, version: 'old' },
				{ path, kind: 'file', size: 8, version: 'old' },
				{ path: 'main/data.json', kind: 'file', size: 2, version: 'old' },
				{ path: 'main/main.typ', kind: 'file', size: 8, version: 'template' },
				{ path: 'main/pixel.png', kind: 'file', size: 3, version: 'image' },
			],
		}
		const project = createTypstSourceProject({ files })
		workspace.registerSourceProject(target.entry, project)
		const identity = workspace.draftRevision(target.entry),
			revision = project.revision
		const current = workspace.documents.get(target.entry)!
		workspace.documents.set(target.entry, {
			...current,
			inputToken: 42,
			storageVersion: 'saved',
			description: { ...current.description!, sourceRevision: 'saved' },
		})
		workspace.tree.revision = 'saved'
		for (const file of workspace.tree.entries.slice(0, 3)) file.version = 'saved'
		expect(workspace.draftRevision(target.entry)).toBe(identity)
		expect(project.revision).toBe(revision)
		workspace.tree.entries[3]!.version = 'changed-template'
		expect(workspace.draftRevision(target.entry)).not.toBe(identity)
		workspace.tree.entries[3]!.version = 'template'
		workspace.tree.entries[4]!.version = 'changed-image'
		expect(workspace.draftRevision(target.entry)).not.toBe(identity)
		workspace.tree.entries[4]!.version = 'image'
		workspace.files.set(path, {
			path,
			content: 'Unapplied source',
			saved: files[path]!,
			version: 'saved',
			dirty: true,
			saving: false,
			token: 1,
			external: 0,
		})
		expect(workspace.draftRevision(target.entry)).not.toBe(identity)
		workspace.files.delete(path)
		await workspace.writeData(target.entry, { title: 'Changed data' })
		expect(project.revision).not.toBe(revision)
		const dataRevision = project.revision
		expect(
			project.replace({
				baseRevision: dataRevision,
				files: { ...project.snapshot().files, [path]: 'External source' },
			}).ok,
		).toBe(true)
		expect(project.revision).not.toBe(dataRevision)
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
	it('routes authored source hits into the real projection and rejects old async source requests', async () => {
		const workspace = createWorkspace()
		workspace.retainDocument(target.entry)
		await settle()
		const files = {
			'main/body.typ': '#for n in (1, 2) [#n]\n\n中文正文\n',
			'main/main.typ': '#include "body.typ"',
			'main/data.json': '{}',
		}
		const project = createTypstSourceProject({ files })
		workspace.registerSourceProject(target.entry, project)
		for (const [path, content] of Object.entries(files))
			workspace.files.set(path, {
				path,
				content,
				saved: content,
				version: 'typ-version',
				dirty: false,
				saving: false,
				token: 0,
				external: 0,
			})
		const current = workspace.documents.get(target.entry)!
		const shown = current.preview!
		workspace.documents.set(target.entry, {
			...current,
			editor: { files },
			compiledSources: files,
			description: { ...description, editor: { sources: [{ path: 'main/body.typ' }] } },
		})
		shown.sourceVersions = { 'main/body.typ': 'body-version', 'main/main.typ': 'typ-version' }
		const point = {
			path: 'main/body.typ',
			line: 3,
			column: 2,
			endLine: 3,
			endColumn: 3,
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
		const expected = findTypstEditorPosition({
			projection: project.open(point.path),
			sourcePosition: point,
		})
		expect(expected).toBeGreaterThan(0)
		expect(workspace.bodyLocation).toMatchObject({
			entry: target.entry,
			path: point.path,
			from: expected,
			to: expected,
		})
		expect(openSource).not.toHaveBeenCalled()
		await workspace.revealSource(shown, { ...point, line: 1, column: 2 })
		expect(workspace.bodyLocation).toMatchObject({
			entry: target.entry,
			path: point.path,
			from: 0,
			to: 0,
			source: { line: 1, column: 2 },
		})
		expect(openSource).not.toHaveBeenCalled()
		const active = workspace.documents.get(target.entry)!
		active.inputDirty = true
		active.inputSaving = true
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
	it.each(['BACKEND_UNAVAILABLE', 'CLOSED'])(
		'clears only the %s connection banner after backend replacement',
		async (code) => {
			vi.useFakeTimers()
			let connectionChanged!: (connected: boolean) => void
			vi.mocked(onDesktopConnectionChange).mockImplementation((listener) => {
				connectionChanged = listener
				return () => {}
			})
			const workspace = createWorkspace()
			vi.mocked(api.getTree).mockRejectedValue(
				Object.assign(new Error('Studio backend generation was withdrawn; reconnect'), { code }),
			)
			workspace.start()
			await settle()
			expect(workspace.error).toBe('后端连接已中断，等待恢复。')
			connectionChanged(true)
			await settle()
			expect(workspace.error).toBe('')
			workspace.error = 'Rename permission denied'
			await workspace.refresh()
			expect(workspace.error).toBe('Rename permission denied')
			connectionChanged(true)
			await settle()
			expect(workspace.error).toBe('Rename permission denied')
			workspace.dispose()
		},
	)
	it.each(['BACKEND_UNAVAILABLE', 'CLOSED'])(
		'ignores a late %s refresh failure from the replaced connection',
		async (code) => {
			vi.useFakeTimers()
			let connectionChanged!: (connected: boolean) => void
			vi.mocked(onDesktopConnectionChange).mockImplementation((listener) => {
				connectionChanged = listener
				return () => {}
			})
			let failOldRead!: (cause: Error) => void
			vi.mocked(api.getTree).mockImplementationOnce(
				() =>
					new Promise((_resolve, reject) => {
						failOldRead = reject
					}),
			)
			const workspace = createWorkspace()
			workspace.start()
			connectionChanged(false)
			connectionChanged(true)
			await settle()
			failOldRead(Object.assign(new Error('Old backend closed'), { code }))
			await settle()
			expect(workspace.error).toBe('')
			workspace.dispose()
		},
	)
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
		const inputError = workspace.documents.get(target.entry)?.inputError
		expect(inputError).toContain('connection lost')
		const calls = vi.mocked(api.compile).mock.calls.length
		connectionChanged(false)
		connectionChanged(true)
		await settle()
		expect(workspace.documents.get(target.entry)).toMatchObject({
			data: { title: 'unsaved draft' },
			inputDirty: true,
			inputError,
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
	it('shares one fresh read among callers waiting for an older refresh', async () => {
		const workspace = createWorkspace()
		const tree = {
			project: workspace.project,
			revision: 'before-write',
			entries: [],
			documents: [],
			config: { name: 'Project', fonts: [] },
		}
		let finishOldRead!: (value: typeof tree) => void
		vi.mocked(api.getTree)
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						finishOldRead = resolve
					}),
			)
			.mockResolvedValue({ ...tree, revision: 'after-write' })
		const polling = workspace.refresh()
		const waiting = [workspace.refresh(), workspace.refresh()]
		finishOldRead(tree)
		expect(await Promise.all([polling, ...waiting])).toEqual([true, true, true])
		expect(api.getTree).toHaveBeenCalledTimes(2)
		expect(workspace.tree?.revision).toBe('after-write')
		workspace.dispose()
	})
	it('reports a fresh read failure after an older refresh succeeded', async () => {
		const workspace = createWorkspace()
		const tree = {
			project: workspace.project,
			revision: 'before-write',
			entries: [],
			documents: [],
			config: { name: 'Project', fonts: [] },
		}
		let finishOldRead!: (value: typeof tree) => void
		vi.mocked(api.getTree)
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						finishOldRead = resolve
					}),
			)
			.mockRejectedValue(new Error('fresh snapshot unavailable'))
		const polling = workspace.refresh()
		const waiting = workspace.refresh()
		finishOldRead(tree)
		expect(await Promise.all([polling, waiting])).toEqual([true, false])
		expect(api.getTree).toHaveBeenCalledTimes(2)
		expect(workspace.error).toBe('fresh snapshot unavailable')
		workspace.dispose()
	})
	it('does not start a waiting refresh after the workspace closes', async () => {
		const workspace = createWorkspace()
		const tree = {
			project: workspace.project,
			revision: 'before-write',
			entries: [],
			documents: [],
			config: { name: 'Project', fonts: [] },
		}
		let finishOldRead!: (value: typeof tree) => void
		vi.mocked(api.getTree).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finishOldRead = resolve
				}),
		)
		const polling = workspace.refresh()
		const waiting = workspace.refresh()
		workspace.dispose()
		finishOldRead(tree)
		expect(await Promise.all([polling, waiting])).toEqual([false, false])
		expect(api.getTree).toHaveBeenCalledOnce()
		expect(workspace.tree).toBeUndefined()
	})
	it('preserves shared body drafts during external refresh and accepts the chosen conflict snapshot in both views', async () => {
		vi.useFakeTimers()
		const workspace = createWorkspace()
		const path = 'main/body.typ'
		const original = { [path]: 'Original body', 'main/data.json': '{}' }
		workspace.documents.set(target.entry, {
			entry: target.entry,
			data: {},
			editor: { files: original },
			description: { ...description, editor: { sources: [{ path }] } },
			storageVersion: 'original',
			inputLoaded: true,
			fields: [],
			diagnostics: [],
			busy: false,
			generation: 1,
		})
		workspace.files.set(path, {
			path,
			content: original[path],
			saved: original[path],
			version: 'original-file',
			dirty: false,
			saving: false,
			token: 0,
			external: 0,
		})
		workspace.writeSources(target.entry, { ...original, [path]: 'Unsaved human body' })
		vi.mocked(api.getTree).mockResolvedValue({
			project: workspace.project,
			revision: 'external',
			entries: [{ path, kind: 'file', binary: false, version: 'external-file', size: 19 }],
			documents: [],
			config: { name: 'Project', fonts: [] },
		})
		vi.mocked(api.readFile).mockResolvedValue({
			path,
			version: 'external-file',
			content: 'External agent body',
		})
		await workspace.refresh()
		expect(workspace.textFiles()[path]).toBe('Unsaved human body')
		expect(workspace.documents.get(target.entry)?.editor?.files[path]).toBe('Unsaved human body')
		expect(workspace.files.get(path)).toMatchObject({ dirty: false, saved: 'External agent body' })
		const saved = {
			data: {},
			editor: { files: { ...original, [path]: 'External agent body' } },
			storageVersion: 'external',
		}
		vi.mocked(api.setInput).mockRejectedValueOnce({ code: 'DRAFT_VERSION_CONFLICT' })
		vi.mocked(api.getInput).mockResolvedValue(saved)
		await workspace.saveInput(target.entry)
		expect(api.setInput).toHaveBeenCalledWith(
			expect.objectContaining({ expectedVersion: 'original' }),
		)
		expect(api.writeFile).not.toHaveBeenCalled()
		expect(workspace.documents.get(target.entry)?.inputConflict).toEqual(saved)
		await workspace.resolveInputConflict(target.entry, 'saved')
		expect(workspace.textFiles()[path]).toBe('External agent body')
		expect(workspace.documents.get(target.entry)?.editor?.files[path]).toBe('External agent body')
		expect(workspace.isDirty()).toBe(false)
		workspace.dispose()
	})
	it.each(['refresh', 'reconnect'] as const)(
		'%s recompiles five retained reports without overflowing the document service',
		async (trigger) => {
			const workspace = createWorkspace()
			const entries = Array.from({ length: 5 }, (_, index) => `report${index}/report${index}.ts`)
			vi.mocked(api.getTree).mockResolvedValue({
				project: workspace.project,
				revision: 'initial',
				entries: [],
				documents: [],
				config: { name: 'Project', fonts: [] },
			})
			workspace.start()
			await workspace.refresh()
			for (const entry of entries) {
				workspace.retainDocument(entry)
				await workspace.compile(entry)
			}
			let active = 0
			let peak = 0
			const retained = new Set<string>()
			workspace.preferPreview(entries[0]!)
			vi.mocked(api.describeDocument).mockImplementation(async (request) => {
				if (active === 4)
					throw Object.assign(new Error('All document records are busy'), { code: 'BUSY' })
				peak = Math.max(peak, ++active)
				try {
					await new Promise<void>((resolve) => queueMicrotask(resolve))
					retained.delete(request.entry)
					if (retained.size === 4) retained.delete(retained.values().next().value!)
					retained.add(request.entry)
					return { ...description, ...request }
				} finally {
					active--
				}
			})
			vi.mocked(api.compile).mockImplementation(async (request) => ({
				...result('refreshed', request.clientRevision),
				entry: request.entry,
			}))
			vi.mocked(api.getPreview).mockImplementation(async (request) => {
				if (!retained.has(request.entry))
					throw Object.assign(new Error('Document revision is no longer retained'), {
						code: 'REVISION_CONFLICT',
					})
				return { ...preview(request.revision), entry: request.entry }
			})
			if (trigger === 'refresh') {
				vi.mocked(api.getTree).mockResolvedValue({ ...workspace.tree!, revision: 'changed' })
				await workspace.refresh()
			} else await vi.mocked(onDesktopConnectionChange).mock.calls.at(-1)![0](true)
			await settle()
			expect(peak).toBeLessThanOrEqual(4)
			for (const entry of entries) {
				expect(workspace.documents.get(entry)?.error).toBeUndefined()
				expect(workspace.documents.get(entry)?.preview).toMatchObject({
					entry,
					revision: 'refreshed',
				})
			}
			await expect(
				api.getPreview({ ...target, entry: entries[0]!, revision: 'refreshed' }),
			).resolves.toMatchObject({ entry: entries[0], revision: 'refreshed' })
			workspace.dispose()
		},
	)
	it('continues the refresh batch after one report fails and stops requests after disposal', async () => {
		const workspace = createWorkspace()
		const entries = ['first/first.ts', 'second/second.ts', 'third/third.ts']
		for (const entry of entries) {
			workspace.retainDocument(entry)
			await workspace.compile(entry)
		}
		const visited: string[] = []
		vi.mocked(api.describeDocument).mockImplementation(async (request) => {
			visited.push(request.entry)
			if (request.entry === entries[0]) throw new Error('Invalid first report')
			workspace.dispose()
			return { ...description, ...request }
		})
		vi.mocked(api.getTree).mockResolvedValue({
			project: workspace.project,
			revision: 'changed',
			entries: [],
			documents: [],
			config: { name: 'Project', fonts: [] },
		})
		await workspace.refresh()
		expect(visited).toEqual(entries.slice(0, 2))
		expect(workspace.documents.get(entries[0]!)?.error).toContain('Invalid first report')
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
	it.each(['main/body.typ', 'main/data.json'])(
		'routes %s save and close through its report input owner',
		async (path) => {
			vi.useFakeTimers()
			const workspace = createWorkspace()
			const files = { 'main/body.typ': 'Original body', 'main/data.json': '{}' }
			workspace.documents.set(target.entry, {
				entry: target.entry,
				data: {},
				editor: { files },
				description: { ...description, editor: { sources: [{ path: 'main/body.typ' }] } },
				storageVersion: 'original',
				inputLoaded: true,
				fields: [],
				diagnostics: [],
				busy: false,
				generation: 1,
			})
			workspace.retainDocument(target.entry)
			workspace.files.set(path, {
				path,
				content: files[path as keyof typeof files],
				saved: files[path as keyof typeof files],
				version: 'original-file',
				dirty: false,
				saving: false,
				token: 0,
				external: 0,
			})
			const lifecycle = editorLifecycle(workspace, path, 'file')
			workspace.edit(path, path.endsWith('.json') ? '{"title":"Saved data"}' : 'Saved body')
			expect(lifecycle.isDirty!()).toBe(true)
			await workspace.save(path)
			expect(api.setInput).toHaveBeenCalledWith(
				expect.objectContaining({ entry: target.entry, expectedVersion: 'original' }),
			)
			expect(api.writeFile).not.toHaveBeenCalled()
			expect(lifecycle.isDirty!()).toBe(false)
			const before = lifecycle.getCloseRevision!()
			workspace.edit(path, path.endsWith('.json') ? '{"title":"Unsaved data"}' : 'Unsaved body')
			expect(lifecycle.getCloseRevision!()).not.toBe(before)
			vi.mocked(api.setInput).mockRejectedValueOnce({ code: 'DRAFT_VERSION_CONFLICT' })
			vi.mocked(api.getInput).mockResolvedValue({
				data: {},
				editor: { files },
				storageVersion: 'external',
			})
			expect(await lifecycle.beforeLeave!('close', { id: 'file', from: '/file' })).toBe(false)
			expect(workspace.documents.get(target.entry)?.inputConflict).toBeDefined()
			expect(lifecycle.isDirty!()).toBe(true)
			workspace.dispose()
		},
	)
	it.each(['reload', 'discard'] as const)(
		'%s from a body file accepts the whole saved report without inventing a conflict',
		async (action) => {
			vi.useFakeTimers()
			const workspace = createWorkspace()
			const path = 'main/body.typ'
			const described = { ...description, editor: { sources: [{ path }] } }
			const files = { [path]: 'Unsaved body', 'main/data.json': '{"title":"Unsaved data"}' }
			workspace.documents.set(target.entry, {
				entry: target.entry,
				data: { title: 'Unsaved data' },
				editor: { files },
				description: described,
				storageVersion: 'original',
				inputLoaded: true,
				inputDirty: true,
				fields: [],
				diagnostics: [],
				busy: false,
				generation: 1,
			})
			workspace.files.set(path, {
				path,
				content: files[path],
				saved: 'Original body',
				version: 'original-file',
				dirty: false,
				saving: false,
				token: 1,
				external: 0,
			})
			const saved = {
				data: { title: 'Saved data' },
				editor: { files: { [path]: 'Saved body', 'main/data.json': '{"title":"Saved data"}' } },
				storageVersion: 'saved',
			}
			vi.mocked(api.describeDocument).mockResolvedValue(described)
			vi.mocked(api.getInput).mockResolvedValue(saved)
			const conflicts: unknown[] = []
			workspace.subscribe(() =>
				conflicts.push(workspace.documents.get(target.entry)?.inputConflict),
			)
			await workspace[action](path)
			expect(workspace.documents.get(target.entry)).toMatchObject({ ...saved, inputDirty: false })
			expect(workspace.textFiles()[path]).toBe('Saved body')
			expect(api.readFile).not.toHaveBeenCalled()
			expect(conflicts.every((conflict) => conflict === undefined)).toBe(true)
			workspace.dispose()
		},
	)
	it('preserves a new edit made while reading a whole-report reload', async () => {
		vi.useFakeTimers()
		const workspace = createWorkspace()
		const path = 'main/body.typ'
		workspace.documents.set(target.entry, {
			entry: target.entry,
			data: {},
			editor: { files: { [path]: 'Local', 'main/data.json': '{}' } },
			description: { ...description, editor: { sources: [{ path }] } },
			storageVersion: 'original',
			inputLoaded: true,
			inputDirty: true,
			inputToken: 1,
			fields: [],
			diagnostics: [],
			busy: false,
			generation: 1,
		})
		let read!: (input: Awaited<ReturnType<typeof api.getInput>>) => void
		vi.mocked(api.getInput).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					read = resolve
				}),
		)
		const loading = workspace.reload(path)
		await settle()
		workspace.writeSources(target.entry, { [path]: 'New edit', 'main/data.json': '{}' })
		read({
			data: {},
			editor: { files: { [path]: 'Disk', 'main/data.json': '{}' } },
			storageVersion: 'disk',
		})
		await expect(loading).rejects.toThrow('新修改已保留')
		expect(workspace.documents.get(target.entry)).toMatchObject({
			inputDirty: true,
			storageVersion: 'original',
			editor: { files: { [path]: 'New edit' } },
		})
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
