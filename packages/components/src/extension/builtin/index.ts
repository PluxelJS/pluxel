import type { ReactNode } from 'react'
import type { BuiltinExtensionDef, BuiltinExtensionKind } from '@pluxel/runtime/web/extensions'
import { BuiltinDoc } from './Doc'
export { BuiltinResourceSelect } from './ResourceSelect'

export { BuiltinDoc } from './Doc'

export const builtinComponents: Partial<
	Record<BuiltinExtensionKind, (props: { def: BuiltinExtensionDef }) => ReactNode>
> = {
	doc: BuiltinDoc as any,
}
