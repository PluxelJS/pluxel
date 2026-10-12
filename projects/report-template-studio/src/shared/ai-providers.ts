import type { AiModel } from './contracts.js'
export interface AiProvider {
	id: string
	name: string
	builtIn: boolean
	configured: boolean
	hasCredential: boolean
	authType: 'api_key' | 'oauth' | 'environment' | 'none'
	baseUrl: string
	api: string
	model: string
	/** Effective image input capability of the selected model. */
	imageInput: boolean
	models: AiModel[]
	suggestedModel?: string
}
export interface AiProviderWrite {
	apiKey?: string | null
	baseUrl?: string
	api?: string
	model?: string
	/** Overrides the selected model; otherwise Pi and the bundled models.dev snapshot apply. */
	imageInput?: boolean
}
export interface AiProviders {
	providers: AiProvider[]
	apis: string[]
}
