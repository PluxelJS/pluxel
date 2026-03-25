import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { isAbsolute, resolve } from 'pathe'
import { build as runTsdown, defineConfig, type InlineConfig } from 'tsdown'
import type { BuildLogger, BuildRuntimeConfig, BuildSuccessHook } from './types'

type SuccessArgs = Parameters<BuildSuccessHook>

export interface TsdownRunnerOptions {
	context: BuildRuntimeConfig
	onSuccess: BuildSuccessHook
	log: BuildLogger
	extraConfig?: TsdownOverride
}

export async function runWithTsdown(options: TsdownRunnerOptions) {
	const debugEnabled = Boolean(options.context.debug)
	const sources = await resolveConfigSources(options)
	const mergedOverrides = mergeInlineConfigs(sources.userOverrides ?? {}, sources.cliOverrides)
	const configPlan = buildInlineConfig(mergedOverrides, options)

	emitDebugInfo({
		enabled: debugEnabled,
		log: options.log,
		context: options.context,
		hasUserOverrides: Boolean(sources.userOverrides),
		hasCliOverrides: Boolean(sources.cliOverrides),
		userSource: sources.userSource,
		inlineConfig: configPlan.inlineConfig,
		plugins: configPlan.plugins,
		hasUserOnSuccess: configPlan.hasUserOnSuccess,
		hasCombinedOnSuccess: configPlan.hasCombinedOnSuccess,
		hasBaseOnSuccess: Boolean(options.onSuccess),
	})

	const bundles = await runTsdown(configPlan.inlineConfig)

	if (!options.context.watch && configPlan.onSuccess) {
		const controller = new AbortController()
		for (const bundle of bundles) {
			await configPlan.onSuccess(bundle.config, controller.signal)
			if (controller.signal.aborted) break
		}
	}
}

interface ResolvedConfigSources {
	userOverrides?: InlineConfig
	userSource?: string
	cliOverrides?: InlineConfig
}

async function resolveConfigSources(options: TsdownRunnerOptions): Promise<ResolvedConfigSources> {
	const userConfig = await loadUserOverrides(options.context, options.log)
	return {
		userOverrides: userConfig?.config,
		userSource: userConfig?.source,
		cliOverrides: await resolveOverride(options.extraConfig, options.context),
	}
}

interface InlineConfigBuildResult {
	inlineConfig: InlineConfig
	plugins?: InlineConfig['plugins']
	onSuccess?: BuildSuccessHook
	hasUserOnSuccess: boolean
	hasCombinedOnSuccess: boolean
}

function buildInlineConfig(
	mergedOverrides: InlineConfig,
	options: TsdownRunnerOptions,
): InlineConfigBuildResult {
	const {
		onSuccess: overrideOnSuccess,
		watch: _overrideWatch,
		plugins,
		...restOverrides
	} = mergedOverrides
	const combinedOnSuccess = combineOnSuccess(options.onSuccess, overrideOnSuccess, options.log)
	const mergedPlugins = mergePlugins(plugins)

	return {
		inlineConfig: defineConfig({
			...restOverrides,
			plugins: mergedPlugins,
			cwd: restOverrides.cwd ?? options.context.projectRoot,
			watch: options.context.watch,
			...(options.context.watch && combinedOnSuccess ? { onSuccess: combinedOnSuccess } : {}),
		}),
		plugins: mergedPlugins,
		onSuccess: combinedOnSuccess,
		hasUserOnSuccess: Boolean(overrideOnSuccess),
		hasCombinedOnSuccess: Boolean(combinedOnSuccess),
	}
}

interface LoadedUserConfig {
	source: string
	config: InlineConfig
}

async function loadUserOverrides(
	context: BuildRuntimeConfig,
	log: BuildLogger,
): Promise<LoadedUserConfig | undefined> {
	const overridePath = context.tsdownConfigPath
	if (!overridePath) return undefined

	const resolved = isAbsolute(overridePath)
		? overridePath
		: resolve(context.projectRoot, overridePath)
	const moduleUrl = pathToFileURL(resolved).href

	try {
		const mod = await import(moduleUrl)
		const source = normalizeOverride(mod?.default ?? mod?.config ?? mod?.tsdown ?? mod)
		if (!source) {
			throw new Error('tsdown override must export a single config object or async function')
		}
		const resolvedConfig = await resolveOverride(source, context)
		if (resolvedConfig && isPlainObject(resolvedConfig)) {
			log(`[build] loaded tsdown overrides from ${resolved}`)
			return { source: resolved, config: resolvedConfig }
		}
		throw new Error('tsdown override must resolve to a single plain config object')
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error)
		throw new Error(`Failed to load tsdown override at ${resolved}: ${reason}`)
	}
}

