import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CompileResult } from '../src/shared/contracts'
import type { PreviewPage, PreviewPagesRequest } from '../src/backend/ai-tools'

const fake = vi.hoisted(() => ({
	available: [] as { provider: string; id: string; name: string; input: ('text' | 'image')[] }[],
	create: vi.fn(),
	reload: vi.fn(),
	refresh: vi.fn(),
}))
vi.mock('@mariozechner/pi-coding-agent', async () => {
	const actual = await vi.importActual<typeof import('@mariozechner/pi-coding-agent')>(
		'@mariozechner/pi-coding-agent',
	)
	return {
		...actual,
		AuthStorage: {
			create: () => ({
				reload: fake.reload,
				list: () => [],
				getAll: () => ({}),
				hasAuth: () => false,
			}),
		},
		ModelRegistry: {
			create: () => ({
				refresh: fake.refresh,
				getAll: () => [],
				getAvailable: () => fake.available,
				find: (provider: string, id: string) =>
					fake.available.find((m) => m.provider === provider && m.id === id),
			}),
		},
		createAgentSession: fake.create,
	}
})
import { StudioAI } from '../src/backend/ai'
import { WorkspaceStore } from '../src/backend/store'
const roots: string[] = [],
	instances: StudioAI[] = []
afterEach(async () => {
	await Promise.all(instances.splice(0).map((ai) => ai.dispose()))
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
	fake.available = []
	vi.clearAllMocks()
})
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), 'studio-ai-'))
	roots.push(root)
	const workspace = join(root, 'workspace')
	await mkdir(join(workspace, '.agents/skills/reports'), { recursive: true })
	await mkdir(join(workspace, 'reports'), { recursive: true })
	await mkdir(join(workspace, 'shared'), { recursive: true })
	await writeFile(
		join(workspace, 'reports/main.typ'),
		'#import "../shared/theme.typ": title\n#title',
	)
	await writeFile(
		join(workspace, 'reports/reports.ts'),
		"import * as v from 'valibot'; import { defineTypstDocument } from '@pluxel/typst/template'; export default defineTypstDocument({ template: './main.typ', schema: v.object({}) });",
	)
	await writeFile(join(workspace, 'shared/theme.typ'), '#let title = "Original"\n')
	await writeFile(join(workspace, 'AGENTS.md'), 'Use the reports skill and preserve user input.')
	await writeFile(
		join(workspace, '.agents/skills/reports/SKILL.md'),
		'---\nname: reports\ndescription: Edit financial reports\n---\nRead shared/theme.typ before changing reports.',
	)
	const store = new WorkspaceStore(join(root, 'state'), '')
	await store.initialize()
	const project = await store.open(workspace)
	const compile = vi.fn(async (_id: string, entry: string): Promise<CompileResult> => ({
		projectId: project.id,
		entry,
		name: 'reports',
		template: 'reports/main.typ',
		revision: 'revision',
		fields: [],
		data: {},
		diagnostics: [],
		elapsedMs: 1,
		sourceVersions: {},
		preview: {
			sessionId: 'test',
			revision: 1,
			format: 'vector',
			compilerVersion: '0.7.0',
			data: [],
			navigation: { pages: [{ page: 1, width: 595, height: 842 }], points: [], outline: [] },
		},
	}))
	const options = {
		root: join(root, 'ai'),
		getProject: (id) => store.get(id),
		tree: (id) => store.tree(id),
		readFile: (id, path) => store.readFile(id, path),
		writeFile: (id, input) => store.writeFile(id, input),
		mkdir: (id, path) => store.mkdir(id, path),
		rename: (id, input) => store.rename(id, input),
		remove: (id, input) => store.remove(id, input),
		compile,
		readPreviewPages: vi.fn(
			async (_id: string, _input: PreviewPagesRequest): Promise<readonly PreviewPage[]> => [],
		),
	} satisfies ConstructorParameters<typeof StudioAI>[0]
	const ai = new StudioAI(options)
	instances.push(ai)
	const thread = await ai.createThread(project.id)
	return { root, store, project, ai, compile, threadId: thread.threadId, options }
}
async function finished(ai: StudioAI, id: string, threadId: string) {
	await vi.waitFor(async () => {
		const state = await ai.snapshot(id, threadId)
		expect(state.running).toBe(false)
	})
}
const model = {
	provider: 'fixture',
	id: 'model',
	name: 'Fixture',
	input: ['text'] as ('text' | 'image')[],
}
it('reports missing credentials without calling a model and isolates project conversations', async () => {
	const { ai, project, store, root, threadId } = await fixture()
	expect(await ai.models()).toEqual([])
	expect(fake.reload).toHaveBeenCalled()
	await ai.prompt(project.id, threadId, {
		message: 'Make a report',
		provider: 'missing',
		model: 'missing',
	})
	await finished(ai, project.id, threadId)
	const state = await ai.snapshot(project.id, threadId)
	expect(state.error).toContain('unavailable')
	expect(state.messages).toMatchObject([
		{ role: 'user', content: [{ type: 'text', text: 'Make a report' }] },
	])
	await mkdir(join(root, 'second'))
	const second = await store.open(join(root, 'second'))
	expect(await ai.createThread(second.id)).toMatchObject({ messages: [], running: false })
	expect(fake.create).not.toHaveBeenCalled()
	await expect(ai.threads('../escape')).rejects.toThrow('Invalid project id')
})
it('uses official Pi file tools against real workspace files, references and skills', async () => {
	const { ai, project, root, compile, threadId } = await fixture()
	fake.available = [model]
	const dispose = vi.fn()
	let requested = ''
	fake.create.mockImplementation(async (options) => ({
		session: {
			messages: [],
			dispose,
			abort: vi.fn(),
			subscribe: () => () => {},
			prompt: async (message: string) => {
				requested = message
				expect(options.cwd).toBe(project.root)
				expect(options.agentDir).toBe(join(root, 'ai', project.id))
				expect(options.sessionManager.getCwd()).toBe(project.root)
				expect(options.tools).toEqual([
					'bash',
					'read',
					'write',
					'edit',
					'ls',
					'find',
					'search_files',
					'compile_preview',
					'read_preview_pages',
				])
				expect(options.resourceLoader.getSkills().skills).toEqual(
					expect.arrayContaining([
						expect.objectContaining({
							name: 'reports',
							filePath: join(project.root, '.agents/skills/reports/SKILL.md'),
						}),
					]),
				)
				expect(options.resourceLoader.getAgentsFiles().agentsFiles).toEqual([
					expect.objectContaining({ content: 'Use the reports skill and preserve user input.' }),
				])
				const tools = new Map<string, any>(
					options.customTools.map((tool: any) => [tool.name, tool]),
				)
				const call = (name: string, args: unknown) => tools.get(name).execute('test', args)
				const read = await call('read', { path: 'reports/main.typ' })
				expect(JSON.stringify(read)).toContain('../shared/theme.typ')
				const listed = await call('ls', { path: 'shared' })
				expect(JSON.stringify(listed)).toContain('theme.typ')
				const found = await call('find', { pattern: '**/*.typ' })
				expect(JSON.stringify(found)).toContain('reports/main.typ')
				const searched = await call('search_files', { text: 'Original', path: 'shared' })
				expect(JSON.stringify(searched)).toContain('shared/theme.typ')
				await call('edit', {
					path: 'shared/theme.typ',
					edits: [{ oldText: 'Original', newText: 'Edited' }],
				})
				expect(await readFile(join(project.root, 'shared/theme.typ'), 'utf8')).toBe(
					'#let title = "Edited"\n',
				)
				await call('write', { path: 'reports/nested/new.typ', content: 'New document' })
				expect(await readFile(join(project.root, 'reports/nested/new.typ'), 'utf8')).toBe(
					'New document',
				)
				await call('write', { path: 'reports/nested/new.typ', content: 'Updated document' })
				expect(await readFile(join(project.root, 'reports/nested/new.typ'), 'utf8')).toBe(
					'Updated document',
				)
				await call('read', { path: 'shared/theme.typ' })
				await writeFile(join(project.root, 'shared/theme.typ'), 'External edit')
				await expect(
					call('write', { path: 'shared/theme.typ', content: 'Lost update' }),
				).rejects.toThrow('File changed')
				expect(await readFile(join(project.root, 'shared/theme.typ'), 'utf8')).toBe('External edit')
				await expect(call('read', { path: '../outside.txt' })).rejects.toThrow('outside')
				await expect(call('write', { path: '../outside.txt', content: 'Escape' })).rejects.toThrow(
					'outside',
				)
				await expect(
					call('edit', {
						path: 'reports/main.typ',
						edits: [{ oldText: 'not present', newText: 'oops' }],
					}),
				).rejects.toThrow('Could not find the exact text')
				await call('compile_preview', { entry: 'reports/reports.ts' })
				await expect(
					call('read_preview_pages', {
						entry: 'reports/reports.ts',
						revision: 'revision',
						pages: [1],
					}),
				).rejects.toThrow('未启用图片输入')
			},
		},
	}))
	await ai.prompt(project.id, threadId, {
		message: 'Adjust layout',
		provider: model.provider,
		model: model.id,
		references: ['shared/theme.typ', 'reports'],
	})
	await finished(ai, project.id, threadId)
	const state = await ai.snapshot(project.id, threadId)
	expect(state.error).toBeUndefined()
	expect(requested).toContain('@shared/theme.typ\n@reports')
	expect(compile).toHaveBeenCalledWith(project.id, 'reports/reports.ts')
	expect(dispose).toHaveBeenCalledOnce()
})
it('delivers page images to Pi for a known model on a custom provider and keeps diagnostics actionable', async () => {
	const { ai, project, threadId, options, compile } = await fixture()
	const visual = { ...model, id: 'deepseek-flash', name: 'deepseek-flash' }
	// The original registry record is text only. Bundled identity metadata must
	// reach both the actual Pi model input contract and the image tool.
	fake.available = [visual]
	const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])
	options.readPreviewPages.mockResolvedValue([
		{
			revision: 1,
			page: 1,
			format: 'png',
			data: png,
			width: 10,
			height: 20,
			region: { x: 0, y: 0, width: 5, height: 10 },
			headings: [],
			sources: [{ path: 'reports/main.typ', fromLine: 1, toLine: 2 }],
		},
	])
	fake.create.mockImplementation(async (sessionOptions) => ({
		session: {
			messages: [],
			dispose: vi.fn(),
			abort: vi.fn(),
			subscribe: () => () => {},
			prompt: async () => {
				expect(sessionOptions.model.input).toContain('image')
				const tools = new Map<string, any>(
					sessionOptions.customTools.map((tool: any) => [tool.name, tool]),
				)
				const compiled = await tools
					.get('compile_preview')
					.execute('compile', { entry: 'reports/reports.ts' })
				expect(JSON.parse(compiled.content[0].text)).toMatchObject({
					ok: true,
					pageCount: 1,
					imageInput: true,
				})
				for (let read = 0; read < 2; read++) {
					const result = await tools
						.get('read_preview_pages')
						.execute('image', { entry: 'reports/reports.ts', revision: 'revision', pages: [1] })
					expect(result.content).toEqual([
						expect.objectContaining({
							type: 'text',
							text: expect.stringContaining('reports/main.typ'),
						}),
						{ type: 'image', mimeType: 'image/png', data: Buffer.from(png).toString('base64') },
					])
				}
				expect(compile).toHaveBeenCalledOnce()
				const diagnostics = [
					{
						severity: 'error',
						message: 'Unexpected token',
						path: 'reports/main.typ',
						range: { start: { line: 6, character: 0 }, end: { line: 6, character: 1 } },
					},
				]
				compile.mockRejectedValueOnce(
					Object.assign(new Error('Typst compilation failed'), {
						code: 'COMPILE_FAILED',
						diagnostics,
					}),
				)
				const failure = await tools
					.get('compile_preview')
					.execute('broken', { entry: 'reports/reports.ts' })
					.catch((error: Error) => error)
				expect(failure).toBeInstanceOf(Error)
				expect(JSON.parse(failure.message)).toMatchObject({
					ok: false,
					code: 'COMPILE_FAILED',
					diagnostics,
				})
			},
		},
	}))
	await ai.prompt(project.id, threadId, {
		message: '检查分页和公式',
		provider: visual.provider,
		model: visual.id,
	})
	await finished(ai, project.id, threadId)
	const snapshot = await ai.snapshot(project.id, threadId)
	expect(snapshot.error).toBeUndefined()
	expect(options.readPreviewPages).toHaveBeenCalledTimes(2)
})
it('rejects unknown references before starting the model', async () => {
	const { ai, project, threadId } = await fixture()
	fake.available = [model]
	await ai.prompt(project.id, threadId, {
		message: 'Read it',
		provider: model.provider,
		model: model.id,
		references: ['../outside'],
	})
	await finished(ai, project.id, threadId)
	const state = await ai.snapshot(project.id, threadId)
	expect(state.error).toContain('Referenced path does not exist')
	expect(fake.create).not.toHaveBeenCalled()
})
it('owns initialization during cancellation and rejects concurrent prompts', async () => {
	const { ai, project, threadId } = await fixture()
	fake.available = [model]
	let resolve!: (value: any) => void
	fake.create.mockImplementation(
		() =>
			new Promise((done) => {
				resolve = done
			}),
	)
	await ai.prompt(project.id, threadId, {
		message: 'First',
		provider: model.provider,
		model: model.id,
	})
	await vi.waitFor(() => expect(fake.create).toHaveBeenCalled())
	await expect(
		ai.prompt(project.id, threadId, {
			message: 'Second',
			provider: model.provider,
			model: model.id,
		}),
	).rejects.toThrow('active AI run')
	const aborted = ai.abort(project.id)
	const prompt = vi.fn(),
		dispose = vi.fn()
	resolve({ session: { dispose, prompt, abort: vi.fn() } })
	await aborted
	expect(prompt).not.toHaveBeenCalled()
	expect(dispose).toHaveBeenCalledOnce()
	const state = await ai.snapshot(project.id, threadId)
	expect(state.running).toBe(false)
	expect(state.error).toBeUndefined()
	await ai.dispose()
	await expect(ai.snapshot(project.id, threadId)).rejects.toThrow('closed')
})

