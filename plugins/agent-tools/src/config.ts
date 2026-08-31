import { f, v } from '@pluxel/runtime'

const machineIdPattern = /^[A-Za-z0-9_.:-]{1,128}$/
const commandNamePattern = /^[A-Za-z0-9_.-]{1,128}$/
const maxCommandMemberships = 100_000
const maxAgentToolsetMemberships = 100_000

type CommandToolsetValue = {
	id: string
	label: string
	description?: string
	commandNames: string[]
}

type AgentToolAssignmentValue = {
	agentId: string
	label: string
	toolsetIds: string[]
}

type AgentToolsConfigValue = {
	toolsets: CommandToolsetValue[]
	agents: AgentToolAssignmentValue[]
}

const MachineId = v.pipe(
	v.string(),
	v.trim(),
	v.regex(machineIdPattern, '必须是 1–128 字符的稳定机器标识'),
)

const CommandName = v.pipe(
	v.string(),
	v.trim(),
	v.regex(commandNamePattern, '必须是有效的 command name'),
)

const Label = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120))

const CommandToolsetConfig = v.strictObject({
	id: v.pipe(MachineId, f.formMeta({ title: 'Toolset ID' })),
	label: v.pipe(Label, f.formMeta({ title: '名称' })),
	description: v.optional(
		v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(1_000), f.formMeta({ title: '说明' })),
	),
	commandNames: v.pipe(
		v.array(CommandName),
		v.maxLength(10_000),
		v.check(unique, '同一个 Toolset 不能重复引用 command'),
		f.formMeta({ title: 'Commands' }),
		f.arrayMeta({ layout: 'list', addLabel: '添加 command', itemLabel: 'Command' }),
	),
})

const AgentToolAssignmentConfig = v.strictObject({
	agentId: v.pipe(MachineId, f.formMeta({ title: 'Agent ID' })),
	label: v.pipe(Label, f.formMeta({ title: '名称' })),
	toolsetIds: v.pipe(
		v.array(MachineId),
		v.maxLength(1_000),
		v.check(unique, '同一个 Agent 不能重复分配 Toolset'),
		f.formMeta({ title: 'Toolsets' }),
		f.arrayMeta({ layout: 'list', addLabel: '添加 Toolset', itemLabel: 'Toolset ID' }),
	),
})

const AgentToolsConfigShape = v.pipe(
	v.strictObject({
		toolsets: v.pipe(
			v.optional(v.array(CommandToolsetConfig), []),
			v.maxLength(1_000),
			v.check(uniqueToolsetIds, 'Toolset ID 必须唯一'),
			f.formMeta({ title: 'Toolsets', description: '按稳定 command name 组合可复用工具集。' }),
			f.arrayMeta({ layout: 'list', addLabel: '添加 Toolset', itemLabel: 'Toolset' }),
		),
		agents: v.pipe(
			v.optional(v.array(AgentToolAssignmentConfig), []),
			v.maxLength(10_000),
			v.check(uniqueAgentIds, 'Agent ID 必须唯一'),
			f.formMeta({ title: 'Agents', description: '每个 Agent 只获得显式分配 Toolset 的并集。' }),
			f.arrayMeta({ layout: 'list', addLabel: '添加 Agent', itemLabel: 'Agent' }),
		),
	}),
	v.transform((config): AgentToolsConfigValue => ({
		toolsets: config.toolsets ?? [],
		agents: config.agents ?? [],
	})),
)

export const AgentToolsConfig = v.pipe(
	AgentToolsConfigShape,
	v.check(
		(config) =>
			config.toolsets.reduce((total, toolset) => total + toolset.commandNames.length, 0) <=
			maxCommandMemberships,
		'Command membership 总数超过上限',
	),
	v.check(
		(config) =>
			config.agents.reduce((total, agent) => total + agent.toolsetIds.length, 0) <=
			maxAgentToolsetMemberships,
		'Agent 与 Toolset 的 membership 总数超过上限',
	),
	v.check(allToolsetsExist, 'Agent 引用了不存在的 Toolset ID'),
)

export type AgentToolsPluginConfig = v.InferOutput<typeof AgentToolsConfig>
export type CommandToolset = AgentToolsPluginConfig['toolsets'][number]
export type AgentToolAssignment = AgentToolsPluginConfig['agents'][number]

function unique(values: string[]): boolean {
	return new Set(values).size === values.length
}

function uniqueToolsetIds(toolsets: CommandToolsetValue[]): boolean {
	return unique(toolsets.map((toolset) => toolset.id))
}

function uniqueAgentIds(agents: AgentToolAssignmentValue[]): boolean {
	return unique(agents.map((agent) => agent.agentId))
}

function allToolsetsExist(config: AgentToolsConfigValue): boolean {
	const ids = new Set(config.toolsets.map((toolset) => toolset.id))
	return config.agents.every((agent) => agent.toolsetIds.every((id) => ids.has(id)))
}