type TsdownOverride =
	| InlineConfig
	| ((context: BuildRuntimeConfig) => InlineConfig | Promise<InlineConfig>)

type TsdownDepsConfig = NonNullable<InlineConfig['deps']>
type NeverBundleValue = TsdownDepsConfig['neverBundle']
type AlwaysBundleValue = TsdownDepsConfig['alwaysBundle']
type OnlyBundleValue = TsdownDepsConfig['onlyBundle']
type BundleMatchFn = (...args: any[]) => boolean | null | undefined | void
const DEPRECATED_DEPS_KEYS = ['external', 'noExternal', 'inlineOnly'] as const

function normalizeOverride(input: unknown): TsdownOverride | undefined {
	if (!input) return undefined
	if (typeof input === 'function') return input as TsdownOverride
	if (isPlainObject(input)) return input as InlineConfig
	return undefined
}

async function resolveOverride(
	override: TsdownOverride | undefined,
	context: BuildRuntimeConfig,
): Promise<InlineConfig | undefined> {
	if (!override) return undefined
	return typeof override === 'function' ? await override(context) : override
}

const SPECIAL_KEYS = new Set(['plugins', 'deps'])

function mergeInlineConfigs(user: InlineConfig, overlay: InlineConfig | undefined) {
	assertNoDeprecatedDepsKeys(user, 'tsdown user override')
	if (!overlay) return { ...user }

	assertNoDeprecatedDepsKeys(overlay, 'tsdown overlay')
	const merged: InlineConfig = { ...user }
	applyOverlay(merged as Record<string, unknown>, overlay as Record<string, unknown>)
	merged.plugins = mergePlugins(user.plugins, overlay.plugins)
	merged.deps = mergeDeps(user.deps, overlay.deps)
	return merged
}

function assertNoDeprecatedDepsKeys(config: InlineConfig, label: string) {
	const deprecated = DEPRECATED_DEPS_KEYS.filter((key) => key in config)
	if (deprecated.length === 0) return
	throw new Error(
		`${label} must use deps.* keys only; found deprecated keys: ${deprecated.join(', ')}`,
	)
}

function applyOverlay(target: Record<string, unknown>, overlay: Record<string, unknown>) {
	for (const [key, value] of Object.entries(overlay)) {
		if (value === undefined || SPECIAL_KEYS.has(key)) continue
		const current = target[key]
		if (isPlainObject(current) && isPlainObject(value)) {
			target[key] = { ...(current as Record<string, unknown>) }
			applyOverlay(target[key] as Record<string, unknown>, value as Record<string, unknown>)
		} else {
			target[key] = value
		}
	}
}

function mergeDeps(
	userDeps: InlineConfig['deps'],
	overlayDeps: InlineConfig['deps'],
): InlineConfig['deps'] | undefined {
	if (!overlayDeps) return userDeps
	if (!userDeps) return overlayDeps

	return {
		...userDeps,
		...overlayDeps,
		neverBundle: mergeBundleMatchers(userDeps.neverBundle, overlayDeps.neverBundle),
		alwaysBundle: mergeBundleMatchers(userDeps.alwaysBundle, overlayDeps.alwaysBundle),
		onlyBundle: mergeOnlyBundle(userDeps.onlyBundle, overlayDeps.onlyBundle),
	}
}

function mergePlugins(
	...sources: Array<InlineConfig['plugins'] | undefined>
): InlineConfig['plugins'] | undefined {
	const list: any[] = []
	for (const source of sources) {
		if (!source) continue
		if (Array.isArray(source)) list.push(...source)
		else list.push(source)
	}
	return list.length > 0 ? list : undefined
}

function mergeBundleMatchers<T extends NeverBundleValue | AlwaysBundleValue>(
	userValue: T | undefined,
	overlayValue: T | undefined,
): T | undefined {
	if (!overlayValue) return userValue
	if (!userValue) return overlayValue

	const overlayIsFn = isBundleMatchFn(overlayValue)
	const userIsFn = isBundleMatchFn(userValue)
	if (!overlayIsFn && !userIsFn) {
		return [...toBundlePatternArray(userValue), ...toBundlePatternArray(overlayValue)] as T
	}

	const overlayFn = overlayIsFn ? overlayValue : createBundleMatcher(overlayValue)
	const userFn = userIsFn ? userValue : createBundleMatcher(userValue)
	return ((...args: any[]) =>
		Boolean((overlayFn?.(...args) ?? false) || (userFn?.(...args) ?? false))) as T
}

