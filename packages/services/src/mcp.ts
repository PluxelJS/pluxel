import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'
import type {
	CommandContext,
	CommandContextArgs,
	CommandFailure,
	DirectCommand,
} from '@pluxel/commands'

/** One selected Command projected to native MCP tool data and a call handler. */
export type McpCommand<Ctx extends CommandContext> = Readonly<{
	tool: Readonly<Tool>
	call(candidate: unknown, ...context: CommandContextArgs<Ctx>): Promise<CallToolResult>
}>

/** The application owns tool publication, authentication, request context and MCP transport. */
export function toMcp<I, O, Ctx extends CommandContext>(
	command: DirectCommand<I, O, Ctx>,
): McpCommand<Ctx> {
	if (
		!command ||
		typeof command.name !== 'string' ||
		!command.descriptor ||
		command.descriptor.inputSchema.type !== 'object' ||
		typeof command.execute !== 'function'
	) {
		throw new TypeError('Expected a direct Command with an object input schema')
	}
	const execute = command.execute.bind(command)
	const tool: Tool = Object.freeze({
		name: command.name,
		description: command.descriptor.description,
		inputSchema: command.descriptor.inputSchema as Tool['inputSchema'],
	})
	return Object.freeze({
		tool,
		async call(candidate: unknown, ...context: CommandContextArgs<Ctx>): Promise<CallToolResult> {
			const result = await execute(candidate as I, ...context)
			try {
				const text = jsonText(result.isErr() ? publicFailure(result.error) : (result.value ?? null))
				return {
					...(result.isErr() ? { isError: true } : {}),
					content: [{ type: 'text', text }],
				}
			} catch {
				return {
					isError: true,
					content: [
						{
							type: 'text',
							text: '{"code":"OUTPUT_ENCODING","message":"Command output is not JSON"}',
						},
					],
				}
			}
		},
	})
}

function publicFailure(failure: CommandFailure): Record<string, unknown> {
	if (failure.code === 'INPUT_VALIDATION') {
		return { code: failure.code, message: failure.message, issues: failure.issues }
	}
	if (failure.code === 'REJECTED') {
		return { code: failure.code, message: failure.message, reason: failure.reason }
	}
	return { code: failure.code, message: failure.message }
}

function jsonText(value: unknown): string {
	assertJson(value, new WeakSet<object>())
	return JSON.stringify(value)
}

function assertJson(value: unknown, ancestors: WeakSet<object>): void {
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return
	if (typeof value === 'number' && Number.isFinite(value)) return
	if (typeof value !== 'object' || ancestors.has(value)) throw new TypeError('Not JSON data')
	const array = Array.isArray(value)
	const prototype = Object.getPrototypeOf(value)
	if (prototype !== (array ? Array.prototype : Object.prototype) && prototype !== null) {
		throw new TypeError('Not JSON data')
	}
	ancestors.add(value)
	try {
		for (const key of Reflect.ownKeys(value)) {
			if (array && key === 'length') continue
			if (typeof key !== 'string') throw new TypeError('Not JSON data')
			if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) {
				throw new TypeError('Not JSON data')
			}
			const property = Object.getOwnPropertyDescriptor(value, key)!
			if (!property.enumerable || !('value' in property)) throw new TypeError('Not JSON data')
			assertJson(property.value, ancestors)
		}
		if (array && Object.keys(value).length !== value.length) throw new TypeError('Not JSON data')
	} finally {
		ancestors.delete(value)
	}
}
