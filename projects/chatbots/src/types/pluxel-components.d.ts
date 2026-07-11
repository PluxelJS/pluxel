import type { ComponentType } from 'react'

// @pluxel/components currently ships workspace source without an isolated public
// declaration entry. Keep the host coupled only to the App surface it consumes.
export const App: ComponentType
