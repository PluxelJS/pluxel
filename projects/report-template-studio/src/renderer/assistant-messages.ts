import type { ThreadMessageLike } from '@assistant-ui/react'
import type { AiMessage } from '../shared/contracts'

/** Preserve Pi's identities and content parts; assistant-ui owns their runtime state. */
export function toAssistantMessage(message: AiMessage): ThreadMessageLike {
	const status = message.status
	return {
		id: message.id,
		role: message.role,
		content: message.content.map((part, index) => {
			if (part.type === 'tool-call') {
				return {
					type: part.type,
					toolCallId: part.toolCallId,
					toolName: part.toolName,
					argsText: part.argsText,
					...(part.result !== undefined && { result: part.result }),
					...(part.isError && { isError: true }),
				}
			}
			return {
				type: part.type,
				text: part.text,
				status:
					index === message.content.length - 1 && status === 'running'
						? { type: 'running' as const }
						: index === message.content.length - 1 && (status === 'cancelled' || status === 'error')
							? { type: 'incomplete' as const, reason: status }
							: { type: 'complete' as const },
			}
		}),
		...(message.role === 'assistant' && {
			status:
				status === 'running'
					? { type: 'running' as const }
					: status === 'error' || status === 'cancelled'
						? { type: 'incomplete' as const, reason: status }
						: { type: 'complete' as const, reason: 'stop' as const },
			metadata: {
				custom: {
					toolStates: Object.fromEntries(
						message.content.flatMap((part) =>
							part.type === 'tool-call' ? [[part.toolCallId, part.status]] : [],
						),
					),
				},
			},
		}),
	}
}
