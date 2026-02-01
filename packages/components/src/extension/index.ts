// packages/components/src/extension/index.ts

export { ExtensionErrorBoundary } from './ErrorBoundary'
// i18n (optional host service used by plugin ctx)
export { getExtensionI18nService, setExtensionLocale } from './internal/i18n'
// Hooks
export { useExtensionRuntimeVersion, useExtensionVersion } from './hooks'
// Paths (host routing conventions)
export {
	EXTENSION_ROUTE_PREFIX,
	EXTENSION_STANDALONE_ROUTE_PREFIX,
	type ExtensionFrame,
	type ExtensionRoutePrefix,
	buildExtensionHref,
	normalizeExtensionRouteSubPath,
} from './paths'
// Registry
export {
	ExtensionProvider,
	extensionRegistry,
	useExtensionContext,
	useExtensions,
} from './internal/registry'
// Runtime
export {
	getExtensionRuntimeRevision,
	getPluginRouteComponent,
	loadExtensionModule,
	subscribeExtensionRuntimeChanges,
	unloadExtensionModule,
} from './internal/runtime'

// 组件 & Slot helpers
export { ExtensionSlot } from './slots/ExtensionSlot'
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
	BuiltinDocBlock,
	BuiltinDocBlockKind,
	BuiltinDocContent,
	BuiltinDocExtensionDef,
	BuiltinDocPart,
	BuiltinInfoCardBlock,
	BuiltinInfoCardLayout,
	BuiltinInfoCardRow,
	BuiltinRpcArg,
	BuiltinRpcAutoFormBlock,
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
	doc,
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
