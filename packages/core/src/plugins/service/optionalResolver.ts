// optionalResolver.ts
// Implements registry.optional().
//
// Design goals:
// - Never block plugin startup: if called during commit(), we defer handler/effects
//   to afterCommit, but we do NOT await afterCommit (otherwise init() could deadlock).
// - Deterministic semantics: handlers observe the "settled" state of a commit cycle.
// - Scoped cleanup: watchers and effects are collected into caller ctx.scope.
// - Clear diagnostics: unregistered vs idle vs failed.

import type { Context } from '@pluxel/context'
import { BasePlugin } from '../BasePlugin'
import type { PluginDiContainer } from '../PluginDefinitions'
import { getPluginInfo } from '../PluginDecorator'
import type { PluginIdentifier } from '../types'
import type { CommitSummary } from './PluginService'

export type InstancesOf<T extends readonly PluginIdentifier[]> = {
	[K in keyof T]: InstanceType<T[K]> | undefined
}

export type OptionalImporter<T extends PluginIdentifier> =
	| Promise<T | T[] | readonly T[]>
	| (() => Promise<T | T[] | readonly T[]>)

export type OptionalAvailability =
	| { state: 'running' }
	| { state: 'unregistered'; missingInContainer: string[] }
	| { state: 'idle'; idle: string[] }
	| { state: 'failed'; failed: Array<{ plugin: string; error: Error }>; idle: string[] }

export type OptionalEffectInfo = {
	label: string
	ids: PluginIdentifier[]
	summary: CommitSummary | undefined
	availability: OptionalAvailability
}

export type OptionalEffectCleanup =
	| void
	| (() => void | Promise<void>)
	| Promise<void | (() => void | Promise<void>)>
export type OptionalEffectHandler<T> = (
	optional: T,
	info: OptionalEffectInfo,
) => OptionalEffectCleanup

export type OptionalEffectOptions = {
	multi?: boolean
	/** Listen to plugin start/commit changes. Default: true. */
	watch?: boolean
	/** Fire once immediately. Default: true. */
	runOnInit?: boolean
	/** Log missing reasons when optional is unavailable. Default: true. */
	logUnavailable?: boolean
	onError?: (error: unknown) => void
}

const isPluginIdentifier = (v: unknown): v is PluginIdentifier =>
	typeof v === 'function' && v.prototype instanceof BasePlugin

const describeIds = (ids: PluginIdentifier[]) =>
	ids.map((id) => (typeof id === 'function' ? (id as Function).name : String(id))).join(', ')

const arraysEqual = <T>(a: T[], b: T[]): boolean => {
	if (a.length !== b.length) return false
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false
	}
	return true
}

export class OptionalResolver {
	/** caller -> (pluginId -> wrapped view) cache */
	private optionalViews = new WeakMap<
		Context,
		Map<PluginIdentifier, { source: BasePlugin; view: BasePlugin }>
	>()

	/**
	 * Last startup/resolve error by pluginInfo.id.
	 * Used purely for better optional diagnostics/logs.
	 */
	private lastErrors = new Map<string, Error>()

	constructor(
		private readonly getCtx: () => Context,
		private readonly getContainer: () => PluginDiContainer | undefined,
		private readonly getInstance: (id: PluginIdentifier) => BasePlugin | undefined,
		private readonly isRunning: (id: PluginIdentifier) => boolean,
		private readonly getLastCommit: () => CommitSummary | undefined,
		private readonly getDraftContainer: () => PluginDiContainer | undefined,
	) {
		const rootCtx = this.getCtx().root
		try {
			rootCtx.events.on('resolveError', (pluginId, error) => {
				const id = this.idOf(pluginId)
				if (id) this.lastErrors.set(id, error)
			})
			rootCtx.events.on('startError', (pluginCtx, error) => {
				const id = pluginCtx.pluginInfo.id
				this.lastErrors.set(id, error)
			})
			rootCtx.events.on('afterStart', (pluginCtx) => {
				const id = pluginCtx.pluginInfo.id
				this.lastErrors.delete(id)
			})
		} catch {
			// ignore: events service may be overridden/removed
		}
	}

	private get ctx(): Context {
		return this.getCtx()
	}

	private isCommitting(): boolean {
		return this.getDraftContainer() !== undefined
	}

	private containerForChecks(): PluginDiContainer | undefined {
		return this.getDraftContainer() ?? this.getContainer()
	}

	private idOf(id: PluginIdentifier): string {
		try {
			return getPluginInfo(id).id
		} catch {
			// fall back for non-decorated identifiers
			const raw = String(id)
			const paren = raw.indexOf('(')
			return (paren > 0 ? raw.slice(0, paren) : raw).trim()
		}
	}

