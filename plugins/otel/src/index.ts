import { ElysiaApp } from '@pluxel/services/elysia'
import type { Meter, Tracer } from '@opentelemetry/api'
import type { Logger } from '@opentelemetry/api-logs'
import { BasePlugin, formatPluginNodeReference, Plugin } from '@pluxel/core'
import { OtelConfig, type OtelSignal } from './config.ts'
import { safeErrorType } from './diagnostics.ts'
import type { OtlpExportState } from './otlp.ts'
import type { PrometheusPullReader } from './prometheus.ts'
import type { OtelProviders, OtelRuntime } from './sdk.ts'
import { OtelWorkbench, type OtelWorkbenchStatus } from './workbench.ts'

export { OtelConfig } from './config.ts'
export type { OtelPluginConfig, OtelSignal } from './config.ts'
export type { OtelProviders } from './sdk.ts'
export { OtelWorkbench } from './workbench.ts'

const DIAGNOSTIC_LOG_INTERVAL_MS = 60_000

type FailureState = { failing: boolean; loggedAt: number }

/**
 * Caller-scoped native OpenTelemetry access with generation-owned providers.
 */
export abstract class Otel extends BasePlugin {
	private readonly meters = new WeakMap<object, Meter>()
	private readonly tracers = new WeakMap<object, Tracer>()
	private readonly loggers = new WeakMap<object, Logger>()
	private readonly otlpFailures = new Map<OtelSignal, FailureState>()
	private readonly otlpStates = new Map<OtelSignal, OtlpExportState>()
	private readonly workbenchDataListeners = new Set<() => void>()
	private runtime: OtelRuntime | undefined
	private prometheusPath: string | undefined
	private prometheusFailureLogAt = Number.NEGATIVE_INFINITY

	/** Standard OTel Meter scoped to the caller Plugin node address. */
	get meter(): Meter {
		return this.getCallerScoped(this.meters, (runtime, scope) => runtime.getMeter(scope))
	}

	/** Standard OTel Tracer scoped to the caller Plugin node address. */
	get tracer(): Tracer {
		return this.getCallerScoped(this.tracers, (runtime, scope) => runtime.getTracer(scope))
	}

	/** Standard OTel Logger scoped to the caller Plugin node address. */
	get logger(): Logger {
		return this.getCallerScoped(this.loggers, (runtime, scope) => runtime.getLogger(scope))
	}

	/**
	 * Create native providers once per generation, after any declared config injection.
	 * Returning transfers their flush/shutdown ownership to this generation.
	 * Clean up partially created resources yourself if this hook rejects.
	 */
	protected abstract createProviders(): Promise<OtelProviders>

	protected override async init(): Promise<void> {
		const { createRuntimeFromProviders } = await import('./sdk.ts')
		const providers = await this.createProviders()
		const runtime = await createRuntimeFromProviders(providers)
		this.runtime = runtime
		try {
			this.ctx.effects.defer(() => this.disposeRuntime(runtime), { tag: 'Otel' })
			if (runtime.prometheus && runtime.prometheusPath !== undefined) {
				this.mountPrometheus(runtime.prometheus, runtime.prometheusPath)
				this.prometheusPath = runtime.prometheusPath
			}
		} catch (error) {
			if (this.runtime === runtime) {
				this.runtime = undefined
				this.prometheusPath = undefined
			}
			const [cleanup] = await Promise.allSettled([runtime.shutdown()])
			if (cleanup.status === 'rejected') {
				throw new AggregateError(
					[error, cleanup.reason],
					'OpenTelemetry initialization and cleanup failed',
					{ cause: error },
				)
			}
			throw error
		}
	}

	/** Bind OtelWorkbench.operations in the concrete Plugin's own init() publication. */
	protected workbenchOperations() {
		return {
			subscribe: (changed: () => void): Disposable => {
				this.workbenchDataListeners.add(changed)
				return {
					[Symbol.dispose]: () => {
						this.workbenchDataListeners.delete(changed)
					},
				}
			},
			load: () => ({ status: this.workbenchStatus() }),
			actions: {
				flush: async () => {
					try {
						await this.requireRuntime().forceFlush()
						return { ok: true as const, message: '待处理 telemetry 已提交给 exporter' }
					} catch (error) {
						this.warn('OpenTelemetry manual flush failed', {
							errorType: safeErrorType(error),
						})
						return { ok: false as const, message: '导出未完成，请查看 Plugin 日志' }
					}
				},
			},
		}
	}

	private getCallerScoped<T>(
		cache: WeakMap<object, T>,
		create: (runtime: OtelRuntime, scopeName: string) => T,
	): T {
		const runtime = this.runtime
		if (!runtime) throw new Error('Otel is not running')
		const owner = this.ctx.caller ?? this.ctx
		const key = owner as object
		const existing = cache.get(key)
		if (existing) return existing
		const value = create(runtime, formatPluginNodeReference(owner.pluginInfo.nodeAddress))
		cache.set(key, value)
		return value
	}