it('persists empty threads, names and model selection across restart without inventing Pi messages', async () => {
	const { ai, project, threadId, options } = await fixture()
	await ai.renameThread(project.id, threadId, '排版讨论')
	await ai.prompt(project.id, threadId, { message: '测试', provider: 'missing', model: 'missing' })
	await finished(ai, project.id, threadId)
	const empty = await ai.createThread(project.id)
	await ai.dispose()
	const restored = new StudioAI(options)
	instances.push(restored)
	expect(await restored.threads(project.id)).toHaveLength(2)
	expect(await restored.snapshot(project.id, threadId)).toMatchObject({
		title: '排版讨论',
		provider: 'missing',
		model: 'missing',
		running: false,
	})
	expect(await restored.snapshot(project.id, empty.threadId)).toMatchObject({
		messages: [],
		title: '新对话',
	})
	await restored.deleteThread(project.id, empty.threadId)
	await restored.dispose()
	const reopened = new StudioAI(options)
	instances.push(reopened)
	expect(await reopened.threads(project.id)).toHaveLength(1)
	await expect(reopened.snapshot(project.id, '../escape')).rejects.toThrow('not found')
})
it('isolates thread ids between projects and prevents concurrent workspace edits and active deletion', async () => {
	const { ai, project, threadId, store, root } = await fixture()
	const other = await ai.createThread(project.id)
	await mkdir(join(root, 'another'))
	const second = await store.open(join(root, 'another'))
	await expect(ai.snapshot(second.id, threadId)).rejects.toThrow('not found')
	await expect(ai.renameThread(second.id, threadId, '错误')).rejects.toThrow('not found')
	fake.available = [model]
	let finish!: (value: any) => void
	fake.create.mockImplementation(
		() =>
			new Promise((resolve) => {
				finish = resolve
			}),
	)
	await ai.prompt(project.id, threadId, {
		message: '处理',
		provider: model.provider,
		model: model.id,
	})
	await vi.waitFor(() => expect(fake.create).toHaveBeenCalled())
	await expect(
		ai.prompt(project.id, other.threadId, {
			message: '并发',
			provider: model.provider,
			model: model.id,
		}),
	).rejects.toThrow('active AI run')
	await expect(ai.deleteThread(project.id, threadId)).rejects.toThrow('Stop')
	expect(await ai.snapshot(project.id, other.threadId)).toMatchObject({ running: false })
	const aborted = ai.abort(project.id, threadId)
	finish({ session: { dispose: vi.fn(), abort: vi.fn() } })
	await aborted
	await ai.deleteThread(project.id, threadId)
	expect(await ai.threads(project.id)).toHaveLength(1)
})

