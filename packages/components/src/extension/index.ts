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
	useGlobalExtensionContext,
	usePluginExtensionContext,
	useExtensionContext,
	useExtensionPathname,
} from '@pluxel/runtime/web'
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
	InteractionSessionComponent,
	InteractionSessionComponentProps,
	InteractionSessionPhase,
	PluginExtensionContext,
	PluginUIModule,
	RouteExtensionDef,
	UiConfirmPayload,
	UiConfirmTone,
	UiNotifyPayload,
	UiNotifyTone,
} from '@pluxel/runtime/web'
export type {
	BuiltinExtensionDef,
	BuiltinExtensionKind,
	ExtensionInteractionRecord,
	ExtensionInteractionState,
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
	BuiltinResourceSelectBlock,
	BuiltinFormBlock,
	InteractionCardinality,
	InteractionOfferDef,
	InteractionSessionDef,
	InteractionSurfaceDef,
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
	InteractionContract,
	InteractionContractRef,
} from '@pluxel/runtime/web/extensions'
export { defineInteractionContract } from '@pluxel/runtime/web/extensions'
export { extensionLocale } from './internal/locale'
export {
	extensionInteractionLabel,
	extensionInteractionReasonLabel,
	hasPluginExtensionDiagnostics,
	summarizePluginExtensionDiagnostics,
	type PluginExtensionDiagnosticsSnapshot,
	type PluginExtensionDiagnosticsSummary,
} from './diagnostics'
// Hooks
export {
	useExtensionModuleState,
	useExtensionModuleStates,
	useExtensionManifestDiagnostics,
	usePluginExtensionDiagnostics,
	usePluginUiStatus,
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
export { extensionRegistry, useExtensions } from './internal/registry'
// Runtime
export {
	getPluginUiRegistryRevision,
	getPluginUiRouteComponent,
	getPluginUiSessionComponent,
	loadPluginUiModule,
	subscribePluginUiRegistryChanges,
	unloadPluginUiModule,
} from './internal/pluginUiRegistry'
export { requestExtensionManifestSync } from './internal/runtime-state'
export { ensureExtensionFederationRuntime, loadFederatedExtensionModule } from './federationRuntime'

// 组件 & Slot helpers
export { ExtensionSlot } from './slots/ExtensionSlot'
export {
	type ExtensionSurfaceOptions,
	type ExtensionSurfaceRender,
	type ExtensionSurfaceRenderPayload,
	type ExtensionSurfaceResult,
	useExtensionSurface,
} from './slots/ExtensionSurface'
