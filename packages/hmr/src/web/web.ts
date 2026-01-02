/**
 * Plugin UI SDK (curated).
 *
 * This module is the recommended *single* import surface for UI bundles:
 * - It loads the necessary type augmentations (HMR services + UI rpc/sse namespaces).
 * - It re-exports the minimal authoring API (`definePluginUIModule`, `ExtensionPoints`, `useExtensionContext`, …).
 * - It intentionally avoids exposing low-level clients/hooks (plugins should use `ctx.services` instead).
 */

// Type-only import: ensure @pluxel/hmr/services module augmentations are loaded
// whenever users import from `@pluxel/hmr/web`.
import type {} from '../services'
// Type-only import: ensure `@pluxel/hmr-web` service augmentations are loaded
// so `ctx.services.hmr` is typed for UI bundles.
import type {} from '@pluxel/hmr-web'
import type { ReactNode } from 'react'
import * as HmrWeb from '@pluxel/hmr-web'

// UI module authoring (stable public surface)
export const ExtensionPoints = HmrWeb.ExtensionPoints
export const defineDocBlocks = HmrWeb.defineDocBlocks
export const blockRef = HmrWeb.blockRef
export const md = HmrWeb.md
export const useExtensionContext = HmrWeb.useExtensionContext

export type ExtensionContext = HmrWeb.ExtensionContext
export type GlobalExtensionContext = HmrWeb.GlobalExtensionContext
export type PluginExtensionContext = HmrWeb.PluginExtensionContext
export interface ExtensionServices extends HmrWeb.ExtensionServices {}
export type PluginI18nBundle = HmrWeb.PluginI18nBundle
export type UiNotifyPayload = HmrWeb.UiNotifyPayload
export type UiNotifyTone = HmrWeb.UiNotifyTone
export type UiConfirmPayload = HmrWeb.UiConfirmPayload
export type UiConfirmTone = HmrWeb.UiConfirmTone
export type PackageMutationAction = HmrWeb.PackageMutationAction
export type PackageSpecInput = HmrWeb.PackageSpecInput
export type PackageIssueSpec = HmrWeb.PackageIssueSpec
export type PackageLoadIssue = HmrWeb.PackageLoadIssue
export type PackageInventoryEntry = HmrWeb.PackageInventoryEntry
export type PackageInventoryFilter = HmrWeb.PackageInventoryFilter
export type PackageMutationInput = HmrWeb.PackageMutationInput
export type PackageMutationResult = HmrWeb.PackageMutationResult
export type PackageBatchResult = HmrWeb.PackageBatchResult

export interface ExtensionPointMap extends HmrWeb.ExtensionPointMap {}
export type ExtensionPoint = keyof ExtensionPointMap & string
export type ExtensionPointCtx<P extends ExtensionPoint> = ExtensionPointMap[P]['ctx']
export type ExtensionPointMeta<P extends ExtensionPoint> = ExtensionPointMap[P]['meta']

type MetaProp<P extends ExtensionPoint> = ExtensionPointMap[P] extends { metaRequired: true }
	? { meta: ExtensionPointMeta<P> }
	: { meta?: ExtensionPointMeta<P> }

export type ExtensionDef<P extends ExtensionPoint = ExtensionPoint> = {
	point: P
	id: string
	priority?: number
	requireRunning?: boolean
	render: (ctx: ExtensionPointCtx<P>) => ReactNode
} & MetaProp<P>

export type AnyExtensionDef = { [P in ExtensionPoint]: ExtensionDef<P> }[ExtensionPoint]

export interface RouteExtensionDef {
	path: string
	title: string
	icon?: string | ReactNode
	addToNav?: boolean
	navPriority?: number
}

export interface PluginUIModule {
	extensions?: AnyExtensionDef[]
	routes?: Array<{
		definition: RouteExtensionDef
		render: (ctx: PluginExtensionContext) => ReactNode
	}>
	i18n?: PluginI18nBundle | PluginI18nBundle[]
	setup?: (ctx: { pluginName: string }) => void | (() => void) | Promise<void | (() => void)>
}

export function definePluginUIModule<T extends PluginUIModule>(module: T): T {
	return HmrWeb.definePluginUIModule(module as unknown as HmrWeb.PluginUIModule) as T
}

// HMR helpers (curated: plugins should use ctx.services.hmr for RPC/SSE).
export const rpcErrorMessage = HmrWeb.rpcErrorMessage
