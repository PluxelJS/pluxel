// packages/components/src/app/ExtensionLoader.tsx
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
	type BuiltinExtensionDef,
	type BuiltinExtensionKind,
	type CompiledExtensionModule,
	type ExtensionMeta,
	type ExtensionManifest,
	type ExtensionModuleState,
	type InteractionSessionDef,
	ExtensionErrorBoundary,
	extensionRegistry,
	getPluginUiSessionComponent,
	loadPluginUiModule,
	unloadPluginUiModule,
} from '../extension'
import { fetchExtensionManifest } from '../extension/api/manifest'
import { builtinComponents } from '../extension/builtin'
import { extLog } from '../extension/debug'
import { loadFederatedExtensionModule } from '../extension/federationRuntime'
import { InteractionSessionHost } from '../extension/session/InteractionSessionHost'
import {
	clearExtensionManifestDiagnostics,
	getExtensionManifestDiagnostics,
	getExtensionModuleStates,
	removeExtensionModuleState,
	replaceExtensionModuleStates,
	replaceExtensionManifestDiagnostics,
	setExtensionManifestSyncHandler,
	upsertExtensionModuleState,
} from '../extension/internal/runtime-state'
import { InlineNotice } from '../components'
import { usePluginOverview } from './plugins/pluginOverviewStore'
import { useRuntimeTransportClient } from '../runtime'

interface ExtensionLoaderProps {
	pollInterval?: number
	onRunningPluginsChange?: (plugins: ReadonlySet<string>) => void
	/** Keep extension modules loaded even when plugins stop running. */
	unloadOnStop?: boolean
	/** Delay unload when unloadOnStop is true, to avoid flapping. */
	unloadDelayMs?: number
}

interface PluginInfo {
	name: string
	isRunning: boolean
}

interface LoadedPluginModule extends CompiledExtensionModule {
	inflight?: Promise<void>
}

interface CachedRegistration {
	sig: string
	cleanup: () => void
}

const FAST_SYNC_POLL_MS = 1_000
const CONNECTED_RECONCILE_POLL_MS = 30_000
const POLL_URGENCY_WINDOW_MS = 15_000

const loaderState = {
	manifestVersion: 0,
	manifestSignature: '',
	loading: false,
	pendingForce: false,
	moduleCache: new Map<string, LoadedPluginModule>(),
	builtinCache: new Map<string, CachedRegistration>(),
	sessionCache: new Map<string, CachedRegistration>(),
	manifestBackoff: null as { at: number; backoffMs: number } | null,
	unloadTimers: new Map<string, ReturnType<typeof setTimeout>>(),
	sseConnected: false,
	pollUrgentUntil: 0,
}

const DEFAULT_UNLOAD_DELAY_MS = 8_000

function getSerializableSignature(value: unknown, fallback: string): string {
	try {
		return JSON.stringify(value)
	} catch {
		return fallback
	}
}

function getCachedRegistrationSignature(cache: Map<string, CachedRegistration>): string {
	return Array.from(cache.entries())
		.map(([key, value]) => `${key}:${value.sig}`)
		.sort()
		.join('|')
}

function getModuleStatesSignature(states: readonly ExtensionModuleState[]): string {
	return states
		.map((state) =>
			[
				state.pluginName,
				state.state,
				state.updatedAt,
				state.sourceHash ?? '',
				state.compiledAt ?? '',
				state.message ?? '',
			].join(':'),
		)
		.sort()
		.join('|')
}

function getManifestDiagnosticsSignature(
	snapshot: Pick<ExtensionManifest, 'interactions' | 'offers' | 'surfaces' | 'sessions'>,
): string {
	const interactionsSig = snapshot.interactions
		.map((item) =>
			[
				item.targetPlugin ?? '',
				item.surface ?? '',
				item.point,
				item.providerPlugin ?? '',
				item.offerId,
				item.state,
				item.reason ?? '',
			].join(':'),
		)
		.sort()
		.join('|')
	const offersSig = snapshot.offers
		.map((item) => [item.pluginName, item.point, item.id, item.renderKey].join(':'))
		.sort()
		.join('|')
	const surfacesSig = snapshot.surfaces
		.map((item) => [item.pluginName, item.point, item.id, item.required ? '1' : '0'].join(':'))
		.sort()
		.join('|')
	const sessionsSig = snapshot.sessions
		.map((item) => [item.pluginName, item.providerPluginName, item.point, item.id].join(':'))
		.sort()
		.join('|')
	return `${interactionsSig}||offers:${offersSig}||surfaces:${surfacesSig}||sessions:${sessionsSig}`
}

