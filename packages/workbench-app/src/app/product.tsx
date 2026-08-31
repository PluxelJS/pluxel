import { createContext, type ReactNode, useContext, useEffect, useState } from 'react'
import type { ProductDescriptor } from '@pluxel/runtime/product'
import type { RuntimeMeta } from '@pluxel/runtime/web'

import type { RuntimeManagementClient } from '../runtime'

const ProductContext = createContext<ProductDescriptor | null | undefined>(undefined)
const RuntimeMetaContext = createContext<RuntimeMeta | null | undefined>(undefined)

export function ProductProvider({
	children,
	client,
}: {
	children: ReactNode
	client: RuntimeManagementClient
}) {
	const [meta, setMeta] = useState<RuntimeMeta | null>(null)
	const product = meta?.application.product ?? null

	useEffect(() => {
		let active = true
		async function loadProduct(): Promise<void> {
			try {
				const nextMeta = await client.describe()
				if (active) setMeta(nextMeta)
			} catch (error: unknown) {
				console.error('[workbench] failed to load host product metadata', error)
			}
		}
		void loadProduct()
		return () => {
			active = false
		}
	}, [client])

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
