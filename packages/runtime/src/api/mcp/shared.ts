import type { ToolCallResult } from 'mcp-lite'

export const textContent = (text: string) => ({ type: 'text' as const, text })

export const textResult = <T>(text: string, structuredContent: T): ToolCallResult<T> => ({
	content: [textContent(text)],
	structuredContent,
})

export function isJsonSchemaObject(schema: unknown): schema is Record<string, unknown> {
	if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return false
	return (
		'$schema' in schema ||
		'type' in schema ||
		'properties' in schema ||
		'anyOf' in schema ||
		'oneOf' in schema ||
		'allOf' in schema
	)
}
