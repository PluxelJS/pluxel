import { createContext, type ReactNode, useContext, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { ProductDescriptor } from '@pluxel/runtime/product'
import type { RuntimeMeta } from '@pluxel/runtime/web'

import type { RuntimeManagementClient } from '../runtime'
import { managementQueryKeys } from './managementQuery'

const ProductContext = createContext<ProductDescriptor | null | undefined>(undefined)
const RuntimeMetaContext = createContext<RuntimeMeta | null | undefined>(undefined)

export function ProductProvider({
	children,
	client,
}: {
	children: ReactNode
	client: RuntimeManagementClient
}) {
	const { data: meta = null } = useQuery({
		queryKey: managementQueryKeys.runtimeMeta(),
		queryFn: () => client.describe(),
		staleTime: Number.POSITIVE_INFINITY,
	})
	const product = meta?.application.product ?? null

	useEffect(() => {
		document.title = product ? `${product.displayName} Workbench` : 'Pluxel Workbench'
	}, [product])

	return (
		<RuntimeMetaContext.Provider value={meta}>
			<ProductContext.Provider value={product}>{children}</ProductContext.Provider>
		</RuntimeMetaContext.Provider>
	)
}

export function useProduct(): ProductDescriptor | null {
	const product = useContext(ProductContext)
	if (product === undefined) throw new Error('useProduct() must be used within ProductProvider')
	return product
}

export function useRuntimeMeta(): RuntimeMeta | null {
	const meta = useContext(RuntimeMetaContext)
	if (meta === undefined) throw new Error('useRuntimeMeta() must be used within ProductProvider')
	return meta
}
