// @vitest-environment jsdom
import type { RuntimeManagementClient, RuntimeUpdateSnapshot } from '@pluxel/runtime/web'
import { QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { RuntimeManagementClientProvider } from '../src/runtime'
import { createManagementQueryClient, managementQueryKeys } from '../src/app/managementQuery'
import { RuntimeUpdatesProvider, useRuntimeUpdates } from '../src/app/runtimeUpdates'

const roots: ReturnType<typeof createRoot>[] = []
beforeAll(() => {
	globalThis.IS_REACT_ACT_ENVIRONMENT = true
})
afterEach(async () => {
	await act(async () => {
		for (const root of roots.splice(0)) root.unmount()
	})
	document.body.replaceChildren()
})

function attempt(sequence: number, state: 'updating' | 'settled'): RuntimeUpdateSnapshot {
	return {
		sequence,
		state,
		phase: 'evaluate',
		outcome: state === 'settled' ? 'retained-previous' : null,
		durationMs: 10,
		trigger: 'new-helper.ts',
		error:
			state === 'settled'
				? {
						message: 'candidate failed',
						file: 'new-helper.ts',
						importChain: ['plugin.ts', 'new-helper.ts'],
					}
				: null,
	}
}

describe('runtime update feed', () => {
	it('shows failed candidate attempts independently of catalog entries and invalidates stale plugin diagnostics', async () => {
		let notify!: (snapshot: RuntimeUpdateSnapshot | null) => void
		const dispose = vi.fn()
		const client = {
			updates: {
				follow: vi.fn(async (observer: typeof notify) => {
					notify = observer
					observer(null)
					return { [Symbol.dispose]: dispose }
				}),
			},
		} as unknown as RuntimeManagementClient
		const queries = createManagementQueryClient()
		queries.setQueryData(managementQueryKeys.pluginOverview(), { plugins: [] })
		queries.setQueryData(managementQueryKeys.pluginDependencyGraph(), { nodes: [] })
		let observed: ReturnType<typeof useRuntimeUpdates> | undefined
		function Probe() {
			observed = useRuntimeUpdates()
			return null
		}
		const root = createRoot(document.body.appendChild(document.createElement('div')))
		roots.push(root)
		await act(async () => {
			root.render(
				<RuntimeManagementClientProvider client={client}>
					<QueryClientProvider client={queries}>
						<RuntimeUpdatesProvider>
							<Probe />
						</RuntimeUpdatesProvider>
					</QueryClientProvider>
				</RuntimeManagementClientProvider>,
			)
		})
		expect(observed?.ready).toBe(true)
		await act(async () => {
			notify(attempt(1, 'updating'))
		})
		expect(observed?.snapshot?.state).toBe('updating')
		expect(queries.getQueryState(managementQueryKeys.pluginOverview())?.isInvalidated).toBe(false)
		await act(async () => {
			notify(attempt(1, 'settled'))
		})
		expect(observed?.snapshot?.error?.file).toBe('new-helper.ts')
		expect(queries.getQueryState(managementQueryKeys.pluginOverview())?.isInvalidated).toBe(true)
		expect(queries.getQueryState(managementQueryKeys.pluginDependencyGraph())?.isInvalidated).toBe(
			true,
		)
		await act(async () => {
			notify(attempt(0, 'settled'))
			notify(attempt(1, 'updating'))
		})
		expect(observed?.snapshot?.state).toBe('settled')
		expect(observed?.snapshot?.sequence).toBe(1)
		await act(async () => {
			notify({
				...attempt(1, 'settled'),
				error: { message: 'additional commit diagnostic', file: null, importChain: [] },
			})
		})
		expect(observed?.snapshot?.error?.message).toBe('additional commit diagnostic')
		await act(async () => {
			root.unmount()
		})
		roots.pop()
		expect(dispose).toHaveBeenCalledOnce()
	})

	it('disposes a subscription whose setup completes after the document session unmounts', async () => {
		let finish!: (handle: Disposable) => void
		const pending = new Promise<Disposable>((resolve) => {
			finish = resolve
		})
		const client = { updates: { follow: () => pending } } as unknown as RuntimeManagementClient
		const root = createRoot(document.body.appendChild(document.createElement('div')))
		await act(async () => {
			root.render(
				<RuntimeManagementClientProvider client={client}>
					<QueryClientProvider client={createManagementQueryClient()}>
						<RuntimeUpdatesProvider>{null}</RuntimeUpdatesProvider>
					</QueryClientProvider>
				</RuntimeManagementClientProvider>,
			)
		})
		await act(async () => {
			root.unmount()
		})
		const dispose = vi.fn()
		await act(async () => {
			finish({ [Symbol.dispose]: dispose })
		})
		expect(dispose).toHaveBeenCalledOnce()
	})
})
