export type ParsedUpstreamError = {
	message: string
	code?: string
	requestId?: string
}

export function previewJson(input: unknown): string {
	try {
		return JSON.stringify(sanitizePreviewValue(input), null, 2)
	} catch {
		return String(input)
	}
}

export function requestPreview(input: unknown): string | undefined {
	if (input === undefined || input === null) return undefined
	if (typeof input === 'string') return input
	if (typeof FormData !== 'undefined' && input instanceof FormData) return 'multipart/form-data'
	if (typeof URLSearchParams !== 'undefined' && input instanceof URLSearchParams) {
		return input.toString()
	}
	if (typeof Blob !== 'undefined' && input instanceof Blob) return `blob:${input.size}`
	if (input instanceof ArrayBuffer || input instanceof Uint8Array) return `binary:${byteLength(input)}`
	return previewJson(input)
}

export function parseUpstreamError(
	text: string,
	contentType: string,
	status: number,
): ParsedUpstreamError {
	if (!contentType.includes('application/json') || !text.trim()) {
		return { message: text || `Zhipu request failed: ${status}` }
	}
	try {
		const parsed = JSON.parse(text) as Record<string, unknown>
		const error = parsed.error
		if (error && typeof error === 'object') {
			const record = error as Record<string, unknown>
			return {
				message: stringField(record, 'message') ?? stringField(record, 'msg') ?? text,
				code: stringField(record, 'code') ?? stringField(parsed, 'code'),
				requestId:
					stringField(record, 'request_id') ??
					stringField(record, 'requestId') ??
					stringField(parsed, 'request_id') ??
					stringField(parsed, 'requestId'),
			}
		}
		return {
			message:
				stringField(parsed, 'message') ??
				stringField(parsed, 'msg') ??
				stringField(parsed, 'error') ??
				text,
			code: stringField(parsed, 'code') ?? stringField(parsed, 'error_code'),
			requestId: stringField(parsed, 'request_id') ?? stringField(parsed, 'requestId'),
		}
	} catch {
		return { message: text || `Zhipu request failed: ${status}` }
	}
}

function sanitizePreviewValue(input: unknown): unknown {
	if (typeof input === 'string') return sanitizePreviewString(input)
	if (!input || typeof input !== 'object') return input
	if (Array.isArray(input)) return input.map((value) => sanitizePreviewValue(value))
	if (typeof FormData !== 'undefined' && input instanceof FormData) return 'multipart/form-data'
	if (typeof URLSearchParams !== 'undefined' && input instanceof URLSearchParams) {
		return input.toString()
	}
	if (typeof Blob !== 'undefined' && input instanceof Blob) return `blob:${input.size}`
	if (input instanceof ArrayBuffer || input instanceof Uint8Array) return `binary:${byteLength(input)}`
	const record = input as Record<string, unknown>
	const output: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(record)) {
		output[key] =
			key.toLowerCase() === 'file' ? summarizeFilePreview(value) : sanitizePreviewValue(value)
	}
	return output
}

function summarizeFilePreview(input: unknown): unknown {
	if (typeof input !== 'string') return sanitizePreviewValue(input)
	const trimmed = input.trim()
	if (trimmed.startsWith('data:')) return summarizeDataUrl(trimmed)
	if (looksLikeBase64(trimmed)) return `base64:${estimatedBase64Bytes(trimmed)} bytes`
	if (trimmed.length > 300) return `${trimmed.slice(0, 120)}...(${trimmed.length} chars)`
	return trimmed
}

function sanitizePreviewString(input: string): string {
	const trimmed = input.trim()
	if (trimmed.startsWith('data:')) return summarizeDataUrl(trimmed)
	if (looksLikeBase64(trimmed)) return `base64:${estimatedBase64Bytes(trimmed)} bytes`
	return input.length > 1_000 ? `${input.slice(0, 500)}...(${input.length} chars)` : input
}

function summarizeDataUrl(input: string): string {
	const [header, data = ''] = input.split(',', 2)
	return `${header};bytes=${estimatedBase64Bytes(data)}`
}

function looksLikeBase64(input: string): boolean {
	return input.length > 500 && /^[A-Za-z0-9+/=\r\n]+$/.test(input)
}

function estimatedBase64Bytes(input: string): number {
	const normalized = input.replace(/\s/g, '')
	const padding = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0
	return Math.max(0, Math.floor((normalized.length * 3) / 4) - padding)
}

function byteLength(input: unknown): number {
	if (typeof input === 'string') return new TextEncoder().encode(input).length
	if (input instanceof ArrayBuffer) return input.byteLength
	if (input instanceof Uint8Array) return input.byteLength
	return new TextEncoder().encode(JSON.stringify(input)).length
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key]
	if (typeof value === 'string' && value.trim()) return value.trim()
	if (typeof value === 'number' && Number.isFinite(value)) return String(value)
	return undefined
}
