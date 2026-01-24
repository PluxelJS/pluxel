import { AsyncLocalStorage } from 'node:async_hooks'
import { Module as NodeModule } from 'node:module'

export type RuntimeShimConfig =
	| true
	| {
			/**
			 * Source code returned by Vite plugin `load()`.
			 * Defaults to `export {}` (an empty ESM module).
			 */
			code?: string
			/**
			 * Controls Vite's `moduleSideEffects` hint for the resolved virtual module.
			 * Defaults to `false` to allow safe skipping by optimizers.
			 */
			moduleSideEffects?: boolean
			/**
			 * Exports returned when the module is loaded via CommonJS `require()`.
			 * Defaults to `{}`.
			 */
			exports?: any
	  }
	| false

export interface RuntimeShimRegistryInput {
	/**
	 * Sugar for:
	 * - `reflect-metadata` -> empty module
	 * - `reflect-metadata/*` -> empty module
	 */
	shimReflectMetadata?: boolean
	/**
	 * Map specifier to shim config.
	 * - exact match: `reflect-metadata`
	 * - prefix match: `reflect-metadata/*` matches `reflect-metadata/anything`
	 */
	shims?: Record<string, RuntimeShimConfig>
}

type ShimKind = 'exact' | 'prefix'
type ShimRule = {
	kind: ShimKind
	match: string
	virtualId: string
	code: string
	moduleSideEffects: boolean
	cjsExports: any
}

export class RuntimeShimRegistry {
	private readonly rules: ShimRule[]
	private readonly byVirtualId: Map<string, ShimRule>
	private readonly exact: Map<string, ShimRule>
	private readonly prefix: ShimRule[]

	constructor(input: RuntimeShimRegistryInput | undefined) {
		this.rules = buildShimRules(input)
		this.byVirtualId = new Map(this.rules.map((r) => [r.virtualId, r]))
		this.exact = new Map(this.rules.filter((r) => r.kind === 'exact').map((r) => [r.match, r]))
		this.prefix = this.rules.filter((r) => r.kind === 'prefix')
	}

	resolveId(id: string) {
		// If a virtual id is already requested, keep it stable.
		if (this.byVirtualId.has(id)) return { id }

		const rule = this.match(id)
		if (!rule) return null
		return { id: rule.virtualId, moduleSideEffects: rule.moduleSideEffects }
	}

	load(id: string) {
		return this.byVirtualId.get(id)?.code ?? null
	}

	require(id: string) {
		const rule = this.match(id)
		return rule ? rule.cjsExports : null
	}

	private match(id: string): ShimRule | null {
		const exact = this.exact.get(id)
		if (exact) return exact
		for (const rule of this.prefix) {
			if (id.startsWith(rule.match)) return rule
		}
		return null
	}
}

function buildShimRules(input: RuntimeShimRegistryInput | undefined): ShimRule[] {
	const rawRules: Array<{
		kind: ShimKind
		match: string
		config: Exclude<RuntimeShimConfig, false>
	}> = []

	const shims = input?.shims ?? {}
	for (const [rawKey, cfg] of Object.entries(shims)) {
		if (!cfg) continue
		if (rawKey.endsWith('/*')) {
			rawRules.push({ kind: 'prefix', match: rawKey.slice(0, -1), config: cfg })
		} else {
			rawRules.push({ kind: 'exact', match: rawKey, config: cfg })
		}
	}

	if (input?.shimReflectMetadata) {
		rawRules.push({ kind: 'exact', match: 'reflect-metadata', config: true })
		rawRules.push({ kind: 'prefix', match: 'reflect-metadata/', config: true })
	}

	const rules: ShimRule[] = []
	const used = new Set<string>()

	let index = 0
	for (const r of rawRules) {
		const key = `${r.kind}:${r.match}`
		if (used.has(key)) continue
		used.add(key)

		const config = r.config === true ? {} : r.config
		const code = config.code ?? 'export {}'
		const moduleSideEffects = config.moduleSideEffects ?? false
		const cjsExports = config.exports ?? {}

		rules.push({
			kind: r.kind,
			match: r.match,
			virtualId: `\0pluxel:hmr:shim:${++index}:${sanitizeIdSegment(r.match)}`,
			code,
			moduleSideEffects,
			cjsExports,
		})
	}

	// Put exact matches first so `foo/*` doesn't shadow `foo`.
	rules.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'exact' ? -1 : 1))

	return rules
}

function sanitizeIdSegment(input: string) {
	const cleaned = input.replace(/[^a-zA-Z0-9._-]+/g, '_')
	return cleaned.length > 60 ? cleaned.slice(0, 60) : cleaned
}

/* ------------------------------ CJS require shims ------------------------------ */

type RequireShimResolver = (id: string) => any | null

const requireScope = new AsyncLocalStorage<boolean>()
let requireShimsInstalled = false
let requireShimResolver: RequireShimResolver | null = null

export function installRequireShims(resolver: RequireShimResolver) {
	requireShimResolver = resolver
	if (requireShimsInstalled) return
	requireShimsInstalled = true

	const modAny = NodeModule as any
	const originalLoad = modAny._load as Function

	modAny._load = function (request: unknown, parent: unknown, isMain: boolean) {
		if (requireScope.getStore() === true && typeof request === 'string') {
			const shim = requireShimResolver?.(request)
			if (shim != null) return shim
		}
		return originalLoad.apply(this, [request, parent, isMain])
	}
}

export function runWithRequireShims<T>(fn: () => Promise<T>): Promise<T> {
	return requireScope.run(true, fn)
}
