import type { WorkbenchArtifactCompilations } from '@pluxel/runtime-dev/workbench'
import { describe, expect, it, vi } from 'vitest'

import {
	attachLoaderHmrWorkbenchArtifactPublisher,
	configureLoaderHmrWorkbenchArtifactSource,
	isLoaderHmrWorkbenchContentSource,
	LoaderHmrService,
	refreshLoaderHmrWorkbenchArtifacts,
} from '../../src/hmr/engine/LoaderHmrService'

describe('Loader HMR Workbench Content sources', () => {
	it('tracks exact Markdown sources outside the TypeScript module graph', async () => {
		const service = {
			normalizeId: (id: string) => id.replaceAll('\\', '/'),
		} as LoaderHmrService
		const publish = vi.fn(async () => undefined)
		let source = '/workspace/plugin/guide.md'
		let fail = false
		attachLoaderHmrWorkbenchArtifactPublisher(service, publish)
		configureLoaderHmrWorkbenchArtifactSource(service, {
			compilations: async () => {
				if (fail) throw new Error('invalid Markdown')
				return {
					producers: [],
					content: [{ sources: [source] }],
				} as unknown as WorkbenchArtifactCompilations
			},
		})

		await refreshLoaderHmrWorkbenchArtifacts(service)
		expect(isLoaderHmrWorkbenchContentSource(service, source)).toBe(true)
		expect(isLoaderHmrWorkbenchContentSource(service, '/workspace/plugin/other.md')).toBe(false)

		fail = true
		await expect(refreshLoaderHmrWorkbenchArtifacts(service)).rejects.toThrow('invalid Markdown')
		expect(isLoaderHmrWorkbenchContentSource(service, source)).toBe(true)

		fail = false
		source = '/workspace/plugin/operations.md'
		await refreshLoaderHmrWorkbenchArtifacts(service)
		expect(isLoaderHmrWorkbenchContentSource(service, '/workspace/plugin/guide.md')).toBe(false)
		expect(isLoaderHmrWorkbenchContentSource(service, source)).toBe(true)
		expect(publish).toHaveBeenCalledTimes(2)
	})

	it('refreshes only tracked raw Markdown watcher events and requests one full reload', async () => {
		const publish = vi.fn(async () => undefined)
		const send = vi.fn()
		const consumeFullReloadRequest = vi.fn(() => true)
		const push = vi.fn()
		const tracked = '/workspace/plugin/guide.md'
		const normalizeId = (id: string) => id.replaceAll('\\', '/')
		const service = {
			closed: false,
			ctx: { logger: { error: vi.fn() } },
			vite: { ws: { send } },
			path: { toClean: normalizeId },
			toolkit: { pathFilter: () => false },
			debouncer: { push },
			ssrEnv: undefined,
			normalizeId,
			isAnchorClean: () => false,
			forwardWorkbenchFullReload: () => {
				if (consumeFullReloadRequest()) send({ type: 'full-reload' })
			},
		} as unknown as LoaderHmrService
		attachLoaderHmrWorkbenchArtifactPublisher(service, publish)
		configureLoaderHmrWorkbenchArtifactSource(service, {
			compilations: async () =>
				({
					producers: [],
					content: [{ sources: [tracked] }],
				}) as unknown as WorkbenchArtifactCompilations,
		})
		await refreshLoaderHmrWorkbenchArtifacts(service)
		const enqueueFileChange = Reflect.get(LoaderHmrService.prototype, 'enqueueFileChange') as (
			this: LoaderHmrService,
			file: string,
		) => boolean

		expect(enqueueFileChange.call(service, tracked)).toBe(true)
		await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(2))
		await vi.waitFor(() => expect(send).toHaveBeenCalledWith({ type: 'full-reload' }))
		expect(consumeFullReloadRequest).toHaveBeenCalledOnce()
		expect(push).not.toHaveBeenCalled()

		expect(enqueueFileChange.call(service, '/workspace/plugin/untracked.md')).toBe(false)
		await Promise.resolve()
		expect(publish).toHaveBeenCalledTimes(2)
		expect(send).toHaveBeenCalledOnce()
	})
})
