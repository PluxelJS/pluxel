import {
	mkdirSync,
	renameSync,
	writeFileSync,
	unlinkSync,
	readdirSync,
	lstatSync,
	readFileSync,
	existsSync,
} from 'node:fs'
import { join } from 'node:path'
import * as v from 'valibot'
import {
	createAgentSession,
	DefaultResourceLoader,
	loadSkills,
	SessionManager,
	SettingsManager,
	type AgentSession,
} from '@mariozechner/pi-coding-agent'
import { StudioProviders } from './ai-providers.js'
import { createWorkspaceTools, type WorkspaceAIOptions } from './ai-tools.js'
import { redactMessage, toolResult, transcript, type ToolExecution } from './ai-transcript.js'
import type { AiModel, AiSnapshot, AiPrompt, AiThread } from '../shared/contracts.js'

const storedThreadsSchema = v.array(
	v.strictObject({
		id: v.pipe(v.string(), v.maxLength(128), v.regex(/^[a-zA-Z0-9_-]+$/)),
		title: v.pipe(
			v.string(),
			v.minLength(1),
			v.maxLength(100),
			v.check((title) => title.trim().length > 0),
		),
		updatedAt: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(Number.MAX_SAFE_INTEGER)),
		provider: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(200))),
		model: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(500))),
		running: v.boolean(),
	}),
)

interface Conversation {
	manager: SessionManager
	snapshot: AiSnapshot
	task?: Promise<void>
	session?: AgentSession
	cancelled: boolean
	updatedAt: number
}

/** Owns Pi runs and their persisted conversation, independently for each workspace. */
export class StudioAI {
	private readonly conversations = new Map<string, Promise<Map<string, Conversation>>>()
	private readonly providerService: StudioProviders
	private disposed = false

	constructor(private readonly options: WorkspaceAIOptions) {
		this.providerService = new StudioProviders(join(options.root, 'providers'))
	}
	async providers() {
		return this.providerService.list()
	}
	async configureProvider(id: string, input: unknown) {
		return this.providerService.configure(id, input)
	}
	async discoverModels(id: string) {
		return this.providerService.discover(id)
	}

	async models(): Promise<AiModel[]> {
		return this.providerService.models()
	}

	private track(manager: SessionManager): Conversation {
		const context = manager.buildSessionContext()
		return {
			manager,
			snapshot: {
				threadId: manager.getSessionId(),
				title:
					manager.getSessionName() ||
					transcript(context.messages)
						.find((item) => item.role === 'user')
						?.content.flatMap((part) => (part.type === 'text' ? [part.text] : []))
						.join('')
						.slice(0, 40) ||
					'新对话',
				provider: context.model?.provider,
				model: context.model?.modelId,
				messages: transcript(context.messages),
				running: false,
			},
			cancelled: false,
			updatedAt: Date.parse(
				manager.getEntries().at(-1)?.timestamp ?? manager.getHeader()!.timestamp,
			),
		}
	}

	private saveThreads(id: string, threads: Map<string, Conversation>): void {
		// Only UI metadata lives here. Pi exclusively owns transcript JSONL files.
		const file = join(this.options.root, id, 'threads.json')
		writeFileSync(
			file + '.tmp',
			JSON.stringify([...threads.values()].map((state) => this.summary(state))),
			{ mode: 0o600 },
		)
		renameSync(file + '.tmp', file)
	}

	private async projectThreads(id: string): Promise<Map<string, Conversation>> {
		if (this.disposed) throw new Error('AI service is closed')
		if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid project id')
		let promise = this.conversations.get(id)
		if (!promise) {
			promise = (async () => {
				const project = await this.options.getProject(id)
				const directory = join(this.options.root, id, 'sessions')
				mkdirSync(directory, { recursive: true })
				const states = new Map<string, Conversation>()
				for (const file of readdirSync(directory)) {
					const path = join(directory, file)
					if (!file.endsWith('.jsonl') || !lstatSync(path).isFile()) continue
					const manager = SessionManager.open(path, directory, project.root)
					states.set(manager.getSessionId(), this.track(manager))
				}
				const metadata = join(this.options.root, id, 'threads.json')
				if (existsSync(metadata)) {
					let entries: AiThread[]
					try {
						entries = v.parse(storedThreadsSchema, JSON.parse(readFileSync(metadata, 'utf8')))
						if (new Set(entries.map((entry) => entry.id)).size !== entries.length)
							throw new Error('Duplicate conversation ids')
					} catch (cause) {
						throw new Error('Invalid stored conversation metadata', { cause })
					}
					for (const entry of entries) {
						let state = states.get(entry.id)
						if (!state) {
							const manager = SessionManager.create(project.root, directory)
							manager.newSession({ id: entry.id })
							manager.appendSessionInfo(entry.title)
							state = this.track(manager)
							state.updatedAt = entry.updatedAt
							states.set(entry.id, state)
						}
						state.snapshot.title = entry.title
						state.snapshot.provider = entry.provider ?? state.snapshot.provider
						state.snapshot.model = entry.model ?? state.snapshot.model
						state.updatedAt = Math.max(state.updatedAt, entry.updatedAt)
					}
				}
				return states
			})()
			this.conversations.set(id, promise)
			void promise.catch(() => this.conversations.delete(id))
		}
		return promise
	}

