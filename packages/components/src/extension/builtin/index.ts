import type { ReactNode } from 'react'
import type { BuiltinExtensionDef, BuiltinExtensionKind, ExtensionContext } from '../types'
import { BuiltinInfoCard } from './InfoCard'
import { BuiltinRpcAutoForm } from './RpcAutoForm'

export { BuiltinInfoCard } from './InfoCard'
export { BuiltinRpcAutoForm } from './RpcAutoForm'

export const builtinComponents: Record<
	BuiltinExtensionKind,
	(props: { ctx: ExtensionContext; def: BuiltinExtensionDef }) => ReactNode
> = {
	infoCard: BuiltinInfoCard as any,
	rpcAutoForm: BuiltinRpcAutoForm as any,
}
