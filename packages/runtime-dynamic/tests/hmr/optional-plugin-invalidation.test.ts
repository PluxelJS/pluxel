import { describe, expect, it, vi } from 'vitest'
import { LoaderHmrService } from '../../src/hmr/engine/LoaderHmrService'
import type { HmrBatchSummary } from '../../src/hmr/engine/pipeline'
import { withTestDynamicContext } from '../support/context'
import { inspectLoaderHmr } from '../support/white-box'

const summary = (ok: boolean, affected = 1): HmrBatchSummary => ({
	epoch: 1,
	changed: ['/plugins/new-entry.mjs'],
	targets: ['/plugins/new-entry.mjs'],
	affectedModules: [],
	syncedModules: [],
	autoDisabled: [],
	enabledButStopped: [],
	affected,
	fallbackRoots: 0,
	invalidated: { runner: 0, vite: 0 },
	activeServices: 0,
	plugins: { loaded: 0, enabled: 0, running: 0 },
	commitMs: 0,
	batchMs: 0,
	ok,
	prefetchFailed: 0,
})

describe('LoaderHmrService optional plugin availability', () => {
	it('invalidates active optional references only after a successful source batch', async () => {
		await withTestDynamicContext((ctx) => {
			const invalidate = vi.spyOn(ctx.root.optionalPlugins, 'invalidate')
			const hmr = inspectLoaderHmr(new LoaderHmrService(ctx, { roots: [], entries: [] }))

			hmr.onBatchSummary(summary(false))
			expect(invalidate).not.toHaveBeenCalled()

			hmr.onBatchSummary(summary(true, 0))
			expect(invalidate).not.toHaveBeenCalled()

			hmr.onBatchSummary(summary(true))
			expect(invalidate).toHaveBeenCalledOnce()
		})
	})
})