it('discovers and resumes native Pi transcripts without conversion', async () => {
	const { ai, project, options } = await fixture()
	const { SessionManager } = await import('@mariozechner/pi-coding-agent')
	const manager = SessionManager.create(project.root, join(options.root, project.id, 'sessions'))
	manager.appendSessionInfo('既有会话')
	manager.appendModelChange('fixture', 'model')
	manager.appendMessage({ role: 'user', content: '请调整标题', timestamp: Date.now() })
	manager.appendMessage({
		role: 'assistant',
		content: [{ type: 'text', text: '已调整' }],
		api: 'openai-responses',
		provider: 'fixture',
		model: 'model',
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: 'stop',
		timestamp: Date.now(),
	})
	await ai.dispose()
	const restored = new StudioAI(options)
	instances.push(restored)
	expect(await restored.snapshot(project.id, manager.getSessionId())).toMatchObject({
		title: '既有会话',
		provider: 'fixture',
		model: 'model',
		messages: [
			{ role: 'user', content: [{ type: 'text', text: '请调整标题' }] },
			{ role: 'assistant', content: [{ type: 'text', text: '已调整' }] },
		],
	})
	await restored.renameThread(project.id, manager.getSessionId(), '修订版')
	expect(SessionManager.open(manager.getSessionFile()!).getSessionName()).toBe('修订版')
	await restored.deleteThread(project.id, manager.getSessionId())
	await expect(readFile(manager.getSessionFile()!)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('rejects corrupt conversation metadata instead of silently restoring it', async () => {
	const { ai, project, options, threadId } = await fixture()
	await ai.dispose()
	const valid = { id: threadId, title: '新对话', updatedAt: Date.now(), running: false }
	for (const invalid of [
		{ title: 42 },
		{ title: ' ' },
		{ updatedAt: 'yesterday' },
		{ updatedAt: -1 },
		{ provider: [] },
		{ model: {} },
		{ running: 'false' },
		{ id: '../escape' },
	]) {
		await writeFile(
			join(options.root, project.id, 'threads.json'),
			JSON.stringify([{ ...valid, ...invalid }]),
		)
		const restored = new StudioAI(options)
		instances.push(restored)
		await expect(restored.threads(project.id)).rejects.toThrow(
			'Invalid stored conversation metadata',
		)
	}
})
it('does not leave a workspace running when initial metadata persistence fails', async () => {
	const { ai, project, options, threadId } = await fixture()
	const temporary = join(options.root, project.id, 'threads.json.tmp')
	await mkdir(temporary)
	await expect(
		ai.prompt(project.id, threadId, { message: '测试', provider: 'missing', model: 'missing' }),
	).rejects.toThrow('EISDIR')
	expect(await ai.snapshot(project.id, threadId)).toMatchObject({ running: false })
	expect(fake.create).not.toHaveBeenCalled()
	await rm(temporary, { recursive: true })
	await ai.prompt(project.id, threadId, { message: '重试', provider: 'missing', model: 'missing' })
	await finished(ai, project.id, threadId)
})