	private async conversation(id: string, threadId: string): Promise<Conversation> {
		const threads = await this.projectThreads(id)
		if (this.disposed) throw new Error('AI service is closed')
		const state = threads.get(threadId)
		if (!state) throw new Error('Conversation not found in this project')
		return state
	}

	private summary(state: Conversation): AiThread {
		return {
			id: state.snapshot.threadId,
			title: state.snapshot.title,
			provider: state.snapshot.provider,
			model: state.snapshot.model,
			running: state.snapshot.running,
			updatedAt: state.updatedAt,
		}
	}

	async threads(id: string): Promise<AiThread[]> {
		const threads = await this.projectThreads(id)
		return [...threads.values()]
			.map((state) => this.summary(state))
			.sort((a, b) => b.updatedAt - a.updatedAt)
	}

	async createThread(id: string): Promise<AiSnapshot> {
		const threads = await this.projectThreads(id)
		const project = await this.options.getProject(id)
		if (this.disposed) throw new Error('AI service is closed')
		const state = this.track(
			SessionManager.create(project.root, join(this.options.root, id, 'sessions')),
		)
		state.manager.appendSessionInfo('新对话')
		threads.set(state.snapshot.threadId, state)
		this.saveThreads(id, threads)
		return this.snapshot(id, state.snapshot.threadId)
	}

	async renameThread(id: string, threadId: string, title: string): Promise<AiThread> {
		const state = await this.conversation(id, threadId)
		title = title.trim()
		if (!title || title.length > 100)
			throw new Error('Conversation title must contain 1–100 characters')
		state.manager.appendSessionInfo(title)
		state.snapshot.title = title
		state.updatedAt = Date.now()
		this.saveThreads(id, await this.projectThreads(id))
		return this.summary(state)
	}

	async deleteThread(id: string, threadId: string): Promise<void> {
		const threads = await this.projectThreads(id)
		if (this.disposed) throw new Error('AI service is closed')
		const state = threads.get(threadId)
		if (!state) throw new Error('Conversation not found in this project')
		if (state.snapshot.running)
			throw new Error('Stop the active AI run before deleting its conversation')
		if (existsSync(state.manager.getSessionFile()!)) unlinkSync(state.manager.getSessionFile()!)
		threads.delete(threadId)
		this.saveThreads(id, threads)
	}

	async snapshot(id: string, threadId: string): Promise<AiSnapshot> {
		const state = await this.conversation(id, threadId)
		const snapshot = structuredClone(state.snapshot)
		snapshot.messages = snapshot.messages.map((message) =>
			redactMessage(message, (text) => this.providerService.redact(text)),
		)
		if (snapshot.error) snapshot.error = this.providerService.redact(snapshot.error)
		return snapshot
	}

	async prompt(id: string, threadId: string, input: AiPrompt): Promise<void> {
		const threads = await this.projectThreads(id)
		if (this.disposed) throw new Error('AI service is closed')
		const state = threads.get(threadId)
		if (!state) throw new Error('Conversation not found in this project')
		if ([...threads.values()].some((item) => item.snapshot.running))
			throw new Error('This workspace already has an active AI run')
		if (!input.message.trim()) throw new Error('Message cannot be empty')
		state.cancelled = false
		if (state.snapshot.messages.length === 0 && state.snapshot.title === '新对话') {
			state.snapshot.title = input.message.trim().slice(0, 40)
			state.manager.appendSessionInfo(state.snapshot.title)
		}
		state.manager.appendModelChange(input.provider, input.model)
		state.snapshot = {
			...state.snapshot,
			provider: input.provider,
			model: input.model,
			messages: [
				...state.snapshot.messages,
				{
					id: `pending:${Date.now()}`,
					role: 'user',
					content: [{ type: 'text', text: input.message }],
				},
			],
			running: true,
			error: undefined,
			activity: '正在连接…',
		}
		state.updatedAt = Date.now()
		try {
			this.saveThreads(id, threads)
		} catch (error) {
			state.snapshot.running = false
			state.snapshot.activity = undefined
			throw error
		}
		state.task = this.run(id, state, input)
			.catch((error: unknown) => {
				if (!state.cancelled)
					state.snapshot.error = error instanceof Error ? error.message : String(error)
			})
			.finally(() => {
				state.session?.dispose()
				state.session = undefined
				state.snapshot.running = false
				state.snapshot.activity = undefined
				state.updatedAt = Date.now()
				try {
					this.saveThreads(id, threads)
				} catch (error) {
					state.snapshot.error = error instanceof Error ? error.message : String(error)
				}
			})
	}

