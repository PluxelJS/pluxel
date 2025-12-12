// optionalResolver.ts
// Implements registry.optional()/optionalImport().
// Optional deps are *never* required for construction; they are looked up at runtime
// and may re‑fire a handler after the next commit if the set of running deps changes.

import type { Context } from '@pluxel/context'
import { BasePlugin, PLUGIN_CTX } from '../BasePlugin'
import type { PluginContainer } from '../PluginContainer'
import type { PluginIdentifier } from '../types'
import type { CommitSummary } from './PluginService'

type OptionalHandler<T> = (
	optional: T | undefined,
	summary: CommitSummary | undefined,
) => void | Promise<void>

type InstancesOf<T extends readonly PluginIdentifier[]> = {
	[K in keyof T]: InstanceType<T[K]> | undefined
}

type OptionalImporter<T extends PluginIdentifier> =
	| Promise<T | T[] | readonly T[]>
	| (() => Promise<T | T[] | readonly T[]>)

type OptionalOptions = {
	watch?: boolean
	multi?: boolean
	onError?: (error: unknown) => void
}

const isPluginIdentifier = (v: unknown): v is PluginIdentifier =>
	typeof v === 'function' && v.prototype instanceof BasePlugin

const describeIds = (ids: PluginIdentifier[]) =>
	ids.map((id) => String((id as any)?.name ?? id)).join(', ')

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

	constructor(
		// Context in PluginService is mutable (Context getter rebinds inst.ctx per caller).
		// We therefore take a getter so optional() always uses the *current* caller ctx
		// for caller‑injection and event attachment.
		private readonly getCtx: () => Context,
		private readonly pluginRegistry: PluginContainer,
		private readonly isRunning: (id: PluginIdentifier) => boolean,
		private readonly getLastCommit: () => CommitSummary | undefined,
	) {}

	private get ctx(): Context {
		return this.getCtx()
	}

	public optional<T extends PluginIdentifier>(
		plugin: T,
		handler?: OptionalHandler<InstanceType<T>>,
		opts?: OptionalOptions,
	): InstanceType<T> | undefined
	public optional<T extends PluginIdentifier>(
		importer: OptionalImporter<T>,
		handler?: OptionalHandler<InstanceType<T>>,
		opts?: OptionalOptions & { multi?: false },
	): Promise<InstanceType<T> | undefined>
	public optional<T extends readonly PluginIdentifier[]>(
		importer: Promise<T> | (() => Promise<T>),
		handler: OptionalHandler<InstancesOf<T>>,
		opts: OptionalOptions & { multi: true },
	): Promise<InstancesOf<T> | undefined>
	public optional<T extends PluginIdentifier>(
		importer: OptionalImporter<T>,
		handler: OptionalHandler<Array<InstanceType<T> | undefined>>,
		opts: OptionalOptions & { multi: true },
	): Promise<Array<InstanceType<T> | undefined> | undefined>
	public optional(
		target: PluginIdentifier | OptionalImporter<PluginIdentifier>,
		handler?: OptionalHandler<BasePlugin> | OptionalHandler<BasePlugin[]>,
		opts?: OptionalOptions,
	) {
		const callerCtx = this.ctx
		const watch = opts?.watch ?? true
		const multi = opts?.multi ?? false

		// Async import path
		if (!isPluginIdentifier(target)) {
			const importer = typeof target === 'function' ? target : () => target
			const label = importer.name || 'dynamic import'

			return this.optionalImport(importer, { onError: opts?.onError, label }).then((mod) => {
				if (mod === undefined) {
					return this.invokeOptionalHandler(handler, undefined, this.getLastCommit(), label, multi)
				}

				const ids = this.normalizePluginIdentifiers(mod)
				if (!ids.length) {
					const err = new Error(`optional(${label}) 未找到 BasePlugin 导出`)
					callerCtx.logger?.warn?.(err)
					opts?.onError?.(err)
					return Promise.resolve(
						this.invokeOptionalHandler(handler, undefined, this.getLastCommit(), label, multi),
					).then(() => (multi ? [] : undefined))
				}

				const payload = this.collectOptionals(ids, callerCtx, multi)
				if (!payload.length || payload.every((item) => item === undefined)) {
					this.logUnavailable(ids, label)
				}
				if (handler) {
					void this.invokeOptionalHandler(handler, payload, this.getLastCommit(), label, multi)
				}
				if (watch && handler) {
					this.attachOptionalWatcher(ids, callerCtx, handler, label, multi, multi)
				}
				return (multi ? payload : payload[0]) as any
			})
		}

		// Sync path
		const ids = [target]
		const label = describeIds(ids)
		const payload = this.collectOptionals(ids, callerCtx, false)
		if (!payload.length) this.logUnavailable(ids, label)
		void this.invokeOptionalHandler(handler, payload, this.getLastCommit(), label, false)
		if (watch && handler) {
			this.attachOptionalWatcher(ids, callerCtx, handler, label, false, false)
		}
		return payload[0] as any
	}

	public async optionalImport<T>(
		importer: () => Promise<T>,
		opts?: { onError?: (error: unknown) => void; label?: string },
	): Promise<T | undefined> {
		const callerCtx = this.ctx
		try {
			return await importer()
		} catch (error) {
			if (opts?.onError) {
				opts.onError(error)
			} else {
				const name = (opts?.label ?? importer.name) || 'optionalImport'
				callerCtx.logger?.warn?.(error, `${name} 动态导入失败`)
			}
			return undefined
		}
	}

	private collectOptionals(
		ids: PluginIdentifier[],
		callerCtx: Context,
		keepGaps: boolean,
	): Array<BasePlugin | undefined> {
		const result = ids.map((id) => this.getRunningOptional(id, callerCtx))
		return keepGaps ? result : result.filter((x): x is BasePlugin => x !== undefined)
	}

	private invokeOptionalHandler(
		handler: OptionalHandler<BasePlugin> | OptionalHandler<BasePlugin[]> | undefined,
		payload: Array<BasePlugin | undefined> | undefined,
		summary: CommitSummary | undefined,
		label: string,
		asMulti: boolean,
	) {
		if (!handler) return
		const value = (asMulti ? (payload ?? []) : payload?.[0]) as any
		return Promise.resolve(handler(value, summary)).catch((error) => {
			this.ctx.logger?.error?.(error, `optional(${label}) 处理失败`)
		})
	}

	private logUnavailable(ids: PluginIdentifier[], label: string) {
		const container = this.pluginRegistry.lastContainer
		const missingInContainer = ids.filter((id) => !container?.services?.has(id))
		if (missingInContainer.length) {
			this.ctx.logger?.warn?.(
				{ plugins: missingInContainer.map(String) },
				`optional(${label}) 未在容器中，可能尚未注册`,
			)
			return
		}
		const notRunning = ids.filter((id) => !this.isRunning(id))
		if (notRunning.length) {
			this.ctx.logger?.info?.(
				{ plugins: notRunning.map(String) },
				`optional(${label}) 已注册但未运行`,
			)
		}
	}

	private attachOptionalWatcher(
		ids: PluginIdentifier[],
		callerCtx: Context,
		handler: OptionalHandler<BasePlugin> | OptionalHandler<BasePlugin[]>,
		label: string,
		asMulti: boolean,
		keepGaps: boolean,
	) {
		let last = this.collectOptionals(ids, callerCtx, keepGaps)
		// 持续监听直到状态变化，再执行 handler 并解绑；避免首次 afterCommit 值相同导致永不触发。
		const unsub = callerCtx.events.on('afterCommit', (summary) => {
			const current = this.collectOptionals(ids, callerCtx, keepGaps)
			if (arraysEqual(last, current)) return
			last = current
			if (!current.length || current.every((item) => item === undefined)) {
				this.logUnavailable(ids, label)
			}
			void this.invokeOptionalHandler(handler as any, current, summary, label, asMulti)
			unsub()
		})
	}

	private getRunningOptional<T extends PluginIdentifier>(
		ctor: T,
		callerCtx: Context,
	): InstanceType<T> | undefined {
		if (!this.isRunning(ctor)) {
			this.optionalViews.get(callerCtx)?.delete(ctor)
			return undefined
		}

		const instance = this.pluginRegistry.singletons.get(ctor as any) as InstanceType<T> | undefined
		if (!instance) {
			this.optionalViews.get(callerCtx)?.delete(ctor)
			return undefined
		}

		let map = this.optionalViews.get(callerCtx)
		const cached = map?.get(ctor)
		if (cached && cached.source === instance) return cached.view as InstanceType<T>

		const wrapped = this.wrapWithCaller(instance, callerCtx) as InstanceType<T>
		if (!map) {
			map = new Map()
			this.optionalViews.set(callerCtx, map)
		}
		map.set(ctor, { source: instance, view: wrapped })
		return wrapped
	}

	private wrapWithCaller<P extends BasePlugin>(instance: P, callerCtx: Context): P {
		const view = Object.create((instance as any)[PLUGIN_CTX])
		view.caller = callerCtx
		return Object.create(instance, {
			ctx: { value: view, writable: false, enumerable: false, configurable: false },
		})
	}

	private normalizePluginIdentifiers(input: unknown): PluginIdentifier[] {
		if (isPluginIdentifier(input)) return [input]
		if (Array.isArray(input)) return input.filter(isPluginIdentifier)
		return []
	}
}
