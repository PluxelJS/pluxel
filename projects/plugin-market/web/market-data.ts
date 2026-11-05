import {
	PackageMarketClient,
	type MarketplaceData,
	type MarketplaceRead,
	type MarketReadResult,
} from '@pluxel/plugin-package-manager/marketplace'
import { useCallback, useEffect, useRef, useState, type ComponentProps } from 'react'

const marketId = 'public'
type Read<T> = (client: PackageMarketClient) => Promise<MarketReadResult<T>>
type State<T> = Omit<MarketplaceRead<T>, 'refetch'> & { read: Read<T> }
type Owner<T> = { read: Read<T>; fetch(): Promise<void> }

// The page owns only HTTP reads. Search, selection and pagination belong to Marketplace.
export function createMarketplaceData(url: string): MarketplaceData {
	function Packages({
		query: { query, registry, official, category, tag, cursor, limit },
		children,
	}: ComponentProps<MarketplaceData['Packages']>) {
		const read = useCallback(
			(client: PackageMarketClient) =>
				client.packages(marketId, { query, registry, official, category, tag, cursor, limit }),
			[query, registry, official, category, tag, cursor, limit],
		)
		return children(useMarketRead(url, read))
	}
	function Package({
		identity: { registry, name },
		children,
	}: ComponentProps<MarketplaceData['Package']>) {
		const read = useCallback(
			(client: PackageMarketClient) => client.package(marketId, name, registry),
			[registry, name],
		)
		return children(useMarketRead(url, read))
	}
	function Releases({
		identity: { registry, name },
		query: { cursor, limit },
		children,
	}: ComponentProps<MarketplaceData['Releases']>) {
		const read = useCallback(
			(client: PackageMarketClient) => client.releases(marketId, name, { registry, cursor, limit }),
			[registry, name, cursor, limit],
		)
		return children(useMarketRead(url, read))
	}
	function Release({
		identity: { registry, name, version },
		children,
	}: ComponentProps<MarketplaceData['Release']>) {
		const read = useCallback(
			(client: PackageMarketClient) => client.release(marketId, name, version, registry),
			[registry, name, version],
		)
		return children(useMarketRead(url, read))
	}
	return { Packages, Package, Releases, Release }
}

function useMarketRead<T>(url: string, read: Read<T>): MarketplaceRead<T> {
	const [state, setState] = useState<State<T>>({ read, isFetching: true })
	const owner = useRef<Owner<T> | undefined>(undefined)

	useEffect(() => {
		let active = true
		let sequence = 0
		let client: PackageMarketClient | undefined
		const current: Owner<T> = {
			read,
			async fetch() {
				const request = ++sequence
				client?.close()
				let pending: PackageMarketClient | undefined
				setState((previous) => ({
					read,
					data: previous.read === read ? previous.data : undefined,
					isFetching: true,
				}))
				try {
					pending = new PackageMarketClient([{ id: marketId, url }])
					client = pending
					const data = await read(pending)
					if (active && request === sequence) setState({ read, data, isFetching: false })
				} catch (error) {
					if (active && request === sequence)
						setState((previous) => ({ ...previous, read, error, isFetching: false }))
				} finally {
					pending?.close()
				}
			},
		}
		owner.current = current
		void current.fetch()
		return () => {
			active = false
			sequence++
			client?.close()
			if (owner.current === current) owner.current = undefined
		}
	}, [url, read])

	const refetch = useCallback(async () => {
		if (owner.current?.read === read) await owner.current.fetch()
	}, [read])

	return state.read === read
		? { data: state.data, error: state.error, isFetching: state.isFetching, refetch }
		: { isFetching: true, refetch }
}
