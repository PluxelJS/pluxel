export type OperationResult = 'ok' | 'error'
export type CapacityLimit = 'total' | 'per_plugin'

export type OperationMetric = Readonly<{
	pluginId: string
	operation: string
	okAttributes: Readonly<Record<string, string>>
	errorAttributes: Readonly<Record<string, string>>
	durationAttributes: Readonly<Record<string, string>>
}>

export type ExportState = Readonly<{ ok: true }> | Readonly<{ ok: false; errorType: string }>

export interface MetricsRecorder {
	record(operation: OperationMetric, result: OperationResult, durationSeconds: number): void
	recordCapacityDrop(limit: CapacityLimit): void
	shutdown(): Promise<void>
}

export type RecorderHooks = Readonly<{
	onCollection: () => void
	onExportState: (state: ExportState) => void
}>
