import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type ToolDefinition,
} from '@earendil-works/pi-coding-agent'
import type { PiModelReference } from './types.ts'

export type ResolvedPiModel = NonNullable<ReturnType<ModelRuntime['getModel']>>

export type PiEngineCreateOptions = Readonly<{
	cwd: string
	systemPrompt: string
	thinkingLevel: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
	model?: ResolvedPiModel
	tools: readonly ToolDefinition[]
}>

export interface PiEngine {
	resolveModel(reference: PiModelReference): ResolvedPiModel | undefined
	createSession(options: PiEngineCreateOptions): Promise<AgentSession>
}

export class DefaultPiEngine implements PiEngine {
	private constructor(private readonly models: ModelRuntime) {}

	static async create(): Promise<DefaultPiEngine> {
		return new DefaultPiEngine(await ModelRuntime.create({ allowModelNetwork: false }))
	}

	resolveModel(reference: PiModelReference): ResolvedPiModel | undefined {
		return this.models.getModel(reference.provider, reference.id)
	}

	async createSession(options: PiEngineCreateOptions): Promise<AgentSession> {
		const settings = SettingsManager.inMemory({
			compaction: { enabled: true },
			defaultThinkingLevel: options.thinkingLevel,
		})
		const resources = new DefaultResourceLoader({
			cwd: options.cwd,
			agentDir: getAgentDir(),
			settingsManager: settings,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			systemPrompt: options.systemPrompt,
		})
		await resources.reload()
		const { session } = await createAgentSession({
			cwd: options.cwd,
			modelRuntime: this.models,
			...(options.model ? { model: options.model } : {}),
			thinkingLevel: options.thinkingLevel,
			noTools: 'builtin',
			customTools: [...options.tools],
			resourceLoader: resources,
			sessionManager: SessionManager.inMemory(options.cwd),
			settingsManager: settings,
		})
		return session
	}
}