	private async optionalImport<T>(
		importer: () => Promise<T>,
		opts?: { onError?: (error: unknown) => void; label?: string },
	): Promise<T | undefined> {
		const callerCtx = this.ctx.caller ?? this.ctx
		try {
			return await importer()
		} catch (error) {
			if (opts?.onError) {
				opts.onError(error)
			} else {
				const name = (opts?.label ?? importer.name) || 'dynamic import'
				callerCtx.logger.warn('optional({name}) 动态导入失败: {error}', { name, error })
			}
			return undefined
		}
	}

	/** The ONLY supported optional API: a scoped effect subscription. */
	public optional<T extends PluginIdentifier>(
		plugin: T,
		effect: OptionalEffectHandler<InstanceType<T> | undefined>,
		opts?: OptionalEffectOptions & { multi?: false },
	): () => void
	public optional<T extends readonly PluginIdentifier[]>(
		plugins: T,
		effect: OptionalEffectHandler<InstancesOf<T>>,
		opts: OptionalEffectOptions & { multi: true },
	): () => void
	public optional<T extends PluginIdentifier>(
		importer: OptionalImporter<T>,
		effect: OptionalEffectHandler<InstanceType<T> | undefined>,
		opts?: OptionalEffectOptions & { multi?: false },
	): Promise<() => void>
	public optional<T extends PluginIdentifier>(
		importer: OptionalImporter<T>,
		effect: OptionalEffectHandler<Array<InstanceType<T> | undefined>>,
		opts: OptionalEffectOptions & { multi: true },
	): Promise<() => void>
	public optional(
		target: PluginIdentifier | OptionalImporter<PluginIdentifier> | readonly PluginIdentifier[],
		effect: OptionalEffectHandler<any>,
		opts?: OptionalEffectOptions,
	): any {
		const callerCtx = this.ctx
		const watch = opts?.watch ?? true
		const multi = opts?.multi ?? false
		const runOnInit = opts?.runOnInit ?? true
		const logUnavailable = opts?.logUnavailable ?? true

		const attach = (ids: PluginIdentifier[], label: string) => {
			let stopped = false
			let last = this.collectOptionals(ids, callerCtx, multi)
			let first = true
			let cleanup: (() => void | Promise<void>) | undefined
			let chain: Promise<void> = Promise.resolve()

			const run = (summary?: CommitSummary) => {
				chain = chain
					.then(async () => {
						if (stopped) return
						const current = this.collectOptionals(ids, callerCtx, multi)
						const same = arraysEqual(last, current)

						if (first) {
							first = false
							if (!runOnInit && same) return
						} else if (same) {
							return
						}

						last = current

						const allMissing = !current.length || current.every((item) => item === undefined)
						if (allMissing && logUnavailable) this.logUnavailable(ids, label)

						const info: OptionalEffectInfo = {
							label,
							ids,
							summary: summary ?? this.getLastCommit(),
							availability: this.getAvailability(ids),
						}

							try {
								if (cleanup) await cleanup()
							} catch (error) {
								callerCtx.logger.warn('optional({label}) 清理失败: {error}', { label, error })
							}
							cleanup = undefined
							if (stopped) return

						try {
							const value = (multi ? current : current[0]) as any
							const ret = await effect(value, info)
							if (typeof ret === 'function') cleanup = ret as any
						} catch (error) {
							if (opts?.onError) opts.onError(error)
							else callerCtx.logger.error('optional({label}) 执行失败: {error}', { label, error })
						}
						})
						.catch((error) => {
							callerCtx.logger.error('optional({label}) 内部异常: {error}', { label, error })
						})
				}

			const offStart = watch ? callerCtx.events.on('afterStart', () => run(undefined)) : () => {}
			const offCommit = watch ? callerCtx.events.on('afterCommit', (s) => run(s)) : () => {}

			const dispose = () => {
				if (stopped) return
				stopped = true
				try {
					offStart()
					offCommit()
				} catch {
					/* ignore */
				}
				chain = chain.finally(async () => {
					try {
						await cleanup?.()
					} catch (error) {
						callerCtx.logger.warn('optional({label}) 清理失败: {error}', { label, error })
					}
					cleanup = undefined
				})
			}

			try {
				callerCtx.collectEffect(dispose)
			} catch {
				/* ignore */
			}

			// IMPORTANT: when called during commit(), we defer the first run to afterCommit
			// to avoid "early miss" within init().
			if (runOnInit) {
				if (this.isCommitting()) {
					const off = callerCtx.events.on('afterCommit', (s) => {
						off()
						run(s)
					})
				} else {
					run(this.getLastCommit())
				}
			}

			return dispose
		}

		if (Array.isArray(target)) {
			const ids = [...target].filter(isPluginIdentifier)
			return attach(ids, describeIds(ids))
		}

		if (!isPluginIdentifier(target)) {
			const importer = typeof target === 'function' ? target : () => target
			const label = importer.name || 'dynamic import'
			return this.optionalImport(importer, { onError: opts?.onError, label }).then((mod) => {
				const ids = this.normalizePluginIdentifiers(mod)
				if (mod !== undefined && ids.length === 0) {
					const err = new Error(`optional(${label}) 未找到 BasePlugin 导出`)
					callerCtx.logger.warn('optional({label}) 未找到 BasePlugin 导出: {error}', {
						label,
						error: err,
					})
					opts?.onError?.(err)
				}
				return attach(ids, label)
			})
		}

		return attach([target], describeIds([target]))
	}

