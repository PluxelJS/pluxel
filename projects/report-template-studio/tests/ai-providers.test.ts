import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AuthStorage, ModelRegistry } from '@mariozechner/pi-coding-agent'
import { StudioProviders } from '../src/backend/ai-providers.js'
import { modelImageInput } from '../src/shared/model-image-input.js'
const roots: string[] = []
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture(request: typeof fetch = fetch, auth = AuthStorage.inMemory()) {
	const root = await mkdtemp(join(tmpdir(), 'studio-providers-'))
	roots.push(root)
	return { root, providers: new StudioProviders(root, request, auth), auth }
}
it('enumerates the Pi SDK catalog and exposes the unverified company suggestion', async () => {
	const { providers, auth } = await fixture()
	const listed = await providers.list()
	const expected = new Set(
		ModelRegistry.create(auth)
			.getAll()
			.map((model) => model.provider),
	)
	expect(
		listed.providers
			.filter((provider) => provider.builtIn)
			.map((provider) => provider.id)
			.sort(),
	).toEqual([...expected].sort())
	expect(listed.apis).toContain('openai-responses')
	expect(listed.providers.find((provider) => provider.id === 'company-proxy')).toMatchObject({
		hasCredential: false,
		model: 'deepseek-flash',
		imageInput: true,
		suggestedModel: 'deepseek-flash',
	})
})
it('persists keys only in app auth and registers manual models without losing native auth', async () => {
	const auth = AuthStorage.inMemory({ anthropic: { type: 'api_key', key: 'native-existing-key' } })
	const { providers, root } = await fixture(fetch, auth)
	const result = await providers.configure('company-proxy', { apiKey: 'test-private-secret' })
	expect(result.hasCredential).toBe(true)
	expect(JSON.stringify(result)).not.toContain('test-private-secret')
	expect(await readFile(join(root, 'providers.json'), 'utf8')).not.toContain('test-private-secret')
	expect(await readFile(join(root, 'auth.json'), 'utf8')).toContain('test-private-secret')
	const available = await providers.models()
	expect(available.some((model) => model.provider === 'anthropic')).toBe(true)
	expect(available).toContainEqual({
		provider: 'company-proxy',
		id: 'deepseek-flash',
		name: 'deepseek-flash',
		imageInput: true,
	})
	const restarted = new StudioProviders(root, fetch, auth)
	expect(await restarted.models()).toContainEqual({
		provider: 'company-proxy',
		id: 'deepseek-flash',
		name: 'deepseek-flash',
		imageInput: true,
	})
	await restarted.configure('company-proxy', { apiKey: null })
	const removed = await restarted.models()
	expect(removed.some((model) => model.provider === 'company-proxy')).toBe(false)
	expect(auth.get('anthropic')).toMatchObject({ key: 'native-existing-key' })
})
it('discovers models with bearer authorization and never reflects response errors or secrets', async () => {
	const request = vi.fn<typeof fetch>().mockResolvedValue(
		new Response(
			JSON.stringify({
				data: [{ id: 'actual-model', input: ['text', 'image'], imageInput: true }],
			}),
		),
	)
	const { providers } = await fixture(request)
	await providers.configure('company-proxy', { apiKey: 'discovery-secret' })
	expect(await providers.discover('company-proxy')).toEqual([
		{ provider: 'company-proxy', id: 'actual-model', name: 'actual-model' },
	])
	expect(String(request.mock.calls[0]![0])).toBe('https://proxy-api.nas.gxyxjt.com:10001/v1/models')
	expect(request.mock.calls[0]![1]?.headers).toMatchObject({
		Authorization: 'Bearer discovery-secret',
	})
	request.mockRejectedValue(new Error('Authorization: Bearer discovery-secret'))
	await expect(providers.discover('company-proxy')).rejects.toThrow('Model discovery failed')
	expect(providers.redact('problem discovery-secret')).toBe('problem [redacted]')
})
it('rejects command credentials and URLs containing credentials before saving', async () => {
	const { providers } = await fixture()
	await expect(providers.configure('company-proxy', { apiKey: '!echo hacked' })).rejects.toThrow(
		'literal',
	)
	await expect(
		providers.configure('company-proxy', { baseUrl: 'https://key:secret@example.com/' }),
	).rejects.toThrow('credentials')
})
it('uses built-in default models and preserves existing versioned endpoint paths', async () => {
	const request = vi
		.fn<typeof fetch>()
		.mockImplementation(
			async () =>
				new Response(JSON.stringify({ data: [{ id: 'one' }, { id: 'one' }, { id: 'two' }] })),
		)
	const { providers } = await fixture(request)
	const saved = await providers.configure('openai', { apiKey: 'test-openai-key' })
	expect(saved.model.length).toBeGreaterThan(0)
	await providers.configure('company-proxy', {
		apiKey: 'test-proxy-key',
		baseUrl: 'https://example.com/api/v1',
	})
	expect(await providers.discover('company-proxy')).toEqual([
		{ provider: 'company-proxy', id: 'one', name: 'one' },
		{ provider: 'company-proxy', id: 'two', name: 'two' },
	])
	expect(String(request.mock.calls[0]![0])).toBe('https://example.com/api/v1/models')
	await providers.configure('company-proxy', { baseUrl: 'https://example.com/' })
	await providers.discover('company-proxy')
	expect(String(request.mock.calls[1]![0])).toBe('https://example.com/v1/models')
	await expect(providers.discover('anthropic')).rejects.toThrow('OpenAI-compatible')
})
it('cancels oversized discovery streams and redacts environment credentials', async () => {
	let cancelled = false
	const request = vi.fn<typeof fetch>().mockImplementation(
		async () =>
			new Response(
				new ReadableStream<Uint8Array>({
					pull(controller) {
						controller.enqueue(new Uint8Array(1024 * 1024))
					},
					cancel() {
						cancelled = true
					},
				}),
			),
	)
	const { providers } = await fixture(request)
	await providers.configure('company-proxy', { apiKey: 'bounded-test-key' })
	await expect(providers.discover('company-proxy')).rejects.toThrow('Model discovery failed')
	expect(cancelled).toBe(true)
	vi.stubEnv('OPENAI_API_KEY', 'env-test-secret')
	try {
		expect(providers.redact('upstream echoed env-test-secret')).toBe('upstream echoed [redacted]')
	} finally {
		vi.unstubAllEnvs()
	}
})
it('keeps native OAuth credentials under the inherited Pi owner', async () => {
	const credential = {
		type: 'oauth' as const,
		access: 'oauth-access',
		refresh: 'oauth-refresh',
		expires: Date.now() + 3600000,
	}
	const inherited = AuthStorage.inMemory({ 'openai-codex': credential })
	const { providers, root } = await fixture(fetch, inherited)
	const listed = await providers.list()
	expect(listed.providers.find((provider) => provider.id === 'openai-codex')?.authType).toBe(
		'oauth',
	)
	await providers.configure('company-proxy', { apiKey: 'new-company-key' })
	expect(inherited.get('openai-codex')).toEqual(credential)
	const local = await readFile(join(root, 'auth.json'), 'utf8')
	expect(local).not.toContain('oauth-access')
	expect(local).not.toContain('oauth-refresh')
})
it('validates unknown route payloads before touching provider credentials', async () => {
	const { providers } = await fixture()
	for (const value of [
		null,
		[],
		'text',
		{ apiKey: 42 },
		{ apiKey: false },
		{ baseUrl: [] },
		{ api: {} },
		{ model: 42 },
		{ imageInput: 'true' },
		{ imageInput: null },
		{ imageInput: 1 },
		{ imageInput: [] },
		{ imageInput: {} },
		{ unexpected: true },
	]) {
		await expect(providers.configure('company-proxy', value)).rejects.toThrow(/Invalid|Unknown/)
	}
	const listed = await providers.list()
	expect(listed.providers.find((provider) => provider.id === 'company-proxy')?.hasCredential).toBe(
		false,
	)
})

