import { ScriptExecutionError } from '@pluxel/host/internal/agent/runtime'

export function checkAbort(signal?: AbortSignal): void {
	if (signal?.aborted)
		throw new ScriptExecutionError(
			'aborted',
			'Client operation was aborted; accepted Host work is retained',
		)
}
