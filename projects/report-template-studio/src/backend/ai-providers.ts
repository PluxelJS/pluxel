import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { AuthStorage, ModelRegistry } from '@mariozechner/pi-coding-agent'
import type { AiModel } from '../shared/contracts.js'
import type { AiProvider, AiProviders, AiProviderWrite } from '../shared/ai-providers.js'
import { modelImageInput } from '../shared/model-image-input.js'
interface Configuration {
	baseUrl: string
	api: string
	model: string
	imageInput?: boolean
}
const COMPANY = 'company-proxy'
const preset: Configuration = {
	baseUrl: 'https://proxy-api.nas.gxyxjt.com:10001/v1',
	api: 'openai-responses',
	model: 'deepseek-flash',
}
function baseUrl(value: string) {
	const url = new URL(value)
	if (
		!['http:', 'https:'].includes(url.protocol) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	)
		throw new Error('Base URL must be HTTP(S) without credentials, query or fragment')
	return url.href.replace(/\/$/, '')
}

function providerWrite(value: unknown): AiProviderWrite {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new Error('Invalid provider configuration')
	if (
		Object.keys(value).some(
			(key) => !['apiKey', 'baseUrl', 'api', 'model', 'imageInput'].includes(key),
		)
	)
		throw new Error('Unknown provider configuration field')
	const input: AiProviderWrite = {}
	if ('apiKey' in value) {
		if (value.apiKey !== null && typeof value.apiKey !== 'string')
			throw new Error('Invalid API key')
		input.apiKey = value.apiKey
	}
	if ('baseUrl' in value) {
		if (typeof value.baseUrl !== 'string') throw new Error('Invalid provider base URL')
		input.baseUrl = value.baseUrl
	}
	if ('api' in value) {
		if (typeof value.api !== 'string') throw new Error('Invalid provider API')
		input.api = value.api
	}
	if ('model' in value) {
		if (typeof value.model !== 'string') throw new Error('Invalid provider model')
		input.model = value.model
	}
	if ('imageInput' in value) {
		if (typeof value.imageInput !== 'boolean') throw new Error('Invalid image input capability')
		input.imageInput = value.imageInput
	}
	return input
}

