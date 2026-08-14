import { readProductDescriptor, type ProductDescriptor } from './product-contract'

export type { ProductDescriptor, ProductLegalLink } from './product-contract'

export function defineProduct(product: ProductDescriptor): ProductDescriptor {
	return readProductDescriptor(product, '[product]')
}
