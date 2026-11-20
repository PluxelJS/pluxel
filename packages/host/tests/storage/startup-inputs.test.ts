import { BasePlugin, Plugin, parsePluginNodeAddress } from '@pluxel/core'
import { requireConfigService } from '@pluxel/core/internal'
import { SuperJSON } from 'superjson'
import { expect, it, vi } from 'vitest'
import { createHost } from '../../src/index'
import { mergeRecord, snapshotHostConfig } from '../../src/config-records'
import { canonicalHostPolicyInput, snapshotHostPolicy } from '../../src/policy-input'
import { createDocumentStorage } from '../support/document-storage'

@Plugin({ forkable: true })
class Tenant extends BasePlugin {}

it.each([
	['config.json', '{'],
	['config.json', SuperJSON.stringify({ version: 3, plugins: [] })],
	['config.json', SuperJSON.stringify({ version: 4, plugins: {} })],
	['state.json', SuperJSON.stringify({ version: 7 })],
	['state.json', SuperJSON.stringify({ version: 8, startTimeoutMs: 2_147_483_648 })],
	['state.json', SuperJSON.stringify({ version: 8, stopConcurrency: 0 })],
	['state.json', SuperJSON.stringify({ version: 8, unsupported: true })],
])('refuses malformed %s at startup and leaves the file intact (%s)', async (key, text) => {
	const disk = createDocumentStorage()
	await disk.put(key, text)
	const document = { storage: () => disk }
	await expect(
		createHost({ plugins: [], config: { document }, policy: { document } }),
	).rejects.toThrow(key)
	expect(await disk.getText(key)).toBe(text)
})

it('refuses saved startup intent referring to a fork excluded by the selected deployment mode', async () => {
	const fork = Tenant.nodeAddress('east')
	const disk = createDocumentStorage()
	await disk.put(
		'state.json',
		SuperJSON.stringify({
			version: 8,
			autoStart: [{ node: fork, autoStart: true }],
			forks: [{ node: fork, deploy: true }],
		}),
	)
	await expect(
		createHost({
			plugins: [{ plugin: Tenant }],
			policy: { document: { storage: () => disk }, modes: { forks: 'declared-only' } },
		}),
	).rejects.toThrow('absent from policy.forks')
})

it('validates authored declarations as portable input without reading accessors', () => {
	const owner = parsePluginNodeAddress(Tenant.nodeAddress())
	const read = vi.fn(() => ({ node: owner, autoStart: true }))
	const accessor = Object.defineProperty([], '0', { enumerable: true, get: read })
	expect(() => canonicalHostPolicyInput({ autoStart: accessor })).toThrow(/accessors/)
	expect(() => snapshotHostConfig({}, undefined, accessor)).toThrow(/data elements/)
	expect(read).not.toHaveBeenCalled()
	expect(() =>
		canonicalHostPolicyInput({
			autoStart: [
				{ node: owner, autoStart: true },
				{ node: owner, autoStart: false },
			],
		}),
	).toThrow(/duplicates/)
	expect(() =>
		canonicalHostPolicyInput({ forks: [{ node: owner, deploy: true }] } as never),
	).toThrow(/fork/)
	for (const policy of [
		{ mode: 'typo' },
		{ modes: { typo: 'saved-first' } },
		{ execution: { startConcurrency: 0 } },
	]) {
		expect(() => snapshotHostPolicy(policy as never)).toThrow(/policy/)
	}
	for (const value of [undefined, Infinity, new Date(), Array(1)]) {
		expect(() => snapshotHostConfig({}, undefined, [{ owner, config: { value } }])).toThrow(
			/portable|dense/,
		)
	}
})

it('stores identity-only policy addresses and rejects copied implementation evidence', () => {
	const fork = Tenant.nodeAddress('east')
	expect(canonicalHostPolicyInput({ forks: [{ node: fork, deploy: true }] }).forks).toEqual([
		{ node: parsePluginNodeAddress(fork), deploy: true },
	])
	expect(() => canonicalHostPolicyInput({ forks: [{ node: { ...fork }, deploy: true }] })).toThrow(
		'copied or detached',
	)
})

it('preserves configuration mode entries and merges saved values without merging array items', () => {
	const owner = Tenant.nodeAddress()
	const mode = { owner, mode: 'saved-first' as const }
	expect(snapshotHostConfig({}, undefined, [mode]).records).toMatchObject([mode])
	expect(() => snapshotHostConfig({}, undefined, [mode, { owner, config: {} }])).toThrow(
		'duplicates',
	)
	expect(() => snapshotHostConfig({}, undefined, [{ owner }])).toThrow('requires mode or config')
	expect(
		mergeRecord(
			{
				fields: { keep: true, replace: 1 },
				rows: [{ id: 'previous', status: 'done' }],
				label: 'old',
			},
			{ fields: { replace: {} }, rows: [{ id: 'next' }], label: null },
		),
	).toEqual({ fields: { keep: true, replace: {} }, rows: [{ id: 'next' }], label: null })
})

it('requires Host transaction admission for direct configuration mutations', async () => {
	await using host = await createHost({ plugins: [{ plugin: Tenant }] })
	const config = requireConfigService(host.ctx)
	expect(() => config.patchConfig(Tenant.nodeAddress(), { injected: true })).toThrow('host.config')
})

it('rejects malformed application options before acquiring services', async () => {
	const prepares = vi.fn()
	const services = [{ name: 'probe', provides: [] as const, prepare: prepares }]
	await expect(createHost({ plugins: [], service: [], services } as never)).rejects.toThrow(
		'unsupported "service"',
	)
	await expect(
		createHost({ plugins: [{ plugin: Tenant.nodeAddress() }], services } as never),
	).rejects.toThrow('must be a Plugin constructor')
	expect(prepares).not.toHaveBeenCalled()
})