it('inherits Pi image input and only overrides the selected model', async () => {
	const { providers, auth } = await fixture()
	const catalog = ModelRegistry.create(auth).getAll()
	const imageModel = catalog.find(
		(model) => model.provider === 'openai' && model.input.includes('image'),
	)!
	const otherImageModel = catalog.find(
		(model) =>
			model.provider === imageModel.provider &&
			model.id !== imageModel.id &&
			model.input.includes('image'),
	)!
	// A native credential enables catalog models without any Studio configuration.
	auth.set(imageModel.provider, { type: 'api_key', key: 'native-image-key' })
	expect(await providers.models()).toContainEqual({
		provider: imageModel.provider,
		id: imageModel.id,
		name: imageModel.name,
		imageInput: true,
	})
	expect(await providers.configure(imageModel.provider, { model: imageModel.id })).toMatchObject({
		model: imageModel.id,
		imageInput: true,
	})
	expect(await providers.configure(imageModel.provider, { imageInput: false })).toMatchObject({
		imageInput: false,
	})
	expect(providers.registry.find(imageModel.provider, imageModel.id)?.input).toEqual(['text'])
	for (const model of catalog.filter(
		(item) => item.provider === imageModel.provider && item.id !== imageModel.id,
	))
		expect(providers.registry.find(model.provider, model.id)?.input).toEqual(model.input)
	// Editing another provider setting preserves an explicit capability for this model.
	expect(
		await providers.configure(imageModel.provider, { baseUrl: 'https://example.com/v1' }),
	).toMatchObject({ imageInput: false })
	// Changing the selected model without an override uses that model's own Pi capability.
	expect(
		await providers.configure(imageModel.provider, { model: otherImageModel.id }),
	).toMatchObject({ imageInput: true })
	expect(providers.registry.find(imageModel.provider, imageModel.id)?.input).toEqual(
		imageModel.input,
	)
})

