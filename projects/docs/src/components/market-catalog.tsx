'use client'

import { createMarketplaceData, Marketplace } from '@pluxel/plugin-package-manager/marketplace'
import { useTheme } from 'next-themes'
import { useMemo, useSyncExternalStore } from 'react'

const subscribeToHydration = () => () => {}

export function MarketCatalog({ url }: Readonly<{ url: string }>) {
	const data = useMemo(() => createMarketplaceData(url), [url])
	const { resolvedTheme } = useTheme()
	const hydrated = useSyncExternalStore(
		subscribeToHydration,
		() => true,
		() => false,
	)
	return (
		<Marketplace
			key={url}
			data={data}
			colorScheme={hydrated && resolvedTheme === 'dark' ? 'dark' : 'light'}
		/>
	)
}
