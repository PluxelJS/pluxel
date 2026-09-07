import { f, v } from '@pluxel/runtime'

const machineIdPattern = /^[A-Za-z0-9_.:-]{1,128}$/

const MachineId = v.pipe(
	v.string(),
	v.trim(),
	v.regex(machineIdPattern, '必须是 1–128 字符的稳定机器标识'),
)

const ModelReference = v.strictObject({
	provider: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(128)),
	id: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(256)),
})

export const PiAgentConfig = v.strictObject({
	defaultToolSetupId: v.pipe(
		v.optional(MachineId, 'assistant'),
		f.formMeta({
			title: 'Default tool setup',
			description: 'AgentTools assignment used when createSession() does not select one.',
		}),
	),
	model: v.pipe(
		v.optional(ModelReference),
		f.formMeta({
			title: 'Default model',
			description:
				'Optional Pi provider/model pair. Pi resolves its configured default when omitted.',
		}),
	),
	thinkingLevel: v.pipe(
		v.optional(v.picklist(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']), 'medium'),
		f.formMeta({ title: 'Thinking level' }),
	),
	systemPrompt: v.pipe(
		v.optional(
			v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(32_000)),
			'You are a Pluxel agent. Use only the tools provided for this session.',
		),
		f.formMeta({ title: 'System prompt' }),
	),
	cwd: v.pipe(
		v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(4_096)), '.'),
		f.formMeta({
			title: 'Working directory',
			description: 'Session metadata only; Pi built-in filesystem and shell tools remain disabled.',
		}),
	),
	maxSessions: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(128)), 16),
		f.formMeta({ title: 'Maximum sessions' }),
	),
	maxSubagentDepth: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(8)), 2),
		f.formMeta({ title: 'Maximum subagent depth' }),
	),
	maxSubagentsPerSession: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(64)), 8),
		f.formMeta({ title: 'Maximum subagents per session' }),
	),
	maxConcurrentSubagents: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(32)), 4),
		f.formMeta({ title: 'Concurrent subagents' }),
	),
	maxToolResultChars: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(1_000), v.maxValue(1_000_000)), 100_000),
		f.formMeta({ title: 'Maximum tool result characters' }),
	),
})

export type PiAgentPluginConfig = v.InferOutput<typeof PiAgentConfig>