	private requireRuntime(): OtelRuntime {
		const runtime = this.runtime
		if (!runtime) throw new Error('Otel is not running')
		return runtime
	}

	private workbenchStatus(): OtelWorkbenchStatus {
		const runtime = this.requireRuntime()
		const signal = (name: OtelSignal): OtelWorkbenchStatus['metrics'] => {
			const output = runtime.outputs[name]
			if (output !== 'managed') {
				return { state: output, errorType: null }
			}
			const state = this.otlpStates.get(name)
			if (!state) return { state: 'waiting' as const, errorType: null }
			return 'errorType' in state
				? { state: 'failing', errorType: state.errorType }
				: { state: 'healthy', errorType: null }
		}
		const prometheusPath = this.prometheusPath
		return {
			metrics: signal('metrics'),
			traces: signal('traces'),
			logs: signal('logs'),
			prometheus:
				prometheusPath === undefined
					? { state: 'disabled' as const, path: null }
					: { state: 'listening' as const, path: prometheusPath },
		}
	}

	private mountPrometheus(reader: PrometheusPullReader, path: string): void {
		this.ctx.require(ElysiaApp).get(path, () => this.scrapePrometheus(reader))
	}

	private async scrapePrometheus(reader: PrometheusPullReader): Promise<Response> {
		try {
			const { body, collectionErrorCount } = await reader.scrape()
			if (collectionErrorCount > 0) {
				this.warnPrometheus('Prometheus scrape completed with collection errors', {
					collectionErrorCount,
				})
			}
			return new Response(body, {
				headers: { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' },
			})
		} catch (error) {
			this.warnPrometheus('Prometheus scrape failed', { errorType: safeErrorType(error) })
			return new Response('# metrics collection failed\n', {
				status: 503,
				headers: { 'content-type': 'text/plain; charset=utf-8' },
			})
		}
	}

	private async disposeRuntime(runtime: OtelRuntime): Promise<void> {
		if (this.runtime === runtime) {
			this.runtime = undefined
			this.prometheusPath = undefined
		}
		try {
			await runtime.shutdown()
		} catch (error) {
			this.warn('OpenTelemetry shutdown failed', { errorType: safeErrorType(error) })
			throw error
		}
	}

	protected onOtlpExportState(state: OtlpExportState): void {
		const previous = this.otlpStates.get(state.signal)
		this.otlpStates.set(state.signal, state)
		if (!sameExportState(previous, state)) {
			for (const changed of this.workbenchDataListeners) changed()
		}
		const failure = this.otlpFailures.get(state.signal) ?? {
			failing: false,
			loggedAt: Number.NEGATIVE_INFINITY,
		}
		if (state.ok) {
			if (!failure.failing) return
			failure.failing = false
			this.info('OTLP ' + state.signal + ' export recovered')
			return
		}

		const now = Date.now()
		const shouldLog = !failure.failing || now - failure.loggedAt >= DIAGNOSTIC_LOG_INTERVAL_MS
		failure.failing = true
		this.otlpFailures.set(state.signal, failure)
		if (!shouldLog) return
		failure.loggedAt = now
		this.warn('OTLP ' + state.signal + ' export failed', {
			errorType: 'errorType' in state ? state.errorType : 'unknown',
		})
	}

	private warnPrometheus(message: string, properties: Readonly<Record<string, unknown>>): void {
		const now = Date.now()
		if (now - this.prometheusFailureLogAt < DIAGNOSTIC_LOG_INTERVAL_MS) return
		this.prometheusFailureLogAt = now
		this.warn(message, properties)
	}

	private info(message: string): void {
		try {
			this.ctx.logger.info(message)
		} catch {
			// Diagnostics cannot affect telemetry or application code.
		}
	}

	private warn(message: string, properties: Readonly<Record<string, unknown>>): void {
		try {
			this.ctx.logger.warn(message, properties)
		} catch {
			// Diagnostics cannot affect telemetry or application code.
		}
	}
}

/** Optional OTLP/Prometheus preset configured through OtelConfig and standard OTEL_* inputs. */
@Plugin(Otel)
export class OtelPlugin extends Otel {
	private readonly config = this.configs.use(OtelConfig)

	protected override async init(): Promise<void> {
		await super.init()
		this.ctx.workbench?.publish(OtelWorkbench, {
			operations: () => this.workbenchOperations(),
		})
	}

	protected override async createProviders(): Promise<OtelProviders> {
		const { createOtelProviders } = await import('./sdk.ts')
		const managed = await createOtelProviders({
			rootName: this.ctx.root.name,
			otlp: this.config.otlp,
			prometheus: this.config.prometheus !== false,
			prometheusPath: this.config.prometheus === false ? undefined : this.config.prometheus.path,
			onOtlpExportState: (state) => this.onOtlpExportState(state),
		})
		return managed.providers
	}
}

function sameExportState(previous: OtlpExportState | undefined, current: OtlpExportState): boolean {
	if (!previous || previous.ok !== current.ok) return false
	if (previous.ok === false && current.ok === false) {
		return previous.errorType === current.errorType
	}
	return true
}
