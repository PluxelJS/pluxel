import type { LoaderHmrService } from '../../src/hmr/engine/LoaderHmrService'
import type { HmrBatchSummary } from '../../src/hmr/engine/pipeline'
import type { HmrRunner } from '../../src/hmr/engine/runner'

type LoaderHmrWhiteBox = LoaderHmrService & {
	debouncer: { push: (id: string) => void }
	ssrEnv?: {
		moduleGraph?: {
			getModulesByFile: (id: string) => Set<unknown> | undefined
		}
	}
	enqueueFileChange: (file: string) => boolean
	getAnchorsCleanSnapshot: () => ReadonlySet<string>
	onBatchSummary: (summary: HmrBatchSummary) => void
}

type HmrRunnerWhiteBox = HmrRunner & {
	bridgedRunnerUrls?: Set<string>
	bridgedHostExports?: Map<string, unknown>
}

export function inspectLoaderHmr(hmr: LoaderHmrService): LoaderHmrWhiteBox {
	return hmr as unknown as LoaderHmrWhiteBox
}

export function inspectHmrRunner(runner: HmrRunner): HmrRunnerWhiteBox {
	return runner as unknown as HmrRunnerWhiteBox
}
