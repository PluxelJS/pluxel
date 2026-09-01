import { pluginNodeAddressOf } from '@pluxel/runtime'
import type { RpcStub, RpcTarget } from '@pluxel/runtime/capnweb'
import { requireWorkbench } from '@pluxel/runtime/internal'
import { createRuntimeHost } from '@pluxel/runtime/test'
import { describe, expect, it, vi } from 'vitest'
import { PluginWithUI } from './PluginWithUI'
import type { PluginWithUIApi, PluginWithUIObserver } from './PluginWithUI.workbench'

const principal = Object.freeze({ provider: 'local', subject: 'plugin-host-test' })

describe('PluginWithUI Workbench observer', () => {
	it('disposes each Cap’n Web callback invocation result after it settles', async () => {
		const host = createRuntimeHost()
		host.add(PluginWithUI)
		host.start(PluginWithUI)
		await host.commit()

		let session: ReturnType<ReturnType<typeof requireWorkbench>['createSession']> | undefined
		let subscription: (RpcTarget & Disposable) | undefined
		try {
			session = requireWorkbench(host.ctx).createSession(principal, () => {})
			const target = pluginNodeAddressOf(PluginWithUI)
			const layout = session.target.layout({ target })
			const entry = layout.entries.find((candidate) => candidate.descriptor.key === 'overview')
			if (!entry) throw new Error('PluginWithUI overview View is missing')

			const opened = await session.target.openEntry({
				layoutRevision: layout.revision,
				target,
				descriptor: entry.descriptor,
			})
			if (!opened.ok || opened.value.kind !== 'local') {
				throw new Error('PluginWithUI overview View did not open')
			}
			const api = opened.value.api as PluginWithUIApi

			const invocation = Promise.withResolvers<void>()
			const disposeInvocation = vi.fn()
			const invocationResult = Object.assign(invocation.promise, {
				[Symbol.dispose]: disposeInvocation,
			})
			const disposeObserver = vi.fn()
			let observer!: RpcStub<PluginWithUIObserver>
			const invokeObserver = vi.fn(() => invocationResult)
			observer = Object.assign(invokeObserver, {
				dup: vi.fn(() => observer),
				[Symbol.dispose]: disposeObserver,
			}) as unknown as RpcStub<PluginWithUIObserver>

			subscription = api.watch(observer as unknown as PluginWithUIObserver) as RpcTarget &
				Disposable
			api.increment()

			expect(invokeObserver).toHaveBeenCalledOnce()
			expect(disposeInvocation).not.toHaveBeenCalled()

			invocation.resolve()
			await invocationResult
			await vi.waitFor(() => expect(disposeInvocation).toHaveBeenCalledOnce())
		} finally {
			subscription?.[Symbol.dispose]()
			session?.dispose()
			await host.dispose()
		}
	})
})
