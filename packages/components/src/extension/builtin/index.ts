import type { ReactNode } from 'react'
import type { BuiltinExtensionDef, BuiltinExtensionKind, ExtensionContext } from '../types'
import { BuiltinDoc } from './Doc'

export { BuiltinDoc } from './Doc'

export const builtinComponents: Record<
	BuiltinExtensionKind,
	(props: { ctx: ExtensionContext; def: BuiltinExtensionDef }) => ReactNode
> = {
	doc: BuiltinDoc as any,
}
