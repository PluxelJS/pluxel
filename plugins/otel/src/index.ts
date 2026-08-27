import type { Meter, Tracer } from '@opentelemetry/api'
import type { Logger } from '@opentelemetry/api-logs'
import { BasePlugin, formatPluginNodeReference, Plugin } from '@pluxel/runtime'
import { OtelConfig, type OtelSignal } from './config.ts'
import { safeErrorType } from './diagnostics.ts'
import type { OtlpExportState } from './otlp.ts'
import type { PrometheusPullReader } from './prometheus.ts'
import type { OtelRuntime } from './sdk.ts'

export { OtelConfig } from './config.ts'
export type { OtelPluginConfig, OtelSignal } from './config.ts'

const DIAGNOSTIC_LOG_INTERVAL_MS = 60_000

type FailureState = { failing: boolean; loggedAt: number }

/**
 * Caller-scoped native OpenTelemetry access with host-owned OTLP push and Prometheus pull.
 */
@Plugin()
export class OtelPlugin extends BasePlugin {
	private readonly config = this.configs.use(OtelConfig)
	private readonly meters = new WeakMap<object, Meter>()
	private readonly tracers = new WeakMap<object, Tracer>()
	private readonly loggers = new WeakMap<object, Logger>()
	private readonly otlpFailures = new Map<OtelSignal, FailureState>()
	private runtime: OtelRuntime | undefined
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

	protected override async init(): Promise<void> {
		const { createOtelRuntime } = await import('./sdk.ts')
		const runtime = await createOtelRuntime({
			rootName: this.ctx.root.name,
			otlp: this.config.otlp,
			prometheus: this.config.prometheus !== false,
			onOtlpExportState: (state) => this.onOtlpExportState(state),
		})
		this.runtime = runtime
		try {
			this.ctx.effects.defer(() => this.disposeRuntime(runtime), { tag: 'OtelPlugin' })
			if (runtime.prometheus && this.config.prometheus !== false) {
				this.mountPrometheus(runtime.prometheus, this.config.prometheus.path)
			}
		} catch (error) {
			if (this.runtime === runtime) this.runtime = undefined
			try {
				await runtime.shutdown()
			} catch {
				// Preserve the registration failure.
			}
			throw error
		}
	}

	private getCallerScoped<T>(
		cache: WeakMap<object, T>,
		create: (runtime: OtelRuntime, scopeName: string) => T,
	): T {
		const runtime = this.runtime
		if (!runtime) throw new Error('OtelPlugin is not running')
		const owner = this.ctx.caller ?? this.ctx
		const key = owner as object
		const existing = cache.get(key)
		if (existing) return existing
		const value = create(runtime, formatPluginNodeReference(owner.pluginInfo.nodeAddress))
		cache.set(key, value)
		return value
	}

	private mountPrometheus(reader: PrometheusPullReader, path: string): void {
		this.ctx.elysia.get(path, () => this.scrapePrometheus(reader))
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
		if (this.runtime === runtime) this.runtime = undefined
		try {
			await runtime.shutdown()
		} catch (error) {
			this.warn('OpenTelemetry shutdown failed', { errorType: safeErrorType(error) })
		}
	}

	private onOtlpExportState(state: OtlpExportState): void {
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
