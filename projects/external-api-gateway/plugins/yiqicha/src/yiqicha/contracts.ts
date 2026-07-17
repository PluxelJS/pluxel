export type YiqichaSettingsDoc = {
	id: 'settings'
	hasAppkey: boolean
	appkeyPreview: string | null
	hasSecretKey: boolean
	secretKeyPreview: string | null
	baseUrl: string
	updatedAt: number
}

export type YiqichaStatusDoc = {
	id: 'status'
	lastOk: boolean | null
	lastStatus: string | null
	lastError: string | null
	updatedAt: number | null
}

export type YiqichaTestRunDoc = {
	id: string
	at: number
	source: 'ui' | 'rpc' | 'settings'
	userId: string
	operation: string
	apiCode?: string
	apiName?: string
	ok: boolean
	status: string
	latencyMs: number
	inputBytes: number
	outputBytes: number
	upstreamRequestId?: string
	requestPreview?: string
	responsePreview?: string
	error?: string
}
