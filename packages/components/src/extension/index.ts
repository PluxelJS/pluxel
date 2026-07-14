// Workbench-owned placement primitives used by the Workbench Plane renderer.
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
export type {
	ExtensionContext,
	ExtensionItem,
	ExtensionMeta,
	ExtensionPoint,
	ExtensionPointCtx,
	GlobalExtensionContext,
	PluginExtensionContext,
} from '@pluxel/runtime/web'
export { extensionLocale } from './internal/locale'
export {
	EXTENSION_ROUTE_PREFIX,
	EXTENSION_STANDALONE_ROUTE_PREFIX,
	type ExtensionFrame,
	type ExtensionRoutePrefix,
	buildExtensionHref,
	normalizeExtensionRouteSubPath,
} from './paths'
export { extensionRegistry, useExtensions } from './internal/registry'
export { ExtensionSlot } from './slots/ExtensionSlot'
export {
	type ExtensionSurfaceOptions,
	type ExtensionSurfaceRender,
	type ExtensionSurfaceRenderPayload,
	type ExtensionSurfaceResult,
	useExtensionSurface,
} from './slots/ExtensionSurface'
