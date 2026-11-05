// @vitest-environment jsdom
import type {
	MarketPackageDetail,
	MarketPackageIdentity,
	MarketplaceRead,
} from '@pluxel/plugin-package-manager/marketplace'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMarketplaceData } from '../market-data'

type Request = { url: string; signal: AbortSignal; resolve(value: Response): void }
const publicRegistry = 'https://registry.npmjs.org'
const privateRegistry = 'http://127.0.0.1:7677/npm'
const name = '@example/plugin'

function detail(registry: string, description = registry): MarketPackageDetail {
	return {
		registry,
		name,
		description,
		latest: '1.0.0',
		repository: null,
		repositoryStars: null,
		repositoryObservedAt: null,
		indexedVersions: 0,
		observedAt: 1,
		official: false,
		category: null,
		tags: [],
		distTags: { latest: '1.0.0' },
		metadataVersion: '1.0.0',
		readme: null,
		license: null,
		coverage: 'indexed-only',
	}
}

describe('public page HTTP hook ownership', () => {
	let root: Root
	let requests: Request[]
	let current: MarketplaceRead<MarketPackageDetail>
	let renders: number
	const data = createMarketplaceData('https://market.example')

	function Probe({ identity }: { identity: MarketPackageIdentity }) {
		return (
			<data.Package identity={identity}>
				{(read) => {
					current = read
					renders++
					return null
				}}
			</data.Package>
		)
	}

	beforeEach(() => {
		vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
		requests = []
		renders = 0
		vi.spyOn(globalThis, 'fetch').mockImplementation(
			(input, init) =>
				new Promise<Response>((resolve) => {
					requests.push({ url: String(input), signal: init!.signal!, resolve })
				}),
		)
		root = createRoot(document.createElement('div'))
	})

	afterEach(async () => {
		await act(() => root.unmount())
		vi.restoreAllMocks()
		vi.unstubAllGlobals()
	})

	it('cancels a previous registry read and never commits its late result for the same package name', async () => {
		await act(() =>
			root.render(createElement(Probe, { identity: { registry: publicRegistry, name } })),
		)
		expect(requests).toHaveLength(1)
		expect(new URL(requests[0].url).searchParams.get('registry')).toBe(publicRegistry)
		await act(() =>
			root.render(createElement(Probe, { identity: { registry: privateRegistry, name } })),
		)
		expect(requests[0].signal.aborted).toBe(true)
		expect(current.data).toBeUndefined()
		expect(new URL(requests[1].url).searchParams.get('registry')).toBe(privateRegistry)
		await act(async () => requests[1].resolve(Response.json(detail(privateRegistry))))
		expect(current.data).toEqual({ ok: true, value: detail(privateRegistry) })
		await act(async () => requests[0].resolve(Response.json(detail(publicRegistry))))
		expect(current.data).toEqual({ ok: true, value: detail(privateRegistry) })
		expect(current.isFetching).toBe(false)
	})

	it('lets the newest refresh win and releases a pending read on unmount', async () => {
		await act(() =>
			root.render(createElement(Probe, { identity: { registry: publicRegistry, name } })),
		)
		await act(async () => requests[0].resolve(Response.json(detail(publicRegistry, 'initial'))))
		let first!: Promise<unknown>
		let second!: Promise<unknown>
		await act(() => {
			first = current.refetch()
		})
		await act(() => {
			second = current.refetch()
		})
		expect(requests[1].signal.aborted).toBe(true)
		await act(async () => {
			requests[2].resolve(Response.json(detail(publicRegistry, 'newest')))
			await second
		})
		await act(async () => {
			requests[1].resolve(Response.json(detail(publicRegistry, 'older')))
			await first
		})
		expect(current.data).toMatchObject({ ok: true, value: { description: 'newest' } })
		let pending!: Promise<unknown>
		await act(() => {
			pending = current.refetch()
		})
		await act(() => root.unmount())
		expect(requests[3].signal.aborted).toBe(true)
		const before = renders
		await act(async () => {
			requests[3].resolve(Response.json(detail(publicRegistry, 'unmounted')))
			await pending
		})
		expect(renders).toBe(before)
	})

	it('exposes a failed public read as a settled query and allows an explicit retry', async () => {
		await act(() =>
			root.render(createElement(Probe, { identity: { registry: publicRegistry, name } })),
		)
		await act(async () => requests[0].resolve(new Response(null, { status: 503 })))
		expect(current.isFetching).toBe(false)
		expect(current.data).toMatchObject({ ok: false, error: { code: 'MARKET_UNAVAILABLE' } })
		let retry!: Promise<unknown>
		await act(() => {
			retry = current.refetch()
		})
		await act(async () => {
			requests[1].resolve(Response.json(detail(publicRegistry)))
			await retry
		})
		expect(current.data).toMatchObject({ ok: true })
	})
})