	private async run(id: string, state: Conversation, input: AiPrompt): Promise<void> {
		const project = await this.options.getProject(id)
		const available = await this.providerService.models()
		const availableModel = available.find(
			(item) => item.provider === input.provider && item.id === input.model,
		)
		const originalModel = this.providerService.registry.find(input.provider, input.model)
		// Studio's explicit override and bundled identity metadata also apply to
		// proxy providers; Pi must receive image in its actual model input contract.
		const model = originalModel && {
			...originalModel,
			input: [
				...originalModel.input.filter((kind) => kind !== 'image'),
				...(availableModel?.imageInput ? (['image'] as const) : []),
			],
		}
		if (!model || !availableModel) {
			throw new Error(
				'Selected model is unavailable. Configure its credentials with Pi, then refresh the model list.',
			)
		}
		const tree = await this.options.tree(id)
		const references = [...new Set(input.references)]
		for (const path of references) {
			if (!tree.entries.some((entry) => entry.path === path))
				throw new Error(`Referenced path does not exist: ${path}`)
		}
		const customTools = createWorkspaceTools(
			this.options,
			project,
			() => this.checkCancelled(state),
			model.input.includes('image'),
		)
		const directory = join(this.options.root, id)
		const settingsManager = SettingsManager.inMemory({ retry: { enabled: true, maxRetries: 1 } })
		const skillPaths = tree.entries
			.filter(
				(entry) =>
					entry.kind === 'file' &&
					entry.path.startsWith('.agents/skills/') &&
					entry.path.endsWith('/SKILL.md'),
			)
			.map((entry) => join(project.root, entry.path))
		const skills = loadSkills({
			cwd: project.root,
			agentDir: directory,
			skillPaths,
			includeDefaults: false,
		})
		const agents = tree.entries.some((entry) => entry.path === 'AGENTS.md')
			? await this.options.readFile(id, 'AGENTS.md')
			: undefined
		const resourceLoader = new DefaultResourceLoader({
			cwd: project.root,
			agentDir: directory,
			settingsManager,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			skillsOverride: () => skills,
			agentsFilesOverride: () => ({
				agentsFiles: agents
					? [{ path: join(project.root, 'AGENTS.md'), content: agents.content }]
					: [],
			}),
			appendSystemPrompt: [
				`You are the coding assistant for this Typst Studio workspace. Use the file tools and the simulated bash tool to inspect and edit ordinary workspace files. Bash uses a virtual POSIX filesystem rooted at /workspace on every platform, including Windows: use /workspace or relative paths, never the host filesystem path. Bash cannot access the host shell, network or installed programs. Read existing files before replacing them; writes reject stale versions. On a conflict, reread and reconcile rather than overwrite user edits. Bash supports UTF-8 file content; binary files may be moved or removed but not read or rewritten as text. Successful writes are persisted immediately, including writes completed before a later command failure or cancellation. Do not promise transaction rollback.
Read AGENTS.md and the relevant project skill. studio.json declares only project name and font directories. Reports are discovered at folder/folder.ts; each default-exports defineTypstDocument({ template, schema, createFiles? }) from @pluxel/plugin-typst/template. The filename supplies the name; do not export a separate name. template is a relative .typ path from the entry directory, and createFiles is synchronous. Do not register documents or data files in studio.json. Reuse shared themes through ordinary Typst imports; changes to a shared file can affect multiple documents. TypeScript schema modules run through Vite with valibot and valibot-form. Use Valibot defaults for demonstration values. Each report stores raw business data in ordinary data.json beside its entry; schema evaluation supplies derived /inputs/data.json only for templates that need normalization. Editable prose is ordinary Typst source. Never read app credentials or sessions.
For editable body prose, use read_body to obtain the current input (including unsaved desktop changes) and baseRevision, then apply_body_candidate with the source path and edited Typst source. Ranges are UTF-8 byte offsets. Preserve unknown expressions and comments. A successful apply already returns a native compile revision: inspect that revision with read_preview_pages without recompiling. On STALE_CANDIDATE reread before reconciling. A committed result with previewError or disconnected editorStatus is still persisted; do not blindly retry.
After source edits, call compile_preview with the affected same-name .ts report entry and explicit input: {kind:'stored'} for saved form data or {kind:'data',data:{}} for defaults/supplied data; fix diagnostics. It returns an exact revision, actual page count, page dimensions in points and outline. Compile affected importers when changing shared themes. Use read_preview_pages with that revision to inspect actual PNG output without compiling again. This model's image input is ${model.input.includes('image') ? 'enabled' : 'disabled; select a visual model before claiming visual inspection'}. For multipage documents first use the outline and sizes, inspect opening/continuation/final pages in batches of at most three, then request point-coordinate crops around suspect formulas, images, table continuations or page breaks. Page images include headings and workspace source line ranges to locate fixes. Crops preserve the original page background; large full pages may reduce the available image scale. Do not dump every page or repeatedly recompile unchanged sources to get another image. Recompile after source changes or when you choose different data and use the new revision; stale images are rejected. A successful compile does not establish visual quality. Use export_pdf with the same entry/revision for a ready immutable PDF file reference. If image inspection is disabled or fails, report that limit honestly. Reply in the user's language.`,
			],
		})
		await resourceLoader.reload()
		this.checkCancelled(state)
		const { session } = await createAgentSession({
			cwd: project.root,
			agentDir: directory,
			model,
			authStorage: this.providerService.auth,
			modelRegistry: this.providerService.registry,
			settingsManager,
			resourceLoader,
			sessionManager: state.manager,
			tools: customTools.map((tool) => tool.name),
			customTools,
		})
		state.session = session
		this.checkCancelled(state)
		const tools = new Map<string, ToolExecution>()
		const unsubscribe = session.subscribe((event) => {
			if (event.type === 'message_start' || event.type === 'message_update') {
				state.snapshot.messages = transcript([...session.messages, event.message], {
					streaming: true,
					running: true,
					tools,
				})
			} else if (event.type === 'message_end') {
				state.snapshot.messages = transcript(session.messages, { running: true, tools })
				if (event.message.role === 'assistant' && event.message.stopReason === 'error') {
					state.snapshot.error = event.message.errorMessage ?? 'The model request failed'
				}
			} else if (event.type === 'tool_execution_start') {
				state.snapshot.activity = event.toolName
				tools.set(event.toolCallId, { status: 'running' })
				state.snapshot.messages = transcript(session.messages, { running: true, tools })
			} else if (event.type === 'tool_execution_update') {
				tools.set(event.toolCallId, { status: 'running', result: toolResult(event.partialResult) })
				state.snapshot.messages = transcript(session.messages, { running: true, tools })
			} else if (event.type === 'tool_execution_end') {
				tools.set(event.toolCallId, {
					status: event.isError ? 'error' : 'complete',
					isError: event.isError,
					result: toolResult(event.result),
				})
				state.snapshot.messages = transcript(session.messages, { running: true, tools })
				state.snapshot.activity = event.isError
					? 'Tool failed; waiting for the assistant…'
					: 'Thinking…'
			}
		})
		try {
			state.snapshot.activity = 'Thinking…'
			const context =
				references.length > 0
					? '\n\nReferenced workspace paths (inspect with file tools):\n' +
						references.map((path) => '@' + path).join('\n')
					: ''
			await session.prompt(input.message + context, { expandPromptTemplates: false })
		} finally {
			state.snapshot.messages = transcript(session.messages)
			unsubscribe()
		}
	}

	private checkCancelled(state: Conversation): void {
		if (state.cancelled || this.disposed) throw new Error('AI run cancelled')
	}

	async abort(id: string, threadId?: string): Promise<void> {
		const threads = await this.conversations.get(id)
		if (!threads) return
		await Promise.all(
			[...threads.values()]
				.filter((state) => !threadId || state.snapshot.threadId === threadId)
				.map(async (state) => {
					state.cancelled = true
					await state.session?.abort()
					await state.task
				}),
		)
	}

	async dispose(): Promise<void> {
		this.disposed = true
		await Promise.all([...this.conversations.keys()].map((id) => this.abort(id)))
		this.conversations.clear()
	}
}
