import '../../src/register-services'
import { createRuntimeHost, type RuntimeHost } from '@pluxel/runtime/test'
import type { LoaderBatch } from '../../src/loader/support'

export type ErrorLog = { msg: string; obj: unknown }
export type LoaderModuleCapture = {
	lastModule: unknown | null
	beginBatchCalls: number
	replaceModuleCalls: number
}

type ScanServiceOverride = { resolveEntry: (...args: any[]) => Promise<unknown> | unknown }

export function createHmrTestHost(options?: {
	errorLogs?: ErrorLog[]
	scanService?: ScanServiceOverride
}) {
	const host = createRuntimeHost()
	if (options?.errorLogs) captureLoggerErrors(host, options.errorLogs)
	if (options?.scanService) {
		;(host.ctx.scanService as typeof host.ctx.scanService & ScanServiceOverride).resolveEntry =
			options.scanService.resolveEntry
	}
	return host
}

export function captureLoggerErrors(host: RuntimeHost, errorLogs: ErrorLog[]) {
	const logger = host.ctx.logger as typeof host.ctx.logger & {
		error: (messageOrObj: unknown, maybeProps?: unknown) => void
	}
	const originalError = logger.error.bind(logger)
	logger.error = (messageOrObj: unknown, maybeProps?: unknown) => {
		if (typeof messageOrObj === 'string') {
			errorLogs.push({ msg: messageOrObj, obj: maybeProps })
		} else if (typeof maybeProps === 'string') {
			errorLogs.push({ msg: maybeProps, obj: messageOrObj })
		}
		originalError(messageOrObj, maybeProps)
	}
}

export function captureLoaderModules(host: RuntimeHost, capture: LoaderModuleCapture) {
	const loader = host.ctx.loader as typeof host.ctx.loader & {
		beginBatch: () => LoaderBatch
	}
	const originalBeginBatch = loader.beginBatch.bind(loader)
	loader.beginBatch = () => {
		capture.beginBatchCalls++
		const batch = originalBeginBatch()
		const originalReplaceModule = batch.replaceModule.bind(batch)
		batch.replaceModule = async (moduleId, mod) => {
			capture.replaceModuleCalls++
			capture.lastModule = mod
			return await originalReplaceModule(moduleId, mod)
		}
		return batch
	}
}