function getManifestPayloadSignature(
	payload: Pick<
		ExtensionManifest,
		'modules' | 'builtins' | 'sessions' | 'states' | 'interactions' | 'offers' | 'surfaces'
	>,
): string {
	const modulesSig = payload.modules
		.map((module) => `${module.pluginName}:${module.sourceHash}`)
		.sort()
		.join('|')
	const builtinsSig = payload.builtins
		.map((builtin) =>
			getSerializableSignature(
				builtin,
				[
					(builtin as any)?.kind ?? '',
					(builtin as any)?.pluginName ?? '',
					(builtin as any)?.point ?? '',
					(builtin as any)?.id ?? '',
				].join(':'),
			),
		)
		.sort()
		.join('|')
	const sessionsSig = payload.sessions
		.map((session) =>
			getSerializableSignature(
				session,
				`session:${session.pluginName ?? ''}:${session.point ?? ''}:${session.id ?? ''}`,
			),
		)
		.sort()
		.join('|')
	const statesSig = getModuleStatesSignature(payload.states)
	const diagnosticsSig = getManifestDiagnosticsSignature(payload)
	return `${modulesSig}||builtins:${builtinsSig}||sessions:${sessionsSig}||states:${statesSig}||diag:${diagnosticsSig}`
}

function clearCachedRegistration(
	cache: Map<string, CachedRegistration>,
	runtimeId: string,
	cached = cache.get(runtimeId),
): void {
	if (!cached) return
	try {
		cached.cleanup()
	} catch {}
	cache.delete(runtimeId)
}

function pruneCachedRegistrations(cache: Map<string, CachedRegistration>, seen: Set<string>): void {
	for (const runtimeId of Array.from(cache.keys())) {
		if (seen.has(runtimeId)) continue
		clearCachedRegistration(cache, runtimeId)
	}
}

function recomputeLoaderSignature() {
	const moduleSig = Array.from(loaderState.moduleCache.values())
		.map((mod) => `${mod.pluginName}:${mod.sourceHash}`)
		.sort()
		.join('|')
	const builtinSig = getCachedRegistrationSignature(loaderState.builtinCache)
	const sessionSig = getCachedRegistrationSignature(loaderState.sessionCache)
	const stateSig = getModuleStatesSignature(getExtensionModuleStates())
	const manifestDiagnostics = getManifestDiagnosticsSignature(getExtensionManifestDiagnostics())
	loaderState.manifestSignature = `${moduleSig}||builtins:${builtinSig}||sessions:${sessionSig}||states:${stateSig}||diag:${manifestDiagnostics}`
}

function cancelScheduledUnload(pluginName: string) {
	const timer = loaderState.unloadTimers.get(pluginName)
	if (!timer) return
	clearTimeout(timer)
	loaderState.unloadTimers.delete(pluginName)
}

function scheduleUnload(pluginName: string, delayMs: number, reason: string) {
	if (loaderState.unloadTimers.has(pluginName)) return
	const timer = setTimeout(() => {
		loaderState.unloadTimers.delete(pluginName)
		if (loaderState.moduleCache.has(pluginName)) {
			loaderState.moduleCache.delete(pluginName)
			unloadPluginUiModule(pluginName)
			extLog('unloaded %s (%s)', pluginName, reason)
			recomputeLoaderSignature()
		}
	}, delayMs)
	loaderState.unloadTimers.set(pluginName, timer)
}

function markPollingUrgent(durationMs = POLL_URGENCY_WINDOW_MS) {
	loaderState.pollUrgentUntil = Math.max(loaderState.pollUrgentUntil, Date.now() + durationMs)
}

function nextManifestSyncDelay(basePollInterval: number): number {
	const fallbackMs = Math.max(500, basePollInterval)
	const hasBuilding = getExtensionModuleStates().some((state) => state.state === 'building')
	if (hasBuilding || Date.now() < loaderState.pollUrgentUntil) {
		return Math.min(fallbackMs, FAST_SYNC_POLL_MS)
	}
	if (!loaderState.sseConnected) return fallbackMs
	return Math.max(fallbackMs * 6, CONNECTED_RECONCILE_POLL_MS)
}

function readyStateFromModule(module: CompiledExtensionModule): ExtensionModuleState {
	return {
		pluginName: module.pluginName,
		state: 'ready',
		updatedAt: module.compiledAt,
		sourceHash: module.sourceHash,
		compiledAt: module.compiledAt,
	}
}

