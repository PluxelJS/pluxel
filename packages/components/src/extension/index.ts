// packages/components/src/extension/index.ts

// 类型
export type {
	CompiledExtensionBundle,
	ExtensionContext,
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
	loadPluginUI,
	unloadPluginUI,
	isPluginUILoaded,
	getLoadedModules,
	getRouteComponent,
	getExtensionRoutes,
	syncWithManifest,
	subscribeExtensionRouteChanges,
	getExtensionRouteVersion,
} from './runtime'

// Hooks
export {
	useExtensionManager,
	useExtensionRouteVersion,
	useExtensionVersion,
	usePluginUILoadState,
	type PluginInfo,
} from './hooks'

// Vendors (共享依赖)
export { vendors, initVendors, getVendor, vendorPackages, type Vendors, type VendorPackage } from './vendors'
