import type { AgentCommandCatalog, AgentCommandCatalogSnapshot } from '@pluxel/agent-tools'
import { CommandError, type CommandDescriptor } from '@pluxel/commands'
import type { AgentSession, ToolDefinition } from '@earendil-works/pi-coding-agent'
import { Type, type TSchema } from 'typebox'
import { PiAgentError } from './errors.ts'
import type { PiSubagentRunResult } from './types.ts'

type PiAgentTool = AgentSession['agent']['state']['tools'][number]

type ControlToolOwner = Readonly<{
	goal(action: 'show' | 'set' | 'complete' | 'clear', text?: string, summary?: string): unknown
	spawnSubagent(task: string, signal?: AbortSignal): Promise<PiSubagentRunResult>
	canSpawnSubagent(): boolean
}>

export function createPiToolDefinitions(input: {
	catalog: AgentCommandCatalog
	snapshot: AgentCommandCatalogSnapshot
	sessionId: string
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
	catalog: AgentCommandCatalog
	snapshot: AgentCommandCatalogSnapshot
	sessionId: string
	maxResultChars: number
}): ToolDefinition[] {
	const names = providerToolNames(input.snapshot.descriptors)
	return input.snapshot.descriptors.map((descriptor) => ({
		name: names.get(descriptor.name)!,
		label: descriptor.title ?? descriptor.name,
		description: `${descriptor.description}\nPluxel command: ${descriptor.name}`,
		parameters: descriptor.inputSchema as TSchema,
		executionMode: descriptor.behavior.kind === 'mutation' ? 'sequential' : 'parallel',
		execute: async (_toolCallId, params, signal) => {
			try {
				const output = await input.catalog.execute(descriptor.name, params, {
					signal,
					meta: Object.freeze({ carrier: 'pi-agent', sessionId: input.sessionId }),
				})
				return {
					content: [{ type: 'text', text: formatToolOutput(output, input.maxResultChars) }],
					details: { commandName: descriptor.name },
				}
			} catch (error) {
				if (error instanceof CommandError) throw new Error(error.publicMessage, { cause: error })
				throw new Error('Pluxel command execution failed', { cause: error })
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
		let candidate = base
		let suffix = 2
		while (used.has(candidate)) candidate = `${base.slice(0, 57)}_${suffix++}`
		used.add(candidate)
		output.set(descriptor.name, candidate)
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

function formatToolOutput(value: unknown, limit: number): string {
	const text = value === undefined ? 'Command completed successfully.' : JSON.stringify(value)
	if (text.length <= limit) return text
	return `${text.slice(0, limit)}\n… Pluxel truncated the tool result at ${limit} characters.`
}

export function requireGoalText(text: string | undefined): string {
	const value = text?.trim()
	if (!value) throw new PiAgentError('INVALID_INPUT', 'Goal text is required')
	if (value.length > 8_000) throw new PiAgentError('INVALID_INPUT', 'Goal text is too long')
	return value
}
