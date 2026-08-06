import { BasePlugin, Plugin } from '@pluxel/runtime'
import { EXPORT_FAILURE_LOG_INTERVAL_MS } from './constants.ts'
import type { MetricsRecorder, ExportState } from './recorder.ts'
import {
	OperationMetricsRuntime,
	type MetricsOwnerContext,
	type MetricsRuntimeLogger,
} from './runtime.ts'

function safeErrorType(error: unknown): string {
	try {
		if (error && typeof error === 'object') {
			const name = (error as { name?: unknown }).name
			if (typeof name === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(name)) return name
		}
	} catch {
		return 'unknown'
	}
	return error === null ? 'null' : typeof error
}

@Plugin({ name: 'MetricsPlugin' })
export class MetricsPlugin extends BasePlugin {
	private readonly runtime = new OperationMetricsRuntime({
		warn: (message, properties) => this.ctx.logger.warn(message, properties),
	} satisfies MetricsRuntimeLogger)
	private recorder: MetricsRecorder | undefined
	private exportFailing = false
	private exportFailureLogAt = Number.NEGATIVE_INFINITY

	measure<T>(operation: string, run: () => PromiseLike<T>): Promise<T>
	measure<T>(operation: string, run: () => T): T
	measure<T>(operation: string, run: () => T | PromiseLike<T>): T | Promise<T> {
		const owner = (this.ctx.caller ?? this.ctx) as unknown as MetricsOwnerContext
		return this.runtime.measure(owner, operation, run)
	}

	protected override async init(): Promise<void> {
		const { createOtlpRecorder } = await import('./otel.ts')
		const recorder = await createOtlpRecorder({
			rootName: this.ctx.root.name,
			hooks: {
				onCollection: () => this.runtime.onCollection(),
				onExportState: (state) => this.onExportState(state),
			},
		})
		this.recorder = recorder
		try {
			this.runtime.start(recorder)
			this.ctx.effects.defer(() => this.disposeRecorder(recorder), {
				tag: 'MetricsPlugin',
			})
		} catch (error) {
			this.runtime.stop()
			this.recorder = undefined
			try {
				await recorder.shutdown()
			} catch {
				// The registration error remains the startup failure.
			}
			throw error
		}
	}

	protected override stop(): void {
		this.runtime.stop()
	}

	private async disposeRecorder(recorder: MetricsRecorder): Promise<void> {
		if (this.recorder === recorder) this.recorder = undefined
		this.runtime.stop()
		try {
			await recorder.shutdown()
		} catch (error) {
			this.ctx.logger.warn('metrics shutdown failed after local resources were stopped', {
				errorType: safeErrorType(error),
			})
		}
	}

	private onExportState(state: ExportState): void {
		if (state.ok) {
			if (!this.exportFailing) return
			this.exportFailing = false
			this.ctx.logger.info('metrics OTLP export recovered')
			return
		}

		const now = Date.now()
		const shouldLog =
			!this.exportFailing || now - this.exportFailureLogAt >= EXPORT_FAILURE_LOG_INTERVAL_MS
		this.exportFailing = true
		if (!shouldLog) return
		this.exportFailureLogAt = now
		this.ctx.logger.warn('metrics OTLP export failed; interval data may be lost', {
			errorType: 'errorType' in state ? state.errorType : 'unknown',
		})
	}
}