export function ExtensionLoader({
	pollInterval = 5000,
	onRunningPluginsChange,
	unloadOnStop = false,
	unloadDelayMs = DEFAULT_UNLOAD_DELAY_MS,
}: ExtensionLoaderProps): null {
	const stream = useRuntimeTransportClient().sse
	const overviewState = usePluginOverview()
	const rawStatuses = overviewState.overview?.status?.statuses ?? []

	const derivedPlugins: PluginInfo[] = useMemo(() => {
		return rawStatuses
			.slice()
			.sort((a, b) => {
				const an = typeof a?.name === 'string' ? a.name : ''
				const bn = typeof b?.name === 'string' ? b.name : ''
				return an.localeCompare(bn)
			})
			.filter(
				(entry): entry is NonNullable<typeof entry> & { name: string } =>
					typeof entry?.name === 'string' && entry.name.trim().length > 0,
			)
			.map((entry) => ({
				name: entry.name.trim(),
				isRunning: Boolean(entry.isRunning),
			}))
	}, [rawStatuses])

	const signature = useMemo(
		() => derivedPlugins.map((p) => `${p.name}:${p.isRunning ? 1 : 0}`).join('|'),
		[derivedPlugins],
	)

	const cachedRef = useRef<{ key: string; plugins: PluginInfo[] }>({
		key: signature,
		plugins: derivedPlugins,
	})

	const [stablePlugins, setStablePlugins] = useState<PluginInfo[]>(derivedPlugins)
	const isLoading = overviewState.isLoading === true
	const hasError = !overviewState.hasSnapshot && Boolean(overviewState.error)
	const statusReadyRef = useRef(false)

	useEffect(() => {
		// IMPORTANT: during refetch/errors, GQty may temporarily surface empty arrays.
		// Never overwrite the stable snapshot with an "empty flash" (would break plugin pages).
		if (isLoading || hasError) return
		if (cachedRef.current.key === signature) {
			setStablePlugins(cachedRef.current.plugins)
			return
		}
		const cloned = derivedPlugins.map((plugin) => ({ ...plugin }))
		cachedRef.current = { key: signature, plugins: cloned }
		setStablePlugins(cloned)
	}, [derivedPlugins, hasError, signature, isLoading])

	const effectivePlugins = isLoading || hasError ? cachedRef.current.plugins : stablePlugins

	useEffect(() => {
		if (!isLoading && !hasError) {
			statusReadyRef.current = true
		}
	}, [hasError, isLoading])

	useEffect(() => {
		if (!onRunningPluginsChange) return
		const next = new Set<string>()
		for (const plugin of effectivePlugins) {
			if (plugin.isRunning && plugin.name) {
				next.add(plugin.name)
			}
		}
		onRunningPluginsChange(next)
	}, [effectivePlugins, onRunningPluginsChange])

	const shouldSkipManifestSync = useCallback(() => {
		const state = loaderState.manifestBackoff
		if (!state) return false
		return Date.now() - state.at < state.backoffMs
	}, [])

	const recomputeManifestSignature = useCallback(recomputeLoaderSignature, [])

	const syncBuiltins = useCallback((builtins?: BuiltinExtensionDef[]) => {
		extensionRegistry.batch(() => {
			const next = Array.isArray(builtins) ? builtins : []
			const seen = new Set<string>()

			for (const def of next) {
				if (!def || typeof def !== 'object') continue
				const pluginName =
					typeof (def as any).pluginName === 'string' ? (def as any).pluginName : ''
				const point = typeof (def as any).point === 'string' ? (def as any).point : ''
				const id = typeof (def as any).id === 'string' ? (def as any).id : ''
				const kind = typeof (def as any).kind === 'string' ? (def as any).kind : ''
				if (!pluginName || !point || !id || !kind) continue

				const runtimeId = `${pluginName}:builtin:${point}:${id}`
				seen.add(runtimeId)

				const sig = getSerializableSignature(def, `${kind}:${pluginName}:${point}:${id}`)

				const cached = loaderState.builtinCache.get(runtimeId)
				if (cached && cached.sig === sig) continue
				clearCachedRegistration(loaderState.builtinCache, runtimeId, cached)

				const meta: ExtensionMeta = {
					...(def as any).meta,
					id: runtimeId,
					pluginName,
					availabilityPluginName:
						typeof (def as any).availabilityPluginName === 'string'
							? (def as any).availabilityPluginName
							: typeof (def as any).sourcePluginName === 'string'
								? (def as any).sourcePluginName
								: pluginName,
					priority: typeof (def as any).priority === 'number' ? (def as any).priority : 0,
					requireRunning: (def as any).requireRunning ?? true,
				}

				const Component = builtinComponents[kind as BuiltinExtensionKind]
				if (!Component) {
					extLog('skip builtin kind=%s (id=%s)', kind, runtimeId)
					continue
				}

				const render = () => (
					<ExtensionErrorBoundary
						pluginName={pluginName}
						extensionId={runtimeId}
						point={point}
						fallback={
							process.env.NODE_ENV !== 'production'
								? ({ error }) => (
										<InlineNotice
											tone="error"
											title={
												<>
													Builtin render failed: {pluginName} · {point}
												</>
											}
										>
											{error?.message ?? String(error ?? 'unknown error')}
										</InlineNotice>
									)
								: null
						}
					>
						<Component def={def as any} />
					</ExtensionErrorBoundary>
				)

				const cleanup = extensionRegistry.register(point as any, { meta, render })
				loaderState.builtinCache.set(runtimeId, { sig, cleanup })
			}

			pruneCachedRegistrations(loaderState.builtinCache, seen)
		})
	}, [])

	const syncSessions = useCallback((sessions?: InteractionSessionDef[]) => {
		extensionRegistry.batch(() => {
			const next = Array.isArray(sessions) ? sessions : []
			const seen = new Set<string>()

			for (const def of next) {
				if (!def || typeof def !== 'object') continue
				const pluginName = typeof def.pluginName === 'string' ? def.pluginName : ''
				const point = typeof def.point === 'string' ? def.point : ''
				const id = typeof def.id === 'string' ? def.id : ''
				const sourcePlugin =
					typeof def.providerPluginName === 'string' ? def.providerPluginName : ''
				if (!pluginName || !point || !id) continue

				const runtimeId = `${pluginName}:session:${point}:${id}`
				seen.add(runtimeId)

				const sig = getSerializableSignature(def, `session:${pluginName}:${point}:${id}`)
				const cached = loaderState.sessionCache.get(runtimeId)
				if (cached && cached.sig === sig) continue
				clearCachedRegistration(loaderState.sessionCache, runtimeId, cached)

				const meta: ExtensionMeta = {
					...(def as any).meta,
					id: runtimeId,
					pluginName,
					availabilityPluginName: sourcePlugin || pluginName,
					priority: typeof def.priority === 'number' ? def.priority : 0,
					requireRunning: def.requireRunning ?? true,
				}

				const SessionComponent = sourcePlugin
					? getPluginUiSessionComponent(sourcePlugin, def.renderKey)
					: undefined
				const render = () => (
					<ExtensionErrorBoundary
						pluginName={pluginName}
						extensionId={runtimeId}
						point={point}
						fallback={
							process.env.NODE_ENV !== 'production'
								? ({ error }) => (
										<InlineNotice
											tone="error"
											title={
												<>
													Interaction session render failed: {pluginName} · {point}
												</>
											}
										>
											{error?.message ?? String(error ?? 'unknown error')}
										</InlineNotice>
									)
								: null
						}
					>
						{SessionComponent ? (
							<InteractionSessionHost session={def} component={SessionComponent} />
						) : (
							<InlineNotice
								title={
									<>
										Session UI not found: {sourcePlugin || 'unknown'} · {def.renderKey}
									</>
								}
							>
								Provider UI module did not expose the requested interaction session component.
							</InlineNotice>
						)}
					</ExtensionErrorBoundary>
				)

				const cleanup = extensionRegistry.register(point as any, { meta, render })
				loaderState.sessionCache.set(runtimeId, { sig, cleanup })
			}

			pruneCachedRegistrations(loaderState.sessionCache, seen)
		})
	}, [])

	// 插件停止后是否卸载扩展模块（避免频繁加载/卸载可延迟执行）
	useEffect(() => {
		if (!unloadOnStop) return
		if (!statusReadyRef.current) return
		const delayMs = Math.max(0, unloadDelayMs)
		const running = new Set<string>()
		for (const plugin of effectivePlugins) {
			if (plugin.isRunning && plugin.name) {
				running.add(plugin.name)
			}
		}

		for (const name of Array.from(loaderState.moduleCache.keys())) {
			if (!running.has(name)) {
				scheduleUnload(name, delayMs, 'plugin-stop')
			} else {
				cancelScheduledUnload(name)
			}
		}
		recomputeManifestSignature()
	}, [effectivePlugins, recomputeManifestSignature, unloadDelayMs, unloadOnStop])

	const ensureModuleLoaded = useCallback(async (module: CompiledExtensionModule) => {
		const cached = loaderState.moduleCache.get(module.pluginName)
		if (cached && cached.sourceHash === module.sourceHash) {
			if (cached.inflight) {
				await cached.inflight
			}
			cancelScheduledUnload(module.pluginName)
			return
		}

		extLog('loading %s@%s', module.pluginName, module.sourceHash)
		const loadPromise = loadPluginUiModule(
			module.pluginName,
			() => loadFederatedExtensionModule(module),
			module.sourceHash,
		)
		loaderState.moduleCache.set(module.pluginName, {
			...module,
			inflight: loadPromise,
		})

		try {
			await loadPromise
			cancelScheduledUnload(module.pluginName)
			upsertExtensionModuleState(readyStateFromModule(module))
			extLog('loaded %s@%s', module.pluginName, module.sourceHash)
		} catch (error) {
			loaderState.moduleCache.delete(module.pluginName)
			extLog('failed to load %s: %o', module.pluginName, error)
			throw error
		} finally {
			const latest = loaderState.moduleCache.get(module.pluginName)
			if (latest && latest.sourceHash === module.sourceHash) {
				latest.inflight = undefined
			}
		}
	}, [])

	const syncManifest = useCallback(
		async (force?: boolean) => {
			if (!force && shouldSkipManifestSync()) return
			if (loaderState.loading) {
				if (force) loaderState.pendingForce = true
				return
			}
			loaderState.loading = true
			try {
				extLog('fetching manifest')
				const manifest = await fetchExtensionManifest()
				loaderState.manifestBackoff = null
				extLog('fetched manifest v%d', manifest.version)

				const applyManifest = async (
					payload: typeof manifest,
					allowRetry: boolean,
				): Promise<{
					signature: string
					version: number
					moduleCount: number
					skipped: boolean
				}> => {
					const nextSignature = getManifestPayloadSignature(payload)
					if (
						!force &&
						payload.version === loaderState.manifestVersion &&
						nextSignature === loaderState.manifestSignature
					) {
						return {
							signature: nextSignature,
							version: payload.version,
							moduleCount: payload.modules.length,
							skipped: true,
						}
					}

					const failedPlugins: string[] = []
					const seen = new Set<string>()
					await Promise.all(
						payload.modules.map(async (module) => {
							seen.add(module.pluginName)
							try {
								await ensureModuleLoaded(module)
							} catch (error) {
								failedPlugins.push(module.pluginName)
								console.error('[ExtensionLoader] failed to load module', module.pluginName, error)
							}
						}),
					)

					replaceExtensionModuleStates(payload.states)
					replaceExtensionManifestDiagnostics({
						interactions: payload.interactions,
						offers: payload.offers,
						surfaces: payload.surfaces,
						sessions: payload.sessions,
					})
					syncBuiltins(payload.builtins)
					syncSessions(payload.sessions)

					// 自愈：如果加载失败（比如服务端删除了陈旧 hash 并触发重新编译），立刻刷新 manifest 再重试一次
					if (allowRetry && failedPlugins.length > 0) {
						const retryManifest = await fetchExtensionManifest()
						const retrySignature = getManifestPayloadSignature(retryManifest)
						if (retryManifest.version !== payload.version || retrySignature !== nextSignature) {
							return applyManifest(retryManifest, false)
						}
					}

					for (const name of Array.from(loaderState.moduleCache.keys())) {
						if (!seen.has(name)) {
							cancelScheduledUnload(name)
							loaderState.moduleCache.delete(name)
							unloadPluginUiModule(name)
						}
					}

					return {
						signature: nextSignature,
						version: payload.version,
						moduleCount: payload.modules.length,
						skipped: false,
					}
				}

				const applied = await applyManifest(manifest, true)
				if (applied.skipped) return

				loaderState.manifestVersion = applied.version
				loaderState.manifestSignature = applied.signature
				extLog('synced manifest v%d (%d modules)', applied.version, applied.moduleCount)
			} catch (error) {
				const now = Date.now()
				const prev = loaderState.manifestBackoff
				const backoffMs = prev ? Math.min(prev.backoffMs * 2, 60_000) : 2_000
				loaderState.manifestBackoff = { at: now, backoffMs }
				console.error('[ExtensionLoader] failed to sync manifest', error)
			} finally {
				loaderState.loading = false
				recomputeManifestSignature()
				if (loaderState.pendingForce) {
					loaderState.pendingForce = false
					queueMicrotask(() => {
						void syncManifest(true)
					})
				}
			}
		},
		[
			ensureModuleLoaded,
			recomputeManifestSignature,
			shouldSkipManifestSync,
			syncBuiltins,
			syncSessions,
		],
	)

	useEffect(() => {
		setExtensionManifestSyncHandler((force) => syncManifest(force))
		return () => {
			setExtensionManifestSyncHandler(null)
			clearExtensionManifestDiagnostics()
		}
	}, [syncManifest])

	useEffect(() => {
		let disposed = false
		let timer: ReturnType<typeof setTimeout> | null = null

		const clear = () => {
			if (!timer) return
			clearTimeout(timer)
			timer = null
		}

		const schedule = (delay: number) => {
			clear()
			if (disposed) return
			timer = setTimeout(
				() => {
					void run()
				},
				Math.max(0, delay),
			)
		}

		const run = async (): Promise<void> => {
			if (disposed) return
			await syncManifest().catch((): void => undefined)
			if (disposed || pollInterval <= 0) return
			schedule(nextManifestSyncDelay(pollInterval))
		}

		void run()
		return () => {
			disposed = true
			clear()
		}
	}, [pollInterval, syncManifest])

	useEffect(() => {
		if (typeof window === 'undefined') {
			return undefined
		}
		const offOpen = stream.onOpen(() => {
			loaderState.sseConnected = true
			markPollingUrgent()
			void syncManifest(true)
		})
		const offError = stream.onError(() => {
			loaderState.sseConnected = false
			markPollingUrgent()
		})
		const off = stream.extensions.on(({ payload }) => {
			if (!payload) return
			if (!('version' in payload)) return
			if (payload.type === 'sync') {
				if (payload.version > loaderState.manifestVersion) {
					markPollingUrgent()
					void syncManifest(true)
				}
				loaderState.manifestVersion = payload.version
				return
			}
			if (payload.version <= loaderState.manifestVersion) {
				return
			}
			loaderState.manifestVersion = payload.version

			if (payload.type === 'building') {
				markPollingUrgent()
				upsertExtensionModuleState({
					pluginName: payload.pluginName,
					state: 'building',
					updatedAt: payload.updatedAt,
					sourceHash: payload.sourceHash,
					compiledAt: payload.compiledAt,
				})
				recomputeManifestSignature()
				return
			}

			if (payload.type === 'error') {
				markPollingUrgent()
				upsertExtensionModuleState({
					pluginName: payload.pluginName,
					state: 'error',
					updatedAt: payload.updatedAt,
					sourceHash: payload.sourceHash,
					compiledAt: payload.compiledAt,
					message: payload.message,
				})
				recomputeManifestSignature()
				if (process.env.NODE_ENV !== 'production') {
					console.error('[ExtensionLoader] extension compile failed', {
						pluginName: payload.pluginName,
						message: payload.message,
					})
				}
				return
			}

			if (payload.type === 'update') {
				markPollingUrgent()
				upsertExtensionModuleState({
					pluginName: payload.pluginName,
					state: 'ready',
					updatedAt: payload.compiledAt,
					sourceHash: payload.sourceHash,
					compiledAt: payload.compiledAt,
				})
				recomputeManifestSignature()
				void ensureModuleLoaded({
					pluginName: payload.pluginName,
					remoteName: payload.remoteName,
					manifestUrl: payload.manifestUrl,
					exposedModule: payload.exposedModule,
					sourceHash: payload.sourceHash,
					compiledAt: payload.compiledAt,
				})
					.then(recomputeManifestSignature)
					.catch((error) => {
						if (process.env.NODE_ENV !== 'production') {
							console.error('[ExtensionLoader] failed to refresh module', payload.pluginName, error)
						}
					})
			} else if (payload.type === 'remove') {
				if (loaderState.moduleCache.has(payload.pluginName)) {
					cancelScheduledUnload(payload.pluginName)
					loaderState.moduleCache.delete(payload.pluginName)
					unloadPluginUiModule(payload.pluginName)
				}
				removeExtensionModuleState(payload.pluginName)
				recomputeManifestSignature()
			}
		})
		return () => {
			offOpen()
			offError()
			off()
		}
	}, [ensureModuleLoaded, recomputeManifestSignature, stream, syncManifest])

	return null
}
