// packages/components/src/extension/index.ts

export { ExtensionErrorBoundary } from './ErrorBoundary'
export {
	createGlobalExtensionContext,
	ExtensionPathnameProvider,
	createPluginExtensionContext,
	ExtensionPoints,
	ExtensionProvider,
	isExtensionPluginRunning,
	toGlobalExtensionContext,
	useExtensionContext,
	useExtensionPathname,
} from '@pluxel/runtime/web/ui'
export { doc } from '@pluxel/runtime/web/extensions'
export type {
	AnyExtensionDef,
	ExtensionContext,
	ExtensionDef,
	ExtensionItem,
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
} from '@pluxel/runtime/web/ui'
export type {
	BuiltinExtensionBase,
	BuiltinExtensionDef,
	BuiltinExtensionKind,
	BuiltinFieldValueRef,
	BuiltinGeneratedIdValue,
	BuiltinDocBlock,
	BuiltinDocBlockKind,
	BuiltinDocContent,
	BuiltinDocExtensionDef,
	BuiltinDocPart,
	BuiltinInfoCardBlock,
	BuiltinInfoCardLayout,
	BuiltinInfoCardRow,
	BuiltinNowValue,
	BuiltinActionBlock,
	BuiltinFormBlock,
	BuiltinSignalDbRef,
	BuiltinSignalDbWriteMode,
	BuiltinSignalDbWriteSpec,
	BuiltinSyncRef,
	BuiltinTemplateValue,
	BuiltinValue,
	CompiledExtensionModule,
	ExtensionManifest,
	ExtensionManifestEvent,
	ExtensionModuleState,
	ExtensionModuleStateKind,
} from '@pluxel/runtime/web/extensions'
export { extensionLocale } from './internal/locale'
// Hooks
export {
	useExtensionModuleState,
	useExtensionModuleStates,
	usePluginUiVersion,
} from './hooks'
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
	extensionRegistry,
	useExtensions,
} from './internal/registry'
// Runtime
export {
	getPluginUiRegistryRevision,
	getPluginUiRouteComponent,
	loadPluginUiModule,
	subscribePluginUiRegistryChanges,
	unloadPluginUiModule,
} from './internal/pluginUiRegistry'
export { requestExtensionManifestSync } from './internal/module-state'
export {
	ensureExtensionFederationRuntime,
	loadFederatedExtensionModule,
} from './federationRuntime'

// 组件 & Slot helpers
export { ExtensionSlot } from './slots/ExtensionSlot'
export {
	type ExtensionSurfaceOptions,
	type ExtensionSurfaceRender,
	type ExtensionSurfaceRenderPayload,
	type ExtensionSurfaceResult,
	useExtensionSurface,
} from './slots/ExtensionSurface'
