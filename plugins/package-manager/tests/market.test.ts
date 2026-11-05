import { afterEach, describe, expect, it, vi } from 'vitest'
import { PackageMarketClient } from '../src/market.ts'
import type { MarketPackageDetail, MarketPackageSummary, MarketRelease } from '../src/contracts.ts'

afterEach(() => vi.restoreAllMocks())

const market = [{ id: 'community', url: 'https://market.example/catalog' }]
const release: MarketRelease = {
	name: '@example/plugin',
	version: '1.0.0',
	registry: 'https://registry.npmjs.org',
	integrity: `sha512-${'A'.repeat(86)}==`,
	checkedAt: 1,
	provenance: { status: 'missing' },
	peerDependencies: {},
	pluginPackages: {},
	readme: null,
	license: null,
}

describe('PackageMarketClient', () => {
	it('validates configured origins and unknown selections before making a request', async () => {
		expect(
			() => new PackageMarketClient([{ id: 'one', url: 'https://secret:password@example.test' }]),
		).toThrow('without credentials')
		expect(() => new PackageMarketClient([...market, ...market])).toThrow('unique')
		const fetch = vi.spyOn(globalThis, 'fetch')
		const client = new PackageMarketClient(market)
		expect(await client.packages('missing')).toMatchObject({
			ok: false,
			error: { code: 'UNKNOWN_MARKET' },
		})
		expect(await client.release('community', '@example/plugin', 'latest')).toMatchObject({
			ok: false,
			error: { code: 'INVALID_QUERY' },
		})
		expect(await client.packages('community', { limit: 101 })).toMatchObject({
			ok: false,
			error: { code: 'INVALID_QUERY' },
		})
		expect(fetch).not.toHaveBeenCalled()
		client.close()
	})

	it('uses configured base paths, escapes coordinates and projects only verified protocol data', async () => {
		const fetch = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(Response.json({ ...release, tarball: 'https://untrusted.test/code.tgz' }))
		const client = new PackageMarketClient(market)
		try {
			const result = await client.release('community', release.name, release.version)
			expect(result).toEqual({ ok: true, value: release })
			expect(fetch).toHaveBeenCalledWith(
				'https://market.example/catalog/v1/packages/%40example%2Fplugin/releases/1.0.0?registry=https%3A%2F%2Fregistry.npmjs.org',
				expect.objectContaining({ redirect: 'error' }),
			)
		} finally {
			client.close()
		}
	})

	it('rejects mismatched releases, unsafe repository links and oversized bodies', async () => {
		const fetch = vi.spyOn(globalThis, 'fetch')
		const client = new PackageMarketClient(market)
		try {
			fetch.mockResolvedValueOnce(Response.json({ ...release, version: '2.0.0' }))
			expect(await client.release('community', release.name, release.version)).toMatchObject({
				ok: false,
				error: { code: 'INVALID_RESPONSE' },
			})
			fetch.mockResolvedValueOnce(
				Response.json({
					...release,
					provenance: {
						status: 'verified',
						repository: 'javascript:alert(1)',
						commit: 'abc',
						buildUrl: null,
					},
				}),
			)
			expect(await client.release('community', release.name, release.version)).toMatchObject({
				ok: false,
				error: { code: 'INVALID_RESPONSE' },
			})
			fetch.mockResolvedValueOnce(new Response('x'.repeat(1_048_577)))
			expect(await client.packages('community')).toMatchObject({
				ok: false,
				error: { code: 'INVALID_RESPONSE', message: expect.stringContaining('size limit') },
			})
		} finally {
			client.close()
		}
	})

	it('keeps current latest tag visible even when its release has not been indexed', async () => {
		const fetch = vi.spyOn(globalThis, 'fetch')
		const client = new PackageMarketClient(market)
		try {
			fetch.mockResolvedValueOnce(
				Response.json({
					packages: [
						{
							registry: release.registry,
							name: release.name,
							description: null,
							latest: '2.0.0',
							repository: null,
							repositoryStars: null,
							repositoryObservedAt: null,
							indexedVersions: 1,
							observedAt: 1,
							official: true,
							category: 'development',
							tags: ['tooling'],
						},
					],
					nextCursor: null,
				}),
			)
			expect(await client.packages('community')).toMatchObject({
				ok: true,
				value: { packages: [{ latest: '2.0.0' }] },
			})
			fetch.mockResolvedValueOnce(new Response(null, { status: 404 }))
			expect(await client.release('community', release.name, '2.0.0')).toMatchObject({
				ok: false,
				error: { code: 'MARKET_UNAVAILABLE', message: expect.stringContaining('not indexed') },
			})
		} finally {
			client.close()
		}
	})

	it('preserves the selected registry and market filters without accepting a same-name public release', async () => {
		const source = 'http://127.0.0.1:7677/npm'
		const fetch = vi.spyOn(globalThis, 'fetch')
		const client = new PackageMarketClient(market)
		try {
			const summary: MarketPackageSummary = {
				registry: source,
				name: release.name,
				description: 'Private plugin',
				latest: release.version,
				repository: null,
				repositoryStars: null,
				repositoryObservedAt: null,
				indexedVersions: 1,
				observedAt: 1,
				official: false,
				category: 'storage',
				tags: ['cache'],
			}
			fetch.mockResolvedValueOnce(Response.json({ packages: [summary], nextCursor: null }))
			expect(
				await client.packages('community', {
					registry: source,
					query: 'plugin',
					official: false,
					category: 'storage',
					tag: 'cache',
					limit: 50,
				}),
			).toEqual({ ok: true, value: { packages: [summary], nextCursor: null } })
			const search = new URL(String(fetch.mock.calls.at(-1)![0])).searchParams
			expect(Object.fromEntries(search)).toEqual({
				registry: source,
				query: 'plugin',
				official: 'false',
				category: 'storage',
				tag: 'cache',
				limit: '50',
			})
			fetch.mockResolvedValueOnce(Response.json({ ...release, registry: source }))
			expect(await client.release('community', release.name, release.version, source)).toEqual({
				ok: true,
				value: { ...release, registry: source },
			})
			expect(new URL(String(fetch.mock.calls.at(-1)![0])).searchParams.get('registry')).toBe(source)
			fetch.mockResolvedValueOnce(Response.json(release))
			expect(
				await client.release('community', release.name, release.version, source),
			).toMatchObject({ ok: false, error: { code: 'INVALID_RESPONSE' } })
			fetch.mockResolvedValueOnce(
				Response.json({ packages: [{ ...summary, registry: release.registry }], nextCursor: null }),
			)
			expect(await client.packages('community', { registry: source })).toMatchObject({
				ok: false,
				error: { code: 'INVALID_RESPONSE' },
			})
			fetch.mockResolvedValueOnce(
				Response.json({ releases: [], nextCursor: null, coverage: 'indexed-only' }),
			)
			expect(await client.releases('community', release.name, { registry: source })).toMatchObject({
				ok: true,
			})
			expect(new URL(String(fetch.mock.calls.at(-1)![0])).searchParams.get('registry')).toBe(source)
		} finally {
			client.close()
		}
	})

	it('rejects unsupported registry URLs and Worker query bounds before requesting', async () => {
		const fetch = vi.spyOn(globalThis, 'fetch')
		const client = new PackageMarketClient(market)
		try {
			for (const source of [
				'http://registry.example',
				'https://registry.example/',
				'https://user:password@registry.example',
				'https://registry.example?token=secret',
				'https://registry.example#fragment',
			]) {
				expect(
					await client.release('community', release.name, release.version, source),
				).toMatchObject({ ok: false, error: { code: 'INVALID_QUERY' } })
			}
			for (const query of [{ query: 'x'.repeat(101) }, { limit: 51 }]) {
				expect(await client.packages('community', query)).toMatchObject({
					ok: false,
					error: { code: 'INVALID_QUERY' },
				})
			}
			expect(fetch).not.toHaveBeenCalled()
		} finally {
			client.close()
		}
	})

	it('reads registry metadata without inventing an installable release and rejects a different package identity', async () => {
		const source = 'http://127.0.0.1:7677/npm'
		const detail: MarketPackageDetail = {
			registry: source,
			name: '@example/plugin',
			description: 'A metadata-only plugin',
			latest: '1.0.0',
			distTags: { latest: '1.0.0' },
			metadataVersion: '1.0.0',
			repository: 'https://github.com/example/plugin',
			repositoryStars: null,
			repositoryObservedAt: null,
			indexedVersions: 0,
			observedAt: 1,
			official: true,
			category: 'development',
			tags: ['tooling'],
			readme: { text: '# Registry README', truncated: false },
			license: 'MIT',
			coverage: 'indexed-only',
		}
		const fetch = vi.spyOn(globalThis, 'fetch')
		const client = new PackageMarketClient(market)
		try {
			fetch.mockResolvedValueOnce(Response.json(detail))
			expect(await client.package('community', detail.name, source)).toEqual({
				ok: true,
				value: detail,
			})
			expect(fetch).toHaveBeenLastCalledWith(
				'https://market.example/catalog/v1/packages/%40example%2Fplugin?registry=http%3A%2F%2F127.0.0.1%3A7677%2Fnpm',
				expect.any(Object),
			)
			for (const different of [
				{ registry: release.registry },
				{ name: '@example/other' },
				{ repositoryStars: -1 },
			]) {
				fetch.mockResolvedValueOnce(Response.json({ ...detail, ...different }))
				expect(await client.package('community', detail.name, source)).toMatchObject({
					ok: false,
					error: { code: 'INVALID_RESPONSE' },
				})
			}
			const publicDetail: MarketPackageDetail = { ...detail, registry: release.registry }
			fetch.mockResolvedValueOnce(Response.json(publicDetail))
			expect(await client.package('community', detail.name)).toEqual({
				ok: true,
				value: publicDetail,
			})
			expect(new URL(String(fetch.mock.calls.at(-1)![0])).searchParams.get('registry')).toBe(
				release.registry,
			)
		} finally {
			client.close()
		}
	})

	it('pages indexed releases independently from the current latest tag', async () => {
		const fetch = vi.spyOn(globalThis, 'fetch')
		const client = new PackageMarketClient(market)
		try {
			const summary = {
				version: release.version,
				integrity: release.integrity,
				checkedAt: release.checkedAt,
			}
			fetch.mockResolvedValueOnce(
				Response.json({
					releases: [summary],
					nextCursor: 'cursor/with+symbols=',
					coverage: 'indexed-only',
				}),
			)
			const first = await client.releases('community', release.name, { limit: 1 })
			expect(first).toEqual({
				ok: true,
				value: {
					releases: [summary],
					nextCursor: 'cursor/with+symbols=',
					coverage: 'indexed-only',
				},
			})
			if (first.ok === false) throw new Error(first.error.message)
			fetch.mockResolvedValueOnce(
				Response.json({ releases: [], nextCursor: null, coverage: 'indexed-only' }),
			)
			expect(
				await client.releases('community', release.name, {
					cursor: first.value.nextCursor!,
					limit: 1,
				}),
			).toMatchObject({ ok: true, value: { releases: [], nextCursor: null } })
			expect(fetch).toHaveBeenLastCalledWith(
				'https://market.example/catalog/v1/packages/%40example%2Fplugin/releases?cursor=cursor%2Fwith%2Bsymbols%3D&limit=1',
				expect.any(Object),
			)
		} finally {
			client.close()
		}
	})

	it('rejects invalid release pagination and incompatible release pages without inventing an empty history', async () => {
		const fetch = vi.spyOn(globalThis, 'fetch')
		const client = new PackageMarketClient(market)
		try {
			expect(await client.releases('community', '../invalid', { limit: 1 })).toMatchObject({
				ok: false,
				error: { code: 'INVALID_QUERY' },
			})
			expect(await client.releases('community', release.name, { limit: 0 })).toMatchObject({
				ok: false,
				error: { code: 'INVALID_QUERY' },
			})
			expect(fetch).not.toHaveBeenCalled()
			const invalidPages: Record<string, unknown>[] = [
				{ releases: [], nextCursor: null, coverage: 'complete' },
				{
					releases: [{ version: 'latest', integrity: release.integrity, checkedAt: 1 }],
					nextCursor: null,
					coverage: 'indexed-only',
				},
				{
					releases: [{ version: '1.0.0', integrity: 'unverified', checkedAt: 1 }],
					nextCursor: null,
					coverage: 'indexed-only',
				},
			]
			for (const page of invalidPages) {
				fetch.mockResolvedValueOnce(Response.json(page))
				expect(await client.releases('community', release.name)).toMatchObject({
					ok: false,
					error: { code: 'INVALID_RESPONSE' },
				})
			}
			fetch.mockResolvedValueOnce(new Response(null, { status: 503 }))
			expect(await client.releases('community', release.name)).toMatchObject({
				ok: false,
				error: { code: 'MARKET_UNAVAILABLE' },
			})
		} finally {
			client.close()
		}
	})

	it('aborts owned requests and rejects retained handles after close', async () => {
		let started!: () => void
		const ready = new Promise<void>((resolve) => {
			started = resolve
		})
		vi.spyOn(globalThis, 'fetch').mockImplementation(
			async (_input, options) =>
				new Promise<Response>((_resolve, reject) => {
					options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), {
						once: true,
					})
					started()
				}),
		)
		const client = new PackageMarketClient(market)
		const reading = client.packages('community')
		await ready
		client.close()
		await expect(reading).rejects.toThrow('closed')
		await expect(client.packages('community')).rejects.toThrow('closed')
	})
})