function createBundleMatcher(
	patterns: Exclude<NeverBundleValue | AlwaysBundleValue, BundleMatchFn | undefined>,
): BundleMatchFn {
	const normalized = toBundlePatternArray(patterns)
	return (id: string) => normalized.some((pattern) => matchExternalPattern(pattern, id))
}

function toBundlePatternArray(
	patterns: Exclude<NeverBundleValue | AlwaysBundleValue, BundleMatchFn | undefined>,
): Array<string | RegExp> {
	return Array.isArray(patterns) ? patterns : [patterns]
}

function matchExternalPattern(pattern: string | RegExp, id: string) {
	return pattern instanceof RegExp ? pattern.test(id) : pattern === id
}

function mergeOnlyBundle(
	userValue: OnlyBundleValue,
	overlayValue: OnlyBundleValue,
): OnlyBundleValue | undefined {
	if (overlayValue === undefined) return userValue
	if (userValue === undefined) return overlayValue
	if (overlayValue === false || userValue === false) return false
	return [...toOnlyBundleArray(userValue), ...toOnlyBundleArray(overlayValue)]
}

function toOnlyBundleArray(
	value: Exclude<OnlyBundleValue, false | undefined>,
): Array<string | RegExp> {
	return Array.isArray(value) ? value : [value]
}

