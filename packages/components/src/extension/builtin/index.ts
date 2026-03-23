import type { ReactNode } from 'react'
import type { BuiltinExtensionDef, BuiltinExtensionKind } from '@pluxel/runtime/web/extensions'
import { BuiltinDoc } from './Doc'

export { BuiltinDoc } from './Doc'

export const builtinComponents: Record<
	BuiltinExtensionKind,
	(props: { def: BuiltinExtensionDef }) => ReactNode
> = {
	doc: BuiltinDoc as any,
}
