// packages/components/src/extension/index.ts

// 类型
export type {
	CompiledExtensionModule,
	ExtensionContext,
	ExtensionManifestEvent,
	ExtensionManifest,
	ExtensionMeta,
	ExtensionPoint,
	ExtensionItem,
	PluginUIModule,
	RouteExtensionDef,
} from './types'
export { ExtensionPoints } from './types'

// Registry
export {
	extensionRegistry,
	ExtensionProvider,
	useExtensionContext,
	useExtensionContextMaybe,
	useExtensions,
	useExtensionsWithContext,
	useRegisterExtension,
} from './registry'

// 组件 & Slot helpers
export { ExtensionSlot, ExtensionSlotRender } from './slots/ExtensionSlot'
export {
	useExtensionSurface,
	type ExtensionSurfaceOptions,
	type ExtensionSurfaceRender,
	type ExtensionSurfaceRenderPayload,
	type ExtensionSurfaceResult,
} from './slots/ExtensionSurface'
export { ExtensionErrorBoundary } from './ErrorBoundary'

// Runtime
export {
	getPluginRouteComponent,
	getExtensionRuntimeRevision,
	subscribeExtensionRuntimeChanges,
	loadExtensionModule,
	unloadExtensionModule,
} from './runtime'

// Hooks
export { useExtensionRuntimeVersion, useExtensionVersion } from './hooks'

// Vendors (共享依赖)
export {
	vendors,
	initVendors,
	getVendor,
	vendorPackages,
	type Vendors,
	type VendorPackage,
} from './vendors'
