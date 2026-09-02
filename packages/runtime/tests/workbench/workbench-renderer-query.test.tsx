// @vitest-environment jsdom

import { parsePluginDefinitionAddress, parsePluginNodeAddress } from '@pluxel/core'
import {
	parseWorkbenchDeclarationIdentity,
	type WorkbenchDeclarationIdentity,
} from '@pluxel/core/federation'
import { StrictMode, act, useState, type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { type RpcStub, type RpcTarget } from '@pluxel/runtime/capnweb'
import { workbench } from '@pluxel/runtime/workbench'
import {
	openWorkbenchEntry,
	type WorkbenchLayoutEntry,
	type WorkbenchSessionApi,
} from '@pluxel/runtime/workbench/client'
import {
	createWorkbenchRenderer,
	WorkbenchRendererError,
	type WorkbenchHostFacade,
	type WorkbenchMutationState,
	type WorkbenchQueryResult,
} from '@pluxel/runtime/workbench/react'
import { createWorkbenchBridge } from '@pluxel/runtime/internal/workbench-react'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

interface QueryApi extends RpcTarget {
	snapshot(): Readonly<{ value: number }>
}

const rendererEntry = workbench.entry(import.meta.url, './fixtures/query.tsx')
const QueryWorkbench = workbench.define({
	query: workbench.view<QueryApi>({
		renderer: rendererEntry,
		placement: workbench.tab({ label: 'Query' }),
	}),
})
const owner = parsePluginDefinitionAddress({
	entry: { kind: 'package-root', packageName: '@example/query' },
	exportName: 'QueryPlugin',
})
const node = parsePluginNodeAddress({ definition: owner, variant: 'default' })
const identity = parseWorkbenchDeclarationIdentity({ kind: 'view', owner, key: 'query' })
const host: WorkbenchHostFacade = Object.freeze({
	locale: 'en',
	colorScheme: 'light',
	notify: vi.fn(),
	confirm: vi.fn().mockResolvedValue(true),
	navigation: null,
	document: null,
})

describe('Workbench renderer query scope', () => {
	it('rejects malformed query and mutation options at declaration time', () => {
		const scope = createWorkbenchRenderer(QueryWorkbench.query)
		expect(() => scope.query({ queryFn: () => ({ value: 1 }), watch: 1 } as never)).toThrowError(
			'[workbench/react] query watch must be a function',
		)
		expect(() =>
			scope.query({ queryFn: () => ({ value: 1 }), workbench: {} } as never),
		).toThrowError('[workbench/react] query options do not support a workbench namespace')
		expect(() =>
			scope.mutation({ mutationFn: () => undefined, invalidates: 1 } as never),
		).toThrowError('[workbench/react] mutation invalidates must be an array or function')
		expect(() =>
			scope.mutation({ mutationFn: () => undefined, workbench: {} } as never),
		).toThrowError('[workbench/react] mutation options do not support a workbench namespace')
	})

	it('isolates query owners between simultaneous opens of the same descriptor', async () => {
		const scope = createWorkbenchRenderer(QueryWorkbench.query)
		const query = scope.query({ queryFn: ({ api }) => api.snapshot() })
		const observed: WorkbenchQueryResult<Readonly<{ value: number }>>[] = []
		function Page() {
			const value = query.useQuery()
			observed.push(value)
			return <p>{value.data?.value ?? 'pending'}</p>
		}
		const Renderer = scope.render(Page)
		const firstApi = { snapshot: vi.fn(() => ({ value: 1 })) }
		const secondApi = { snapshot: vi.fn(() => ({ value: 2 })) }
		const first = await renderOpened(identity, Renderer, firstApi)
		const second = await renderOpened(identity, Renderer, secondApi)

		await vi.waitFor(() => {
			expect(first.dom.textContent).toBe('1')
			expect(second.dom.textContent).toBe('2')
		})
		expect(firstApi.snapshot).toHaveBeenCalledTimes(1)
		expect(secondApi.snapshot).toHaveBeenCalledTimes(1)
		expect(observed.some((value) => value.status === 'pending')).toBe(true)

		await first.dispose()
		await second.dispose()
	})

	it('shares one subscribe-before-read cycle and coalesces invalidation during a read', async () => {
		const events: string[] = []
		const firstRead = deferred<ReturnType<typeof disposableValue>>()
		const secondRead = deferred<ReturnType<typeof disposableValue>>()
		const firstDispose = vi.fn()
		const secondDispose = vi.fn()
		const watchDispose = vi.fn()
		let invalidate: (() => void) | undefined
		const scope = createWorkbenchRenderer(QueryWorkbench.query)
		const queryFn = vi
			.fn()
			.mockImplementationOnce(() => {
				events.push('read-1')
				return firstRead.promise
			})
			.mockImplementationOnce(() => {
				events.push('read-2')
				return secondRead.promise
			})
		const query = scope.query({
			queryFn,
			watch: (_context, next) => {
				events.push('watch')
				invalidate = next
				return { [Symbol.dispose]: watchDispose }
			},
		})
		function Child() {
			const value = query.useQuery()
			return <span>{value.data?.value ?? 'pending'}</span>
		}
		function Page() {
			return (
				<StrictMode>
					<Child />
					<Child />
				</StrictMode>
			)
		}
		const opened = await renderOpened(identity, scope.render(Page), { snapshot: vi.fn() })

		await vi.waitFor(() => expect(queryFn).toHaveBeenCalledTimes(1))
		expect(events.slice(0, 2)).toEqual(['watch', 'read-1'])
		act(() => invalidate?.())
		firstRead.resolve(disposableValue(1, firstDispose))
		await vi.waitFor(() => expect(queryFn).toHaveBeenCalledTimes(2))
		secondRead.resolve(disposableValue(2, secondDispose))
		await vi.waitFor(() => expect(opened.dom.textContent).toBe('22'))
		expect(watchDispose).not.toHaveBeenCalled()
		expect(firstDispose).toHaveBeenCalledTimes(1)
		expect(secondDispose).toHaveBeenCalledTimes(1)

		await opened.dispose()
		expect(watchDispose).toHaveBeenCalledTimes(1)
	})

	it('disposes a late result and a pending watch when the renderer closes', async () => {
		const watch = deferred<Disposable>()
		const read = deferred<ReturnType<typeof disposableValue>>()
		const pendingWatchDispose = vi.fn()
		const settledWatchDispose = vi.fn()
		const resultDispose = vi.fn()
		const scope = createWorkbenchRenderer(QueryWorkbench.query)
		const query = scope.query({
			queryFn: () => read.promise,
			watch: () => watch.promise,
		})
		function Page() {
			query.useQuery()
			return null
		}
		const opened = await renderOpened(identity, scope.render(Page), { snapshot: vi.fn() })
		await vi.waitFor(() => expect(watch.settled).toBe(false))
		await opened.dispose()

		watch.resolve({ [Symbol.dispose]: settledWatchDispose })
		await Promise.resolve()
		expect(settledWatchDispose).toHaveBeenCalledTimes(1)
		expect(pendingWatchDispose).not.toHaveBeenCalled()
		// A read only begins after watch settles, so make a second unwatched owner exercise late DTO cleanup.
		const lateScope = createWorkbenchRenderer(QueryWorkbench.query)
		const lateQuery = lateScope.query({ queryFn: () => read.promise })
		function LatePage() {
			lateQuery.useQuery()
			return null
		}
		const lateOpened = await renderOpened(identity, lateScope.render(LatePage), {
			snapshot: vi.fn(),
		})
		await vi.waitFor(() => expect(read.settled).toBe(false))
		await lateOpened.dispose()
		read.resolve(disposableValue(7, resultDispose))
		await vi.waitFor(() => expect(resultDispose).toHaveBeenCalledTimes(1))
	})

	it('canonicalizes structural keys and rejects unsafe or oversized keys with stable codes', async () => {
		const scope = createWorkbenchRenderer(QueryWorkbench.query)
		const queryFn = vi.fn((_, input: Readonly<{ a: number; b: number }>) => ({
			value: input.a + input.b,
		}))
		const query = scope.query({
			queryKey: (input: Readonly<{ a: number; b: number }>) => [input],
			queryFn,
		})
		function Child({ input }: Readonly<{ input: Readonly<{ a: number; b: number }> }>) {
			return <span>{query.useQuery(input).data?.value ?? 'pending'}</span>
		}
		function Page() {
			return (
				<>
					<Child input={{ a: 1, b: 2 }} />
					<Child input={{ b: 2, a: 1 }} />
				</>
			)
		}
		const opened = await renderOpened(identity, scope.render(Page), { snapshot: vi.fn() })
		await vi.waitFor(() => expect(opened.dom.textContent).toBe('33'))
		expect(queryFn).toHaveBeenCalledTimes(1)

		const invalid = (() => {
			class ArrayKey extends Array<unknown> {}
			return new ArrayKey('unsafe')
		})()
		expect(() => query.target(invalid as never)).toThrowError(
			expect.objectContaining<Partial<WorkbenchRendererError>>({
				code: 'WORKBENCH_RESOURCE_KEY_INVALID',
			}),
		)
		expect(() => query.target({ a: 1, b: 2 } as never)).not.toThrow()
		const oversized = { a: 1, b: 2, extra: 'x'.repeat(16_385) }
		expect(() => query.target(oversized as never)).toThrowError(
			expect.objectContaining<Partial<WorkbenchRendererError>>({
				code: 'WORKBENCH_RESOURCE_LIMIT_EXCEEDED',
			}),
		)
		await opened.dispose()
	})

	it('does not create duplicate runs when watch synchronously invalidates', async () => {
		const scope = createWorkbenchRenderer(QueryWorkbench.query)
		const watch = vi.fn((_context, invalidate: () => void) => {
			invalidate()
			return { [Symbol.dispose]() {} }
		})
		const queryFn = vi.fn(() => ({ value: 1 }))
		const query = scope.query({ queryFn, watch })
		function Page() {
			return <p>{query.useQuery().data?.value ?? 'pending'}</p>
		}
		const opened = await renderOpened(identity, scope.render(Page), { snapshot: vi.fn() })
		await vi.waitFor(() => expect(opened.dom.textContent).toBe('1'))
		expect(watch).toHaveBeenCalledTimes(1)
		expect(queryFn).toHaveBeenCalledTimes(1)
		await opened.dispose()
	})

	it('replaces the per-open owner when the Bridge payload changes in the same React mount', async () => {
		const firstRead = deferred<ReturnType<typeof disposableValue>>()
		const firstDispose = vi.fn()
		const firstApi = { snapshot: vi.fn(() => firstRead.promise) }
		const secondApi = { snapshot: vi.fn(() => ({ value: 2 })) }
		const scope = createWorkbenchRenderer(QueryWorkbench.query)
		const query = scope.query({ queryFn: ({ api }) => api.snapshot() })
		function Page() {
			return <p>{query.useQuery().data?.value ?? 'pending'}</p>
		}
		const opened = await renderOpened(identity, scope.render(Page), firstApi)
		await vi.waitFor(() => expect(firstApi.snapshot).toHaveBeenCalledTimes(1))

		await opened.replaceApi(secondApi)
		await vi.waitFor(() => expect(opened.dom.textContent).toBe('2'))
		expect(secondApi.snapshot).toHaveBeenCalledTimes(1)
		firstRead.resolve(disposableValue(1, firstDispose))
		await vi.waitFor(() => expect(firstDispose).toHaveBeenCalledTimes(1))
		expect(opened.dom.textContent).toBe('2')
		await opened.dispose()
	})

	it('keeps successful data when a background refresh fails', async () => {
		const failure = new Error('background failed')
		const queryFn = vi.fn().mockResolvedValueOnce({ value: 1 }).mockRejectedValueOnce(failure)
		const scope = createWorkbenchRenderer(QueryWorkbench.query)
		const query = scope.query({ queryFn })
		let observed: WorkbenchQueryResult<Readonly<{ value: number }>> | undefined
		function Page() {
			observed = query.useQuery()
			return <p>{`${observed.status}:${observed.data?.value ?? 'none'}`}</p>
		}
		const opened = await renderOpened(identity, scope.render(Page), { snapshot: vi.fn() })
		await vi.waitFor(() => expect(opened.dom.textContent).toBe('success:1'))

		act(() => observed!.invalidate())
		await vi.waitFor(() => expect(opened.dom.textContent).toBe('error:1'))
		expect(observed).toMatchObject({ error: failure, isStale: true, data: { value: 1 } })
		await opened.dispose()
	})

	it('makes concurrent refetch calls join one follow-up read', async () => {
		const firstRead = deferred<Readonly<{ value: number }>>()
		const secondRead = deferred<Readonly<{ value: number }>>()
		const queryFn = vi
			.fn()
			.mockImplementationOnce(() => firstRead.promise)
			.mockImplementationOnce(() => secondRead.promise)
		const scope = createWorkbenchRenderer(QueryWorkbench.query)
		const query = scope.query({ queryFn })
		let observed: WorkbenchQueryResult<Readonly<{ value: number }>> | undefined
		function Page() {
			observed = query.useQuery()
			return <p>{observed.data?.value ?? 'pending'}</p>
		}
		const opened = await renderOpened(identity, scope.render(Page), { snapshot: vi.fn() })
		await vi.waitFor(() => expect(queryFn).toHaveBeenCalledTimes(1))
		let firstRefetch!: Promise<Readonly<{ value: number }>>
		let secondRefetch!: Promise<Readonly<{ value: number }>>
		act(() => {
			firstRefetch = observed!.refetch()
			secondRefetch = observed!.refetch()
		})
		firstRead.resolve({ value: 1 })
		await vi.waitFor(() => expect(queryFn).toHaveBeenCalledTimes(2))
		secondRead.resolve({ value: 2 })
		await expect(Promise.all([firstRefetch, secondRefetch])).resolves.toEqual([
			{ value: 2 },
			{ value: 2 },
		])
		await vi.waitFor(() => expect(opened.dom.textContent).toBe('2'))
		await opened.dispose()
	})

	it('turns a throwing retry predicate into query error state and cancels retries on close', async () => {
		const retryFailure = new Error('retry predicate failed')
		const queryFn = vi.fn(() => Promise.reject(new Error('read failed')))
		const retry = vi.fn(() => {
			throw retryFailure
		})
		const scope = createWorkbenchRenderer(QueryWorkbench.query)
		const query = scope.query({ queryFn, retry })
		let observed: WorkbenchQueryResult<Readonly<{ value: number }>> | undefined
		function Page() {
			observed = query.useQuery()
			return <p>{observed.status}</p>
		}
		const opened = await renderOpened(identity, scope.render(Page), { snapshot: vi.fn() })
		await vi.waitFor(() => expect(opened.dom.textContent).toBe('error'))
		expect(observed?.error).toBe(retryFailure)
		expect(retry).toHaveBeenCalledTimes(1)
		await opened.dispose()

		const retryingScope = createWorkbenchRenderer(QueryWorkbench.query)
		const retryingFn = vi.fn(() => Promise.reject(new Error('read failed')))
		const retryingQuery = retryingScope.query({ queryFn: retryingFn, retry: 5 })
		function RetryingPage() {
			retryingQuery.useQuery()
			return null
		}
		const retrying = await renderOpened(identity, retryingScope.render(RetryingPage), {
			snapshot: vi.fn(),
		})
		await vi.waitFor(() => expect(retryingFn).toHaveBeenCalledTimes(1))
		await retrying.dispose()
		await new Promise((resolve) => setTimeout(resolve, 300))
		expect(retryingFn).toHaveBeenCalledTimes(1)
	})

	it('continues owner teardown after one watch disposer throws', async () => {
		const disposalFailure = new Error('watch cleanup failed')
		const firstDispose = vi.fn(() => {
			throw disposalFailure
		})
		const secondDispose = vi.fn()
		const scope = createWorkbenchRenderer(QueryWorkbench.query)
		const firstRead = vi.fn(() => ({ value: 1 }))
		const secondRead = vi.fn(() => ({ value: 2 }))
		const first = scope.query({
			queryFn: firstRead,
			watch: () => ({ [Symbol.dispose]: firstDispose }),
		})
		const second = scope.query({
			queryFn: secondRead,
			watch: () => ({ [Symbol.dispose]: secondDispose }),
		})
		function Page() {
			first.useQuery()
			second.useQuery()
			return null
		}
		const opened = await renderOpened(identity, scope.render(Page), { snapshot: vi.fn() })
		await vi.waitFor(() => {
			expect(firstRead).toHaveBeenCalledTimes(1)
			expect(secondRead).toHaveBeenCalledTimes(1)
		})

		await opened.dispose()
		expect(firstDispose).toHaveBeenCalledTimes(1)
		expect(secondDispose).toHaveBeenCalledTimes(1)
	})

	it('evicts from the full resource before unrelated inactive query data', async () => {
		type Phase =
			| Readonly<{ kind: 'other' }>
			| Readonly<{ kind: 'blank' }>
			| Readonly<{ kind: 'batch'; start: number; count: number }>
		const scope = createWorkbenchRenderer(QueryWorkbench.query)
		const otherRead = vi.fn(() => ({ value: 1 }))
		const currentRead = vi.fn((_context, input: number) => ({ value: input }))
		const other = scope.query({
			queryKey: (input: number) => [input],
			queryFn: otherRead,
			staleTime: Infinity,
		})
		const current = scope.query({
			queryKey: (input: number) => [input],
			queryFn: currentRead,
			staleTime: Infinity,
		})
		let setPhase!: (phase: Phase) => void
		function Other() {
			return <p>other:{other.useQuery(1).data?.value ?? 'pending'}</p>
		}
		function Current({ input }: Readonly<{ input: number }>) {
			return <span>{current.useQuery(input).status}</span>
		}
		function Page() {
			const [phase, updatePhase] = useState<Phase>({ kind: 'other' })
			setPhase = updatePhase
			if (phase.kind === 'other') return <Other />
			if (phase.kind === 'blank') return <p>blank</p>
			return (
				<>
					<p>batch</p>
					{Array.from({ length: phase.count }, (_, offset) => (
						<Current key={phase.start + offset} input={phase.start + offset} />
					))}
				</>
			)
		}
		const opened = await renderOpened(identity, scope.render(Page), { snapshot: vi.fn() })
		await vi.waitFor(() => expect(opened.dom.textContent).toBe('other:1'))
		expect(otherRead).toHaveBeenCalledTimes(1)

		await switchPhase(setPhase, { kind: 'blank' })
		await switchPhase(setPhase, { kind: 'batch', start: 0, count: 64 })
		await vi.waitFor(() => {
			expect(currentRead).toHaveBeenCalledTimes(64)
			expect(opened.dom.textContent).not.toContain('pending')
		})
		await switchPhase(setPhase, { kind: 'blank' })
		await switchPhase(setPhase, { kind: 'batch', start: 64, count: 64 })
		await vi.waitFor(() => {
			expect(currentRead).toHaveBeenCalledTimes(128)
			expect(opened.dom.textContent).not.toContain('pending')
		})
		await switchPhase(setPhase, { kind: 'blank' })
		await switchPhase(setPhase, { kind: 'batch', start: 128, count: 1 })
		await vi.waitFor(() => {
			expect(currentRead).toHaveBeenCalledTimes(129)
			expect(opened.dom.textContent).not.toContain('pending')
		})
		await switchPhase(setPhase, { kind: 'blank' })
		await switchPhase(setPhase, { kind: 'other' })
		await vi.waitFor(() => expect(opened.dom.textContent).toBe('other:1'))
		expect(otherRead).toHaveBeenCalledTimes(1)
		await opened.dispose()
	})

	it('reattaches a resource map when global eviction removes its last cached entry', async () => {
		type Phase = 'seed' | 'fill' | 'blank' | 'probe'
		const scope = createWorkbenchRenderer(QueryWorkbench.query)
		const currentRead = vi.fn((_context, input: number) => ({ value: input }))
		const current = scope.query({
			queryKey: (input: number) => [input],
			queryFn: currentRead,
			staleTime: Infinity,
		})
		const fillers = Array.from({ length: 255 }, () =>
			scope.query({ queryFn: () => ({ value: -1 }), enabled: false }),
		)
		let setPhase!: (phase: Phase) => void

		function DisabledQuery({ index }: Readonly<{ index: number }>) {
			fillers[index]!.useQuery()
			return null
		}
		function Seed() {
			current.useQuery(0)
			return <p>seed</p>
		}
		function Fill() {
			return (
				<>
					<p>fill</p>
					{fillers.map((_query, index) => (
						<DisabledQuery key={index} index={index} />
					))}
				</>
			)
		}
		function Probe() {
			return <p>{current.useQuery(1).data?.value ?? 'pending'}</p>
		}
		function Page() {
			const [phase, updatePhase] = useState<Phase>('seed')
			setPhase = updatePhase
			if (phase === 'seed') return <Seed />
			if (phase === 'fill') return <Fill />
			if (phase === 'probe') return <Probe />
			return <p>blank</p>
		}

		const opened = await renderOpened(identity, scope.render(Page), { snapshot: vi.fn() })
		await vi.waitFor(() => expect(currentRead).toHaveBeenCalledTimes(1))
		await switchPhase(setPhase, 'blank')
		await switchPhase(setPhase, 'fill')
		expect(opened.dom.textContent).toBe('fill')
		await switchPhase(setPhase, 'blank')
		await switchPhase(setPhase, 'probe')
		await vi.waitFor(() => expect(opened.dom.textContent).toBe('1'))
		expect(currentRead).toHaveBeenCalledTimes(2)

		await switchPhase(setPhase, 'blank')
		await switchPhase(setPhase, 'probe')
		await vi.waitFor(() => expect(opened.dom.textContent).toBe('1'))
		expect(currentRead).toHaveBeenCalledTimes(2)
		await opened.dispose()
	})
})

describe('Workbench renderer mutation resource', () => {
	it('is single-flight per hook, detaches its result, invalidates, and resets settled state', async () => {
		const result = deferred<Readonly<{ value: number }>>()
		const resultDispose = vi.fn()
		let reads = 0
		const scope = createWorkbenchRenderer(QueryWorkbench.query)
		const query = scope.query({ queryFn: () => ({ value: ++reads }) })
		const invalidations = [query]
		const save = scope.mutation({
			mutationFn: (_context, value: number) => {
				void value
				return result.promise
			},
			invalidates: invalidations,
		})
		invalidations.length = 0
		let mutation: WorkbenchMutationState<[value: number], Readonly<{ value: number }>> | undefined
		function Page() {
			const snapshot = query.useQuery()
			mutation = save.useMutation()
			return <p>{`${snapshot.data?.value ?? 'pending'}:${mutation.status}`}</p>
		}
		const opened = await renderOpened(identity, scope.render(Page), { snapshot: vi.fn() })
		await vi.waitFor(() => expect(opened.dom.textContent).toBe('1:idle'))

		let accepted!: Promise<Readonly<{ value: number }>>
		act(() => {
			accepted = mutation!.mutateAsync(2)
		})
		await vi.waitFor(() => expect(opened.dom.textContent).toBe('1:pending'))
		act(() => mutation!.reset())
		expect(opened.dom.textContent).toBe('1:pending')
		act(() => mutation!.mutate(3))
		expect(opened.dom.textContent).toBe('1:pending')
		await expect(mutation!.mutateAsync(3)).rejects.toMatchObject({
			code: 'WORKBENCH_MUTATION_PENDING',
		})

		result.resolve(disposableValue(2, resultDispose))
		await act(async () => {
			await expect(accepted).resolves.toEqual({ value: 2 })
		})
		expect(resultDispose).toHaveBeenCalledTimes(1)
		await vi.waitFor(() => expect(opened.dom.textContent).toBe('2:success'))
		expect(Object.isFrozen(mutation!.data)).toBe(true)

		act(() => mutation!.reset())
		expect(opened.dom.textContent).toBe('2:idle')
		await opened.dispose()
	})

	it('rejects malformed and oversized callback invalidations before invoking the mutation', async () => {
		const scope = createWorkbenchRenderer(QueryWorkbench.query)
		const query = scope.query({ queryFn: () => ({ value: 1 }) })
		const mutationFn = vi.fn(() => ({ value: 1 }))
		const malformed = scope.mutation({
			mutationFn,
			invalidates: (() => null) as never,
		})
		const oversized = scope.mutation({
			mutationFn,
			invalidates: () => Array.from({ length: 129 }, () => query),
		})
		let malformedState: WorkbenchMutationState<[], Readonly<{ value: number }>> | undefined
		let oversizedState: WorkbenchMutationState<[], Readonly<{ value: number }>> | undefined
		function Page() {
			malformedState = malformed.useMutation()
			oversizedState = oversized.useMutation()
			return null
		}
		const opened = await renderOpened(identity, scope.render(Page), { snapshot: vi.fn() })

		act(() => malformedState!.mutate())
		await vi.waitFor(() => expect(malformedState!.status).toBe('error'))
		expect(malformedState!.error).toEqual(
			expect.objectContaining({
				message: '[workbench/react] mutation invalidates() must return an array',
			}),
		)
		await act(async () => {
			await expect(oversizedState!.mutateAsync()).rejects.toMatchObject({
				code: 'WORKBENCH_RESOURCE_LIMIT_EXCEEDED',
			})
		})
		expect(mutationFn).not.toHaveBeenCalled()
		expect(oversizedState!.status).toBe('error')
		await opened.dispose()
	})

	it('supports input-derived exact and static broad keyed invalidation targets', async () => {
		type Key = 'first' | 'second'
		const reads: Record<Key, number> = { first: 0, second: 0 }
		let unrelatedReads = 0
		const scope = createWorkbenchRenderer(QueryWorkbench.query)
		const query = scope.query({
			queryKey: (input: Key) => [input],
			queryFn: (_context, input) => ({ value: ++reads[input] }),
		})
		const unrelated = scope.query({
			queryKey: (input: Key) => [input],
			queryFn: () => ({ value: ++unrelatedReads }),
		})
		const invalidateExact = scope.mutation({
			mutationFn: (_context, input: Key) => {
				void input
			},
			invalidates: (input) => [query.target(input)],
		})
		const invalidateAll = scope.mutation({
			mutationFn: () => undefined,
			invalidates: [query.all()],
		})
		let exactState: WorkbenchMutationState<[input: Key], void> | undefined
		let allState: WorkbenchMutationState<[], void> | undefined
		function Page() {
			const first = query.useQuery('first')
			const second = query.useQuery('second')
			const separate = unrelated.useQuery('first')
			exactState = invalidateExact.useMutation()
			allState = invalidateAll.useMutation()
			return (
				<p>{`${first.data?.value ?? 0}${second.data?.value ?? 0}${separate.data?.value ?? 0}`}</p>
			)
		}
		const opened = await renderOpened(identity, scope.render(Page), { snapshot: vi.fn() })
		await vi.waitFor(() => expect(opened.dom.textContent).toBe('111'))

		await act(async () => {
			await exactState!.mutateAsync('first')
		})
		await vi.waitFor(() => expect(opened.dom.textContent).toBe('211'))

		await act(async () => {
			await allState!.mutateAsync()
		})
		await vi.waitFor(() => expect(opened.dom.textContent).toBe('321'))
		await opened.dispose()
	})

	it('validates every invalidation target before invoking the mutation', async () => {
		const scope = createWorkbenchRenderer(QueryWorkbench.query)
		const foreignScope = createWorkbenchRenderer(QueryWorkbench.query)
		const foreignQuery = foreignScope.query({ queryFn: () => ({ value: 1 }) })
		const keyedQuery = scope.query({
			queryKey: (input: Readonly<{ id: number }>) => [input],
			queryFn: (_context, input) => ({ value: input.id }),
		})
		const mutationFn = vi.fn(() => ({ value: 1 }))
		const foreignMutation = scope.mutation({
			mutationFn,
			invalidates: [foreignQuery] as never,
		})
		const invalidKeyMutation = scope.mutation({
			mutationFn,
			invalidates: () => [keyedQuery.target({ id: Number.NaN })],
		})
		let foreign: WorkbenchMutationState<[], Readonly<{ value: number }>> | undefined
		let invalidKey: WorkbenchMutationState<[], Readonly<{ value: number }>> | undefined
		function Page() {
			foreign = foreignMutation.useMutation()
			invalidKey = invalidKeyMutation.useMutation()
			return null
		}
		const opened = await renderOpened(identity, scope.render(Page), { snapshot: vi.fn() })

		await act(async () => {
			await expect(foreign!.mutateAsync()).rejects.toMatchObject({
				code: 'WORKBENCH_RENDERER_SCOPE_MISMATCH',
			})
		})
		await act(async () => {
			await expect(invalidKey!.mutateAsync()).rejects.toMatchObject({
				code: 'WORKBENCH_RESOURCE_KEY_INVALID',
			})
		})
		expect(mutationFn).not.toHaveBeenCalled()
		expect(foreign!.status).toBe('error')
		expect(invalidKey!.status).toBe('error')
		await opened.dispose()
	})

	it('invalidates after rejection and after fulfilled-result detach failure', async () => {
		const domainFailure = new Error('write outcome is unknown')
		const invalidDispose = vi.fn()
		let reads = 0
		const scope = createWorkbenchRenderer(QueryWorkbench.query)
		const query = scope.query({ queryFn: () => ({ value: ++reads }) })
		const rejected = scope.mutation({
			mutationFn: () => Promise.reject(domainFailure),
			invalidates: [query],
		})
		const invalidResult = scope.mutation({
			mutationFn: () =>
				Promise.resolve(
					Object.defineProperty({ missing: undefined }, Symbol.dispose, {
						value: invalidDispose,
					}),
				),
			invalidates: [query],
		})
		let rejectState: WorkbenchMutationState<[], never> | undefined
		let invalidState: WorkbenchMutationState<[], Readonly<{ missing: undefined }>> | undefined
		function Page() {
			const snapshot = query.useQuery()
			rejectState = rejected.useMutation()
			invalidState = invalidResult.useMutation()
			return <p>{snapshot.data?.value ?? 'pending'}</p>
		}
		const opened = await renderOpened(identity, scope.render(Page), { snapshot: vi.fn() })
		await vi.waitFor(() => expect(opened.dom.textContent).toBe('1'))

		await act(async () => {
			await expect(rejectState!.mutateAsync()).rejects.toBe(domainFailure)
		})
		await vi.waitFor(() => expect(opened.dom.textContent).toBe('2'))
		expect(rejectState!.status).toBe('error')

		await act(async () => {
			await expect(invalidState!.mutateAsync()).rejects.toMatchObject({
				code: 'WORKBENCH_NON_PORTABLE_VALUE',
			})
		})
		expect(invalidDispose).toHaveBeenCalledTimes(1)
		await vi.waitFor(() => expect(opened.dom.textContent).toBe('3'))
		expect(invalidState!.status).toBe('error')
		await opened.dispose()
	})

	it('rejects promptly on renderer close while still disposing the late result', async () => {
		const result = deferred<Readonly<{ value: number }>>()
		const resultDispose = vi.fn()
		let mutation: WorkbenchMutationState<[value: number], Readonly<{ value: number }>> | undefined
		let executionSignal: AbortSignal | undefined
		const scope = createWorkbenchRenderer(QueryWorkbench.query)
		const save = scope.mutation({
			mutationFn: ({ signal }, value: number) => {
				executionSignal = signal
				void value
				return result.promise
			},
		})
		function Page() {
			mutation = save.useMutation()
			return <p>{mutation.status}</p>
		}
		const opened = await renderOpened(identity, scope.render(Page), { snapshot: vi.fn() })
		let pending!: Promise<Readonly<{ value: number }>>
		act(() => {
			pending = mutation!.mutateAsync(1)
		})
		await vi.waitFor(() => expect(executionSignal?.aborted).toBe(false))

		await opened.dispose()
		expect(executionSignal?.aborted).toBe(true)
		await expect(pending).rejects.toMatchObject({ code: 'WORKBENCH_RENDERER_CLOSED' })

		result.resolve(disposableValue(1, resultDispose))
		await vi.waitFor(() => expect(resultDispose).toHaveBeenCalledTimes(1))
	})
})

function disposableValue(value: number, dispose = vi.fn()) {
	return { value, [Symbol.dispose]: dispose }
}

function deferred<Value>() {
	let resolve!: (value: Value) => void
	let reject!: (error: unknown) => void
	let settled = false
	const promise = new Promise<Value>((nextResolve, nextReject) => {
		resolve = (value) => {
			settled = true
			nextResolve(value)
		}
		reject = (error) => {
			settled = true
			nextReject(error)
		}
	})
	return {
		promise,
		resolve,
		reject,
		get settled() {
			return settled
		},
	}
}

async function switchPhase<Phase>(setPhase: (phase: Phase) => void, phase: Phase): Promise<void> {
	act(() => setPhase(phase))
	await Promise.resolve()
}

async function renderOpened(
	declaration: WorkbenchDeclarationIdentity,
	Renderer: () => ReactNode,
	api: object,
) {
	const federatedViewRef = Object.freeze({
		profile: 1 as const,
		producer: 'pluxel_workbench_query',
		buildRevision: 'build-1',
		manifestUrl: '/__pluxel/runtime/federation/pluxel_workbench_query/build-1/mf-manifest.json',
		expose: './views/query' as const,
		descriptor: declaration,
	})
	const entry: WorkbenchLayoutEntry = Object.freeze({
		descriptor: declaration as Extract<typeof declaration, { kind: 'view' }>,
		target: Object.freeze({ node, displayName: 'Query' }),
		renderer: node,
		definitionRevisions: Object.freeze({ target: 1, renderer: 1 }),
		placement: QueryWorkbench.query.placement,
		federatedViewRef,
	})
	const open = async (nextApi: object) => {
		if (!(Symbol.dispose in nextApi)) {
			Object.defineProperty(nextApi, Symbol.dispose, { value() {} })
		}
		const session = {
			openEntry: vi.fn().mockResolvedValue({
				ok: true,
				value: { kind: 'local', api: nextApi, params: {}, federatedViewRef },
				[Symbol.dispose]() {},
			}),
		} as unknown as RpcStub<WorkbenchSessionApi>
		const result = await openWorkbenchEntry(session, entry, { layoutRevision: 1 })
		if (!result.ok) throw new Error('expected View')
		return result.handle
	}
	const openedHandles = [await open(api)]
	const provider = createWorkbenchBridge(declaration, Renderer)
	const application = provider()
	const dom = document.createElement('div')
	await act(() =>
		application.render({
			dom,
			moduleName: 'pluxel_workbench_query/views/query',
			__pluxelWorkbench: { profile: 1, handle: openedHandles[0], host },
		}),
	)
	return {
		dom,
		async replaceApi(nextApi: object) {
			const handle = await open(nextApi)
			openedHandles.push(handle)
			await act(() =>
				application.render({
					dom,
					moduleName: 'pluxel_workbench_query/views/query',
					__pluxelWorkbench: { profile: 1, handle, host },
				}),
			)
		},
		async dispose() {
			act(() => application.destroy({ dom, moduleName: 'query' }))
			await Promise.resolve()
			for (const handle of openedHandles) handle[Symbol.dispose]()
		},
	}
}
