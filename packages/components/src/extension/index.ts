// packages/components/src/extension/index.ts

export { ExtensionErrorBoundary } from './ErrorBoundary'
// Hooks
export { useExtensionRuntimeVersion, useExtensionVersion } from './hooks'
// Registry
export {
	ExtensionProvider,
	extensionRegistry,
	useExtensionContext,
	useExtensionContextMaybe,
	useExtensions,
	useExtensionsWithContext,
	useRegisterExtension,
} from './registry'
// Runtime
export {
	getExtensionRuntimeRevision,
	getPluginRouteComponent,
	loadExtensionModule,
	subscribeExtensionRuntimeChanges,
	unloadExtensionModule,
} from './runtime'

// 组件 & Slot helpers
export { ExtensionSlot, ExtensionSlotRender } from './slots/ExtensionSlot'
export {
	type ExtensionSurfaceOptions,
	type ExtensionSurfaceRender,
	type ExtensionSurfaceRenderPayload,
	type ExtensionSurfaceResult,
	useExtensionSurface,
} from './slots/ExtensionSurface'
// 类型
export type {
	AnyExtensionDef,
	BuiltinExtensionBase,
	BuiltinExtensionDef,
	BuiltinExtensionKind,
	BuiltinInfoCardExtensionDef,
	BuiltinInfoCardRow,
	BuiltinRpcArg,
	BuiltinSseRef,
	BuiltinValue,
	CompiledExtensionModule,
	ExtensionContext,
	ExtensionDef,
	ExtensionItem,
	ExtensionManifest,
	ExtensionManifestEvent,
	ExtensionMeta,
	ExtensionPoint,
	ExtensionPointCtx,
	ExtensionPointMap,
	ExtensionPointMeta,
	GlobalExtensionContext,
	PluginExtensionContext,
	PluginUIModule,
	RouteExtensionDef,
	UiConfirmPayload,
	UiConfirmTone,
	UiNotifyPayload,
	UiNotifyTone,
} from './types'
export {
	createGlobalExtensionContext,
	createPluginExtensionContext,
	ExtensionPoints,
	isExtensionPluginRunning,
	toGlobalExtensionContext,
} from './types'

// Vendors (共享依赖)
export {
	getVendor,
	initVendors,
	type VendorPackage,
	type Vendors,
	vendorPackages,
	vendors,
} from './vendors'
