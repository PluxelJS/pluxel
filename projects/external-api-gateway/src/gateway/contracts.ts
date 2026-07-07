export type GatewayPermission = `${string}:${string}` | `${string}:*` | '*'

export type GatewayTokenDoc = {
	id: string
	name: string
	tokenPreview: string
	permissions: GatewayPermission[]
	enabled: boolean
	createdAt: number
	updatedAt: number
	lastUsedAt: number | null
}

export type GatewayAuthContext = {
	tokenId: string
	name: string
	permissions: GatewayPermission[]
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
	permissions: GatewayPermission[]
	enabled?: boolean
}

export type GatewayStatusDoc = {
	id: 'status'
	rpcPath: string
	tokenCount: number
	enabledTokenCount: number
	updatedAt: number | null
}