/** Studio keys remain in app data; native Pi auth/OAuth remains owned by Pi. */
export class StudioProviders {
	readonly auth: AuthStorage
	readonly registry: ModelRegistry
	private readonly local: AuthStorage
	private readonly file: string
	private readonly configs = new Map<string, Configuration>()
	private readonly overrides = new Set<string>()
	private readonly registered = new Set<string>()
	private readonly builtIns: Set<string>
	private readonly apis: string[]
	constructor(
		root: string,
		private readonly request: typeof fetch = fetch,
		inheritedAuth?: AuthStorage,
	) {
		mkdirSync(root, { recursive: true, mode: 0o700 })
		this.file = join(root, 'providers.json')
		this.local = AuthStorage.create(join(root, 'auth.json'))
		this.auth = inheritedAuth ?? AuthStorage.create()
		this.registry = ModelRegistry.create(this.auth)
		const catalog = this.registry.getAll()
		this.builtIns = new Set(catalog.map((model) => model.provider))
		this.apis = [...new Set(catalog.map((model) => model.api))].sort()
		this.configs.set(COMPANY, { ...preset })
		if (existsSync(this.file)) {
			const saved: unknown = JSON.parse(readFileSync(this.file, 'utf8'))
			if (!saved || typeof saved !== 'object' || Array.isArray(saved))
				throw new Error('Invalid provider configuration file')
			for (const [id, config] of Object.entries(saved))
				this.configs.set(this.validateId(id), this.validate(config))
		}
	}
	private validateId(id: string) {
		if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(id)) throw new Error('Invalid provider id')
		return id
	}
	private validate(value: unknown): Configuration {
		if (
			!value ||
			typeof value !== 'object' ||
			!('baseUrl' in value) ||
			typeof value.baseUrl !== 'string' ||
			!('api' in value) ||
			typeof value.api !== 'string' ||
			!this.apis.includes(value.api) ||
			!('model' in value) ||
			typeof value.model !== 'string' ||
			!value.model.trim() ||
			value.model.length > 200
		)
			throw new Error('Invalid provider base URL, API or model')
		const imageInput = 'imageInput' in value ? value.imageInput : undefined
		if (imageInput !== undefined && typeof imageInput !== 'boolean')
			throw new Error('Invalid image input capability')
		return {
			baseUrl: baseUrl(value.baseUrl),
			api: value.api,
			model: value.model.trim(),
			...(imageInput === undefined ? {} : { imageInput }),
		}
	}
	private persist() {
		const temporary = this.file + '.' + randomUUID()
		writeFileSync(temporary, JSON.stringify(Object.fromEntries(this.configs), null, 2), {
			mode: 0o600,
			flag: 'wx',
		})
		renameSync(temporary, this.file)
		chmodSync(this.file, 0o600)
	}
	refresh() {
		this.auth.reload()
		this.local.reload()
		for (const id of this.overrides) this.auth.removeRuntimeApiKey(id)
		this.overrides.clear()
		for (const id of this.local.list()) {
			const credential = this.local.get(id)
			if (credential?.type === 'api_key') {
				this.auth.setRuntimeApiKey(id, credential.key)
				this.overrides.add(id)
			}
		}
		for (const id of this.registered) this.registry.unregisterProvider(id)
		this.registered.clear()
		this.registry.refresh()
		for (const [id, config] of this.configs) {
			if (!this.auth.hasAuth(id)) continue
			const existing = this.registry.getAll().filter((model) => model.provider === id)
			const selected = existing.find((model) => model.id === config.model)
			const imageInput = modelImageInput(
				{ id: config.model, name: selected?.name, input: selected?.input },
				config.imageInput,
			)
			const input: ('text' | 'image')[] = imageInput ? ['text', 'image'] : ['text']
			const models = existing.map((model) =>
				Object.assign({}, model, {
					baseUrl: config.baseUrl,
					api: config.api,
					...(model.id === config.model ? { input } : {}),
				}),
			)
			if (!selected)
				models.push({
					id: config.model,
					name: config.model,
					provider: id,
					api: config.api,
					baseUrl: config.baseUrl,
					reasoning: false,
					input,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 32768,
					maxTokens: 4096,
				})
			// AuthStorage resolves the real key first; this placeholder never becomes an available credential.
			this.registry.registerProvider(id, {
				baseUrl: config.baseUrl,
				api: config.api,
				apiKey: 'STUDIO_MANAGED_AUTH',
				models,
			})
			this.registered.add(id)
		}
	}
	async list(): Promise<AiProviders> {
		this.refresh()
		const all = this.registry.getAll()
		const providers = Array.from(new Set([...this.builtIns, ...this.configs.keys()]))
			.sort()
			.map((id) => {
				const models = all.filter((model) => model.provider === id)
				const config = this.configs.get(id)
				const first = models[0]
				const selected = config ? models.find((model) => model.id === config.model) : first
				const credential = this.local.get(id) ?? this.auth.get(id)
				const hasCredential = this.auth.hasAuth(id)
				const result: AiProvider = {
					id,
					name: id === COMPANY ? '公司代理' : id,
					builtIn: this.builtIns.has(id),
					configured: this.configs.has(id),
					hasCredential,
					authType:
						credential?.type === 'oauth'
							? 'oauth'
							: credential?.type === 'api_key'
								? 'api_key'
								: hasCredential
									? 'environment'
									: 'none',
					baseUrl: config?.baseUrl ?? first?.baseUrl ?? '',
					api: config?.api ?? first?.api ?? '',
					model: config?.model ?? first?.id ?? '',
					imageInput: modelImageInput(
						{ id: config?.model ?? first?.id ?? '', name: selected?.name, input: selected?.input },
						config?.imageInput,
					),
					models: models.map(({ id: modelId, name, provider, input }) => ({
						id: modelId,
						name,
						provider,
						imageInput: modelImageInput(
							{ id: modelId, name, input },
							modelId === config?.model ? config.imageInput : undefined,
						),
					})),
					suggestedModel: id === COMPANY ? 'deepseek-flash' : undefined,
				}
				return result
			})
		return { providers, apis: this.apis }
	}
	async configure(id: string, value: unknown): Promise<AiProvider> {
		const input = providerWrite(value)
		this.validateId(id)
		const listed = await this.list()
		const current = listed.providers.find((provider) => provider.id === id)
		const currentConfig = this.configs.get(id)
		const model = (input.model ?? (current?.model || current?.models[0]?.id))?.trim()
		const next = this.validate({
			baseUrl: input.baseUrl ?? current?.baseUrl,
			api: input.api ?? current?.api,
			model,
			imageInput:
				input.imageInput ??
				(model === currentConfig?.model ? currentConfig?.imageInput : undefined),
		})
		if (
			input.apiKey !== undefined &&
			input.apiKey !== null &&
			(typeof input.apiKey !== 'string' ||
				!input.apiKey.trim() ||
				input.apiKey.length > 16384 ||
				input.apiKey.startsWith('!') ||
				/[\r\n]/.test(input.apiKey))
		)
			throw new Error('API key must be a nonempty literal value')
		if (input.apiKey === null) this.local.remove(id)
		else if (input.apiKey !== undefined) this.local.set(id, { type: 'api_key', key: input.apiKey })
		if (this.local.drainErrors().length > 0) throw new Error('Unable to save provider credentials')
		this.configs.set(id, next)
		this.persist()
		const updated = await this.list()
		return updated.providers.find((provider) => provider.id === id)!
	}
	async models(): Promise<AiModel[]> {
		this.refresh()
		return this.registry.getAvailable().map(({ provider, id, name, input }) => {
			const config = this.configs.get(provider)
			return {
				provider,
				id,
				name,
				imageInput: modelImageInput(
					{ id, name, input },
					id === config?.model ? config.imageInput : undefined,
				),
			}
		})
	}
	async discover(id: string): Promise<AiModel[]> {
		const listed = await this.list()
		const provider = listed.providers.find((item) => item.id === id)
		if (!provider) throw new Error('Unknown provider')
		if (!['openai-completions', 'openai-responses'].includes(provider.api))
			throw new Error(
				'Model discovery supports OpenAI-compatible providers only. Select or enter a model manually for this provider.',
			)
		if (!provider.hasCredential)
			throw new Error('Configure provider credentials before discovering models')
		const key = await this.auth.getApiKey(id)
		if (!key) throw new Error('Provider credentials are unavailable')
		const endpoint = new URL(provider.baseUrl + '/')
		endpoint.pathname = endpoint.pathname === '/' ? '/v1/models' : endpoint.pathname + 'models'
		try {
			const response = await this.request(endpoint, {
				headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
				signal: AbortSignal.timeout(15000),
				redirect: 'error',
			})
			if (!response.ok) throw new Error(`Model discovery returned HTTP ${response.status}`)
			if (!response.body) throw new Error('Empty discovery response')
			const reader = response.body.getReader()
			const chunks: Uint8Array[] = []
			let size = 0
			try {
				while (true) {
					const { value, done } = await reader.read()
					if (done) break
					size += value.length
					if (size > 2 * 1024 * 1024) {
						await reader.cancel()
						throw new Error('Discovery response too large')
					}
					chunks.push(value)
				}
			} finally {
				reader.releaseLock()
			}
			const text = Buffer.concat(chunks).toString('utf8')
			const body: unknown = JSON.parse(text)
			if (!body || typeof body !== 'object' || !('data' in body) || !Array.isArray(body.data))
				throw new Error('Model discovery requires an OpenAI-compatible data array')
			const models = body.data.slice(0, 1000).map((model: unknown) => {
				if (
					!model ||
					typeof model !== 'object' ||
					!('id' in model) ||
					typeof model.id !== 'string' ||
					!model.id.trim() ||
					model.id.length > 200
				)
					throw new Error('Invalid discovered model')
				return { provider: id, id: model.id, name: model.id }
			})
			return [...new Map(models.map((model) => [model.id, model])).values()]
		} catch {
			throw new Error(
				'Model discovery failed. Check the endpoint and credentials, or enter a model manually.',
			)
		}
	}
	redact(text: string) {
		for (const [name, value] of Object.entries(process.env))
			if (/(?:KEY|TOKEN|SECRET|PASSWORD)$/i.test(name) && value && value.length >= 4)
				text = text.replaceAll(value, '[redacted]')
		for (const credentials of [this.local.getAll(), this.auth.getAll()])
			for (const credential of Object.values(credentials)) {
				const secrets =
					credential.type === 'api_key' ? [credential.key] : [credential.access, credential.refresh]
				for (const secret of secrets) if (secret) text = text.replaceAll(secret, '[redacted]')
			}
		return text.replaceAll(/Authorization:\s*[^\r\n]+/gi, 'Authorization: [redacted]')
	}
}