it('persists explicit image input for manual models and does not carry it to another model', async () => {
	const { providers, root, auth } = await fixture()
	expect(
		await providers.configure('company-proxy', { apiKey: 'manual-image-key', imageInput: true }),
	).toMatchObject({ model: 'deepseek-flash', imageInput: true })
	expect(providers.registry.find('company-proxy', 'deepseek-flash')?.input).toEqual([
		'text',
		'image',
	])
	const saved = JSON.parse(await readFile(join(root, 'providers.json'), 'utf8'))
	expect(saved['company-proxy'].imageInput).toBe(true)
	const restarted = new StudioProviders(root, fetch, auth)
	expect(await restarted.models()).toContainEqual({
		provider: 'company-proxy',
		id: 'deepseek-flash',
		name: 'deepseek-flash',
		imageInput: true,
	})
	expect(
		await restarted.configure('company-proxy', { baseUrl: 'https://example.com/v1' }),
	).toMatchObject({ imageInput: true })
	expect(
		await restarted.configure('company-proxy', { model: 'another-custom-model' }),
	).toMatchObject({
		model: 'another-custom-model',
		imageInput: false,
	})
	expect(restarted.registry.find('company-proxy', 'another-custom-model')?.input).toEqual(['text'])
	const available = await restarted.models()
	expect(available.every((model) => typeof model.imageInput === 'boolean')).toBe(true)
})

it('rejects a nonboolean image input capability in persisted provider configuration', async () => {
	const { root, auth } = await fixture()
	await writeFile(
		join(root, 'providers.json'),
		JSON.stringify({
			'company-proxy': {
				baseUrl: 'https://example.com/v1',
				api: 'openai-responses',
				model: 'manual-model',
				imageInput: 'true',
			},
		}),
	)
	expect(() => new StudioProviders(root, fetch, auth)).toThrow('Invalid image input capability')
})

it('uses exact models.dev IDs or display names across providers without name heuristics', async () => {
	expect(modelImageInput({ id: 'deepseek-flash' })).toBe(true)
	expect(modelImageInput({ id: 'company-model', name: 'DeepSeek V4.1 Flash' })).toBe(true)
	expect(modelImageInput({ id: 'company-vision-model' })).toBe(false)
	expect(modelImageInput({ id: 'DeepSeek-Flash' })).toBe(false)
	expect(modelImageInput({ id: 'deepseek-flash-company-edition' })).toBe(false)
	expect(modelImageInput({ id: 'company-model', input: ['text', 'image'] })).toBe(true)
	expect(modelImageInput({ id: 'deepseek-flash', input: ['text', 'image'] }, false)).toBe(false)
	const { providers } = await fixture()
	expect(
		await providers.configure('company-proxy', { apiKey: 'snapshot-model-key' }),
	).toMatchObject({
		model: 'deepseek-flash',
		imageInput: true,
	})
	expect(providers.registry.find('company-proxy', 'deepseek-flash')?.input).toEqual([
		'text',
		'image',
	])
	expect(
		await providers.configure('company-proxy', { model: 'DeepSeek V4.1 Flash' }),
	).toMatchObject({ imageInput: true })
	expect(await providers.models()).toContainEqual({
		provider: 'company-proxy',
		id: 'DeepSeek V4.1 Flash',
		name: 'DeepSeek V4.1 Flash',
		imageInput: true,
	})
})

it('prioritizes an explicit image opt-out over snapshot hints and resets it when changing models', async () => {
	const { providers, root, auth } = await fixture()
	await providers.configure('company-proxy', { apiKey: 'snapshot-opt-out-key', imageInput: false })
	expect(providers.registry.find('company-proxy', 'deepseek-flash')?.input).toEqual(['text'])
	expect(await providers.models()).toContainEqual({
		provider: 'company-proxy',
		id: 'deepseek-flash',
		name: 'deepseek-flash',
		imageInput: false,
	})
	const restarted = new StudioProviders(root, fetch, auth)
	const listed = await restarted.list()
	expect(listed.providers.find((provider) => provider.id === 'company-proxy')).toMatchObject({
		imageInput: false,
		models: [expect.objectContaining({ imageInput: false })],
	})
	// A new ID gets its own metadata hint, rather than the previous model's explicit false.
	expect(
		await restarted.configure('company-proxy', { model: 'DeepSeek V4.1 Flash' }),
	).toMatchObject({ imageInput: true })
	expect(
		await restarted.configure('company-proxy', { model: 'company-unknown-model' }),
	).toMatchObject({
		imageInput: false,
	})
})
