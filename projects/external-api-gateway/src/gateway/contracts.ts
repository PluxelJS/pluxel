export type GatewayTokenDoc = {
	id: string
	name: string
	tokenPreview: string
	enabled: boolean
	createdAt: number
	updatedAt: number
	lastUsedAt: number | null
}

export type GatewayAuthContext = {
	tokenId: string
	name: string
}

export type GatewayBillingContext = {
	userId: string
	tenantId?: string
	traceId?: string
	metadata?: Record<string, unknown>
}

export type GatewayTokenCreateInput = {
	name: string
	token: string
	enabled?: boolean
}

export type GatewayStatusDoc = {
	id: 'status'
	rpcPath: string
	tokenCount: number
	enabledTokenCount: number
	updatedAt: number | null
}
