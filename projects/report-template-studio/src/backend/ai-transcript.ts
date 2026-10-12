import type { AiMessage, AiMessagePart } from '../shared/contracts.js'

type ToolPart = Extract<AiMessagePart, { type: 'tool-call' }>
export type ToolExecution = Pick<ToolPart, 'result' | 'isError' | 'status'>

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined
}

/** Pi owns the transcript; this projects its actual model/tool parts for the UI. */
export function transcript(
	messages: readonly unknown[],
	options: {
		streaming?: boolean
		running?: boolean
		tools?: ReadonlyMap<string, ToolExecution>
	} = {},
): AiMessage[] {
	const results = new Map<string, ToolExecution>()
	for (const value of messages) {
		const message = record(value)
		if (message?.role !== 'toolResult' || typeof message.toolCallId !== 'string') continue
		results.set(message.toolCallId, {
			result: toolResult(message),
			isError: message.isError === true,
			status: message.isError === true ? 'error' : 'complete',
		})
	}
	return messages.flatMap((value, index) => {
		const message = record(value)
		if (!message || (message.role !== 'user' && message.role !== 'assistant')) return []
		const source =
			typeof message.content === 'string'
				? [{ type: 'text', text: message.content }]
				: Array.isArray(message.content)
					? message.content
					: []
		const content = source.flatMap((candidate): AiMessagePart[] => {
			const part = record(candidate)
			if (part?.type === 'text' && typeof part.text === 'string')
				return [{ type: 'text', text: part.text }]
			if (part?.type === 'thinking' && typeof part.thinking === 'string')
				return [{ type: 'reasoning', text: part.thinking }]
			if (part?.type !== 'toolCall' || typeof part.id !== 'string' || typeof part.name !== 'string')
				return []
			const args = record(part.arguments) ?? {}
			const execution = results.get(part.id) ?? options.tools?.get(part.id)
			return [
				{
					type: 'tool-call',
					toolCallId: part.id,
					toolName: part.name,
					args,
					argsText: JSON.stringify(args, null, 2),
					status: execution?.status ?? (options.running ? 'running' : 'incomplete'),
					...(execution && { result: execution.result, isError: execution.isError }),
				},
			]
		})
		if (content.length === 0 && message.role === 'user') return []
		return [
			{
				id: `pi:${index}:${message.role}:${message.timestamp ?? 0}`,
				role: message.role,
				content,
				...(message.role === 'assistant' && {
					status:
						options.streaming && index === messages.length - 1
							? ('running' as const)
							: message.stopReason === 'error'
								? ('error' as const)
								: message.stopReason === 'aborted'
									? ('cancelled' as const)
									: ('complete' as const),
				}),
			},
		]
	})
}

/** Text and optional structured details from the SDK, without inventing tool output. */
export function toolResult(value: unknown): unknown {
	const result = record(value)
	if (!result) return value ?? null
	const text = Array.isArray(result.content)
		? result.content
				.flatMap((candidate) => {
					const part = record(candidate)
					return part?.type === 'text' && typeof part.text === 'string' ? [part.text] : []
				})
				.join('\n')
		: ''
	return result.details !== undefined && Object.keys(record(result.details) ?? {}).length > 0
		? { output: text, details: result.details }
		: text
}

/** Redact each string before transport, including nested tool arguments/results. */
export function redactMessage(message: AiMessage, redact: (text: string) => string): AiMessage {
	function value(item: unknown): unknown {
		if (typeof item === 'string') return redact(item)
		if (Array.isArray(item)) return item.map(value)
		const fields = record(item)
		return fields
			? Object.fromEntries(
					Object.entries(fields).map(([key, field]) => [redact(key), value(field)]),
				)
			: item
	}
	return {
		...message,
		content: message.content.map((part) =>
			part.type === 'tool-call'
				? {
						...part,
						args: value(part.args) as Record<string, unknown>,
						argsText: JSON.stringify(value(part.args), null, 2),
						result: value(part.result),
					}
				: { ...part, text: redact(part.text) },
		),
	}
}
