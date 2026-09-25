import type { CommandDescriptor, CommandFailure, Result } from '@pluxel/commands'
import type { AgentSession, ToolDefinition } from '@earendil-works/pi-coding-agent'
import { Type, type TSchema } from 'typebox'
import { PiAgentError } from './errors.ts'
import { formatToolFailure, formatToolOutput } from './tool-output.ts'
import type { PiSubagentRunResult } from './types.ts'

type PiAgentTool = AgentSession['agent']['state']['tools'][number]

type ControlToolOwner = Readonly<{
	goal(action: 'show' | 'set' | 'complete' | 'clear', text?: string, summary?: string): unknown
	spawnSubagent(task: string, signal?: AbortSignal): Promise<PiSubagentRunResult>
	canSpawnSubagent(): boolean
}>

export type PiToolDelivery = Readonly<{
	result: Result<unknown, CommandFailure>
	release(): void
}>

export type SelectedPiCommand = Readonly<{
	name: string
	descriptor: CommandDescriptor
	available(): boolean
	allowed(signal?: AbortSignal): Promise<boolean>
	invoke(candidate: unknown, sessionId: string, signal?: AbortSignal): Promise<PiToolDelivery>
}>

export function createPiToolDefinitions(input: {
	sessionId: string
	tools: readonly SelectedPiCommand[]
	maxResultChars: number
	controls: ControlToolOwner
}): ToolDefinition[] {
	const commandTools = createCommandTools(input)
	return [
		createGoalTool(input.controls),
		...(input.controls.canSpawnSubagent() ? [createSubagentTool(input.controls)] : []),
		...commandTools,
	]
}

export function toPiAgentTools(definitions: readonly ToolDefinition[]): PiAgentTool[] {
	return definitions.map((definition) => ({
		name: definition.name,
		label: definition.label,
		description: definition.description,
		parameters: definition.parameters,
		...(definition.prepareArguments ? { prepareArguments: definition.prepareArguments } : {}),
		...(definition.executionMode ? { executionMode: definition.executionMode } : {}),
		execute: async (toolCallId, params, signal, onUpdate) =>
			await definition.execute(toolCallId, params, signal, onUpdate, undefined as never),
	}))
}

function createCommandTools(input: {
	sessionId: string
	tools: readonly SelectedPiCommand[]
	maxResultChars: number
}): ToolDefinition[] {
	const names = providerToolNames(input.tools.map((tool) => tool.descriptor))
	return input.tools.map((tool) => ({
		name: names.get(tool.name)!,
		label: tool.name,
		description: tool.descriptor.description,
		parameters: tool.descriptor.inputSchema as TSchema,
		executionMode: 'sequential',
		execute: async (_toolCallId, params, signal) => {
			const delivery = await tool.invoke(params, input.sessionId, signal)
			try {
				if (delivery.result.isErr()) {
					throw new Error(formatToolFailure(delivery.result.error, input.maxResultChars), {
						cause: delivery.result.error,
					})
				}
				return {
					content: [
						{ type: 'text', text: formatToolOutput(delivery.result.value, input.maxResultChars) },
					],
					details: { commandName: tool.name },
				}
			} finally {
				delivery.release()
			}
		},
	}))
}

function createGoalTool(owner: ControlToolOwner): ToolDefinition {
	return {
		name: 'pluxel_goal',
		label: 'Goal',
		description: 'Read, set, complete, or clear the current in-memory session goal.',
		promptSnippet: 'read or update the current Pluxel session goal',
		parameters: Type.Object(
			{
				action: Type.Union([
					Type.Literal('show'),
					Type.Literal('set'),
					Type.Literal('complete'),
					Type.Literal('clear'),
				]),
				text: Type.Optional(Type.String({ minLength: 1, maxLength: 8_000 })),
				summary: Type.Optional(Type.String({ minLength: 1, maxLength: 8_000 })),
			},
			{ additionalProperties: false },
		),
		executionMode: 'sequential',
		execute: async (_toolCallId, params) => {
			const value = params as {
				action: 'show' | 'set' | 'complete' | 'clear'
				text?: string
				summary?: string
			}
			const goal = owner.goal(value.action, value.text, value.summary)
			return {
				content: [{ type: 'text', text: JSON.stringify({ goal }) }],
				details: { action: value.action },
			}
		},
	}
}

function createSubagentTool(owner: ControlToolOwner): ToolDefinition {
	return {
		name: 'pluxel_subagent',
		label: 'Subagent',
		description:
			'Spawn one bounded child agent for an independent task. The child inherits this session tool setup.',
		promptSnippet: 'delegate one bounded independent task to a child agent',
		parameters: Type.Object(
			{ task: Type.String({ minLength: 1, maxLength: 16_000 }) },
			{ additionalProperties: false },
		),
		executionMode: 'parallel',
		execute: async (_toolCallId, params, signal) => {
			const result = await owner.spawnSubagent((params as { task: string }).task, signal)
			return {
				content: [{ type: 'text', text: JSON.stringify(result) }],
				details: { subagentId: result.id, ok: result.ok },
			}
		},
	}
}

function providerToolNames(descriptors: readonly CommandDescriptor[]): ReadonlyMap<string, string> {
	const output = new Map<string, string>()
	const used = new Set<string>(['pluxel_goal', 'pluxel_subagent'])
	for (const descriptor of descriptors.toSorted((left, right) =>
		left.name.localeCompare(right.name),
	)) {
		const readable = descriptor.name
			.replaceAll(/[^A-Za-z0-9_-]+/g, '_')
			.replaceAll(/^_+|_+$/g, '')
			.slice(0, 38)
		const base = `pluxel_cmd_${readable || 'tool'}_${stableHash(descriptor.name)}`.slice(0, 60)
		if (used.has(base))
			throw new PiAgentError('TOOL_CONFLICT', `Pi tool name conflicts for "${descriptor.name}"`)
		used.add(base)
		output.set(descriptor.name, base)
	}
	return output
}

function stableHash(value: string): string {
	let hash = 0x811c9dc5
	for (let index = 0; index < value.length; index++) {
		hash ^= value.charCodeAt(index)
		hash = Math.imul(hash, 0x01000193)
	}
	return (hash >>> 0).toString(36).padStart(7, '0')
}

export function requireGoalText(text: string | undefined): string {
	const value = text?.trim()
	if (!value) throw new PiAgentError('INVALID_INPUT', 'Goal text is required')
	if (value.length > 8_000) throw new PiAgentError('INVALID_INPUT', 'Goal text is too long')
	return value
}
