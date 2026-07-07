export type ZhipuSettingsDoc = {
	id: 'settings'
	hasApiKey: boolean
	apiKeyPreview: string | null
	baseUrl: string
	updatedAt: number | null
}

export type ZhipuStatusDoc = {
	id: 'status'
	lastOk: boolean | null
	lastStatus: string | null
	lastError: string | null
	updatedAt: number | null
}

export type ZhipuTestRunDoc = {
	id: string
	at: number
	source: 'ui' | 'rpc' | 'settings'
	userId: string
	operation: string
	model?: string
	ok: boolean
	status: string
	latencyMs: number
	inputBytes: number
	outputBytes: number
	fileName?: string
	upstreamRequestId?: string
	requestPreview?: string
	responsePreview?: string
	error?: string
}
