import { createContext, type ReactNode, useContext, useEffect, useState } from 'react'
import type { ProductDescriptor } from '@pluxel/runtime/product'

import type { RuntimeTransportClient } from '../runtime'

const ProductContext = createContext<ProductDescriptor | null | undefined>(undefined)

export function ProductProvider({
	children,
	transport,
}: {
	children: ReactNode
	transport: RuntimeTransportClient
}) {
	const [product, setProduct] = useState<ProductDescriptor | null>(null)

	useEffect(() => {
		let active = true
		async function loadProduct(): Promise<void> {
			try {
				const meta = await transport.http.meta.info()
				if (active) setProduct(meta.application.product)
			} catch (error: unknown) {
				console.error('[workbench] failed to load host product metadata', error)
			}
		}
		void loadProduct()
		return () => {
			active = false
		}
	}, [transport])

	useEffect(() => {
		document.title = product ? `${product.displayName} Workbench` : 'Pluxel Workbench'
	}, [product])

	return <ProductContext.Provider value={product}>{children}</ProductContext.Provider>
}

export function useProduct(): ProductDescriptor | null {
	const product = useContext(ProductContext)
	if (product === undefined) throw new Error('useProduct() must be used within ProductProvider')
	return product
}
