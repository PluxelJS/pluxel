import { deepFreeze, isDeepFrozen } from '../internal/freeze'
import {
	assertJsonValue,
	cloneJsonValue,
	isStrictJsonSnapshot,
	markStrictJsonSnapshot,
} from '../internal/json'
import type { CommandBehavior, CommandDescriptor } from '../types'

export type ToolAnnotations = {
	readonly readOnlyHint: boolean
	readonly destructiveHint: boolean
	readonly idempotentHint: boolean
	readonly openWorldHint: boolean
}

export type ToolExecution = {
	readonly taskSupport: 'forbidden'
}

/** Provider-neutral tool facts, directly compatible with the common MCP tool shape. */
export type ToolDescriptor = {
	readonly name: string
	readonly title?: string
	readonly description: string
	readonly inputSchema: Readonly<Record<string, unknown>>
	readonly outputSchema?: Readonly<Record<string, unknown>>
	readonly annotations: ToolAnnotations
	readonly execution: ToolExecution
}

const descriptorCache = new WeakMap<CommandDescriptor, ToolDescriptor>()
const listCache = new WeakMap<readonly CommandDescriptor[], readonly ToolDescriptor[]>()

export function toToolDescriptor(descriptor: CommandDescriptor): ToolDescriptor {
	const cached = descriptorCache.get(descriptor)
	if (cached) return cached
	const cacheable = isDeepFrozen(descriptor)
	if (cacheable && !isStrictJsonSnapshot(descriptor)) {
		assertJsonValue(descriptor)
		markStrictJsonSnapshot(descriptor)
	}
	const tool = deepFreeze({
		name: descriptor.name,
		...(descriptor.title ? { title: descriptor.title } : {}),
		description: descriptor.description,
		inputSchema: schemaSnapshot(descriptor.inputSchema, cacheable),
		...(descriptor.outputSchema
			? { outputSchema: schemaSnapshot(descriptor.outputSchema, cacheable) }
			: {}),
		annotations: annotationsFor(descriptor.behavior),
		execution: { taskSupport: 'forbidden' as const },
	})
	if (cacheable) descriptorCache.set(descriptor, tool)
	return tool
}

export function toToolDescriptors(
	descriptors: readonly CommandDescriptor[],
): readonly ToolDescriptor[] {
	const cached = listCache.get(descriptors)
	if (cached) return cached
	const cacheable = isDeepFrozen(descriptors)
	const tools = deepFreeze(descriptors.map(toToolDescriptor))
	if (cacheable) listCache.set(descriptors, tools)
	return tools
}

function schemaSnapshot(
	schema: Readonly<Record<string, unknown>>,
	reuse: boolean,
): Readonly<Record<string, unknown>> {
	return reuse ? schema : (cloneJsonValue(schema) as Record<string, unknown>)
}

function annotationsFor(behavior: CommandBehavior): ToolAnnotations {
	if (behavior.kind === 'query') {
		return {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: behavior.world === 'open',
		}
	}
	return {
		readOnlyHint: false,
		destructiveHint: behavior.destructive,
		idempotentHint: behavior.idempotent,
		openWorldHint: behavior.world === 'open',
	}
}