function isBundleMatchFn(value: unknown): value is BundleMatchFn {
	return typeof value === 'function'
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

type OnSuccessOverride = InlineConfig['onSuccess']

function combineOnSuccess(
	baseHook: BuildSuccessHook,
	overrideHook: OnSuccessOverride | undefined,
	log: BuildLogger,
): BuildSuccessHook | undefined {
	const normalizedOverride = normalizeOnSuccess(overrideHook, log)
	if (!baseHook && !normalizedOverride) return undefined
	if (!normalizedOverride) return baseHook
	if (!baseHook) return normalizedOverride

	return async (config, signal) => {
		await baseHook(config, signal)
		if (!signal.aborted) {
			await normalizedOverride(config, signal)
		}
	}
}

function normalizeOnSuccess(
	hook: OnSuccessOverride | undefined,
	log: BuildLogger,
): BuildSuccessHook | undefined {
	if (!hook) return undefined
	if (typeof hook === 'string') {
		return (_config: SuccessArgs[0], signal: SuccessArgs[1]) => runShellCommand(hook, signal, log)
	}

	return async (config: SuccessArgs[0], signal: SuccessArgs[1]) => {
		await hook(config, signal)
	}
}

async function runShellCommand(command: string, signal: AbortSignal, log: BuildLogger) {
	log(`[build] exec: ${command}`)
	return new Promise<void>((resolvePromise, reject) => {
		const child = spawn(command, {
			shell: true,
			stdio: 'inherit',
			env: process.env,
		})

		const abort = () => {
			if (child.killed) return
			child.kill()
		}

		signal.addEventListener('abort', abort, { once: true })
		child.on('exit', (code) => {
			signal.removeEventListener('abort', abort)
			if (code === 0) resolvePromise()
			else reject(new Error(`Command "${command}" failed with exit code ${code ?? 'unknown'}`))
		})
		child.on('error', (error) => {
			signal.removeEventListener('abort', abort)
			reject(error)
		})
	})
}

interface DebugInfoArgs {
	enabled: boolean
	log: BuildLogger
	context: BuildRuntimeConfig
	hasUserOverrides: boolean
	userSource?: string
	hasCliOverrides: boolean
	inlineConfig: InlineConfig
	plugins?: InlineConfig['plugins']
	hasUserOnSuccess: boolean
	hasCombinedOnSuccess: boolean
	hasBaseOnSuccess: boolean
}

function emitDebugInfo(args: DebugInfoArgs) {
	if (!args.enabled) return
	const snapshot = createDebugSnapshot(args)
	const formatted = JSON.stringify(snapshot, null, 2)
	args.log(`[build] tsdown config snapshot:\n${formatted}`)
}

interface TsdownDebugSnapshot {
	projectRoot: string
	cwd?: string
	watch?: boolean
	overridePath?: string
	overrides: {
		userConfig: boolean
		userSource?: string
		cliOverlay: boolean
	}
	hooks: {
		base: boolean
		user: boolean
		final: boolean
	}
	tsdown: ReturnType<typeof summarizeInlineConfig>
}

function createDebugSnapshot(args: DebugInfoArgs): TsdownDebugSnapshot {
	return {
		projectRoot: args.context.projectRoot,
		cwd: args.inlineConfig.cwd,
		watch: Boolean(args.inlineConfig.watch),
		overridePath: args.context.tsdownConfigPath,
		overrides: {
			userConfig: args.hasUserOverrides,
			userSource: args.userSource,
			cliOverlay: args.hasCliOverrides,
		},
		hooks: {
			base: args.hasBaseOnSuccess,
			user: args.hasUserOnSuccess,
			final: args.hasCombinedOnSuccess,
		},
		tsdown: summarizeInlineConfig(args.inlineConfig, args.plugins),
	}
}

function summarizeInlineConfig(config: InlineConfig, plugins?: InlineConfig['plugins']) {
	return {
		entry: sanitizeDebugValue(config.entry),
		format: sanitizeDebugValue(config.format),
		target: sanitizeDebugValue(config.target),
		dts: sanitizeDebugValue(config.dts),
		tsconfig: sanitizeDebugValue(config.tsconfig),
		env: sanitizeDebugValue(config.env),
		minify: sanitizeDebugValue(config.minify),
		treeshake: sanitizeDebugValue(config.treeshake),
		copy: sanitizeDebugValue(config.copy),
		clean: sanitizeDebugValue(config.clean),
		sourcemap: sanitizeDebugValue(config.sourcemap),
		deps: describeDeps(config.deps),
		plugins: describePlugins(plugins),
	}
}

function describeDeps(value: InlineConfig['deps']) {
	if (!value) return {}
	return {
		alwaysBundle: describeBundleMatcher(value.alwaysBundle),
		neverBundle: describeBundleMatcher(value.neverBundle),
		onlyBundle:
			value.onlyBundle === false
				? false
				: value.onlyBundle
					? (Array.isArray(value.onlyBundle) ? value.onlyBundle : [value.onlyBundle]).map((item) =>
							sanitizeDebugValue(item),
						)
					: undefined,
		skipNodeModulesBundle: sanitizeDebugValue(value.skipNodeModulesBundle),
	}
}

function describeBundleMatcher(value: NeverBundleValue | AlwaysBundleValue) {
	if (!value) return []
	if (typeof value === 'function') return ['[function matcher]']
	const list = Array.isArray(value) ? value : [value]
	return list.map((item) => (item instanceof RegExp ? item.toString() : String(item)))
}

function describePlugins(plugins: InlineConfig['plugins']) {
	if (!plugins) return []
	const list = Array.isArray(plugins) ? plugins : [plugins]
	return list.map((plugin, index) => {
		if (!plugin) return { name: `plugin-${index + 1}`, type: typeof plugin }
		if (typeof plugin === 'function') {
			return { name: plugin.name || `plugin-${index + 1}`, type: 'function' }
		}
		if (typeof plugin === 'string') return { name: plugin }
		if (typeof plugin !== 'object') return { name: `plugin-${index + 1}`, type: typeof plugin }
		const name =
			typeof (plugin as { name?: unknown }).name === 'string' &&
			(plugin as { name?: string }).name?.length
				? (plugin as { name: string }).name
				: `plugin-${index + 1}`
		const enforce =
			typeof (plugin as { enforce?: unknown }).enforce === 'string'
				? (plugin as { enforce: string }).enforce
				: undefined
		return enforce ? { name, enforce } : { name }
	})
}

function sanitizeDebugValue<T>(value: T): unknown {
	return cloneValue(value, new WeakSet())
}

function cloneValue(value: unknown, seen: WeakSet<object>): unknown {
	if (value === null) return null
	if (typeof value === 'undefined') return undefined
	if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean')
		return value
	if (typeof value === 'function') return '[function]'
	if (value instanceof RegExp) return value.toString()
	if (Array.isArray(value)) {
		return value.map((item) => cloneValue(item, seen))
	}
	if (typeof value === 'object') {
		if (seen.has(value as object)) return '[circular]'
		seen.add(value as object)
		const result: Record<string, unknown> = {}
		for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
			result[key] = cloneValue(entry, seen)
		}
		return result
	}
	return String(value)
}
