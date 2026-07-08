export type ProviderOperationDescriptor = {
	id: string
	label: string
	path?: string
	method?: string
	unitName: string
	defaultModel?: string
}

export type ProviderDescriptor = {
	id: string
	label: string
	pluginId: string
	operations: ProviderOperationDescriptor[]
}

export type ProviderCallInput = {
	operation: string
	body?: Record<string, unknown> | string | null
	method?: string
	path?: string
	model?: string
}