	/* ─────────────────────────── Internals ─────────────────────────── */

	private normalizePluginIdentifiers(input: unknown): PluginIdentifier[] {
		if (isPluginIdentifier(input)) return [input]
		if (Array.isArray(input)) return input.filter(isPluginIdentifier)
		return []
	}

	private collectOptionals(
		ids: PluginIdentifier[],
		callerCtx: Context,
		keepGaps: boolean,
	): Array<BasePlugin | undefined> {
		const out = ids.map((id) => this.getRunningOptional(id, callerCtx))
		return keepGaps ? out : out.filter((x): x is BasePlugin => x !== undefined)
	}

	private getAvailability(ids: PluginIdentifier[]): OptionalAvailability {
		if (ids.length === 0) return { state: 'unregistered', missingInContainer: [] }
		const container = this.containerForChecks()
		const missingInContainer = ids.filter((id) => {
			const key = container?.resolveIdentifier?.(id as any) ?? id
			return !container?.services?.has(key as any)
		})
		if (missingInContainer.length) {
			return { state: 'unregistered', missingInContainer: missingInContainer.map(String) }
		}

		const notRunning = ids.filter((id) => !this.isRunning(id))
		if (!notRunning.length) return { state: 'running' }

		const failed: Array<{ plugin: string; error: Error }> = []
		const idle: string[] = []
		for (const id of notRunning) {
			const raw = String(id)
			const err = this.lastErrors.get(this.idOf(id))
			if (err) failed.push({ plugin: raw, error: err })
			else idle.push(raw)
		}
		if (failed.length) return { state: 'failed', failed, idle }
		return { state: 'idle', idle }
	}

		private logUnavailable(ids: PluginIdentifier[], label: string) {
			const availability = this.getAvailability(ids)
			switch (availability.state) {
				case 'unregistered':
					this.ctx.logger.warn('optional({label}) 未在容器中，可能尚未注册', {
						label,
						plugins: availability.missingInContainer,
					})
					return
				case 'failed':
					this.ctx.logger.info('optional({label}) 已注册但未运行（最近启动失败）', {
						label,
						failed: availability.failed.map((x) => ({
							plugin: x.plugin,
							message: x.error.message || String(x.error),
					})),
					idle: availability.idle.length ? availability.idle : undefined,
					})
					return
				case 'idle':
					this.ctx.logger.info('optional({label}) 已注册但未运行', { label, plugins: availability.idle })
					return
				case 'running':
					return
			}
		}

	private getRunningOptional<T extends PluginIdentifier>(
		ctor: T,
		callerCtx: Context,
	): InstanceType<T> | undefined {
		const container = this.containerForChecks()
		const key = (container?.resolveIdentifier?.(ctor as any) ?? ctor) as PluginIdentifier

		if (!this.isRunning(ctor)) {
			this.optionalViews.get(callerCtx)?.delete(key)
			return undefined
		}

		const instance = this.getInstance(key) as InstanceType<T> | undefined
		if (!instance) {
			this.optionalViews.get(callerCtx)?.delete(key)
			return undefined
		}

		let map = this.optionalViews.get(callerCtx)
		const cached = map?.get(key)
		if (cached && cached.source === instance) return cached.view as InstanceType<T>

		const wrapped = this.wrapWithCaller(instance, callerCtx) as InstanceType<T>
		if (!map) {
			map = new Map()
			this.optionalViews.set(callerCtx, map)
		}
		map.set(key, { source: instance, view: wrapped })
		return wrapped
	}

	private wrapWithCaller<P extends BasePlugin>(instance: P, callerCtx: Context): P {
		const view = Object.create(instance.ctx) as Context
		view.caller = callerCtx
		return Object.create(instance, {
			ctx: { value: view, writable: false, enumerable: false, configurable: false },
		})
	}
}
