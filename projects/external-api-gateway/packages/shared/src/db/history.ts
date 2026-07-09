import type { ProviderCallHistoryRow } from './schema.ts'

export type ProviderCallHistorySource = 'ui' | 'rpc' | 'settings'

export type ProviderCallHistoryDoc = {
	id: string
	at: number
	source: ProviderCallHistorySource
	userId: string
	operation: string
	model?: string
	ok: boolean
	status: string
	latencyMs: number
	inputBytes: number
	outputBytes: number
	upstreamRequestId?: string
	requestPreview?: string
	responsePreview?: string
	error?: string
	details?: Record<string, unknown>
}

export function providerHistoryRowId(provider: string, id: string): string {
	return `${provider}:${id}`
}

export function providerHistoryToRow(
	provider: string,
	doc: ProviderCallHistoryDoc,
): ProviderCallHistoryRow {
	return {
		id: providerHistoryRowId(provider, doc.id),
		provider,
		providerRecordId: doc.id,
		at: doc.at,
		source: doc.source,
		userId: doc.userId,
		operation: doc.operation,
		model: doc.model ?? null,
		ok: doc.ok,
		status: doc.status,
		latencyMs: doc.latencyMs,
		inputBytes: doc.inputBytes,
		outputBytes: doc.outputBytes,
		upstreamRequestId: doc.upstreamRequestId ?? null,
		requestPreview: doc.requestPreview ?? null,
		responsePreview: doc.responsePreview ?? null,
		error: doc.error ?? null,
		detailsJson: doc.details ? JSON.stringify(doc.details) : null,
	}
}

export function providerHistoryFromRow(row: ProviderCallHistoryRow): ProviderCallHistoryDoc {
	return {
		id: row.providerRecordId,
		at: row.at,
		source: row.source,
		userId: row.userId,
		operation: row.operation,
		...(row.model ? { model: row.model } : {}),
		ok: row.ok,
		status: row.status,
		latencyMs: row.latencyMs,
		inputBytes: row.inputBytes,
		outputBytes: row.outputBytes,
		...(row.upstreamRequestId ? { upstreamRequestId: row.upstreamRequestId } : {}),
		...(row.requestPreview ? { requestPreview: row.requestPreview } : {}),
		...(row.responsePreview ? { responsePreview: row.responsePreview } : {}),
		...(row.error ? { error: row.error } : {}),
		...(row.detailsJson ? { details: parseDetails(row.detailsJson) } : {}),
	}
}

function parseDetails(input: string): Record<string, unknown> | undefined {
	try {
		const parsed = JSON.parse(input)
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: undefined
	} catch {
		return undefined
	}
}
