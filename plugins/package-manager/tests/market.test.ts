import { afterEach, describe, expect, it, vi } from 'vitest'
import { PackageMarketClient } from '../src/market.ts'

afterEach(() => vi.restoreAllMocks())

const market = [{ id: 'community', url: 'https://market.example/catalog' }]
const release = {
	name: '@example/plugin',
	version: '1.0.0',
	registry: 'https://registry.npmjs.org',
	integrity: `sha512-${'A'.repeat(86)}==`,
	checkedAt: 1,
	provenance: { status: 'missing' },
	peerDependencies: {},
	pluginPackages: {},
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
				'https://market.example/catalog/v1/packages/%40example%2Fplugin/releases/1.0.0',
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
							name: release.name,
							description: null,
							latest: '2.0.0',
							repository: null,
							indexedVersions: 1,
							observedAt: 1,
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
