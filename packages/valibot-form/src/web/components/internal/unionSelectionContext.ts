import { createContext } from 'react'

/** A visible union branch establishes its discriminator before descendants edit. */
export const UnionSelectionContext = createContext<(() => void) | undefined>(undefined)
