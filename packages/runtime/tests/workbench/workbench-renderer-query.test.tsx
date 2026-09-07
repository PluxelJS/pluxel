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
	it('rejects flat legacy options when their factories bind to an owner', async () => {
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
		const scope = createWorkbenchRenderer(QueryWorkbench.query)
		const legacyQuery = scope.query((() => ({
			queryKey: ['malformed'],
			queryFn: () => ({ value: 1 }),
			watch: () => ({ [Symbol.dispose]() {} }),
		})) as never)
		function LegacyQueryPage() {
			legacyQuery.useQuery()
			return null
		}
		const legacyQueryOpened = await renderOpened(identity, scope.render(LegacyQueryPage), {
			snapshot: vi.fn(),
		})
		expect(legacyQueryOpened.dom.textContent).toMatch(/unsupported option "watch"/i)
		await legacyQueryOpened.dispose()

		const mutationScope = createWorkbenchRenderer(QueryWorkbench.query)
		const legacyMutation = mutationScope.mutation((() => ({
			mutationFn: () => undefined,
			invalidates: [],
		})) as never)
		function LegacyMutationPage() {
			legacyMutation.useMutation()
			return null
		}
		const legacyMutationOpened = await renderOpened(
			identity,
			mutationScope.render(LegacyMutationPage),
			{ snapshot: vi.fn() },
		)
		expect(legacyMutationOpened.dom.textContent).toMatch(/unsupported option "invalidates"/i)
		await legacyMutationOpened.dispose()
		consoleError.mockRestore()

		expect(() =>
			scope.query(() => ({
				queryKey: ['namespaced'],
				queryFn: () => ({ value: 1 }),
				workbench: { subscribe: () => ({ [Symbol.dispose]() {} }) },
			})),
		).not.toThrow()
		expect(() =>
			scope.mutation(() => ({ mutationFn: () => undefined, workbench: { invalidates: [] } })),
		).not.toThrow()
	})

	it('isolates query owners between simultaneous opens of the same descriptor', async () => {
		const scope = createWorkbenchRenderer(QueryWorkbench.query)
		const query = scope.query(({ api }) => ({
			queryKey: ['snapshot'],
			queryFn: () => api.snapshot(),
		}))
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
		const query = scope.query(() => ({
			queryKey: ['watched'],
			queryFn,
			workbench: {
				subscribe: ({ invalidate: next }) => {
					events.push('watch')
					invalidate = next
					return { [Symbol.dispose]: watchDispose }
				},
			},
		}))
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
		const query = scope.query(() => ({
			queryKey: ['late-watch'],
			queryFn: () => read.promise,
			workbench: { subscribe: () => watch.promise },
		}))
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
		const lateQuery = lateScope.query(() => ({
			queryKey: ['late-read'],
			queryFn: () => read.promise,
		}))
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

	it('closes renderer resources synchronously when the host owner signal aborts', async () => {
		const read = deferred<ReturnType<typeof disposableValue>>()
		const subscriptionDispose = vi.fn()
		const resultDispose = vi.fn()
		let readSignal: AbortSignal | undefined
		const scope = createWorkbenchRenderer(QueryWorkbench.query)
		const query = scope.query(() => ({
			queryKey: ['owner-signal-close'],
			queryFn: ({ signal }) => {
				readSignal = signal
				return read.promise
			},
			workbench: {
				subscribe: () => ({ [Symbol.dispose]: subscriptionDispose }),
			},
		}))
		function Page() {
			query.useQuery()
			return null
		}
		const opened = await renderOpened(identity, scope.render(Page), { snapshot: vi.fn() })
		await vi.waitFor(() => expect(readSignal?.aborted).toBe(false))

		opened.abortOwner()
		expect(readSignal?.aborted).toBe(true)
		expect(subscriptionDispose).toHaveBeenCalledTimes(1)

		read.resolve(disposableValue(1, resultDispose))
		await vi.waitFor(() => expect(resultDispose).toHaveBeenCalledTimes(1))
		await opened.dispose()
	})

	it('keeps query ownership coherent when one render creates many inactive keys', async () => {
		const read = deferred<ReturnType<typeof disposableValue>>()
		const resultDispose = vi.fn()
		const subscriptionDispose = vi.fn()
		let readSignal: AbortSignal | undefined
		const scope = createWorkbenchRenderer(QueryWorkbench.query)
		const query = scope.queryFamily((_context, input: number) => ({
			queryKey: ['many-keys', input],
			queryFn: ({ signal }) => {
				readSignal = signal
				return read.promise
			},
			enabled: input === 0,
			workbench: {
				subscribe: () => ({ [Symbol.dispose]: subscriptionDispose }),
			},
		}))
		function Child({ input }: Readonly<{ input: number }>) {
			query.useQuery(input)
			return null
		}
		function Page() {
			return Array.from({ length: 129 }, (_, input) => <Child key={input} input={input} />)
		}
		const opened = await renderOpened(identity, scope.render(Page), { snapshot: vi.fn() })
		await vi.waitFor(() => expect(readSignal?.aborted).toBe(false))
		await opened.dispose()
		expect(readSignal?.aborted).toBe(true)
		expect(subscriptionDispose).toHaveBeenCalledTimes(1)

		read.resolve(disposableValue(1, resultDispose))
		await vi.waitFor(() => expect(resultDispose).toHaveBeenCalledTimes(1))
	})

	it('reclaims an observerless grace entry when replacing a key at the active limit', async () => {
		const queryFn = vi.fn((input: number) => ({ value: input }))
		const scope = createWorkbenchRenderer(QueryWorkbench.query)
		const query = scope.queryFamily((_context, input: number) => ({
			queryKey: ['active-key-replacement', input],
			queryFn: () => queryFn(input),
		}))
		let replaceFirst!: () => void
		function Child({ slot, input }: Readonly<{ slot: number; input: number }>) {
			return <span data-slot={slot}>{query.useQuery(input).data?.value ?? 'pending'},</span>
		}
		function Page() {
			const [first, setFirst] = useState(0)
			replaceFirst = () => setFirst(64)
			return Array.from({ length: 64 }, (_, slot) => (
				<Child key={slot} slot={slot} input={slot === 0 ? first : slot} />
			))
		}
		const opened = await renderOpened(identity, scope.render(Page), { snapshot: vi.fn() })
		await vi.waitFor(() => expect(queryFn).toHaveBeenCalledTimes(64))

		await act(async () => replaceFirst())
		await vi.waitFor(() => expect(queryFn).toHaveBeenCalledTimes(65))
		expect(opened.dom.querySelector('[data-slot="0"]')?.textContent).toBe('64,')
		expect(opened.dom.textContent).not.toMatch(/too many active query keys/i)
		await opened.dispose()
	})

	it('canonicalizes structural keys and rejects unsafe or oversized keys with stable codes', async () => {
		const scope = createWorkbenchRenderer(QueryWorkbench.query)
		const queryFn = vi.fn((input: Readonly<{ a: number; b: number }>) => ({
			value: input.a + input.b,
		}))
		const query = scope.queryFamily((_context, input: Readonly<{ a: number; b: number }>) => ({
			queryKey: ['sum', input],
			queryFn: () => queryFn(input),
		}))
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
		const oversized = { a: 1, b: 2, extra: 'x'.repeat(16_385) }
		const hiddenField = Object.defineProperty({ a: 1, b: 2 }, 'hidden', {
			value: 3,
			enumerable: false,
		})
		const hiddenIndex = ['unsafe']
		Object.defineProperty(hiddenIndex, '0', { value: 'unsafe', enumerable: false })
		const invalidMutation = scope.mutation(() => ({
			mutationFn: () => undefined,
			workbench: { invalidates: [query.target(invalid as never)] },
		}))
		const oversizedMutation = scope.mutation(() => ({
			mutationFn: () => undefined,
			workbench: { invalidates: [query.target(oversized as never)] },
		}))
		const hiddenFieldMutation = scope.mutation(() => ({
			mutationFn: () => undefined,
			workbench: { invalidates: [query.target(hiddenField)] },
		}))
		const hiddenIndexMutation = scope.mutation(() => ({
			mutationFn: () => undefined,
			workbench: { invalidates: [query.target(hiddenIndex as never)] },
		}))
		let invalidate!: WorkbenchMutationState<void, void>
		let invalidateOversized!: WorkbenchMutationState<void, void>
		let invalidateHiddenField!: WorkbenchMutationState<void, void>
		let invalidateHiddenIndex!: WorkbenchMutationState<void, void>
		function Invalidations() {
			invalidate = invalidMutation.useMutation()
			invalidateOversized = oversizedMutation.useMutation()
			invalidateHiddenField = hiddenFieldMutation.useMutation()
			invalidateHiddenIndex = hiddenIndexMutation.useMutation()
			return null
		}
		const invalidations = await renderOpened(identity, scope.render(Invalidations), {
			snapshot: vi.fn(),
		})
		await expect(invalidate.mutateAsync()).rejects.toMatchObject({
			code: 'WORKBENCH_RESOURCE_KEY_INVALID',
		})
		await expect(invalidateOversized.mutateAsync()).rejects.toMatchObject({
			code: 'WORKBENCH_RESOURCE_LIMIT_EXCEEDED',
		})
		await expect(invalidateHiddenField.mutateAsync()).rejects.toMatchObject({
			code: 'WORKBENCH_RESOURCE_KEY_INVALID',
		})
		await expect(invalidateHiddenIndex.mutateAsync()).rejects.toMatchObject({
			code: 'WORKBENCH_RESOURCE_KEY_INVALID',
		})
		await invalidations.dispose()
		await opened.dispose()
	})

	it('does not create duplicate runs when watch synchronously invalidates', async () => {
		const scope = createWorkbenchRenderer(QueryWorkbench.query)
		const watch = vi.fn((invalidate: () => void) => {
			invalidate()
			return { [Symbol.dispose]() {} }
		})
		const queryFn = vi.fn(() => ({ value: 1 }))
		const query = scope.query(() => ({
			queryKey: ['sync-watch'],
			queryFn,
			workbench: { subscribe: ({ invalidate }) => watch(invalidate) },
		}))
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
		const query = scope.query(({ api }) => ({
			queryKey: ['replace-api'],
			queryFn: () => api.snapshot(),
		}))
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

	it('remounts local state and lets the new owner mutate while the old owner is still settling', async () => {
		const firstResult = deferred<ReturnType<typeof disposableValue>>()
		const firstDispose = vi.fn()
		const firstApi = { snapshot: vi.fn(() => firstResult.promise) }
		const secondApi = { snapshot: vi.fn(() => ({ value: 2 })) }
		const scope = createWorkbenchRenderer(QueryWorkbench.query)
		const save = scope.mutation(({ api }) => ({
			mutationFn: (_value: number) => api.snapshot(),
		}))
		let mutation: WorkbenchMutationState<number, Readonly<{ value: number }>> | undefined
		let setLocal!: (value: number) => void
		function Page() {
			const [local, updateLocal] = useState(0)
			setLocal = updateLocal
			mutation = save.useMutation()
			return <p>{`${local}:${mutation.status}:${mutation.data?.value ?? 'none'}`}</p>
		}
		const opened = await renderOpened(identity, scope.render(Page), firstApi)
		act(() => setLocal(7))
		expect(opened.dom.textContent).toBe('7:idle:none')

		let oldOperation!: Promise<Readonly<{ value: number }>>
		act(() => {
			oldOperation = mutation!.mutateAsync(1)
		})
		await vi.waitFor(() => expect(opened.dom.textContent).toBe('7:pending:none'))

		await opened.replaceApi(secondApi)
		await vi.waitFor(() => expect(opened.dom.textContent).toBe('0:idle:none'))
		await expect(oldOperation).rejects.toMatchObject({ code: 'WORKBENCH_RENDERER_CLOSED' })
		await act(async () => {
			await expect(mutation!.mutateAsync(2)).resolves.toEqual({ value: 2 })
		})
		expect(opened.dom.textContent).toBe('0:success:2')

		firstResult.resolve(disposableValue(1, firstDispose))
		await vi.waitFor(() => expect(firstDispose).toHaveBeenCalledTimes(1))
		expect(opened.dom.textContent).toBe('0:success:2')
		await opened.dispose()
	})

	it('re-establishes an async subscription before reading after observer reactivation', async () => {
		const firstSubscription = deferred<Disposable>()
		const secondSubscription = deferred<Disposable>()
		const firstDispose = vi.fn()
		const secondDispose = vi.fn()
		let firstInvalidate: (() => void) | undefined
		let secondInvalidate: (() => void) | undefined
		const subscribe = vi
			.fn()
			.mockImplementationOnce(({ invalidate }: Readonly<{ invalidate: () => void }>) => {
				firstInvalidate = invalidate
				return firstSubscription.promise
			})
			.mockImplementationOnce(({ invalidate }: Readonly<{ invalidate: () => void }>) => {
				secondInvalidate = invalidate
				return secondSubscription.promise
			})
		const queryFn = vi.fn(() => ({ value: 1 }))
		const scope = createWorkbenchRenderer(QueryWorkbench.query)
		const query = scope.query(() => ({
			queryKey: ['async-reactivation'],
			queryFn,
			workbench: { subscribe },
		}))
		let setVisible!: (visible: boolean) => void
		function Child() {
			return <span>{query.useQuery().data?.value ?? 'pending'}</span>
		}
		function Page() {
			const [visible, updateVisible] = useState(true)
			setVisible = updateVisible
			return visible ? <Child /> : <span>hidden</span>
		}
		const opened = await renderOpened(identity, scope.render(Page), { snapshot: vi.fn() })
		await vi.waitFor(() => expect(subscribe).toHaveBeenCalledTimes(1))
		expect(queryFn).not.toHaveBeenCalled()

		await act(async () => setVisible(false))
		act(() => setVisible(true))
		firstSubscription.resolve({ [Symbol.dispose]: firstDispose })
		await vi.waitFor(() => expect(subscribe).toHaveBeenCalledTimes(2))
		expect(firstDispose).toHaveBeenCalledTimes(1)
		expect(queryFn).not.toHaveBeenCalled()

		secondSubscription.resolve({ [Symbol.dispose]: secondDispose })
		await vi.waitFor(() => expect(opened.dom.textContent).toBe('1'))
		expect(queryFn).toHaveBeenCalledTimes(1)
		act(() => firstInvalidate?.())
		await Promise.resolve()
		expect(queryFn).toHaveBeenCalledTimes(1)
		act(() => secondInvalidate?.())
		await vi.waitFor(() => expect(queryFn).toHaveBeenCalledTimes(2))
		await opened.dispose()
		expect(secondDispose).toHaveBeenCalledTimes(1)
	})

	it('does not let an old disposable subscription promise disturb a newer generation', async () => {
		const firstSubscription = disposableDeferred<Disposable>()
		const secondSubscription = disposableDeferred<Disposable>()
		const secondSettledDispose = vi.fn()
		const subscribe = vi
			.fn()
			.mockImplementationOnce(() => firstSubscription.promise)
			.mockImplementationOnce(() => secondSubscription.promise)
		const queryFn = vi.fn(() => ({ value: 1 }))
		const scope = createWorkbenchRenderer(QueryWorkbench.query)
		const query = scope.query(() => ({
			queryKey: ['disposable-subscription-generation'],
			queryFn,
			workbench: { subscribe },
		}))
		let setVisible!: (visible: boolean) => void
		function Child() {
			return <span>{query.useQuery().data?.value ?? 'pending'}</span>
		}
		function Page() {
			const [visible, updateVisible] = useState(true)
			setVisible = updateVisible
			return visible ? <Child /> : <span>hidden</span>
		}
		const opened = await renderOpened(identity, scope.render(Page), { snapshot: vi.fn() })
		await vi.waitFor(() => expect(subscribe).toHaveBeenCalledTimes(1))

		act(() => setVisible(false))
		await vi.waitFor(() => expect(firstSubscription.dispose).toHaveBeenCalledTimes(1))
		act(() => setVisible(true))
		await vi.waitFor(() => expect(subscribe).toHaveBeenCalledTimes(2))

		firstSubscription.reject(new Error('old subscription failed late'))
		await Promise.resolve()
		expect(secondSubscription.dispose).not.toHaveBeenCalled()
		secondSubscription.resolve({ [Symbol.dispose]: secondSettledDispose })
		await vi.waitFor(() => expect(opened.dom.textContent).toBe('1'))
		expect(queryFn).toHaveBeenCalledTimes(1)
		expect(secondSubscription.dispose).not.toHaveBeenCalled()

		await opened.dispose()
		expect(secondSettledDispose).toHaveBeenCalledTimes(1)
	})

	it('refreshes after a cancelled read even when the old query function ignores abort', async () => {
		const staleRead = deferred<ReturnType<typeof disposableValue>>()
		const staleDispose = vi.fn()
		let staleSignal: AbortSignal | undefined
		let latestInvalidate: (() => void) | undefined
		const subscribe = vi.fn(({ invalidate }: Readonly<{ invalidate: () => void }>) => {
			latestInvalidate = invalidate
			return { [Symbol.dispose]() {} }
		})
		const queryFn = vi
			.fn()
			.mockImplementationOnce(() => ({ value: 1 }))
			.mockImplementationOnce(({ signal }: Readonly<{ signal: AbortSignal }>) => {
				staleSignal = signal
				return staleRead.promise
			})
			.mockImplementation(() => ({ value: 3 }))
		const scope = createWorkbenchRenderer(QueryWorkbench.query)
		const query = scope.query(() => ({
			queryKey: ['cancelled-ignores-abort'],
			queryFn,
			workbench: { subscribe },
		}))
		let setVisible!: (visible: boolean) => void
		function Child() {
			return <span>{query.useQuery().data?.value ?? 'pending'}</span>
		}
		function Page() {
			const [visible, updateVisible] = useState(true)
			setVisible = updateVisible
			return visible ? <Child /> : <span>hidden</span>
		}
		const opened = await renderOpened(identity, scope.render(Page), { snapshot: vi.fn() })
		await vi.waitFor(() => expect(opened.dom.textContent).toBe('1'))
		act(() => latestInvalidate?.())
		await vi.waitFor(() => expect(queryFn).toHaveBeenCalledTimes(2))

		act(() => setVisible(false))
		await vi.waitFor(() => expect(staleSignal?.aborted).toBe(true))
		act(() => setVisible(true))
		await vi.waitFor(() => expect(subscribe).toHaveBeenCalledTimes(2))
		act(() => latestInvalidate?.())
		await vi.waitFor(() => expect(opened.dom.textContent).toBe('3'))
		expect(queryFn).toHaveBeenCalledTimes(3)

		staleRead.resolve(disposableValue(2, staleDispose))
		await vi.waitFor(() => expect(staleDispose).toHaveBeenCalledTimes(1))
		await opened.dispose()
	})

	it('revokes an invalidation callback when subscription setup fails', async () => {
		const subscribeFailure = new Error('subscribe failed')
		let ghostInvalidate: (() => void) | undefined
		const subscribe = vi.fn(({ invalidate }: Readonly<{ invalidate: () => void }>) => {
			ghostInvalidate = invalidate
			throw subscribeFailure
		})
		const queryFn = vi.fn(() => ({ value: 1 }))
		const scope = createWorkbenchRenderer(QueryWorkbench.query)
		const query = scope.query(() => ({
			queryKey: ['failed-subscription'],
			queryFn,
			retry: false,
			workbench: { subscribe },
		}))
		let observed: WorkbenchQueryResult<Readonly<{ value: number }>> | undefined
		function Page() {
			observed = query.useQuery()
			return <p>{observed.status}</p>
		}
		const opened = await renderOpened(identity, scope.render(Page), { snapshot: vi.fn() })
		await vi.waitFor(() => expect(opened.dom.textContent).toBe('error'))
		expect(observed?.error).toBe(subscribeFailure)
		expect(queryFn).not.toHaveBeenCalled()

		act(() => ghostInvalidate?.())
		await Promise.resolve()
		expect(subscribe).toHaveBeenCalledTimes(1)
		expect(queryFn).not.toHaveBeenCalled()
		await opened.dispose()
	})

	it('does not retry a failed subscription as a separate reactivation read', async () => {
		const subscribeFailure = new Error('reactivated subscription failed')
		const firstDispose = vi.fn()
		const subscribe = vi
			.fn()
			.mockImplementationOnce(() => ({ [Symbol.dispose]: firstDispose }))
			.mockImplementationOnce(() => {
				throw subscribeFailure
			})
		const queryFn = vi.fn(() => ({ value: 1 }))
		const scope = createWorkbenchRenderer(QueryWorkbench.query)
		const query = scope.query(() => ({
			queryKey: ['reactivation-subscription-failure'],
			queryFn,
			retry: false,
			workbench: { subscribe },
		}))
		let observed!: WorkbenchQueryResult<Readonly<{ value: number }>>
		let setVisible!: (visible: boolean) => void
		function Child() {
			observed = query.useQuery()
			return <span>{`${observed.status}:${observed.data?.value ?? 'none'}`}</span>
		}
		function Page() {
			const [visible, updateVisible] = useState(true)
			setVisible = updateVisible
			return visible ? <Child /> : <span>hidden</span>
		}
		const opened = await renderOpened(identity, scope.render(Page), { snapshot: vi.fn() })
		await vi.waitFor(() => expect(opened.dom.textContent).toBe('success:1'))

		await act(async () => setVisible(false))
		expect(firstDispose).toHaveBeenCalledTimes(1)
		act(() => setVisible(true))
		await vi.waitFor(() => expect(opened.dom.textContent).toBe('error:1'))
		expect(observed.error).toBe(subscribeFailure)
		await new Promise((resolve) => setTimeout(resolve, 10))
		expect(subscribe).toHaveBeenCalledTimes(2)
		expect(queryFn).toHaveBeenCalledTimes(1)
		await opened.dispose()
	})

	it('marks a continuously observed query stale after staleTime', async () => {
		vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
		let opened: Awaited<ReturnType<typeof renderOpened>> | undefined
		try {
			const scope = createWorkbenchRenderer(QueryWorkbench.query)
			const query = scope.query(() => ({
				queryKey: ['stale-timer'],
				queryFn: () => ({ value: 1 }),
				staleTime: 200,
			}))
			let observed: WorkbenchQueryResult<Readonly<{ value: number }>> | undefined
			function Page() {
				observed = query.useQuery()
				return <p>{`${observed.status}:${observed.isStale}`}</p>
			}
			opened = await renderOpened(identity, scope.render(Page), { snapshot: vi.fn() })
			await act(() => vi.advanceTimersByTimeAsync(0))
			expect(opened.dom.textContent).toBe('success:false')
			await act(() => vi.advanceTimersByTimeAsync(199))
			expect(opened.dom.textContent).toBe('success:false')
			await act(() => vi.advanceTimersByTimeAsync(2))
			expect(opened.dom.textContent).toBe('success:true')
		} finally {
			await opened?.dispose()
			vi.useRealTimers()
		}
	})

	it('expires instance controls when the Hook that produced them unmounts', async () => {
		const queryFn = vi.fn((value: number) => ({ value }))
		const mutationFn = vi.fn((value: number) => ({ value }))
		const scope = createWorkbenchRenderer(QueryWorkbench.query)
		const query = scope.queryFamily((_context, input: number) => ({
			queryKey: ['hook-lifetime', input],
			queryFn: () => queryFn(input),
		}))
		const mutation = scope.mutation(() => ({ mutationFn }))
		let savedQuery!: WorkbenchQueryResult<Readonly<{ value: number }>>
		let savedMutation!: WorkbenchMutationState<number, Readonly<{ value: number }>>
		let setVisible!: (visible: boolean) => void
		let setInput!: (input: number) => void
		function Child({ input }: Readonly<{ input: number }>) {
			savedQuery = query.useQuery(input)
			savedMutation = mutation.useMutation()
			return <span>{savedQuery.data?.value ?? 'pending'}</span>
		}
		function Page() {
			const [visible, updateVisible] = useState(true)
			const [input, updateInput] = useState(1)
			setVisible = updateVisible
			setInput = updateInput
			return visible ? <Child input={input} /> : <span>hidden</span>
		}
		const opened = await renderOpened(identity, scope.render(Page), { snapshot: vi.fn() })
		await vi.waitFor(() => expect(opened.dom.textContent).toBe('1'))
		const firstQuery = savedQuery

		await act(async () => setInput(2))
		await vi.waitFor(() => expect(opened.dom.textContent).toBe('2'))
		expect(() => firstQuery.invalidate()).toThrowError(
			expect.objectContaining({ code: 'WORKBENCH_RENDERER_HOOK_INACTIVE' }),
		)
		await expect(firstQuery.refetch()).rejects.toMatchObject({
			code: 'WORKBENCH_RENDERER_HOOK_INACTIVE',
		})

		await act(async () => setVisible(false))
		expect(() => savedQuery.invalidate()).toThrowError(
			expect.objectContaining({ code: 'WORKBENCH_RENDERER_HOOK_INACTIVE' }),
		)
		await expect(savedQuery.refetch()).rejects.toMatchObject({
			code: 'WORKBENCH_RENDERER_HOOK_INACTIVE',
		})
		expect(() => savedMutation.mutate(2)).toThrowError(
			expect.objectContaining({ code: 'WORKBENCH_RENDERER_HOOK_INACTIVE' }),
		)
		await expect(savedMutation.mutateAsync(2)).rejects.toMatchObject({
			code: 'WORKBENCH_RENDERER_HOOK_INACTIVE',
		})
		expect(queryFn).toHaveBeenCalledTimes(2)
		expect(mutationFn).not.toHaveBeenCalled()
		await opened.dispose()
	})

	it('keeps successful data when a background refresh fails', async () => {
		const failure = new Error('background failed')
		const queryFn = vi.fn().mockResolvedValueOnce({ value: 1 }).mockRejectedValueOnce(failure)
		const scope = createWorkbenchRenderer(QueryWorkbench.query)
		const query = scope.query(() => ({ queryKey: ['background-failure'], queryFn }))
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

	it('makes concurrent refetch calls join the current initial read', async () => {
		const firstRead = deferred<Readonly<{ value: number }>>()
		const queryFn = vi.fn(() => firstRead.promise)
		const scope = createWorkbenchRenderer(QueryWorkbench.query)
		const query = scope.query(() => ({ queryKey: ['concurrent-refetch'], queryFn }))
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
		await act(async () => {
			firstRead.resolve({ value: 1 })
			await expect(Promise.all([firstRefetch, secondRefetch])).resolves.toEqual([
				{ value: 1 },
				{ value: 1 },
			])
		})
		expect(queryFn).toHaveBeenCalledTimes(1)
		expect(opened.dom.textContent).toBe('1')
		await opened.dispose()
	})

	it('keeps a shared subscription leased across concurrent disabled refetch cancellation', async () => {
		const cancelledRead = deferred<Readonly<{ value: number }>>()
		const latestRead = deferred<Readonly<{ value: number }>>()
		const subscriptionDisposers: ReturnType<typeof vi.fn>[] = []
		const subscribe = vi.fn(() => {
			const dispose = vi.fn()
			subscriptionDisposers.push(dispose)
			return { [Symbol.dispose]: dispose }
		})
		const queryFn = vi
			.fn()
			.mockResolvedValueOnce({ value: 1 })
			.mockImplementationOnce(() => cancelledRead.promise)
			.mockImplementationOnce(() => latestRead.promise)
		const scope = createWorkbenchRenderer(QueryWorkbench.query)
		const query = scope.query(() => ({
			queryKey: ['disabled-concurrent-refetch'],
			queryFn,
			enabled: false,
			workbench: { subscribe },
		}))
		let observed!: WorkbenchQueryResult<Readonly<{ value: number }>>
		function Page() {
			observed = query.useQuery()
			return <p>{observed.data?.value ?? 'pending'}</p>
		}
		const opened = await renderOpened(identity, scope.render(Page), { snapshot: vi.fn() })
		await act(async () => expect(observed.refetch()).resolves.toEqual({ value: 1 }))
		await vi.waitFor(() => expect(subscriptionDisposers[0]).toHaveBeenCalledTimes(1))

		let first!: Promise<Readonly<{ value: number }>>
		act(() => {
			first = observed.refetch()
		})
		await vi.waitFor(() => expect(queryFn).toHaveBeenCalledTimes(2))
		let second!: Promise<Readonly<{ value: number }>>
		act(() => {
			second = observed.refetch()
		})
		await vi.waitFor(() => expect(queryFn).toHaveBeenCalledTimes(3))
		act(() => cancelledRead.resolve({ value: 2 }))
		await Promise.resolve()
		expect(subscriptionDisposers[1]).not.toHaveBeenCalled()

		await act(async () => {
			latestRead.resolve({ value: 3 })
			const results = await Promise.allSettled([first, second])
			expect(results[1]).toEqual({ status: 'fulfilled', value: { value: 3 } })
		})
		await vi.waitFor(() => expect(subscriptionDisposers[1]).toHaveBeenCalledTimes(1))
		await opened.dispose()
	})

	it('turns a throwing retry predicate into query error state and cancels retries on close', async () => {
		const retryFailure = new Error('retry predicate failed')
		const queryFn = vi.fn(() => Promise.reject(new Error('read failed')))
		const retry = vi.fn(() => {
			throw retryFailure
		})
		const scope = createWorkbenchRenderer(QueryWorkbench.query)
		const query = scope.query(() => ({
			queryKey: ['retry-predicate'],
			queryFn,
			retry: (_failureCount, error) => retry({ failureCount: 1, error }),
		}))
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
		const retryingQuery = retryingScope.query(() => ({
			queryKey: ['retry-close'],
			queryFn: retryingFn,
			retry: 5,
		}))
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

	it('uses TanStack retryDelay semantics without retrying Workbench boundary failures', async () => {
		const readFailure = new Error('transient read failure')
		const retryDelay = vi.fn(() => 0)
		const retriedQueryFn = vi
			.fn()
			.mockRejectedValueOnce(readFailure)
			.mockRejectedValueOnce(readFailure)
			.mockResolvedValueOnce({ value: 3 })
		const boundaryRetryDelay = vi.fn(() => 0)
		const boundaryQueryFn = vi.fn(() => ({ missing: undefined }))
		const scope = createWorkbenchRenderer(QueryWorkbench.query)
		const retried = scope.query(() => ({
			queryKey: ['retry-delay'],
			queryFn: retriedQueryFn,
			retry: 2,
			retryDelay,
		}))
		const boundary = scope.query(() => ({
			queryKey: ['boundary-no-retry'],
			queryFn: boundaryQueryFn as never,
			retry: true,
			retryDelay: boundaryRetryDelay,
		}))
		let boundaryResult: WorkbenchQueryResult<unknown> | undefined
		function Page() {
			const retriedResult = retried.useQuery()
			boundaryResult = boundary.useQuery()
			return <p>{`${retriedResult.data?.value ?? 'pending'}:${boundaryResult.status}`}</p>
		}
		const opened = await renderOpened(identity, scope.render(Page), { snapshot: vi.fn() })
		await vi.waitFor(() => expect(opened.dom.textContent).toBe('3:error'))
		expect(retriedQueryFn).toHaveBeenCalledTimes(3)
		expect(retryDelay.mock.calls.map(([failureCount]) => failureCount)).toEqual([0, 1])
		expect(boundaryQueryFn).toHaveBeenCalledTimes(1)
		expect(boundaryRetryDelay).not.toHaveBeenCalled()
		expect(boundaryResult?.error).toMatchObject({ code: 'WORKBENCH_NON_PORTABLE_VALUE' })
		await opened.dispose()
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
		const first = scope.query(() => ({
			queryKey: ['dispose-first'],
			queryFn: firstRead,
			workbench: { subscribe: () => ({ [Symbol.dispose]: firstDispose }) },
		}))
		const second = scope.query(() => ({
			queryKey: ['dispose-second'],
			queryFn: secondRead,
			workbench: { subscribe: () => ({ [Symbol.dispose]: secondDispose }) },
		}))
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
})

describe('Workbench renderer mutation resource', () => {
	it('is single-flight per hook, detaches its result, invalidates, and resets settled state', async () => {
		const result = deferred<Readonly<{ value: number }>>()
		const resultDispose = vi.fn()
		let reads = 0
		const scope = createWorkbenchRenderer(QueryWorkbench.query)
		const query = scope.query(() => ({
			queryKey: ['mutation-snapshot'],
			queryFn: () => ({ value: ++reads }),
		}))
		const invalidations = [query]
		const save = scope.mutation(() => ({
			mutationFn: (value: number) => {
				void value
				return result.promise
			},
			workbench: { invalidates: invalidations },
		}))
		let mutation: WorkbenchMutationState<number, Readonly<{ value: number }>> | undefined
		function Page() {
			const snapshot = query.useQuery()
			mutation = save.useMutation()
			return <p>{`${snapshot.data?.value ?? 'pending'}:${mutation.status}`}</p>
		}
		const opened = await renderOpened(identity, scope.render(Page), { snapshot: vi.fn() })
		await vi.waitFor(() => expect(opened.dom.textContent).toBe('1:idle'))
		invalidations.length = 0

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
		const query = scope.query(() => ({
			queryKey: ['invalidates-validation'],
			queryFn: () => ({ value: 1 }),
		}))
		const mutationFn = vi.fn(() => ({ value: 1 }))
		const malformed = scope.mutation(() => ({
			mutationFn,
			workbench: { invalidates: (() => null) as never },
		}))
		const oversized = scope.mutation(() => ({
			mutationFn,
			workbench: { invalidates: () => Array.from({ length: 129 }, () => query) },
		}))
		let malformedState: WorkbenchMutationState<void, Readonly<{ value: number }>> | undefined
		let oversizedState: WorkbenchMutationState<void, Readonly<{ value: number }>> | undefined
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

	it('rejects sparse invalidations before the mutation and deduplicates repeated targets', async () => {
		let reads = 0
		const scope = createWorkbenchRenderer(QueryWorkbench.query)
		const query = scope.query(() => ({
			queryKey: ['deduplicated-invalidation'],
			queryFn: () => ({ value: ++reads }),
		}))
		const sparseMutationFn = vi.fn(() => undefined)
		const sparse = scope.mutation(() => ({
			mutationFn: sparseMutationFn,
			workbench: {
				invalidates: () => {
					const targets: unknown[] = []
					targets.length = 1
					return targets as never
				},
			},
		}))
		const duplicate = scope.mutation(() => ({
			mutationFn: () => undefined,
			workbench: {
				invalidates: [query, query, query],
			},
		}))
		let sparseState: WorkbenchMutationState<void, void> | undefined
		let duplicateState: WorkbenchMutationState<void, void> | undefined
		function Page() {
			const snapshot = query.useQuery()
			sparseState = sparse.useMutation()
			duplicateState = duplicate.useMutation()
			return <p>{snapshot.data?.value ?? 'pending'}</p>
		}
		const opened = await renderOpened(identity, scope.render(Page), { snapshot: vi.fn() })
		await vi.waitFor(() => expect(opened.dom.textContent).toBe('1'))

		await act(async () => {
			await expect(sparseState!.mutateAsync()).rejects.toBeInstanceOf(Error)
		})
		expect(sparseMutationFn).not.toHaveBeenCalled()
		await act(async () => {
			await duplicateState!.mutateAsync()
		})
		await vi.waitFor(() => expect(opened.dom.textContent).toBe('2'))
		expect(reads).toBe(2)
		await opened.dispose()
	})

	it('invokes zero-variable mutation functions and invalidation selectors with zero arguments', async () => {
		let mutationArgumentCount = -1
		let invalidationArgumentCount = -1
		const scope = createWorkbenchRenderer(QueryWorkbench.query)
		const mutation = scope.mutation(() => ({
			mutationFn: (...args: []) => {
				mutationArgumentCount = args.length
			},
			workbench: {
				invalidates: (...args: []) => {
					invalidationArgumentCount = args.length
					return []
				},
			},
		}))
		let state: WorkbenchMutationState<void, void> | undefined
		function Page() {
			state = mutation.useMutation()
			return null
		}
		const opened = await renderOpened(identity, scope.render(Page), { snapshot: vi.fn() })

		await act(async () => {
			await state!.mutateAsync()
		})
		expect(invalidationArgumentCount).toBe(0)
		expect(mutationArgumentCount).toBe(0)
		await opened.dispose()
	})

	it('supports input-derived exact and static broad keyed invalidation targets', async () => {
		type Key = 'first' | 'second'
		const reads: Record<Key, number> = { first: 0, second: 0 }
		let unrelatedReads = 0
		const scope = createWorkbenchRenderer(QueryWorkbench.query)
		const query = scope.queryFamily((_context, input: Key) => ({
			queryKey: ['keyed', input],
			queryFn: () => ({ value: ++reads[input] }),
		}))
		const unrelated = scope.queryFamily((_context, input: Key) => ({
			queryKey: ['unrelated', input],
			queryFn: () => ({ value: ++unrelatedReads }),
		}))
		const invalidateExact = scope.mutation(() => ({
			mutationFn: (input: Key) => {
				void input
			},
			workbench: { invalidates: (input: Key) => [query.target(input)] },
		}))
		const invalidateAll = scope.mutation(() => ({
			mutationFn: () => undefined,
			workbench: { invalidates: [query.all()] },
		}))
		let exactState: WorkbenchMutationState<Key, void> | undefined
		let allState: WorkbenchMutationState<void, void> | undefined
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
		const foreignQuery = foreignScope.query(() => ({
			queryKey: ['foreign'],
			queryFn: () => ({ value: 1 }),
		}))
		const keyedQuery = scope.queryFamily((_context, input: Readonly<{ id: number }>) => ({
			queryKey: ['validation', input],
			queryFn: () => ({ value: input.id }),
		}))
		const mutationFn = vi.fn(() => ({ value: 1 }))
		const foreignMutation = scope.mutation(() => ({
			mutationFn,
			workbench: { invalidates: [foreignQuery] as never },
		}))
		const invalidKeyMutation = scope.mutation(() => ({
			mutationFn,
			workbench: { invalidates: () => [keyedQuery.target({ id: Number.NaN })] },
		}))
		let foreign: WorkbenchMutationState<void, Readonly<{ value: number }>> | undefined
		let invalidKey: WorkbenchMutationState<void, Readonly<{ value: number }>> | undefined
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
		const query = scope.query(() => ({
			queryKey: ['settle-invalidation'],
			queryFn: () => ({ value: ++reads }),
		}))
		const rejected = scope.mutation(() => ({
			mutationFn: () => Promise.reject(domainFailure),
			workbench: { invalidates: [query] },
		}))
		const invalidResult = scope.mutation(() => ({
			mutationFn: () =>
				Promise.resolve(
					Object.defineProperty({ missing: undefined }, Symbol.dispose, {
						value: invalidDispose,
					}),
				),
			workbench: { invalidates: [query] },
		}))
		let rejectState: WorkbenchMutationState<void, never> | undefined
		let invalidState: WorkbenchMutationState<void, Readonly<{ missing: undefined }>> | undefined
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
		let mutation: WorkbenchMutationState<number, Readonly<{ value: number }>> | undefined
		let executionSignal: AbortSignal | undefined
		const scope = createWorkbenchRenderer(QueryWorkbench.query)
		const save = scope.mutation(({ signal }) => ({
			mutationFn: (value: number) => {
				executionSignal = signal
				void value
				return result.promise
			},
		}))
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

function disposableDeferred<Value>() {
	const operation = deferred<Value>()
	const dispose = vi.fn()
	const promise = operation.promise as Promise<Value> & Disposable
	Object.defineProperty(promise, Symbol.dispose, { value: dispose })
	return { ...operation, promise, dispose }
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
	const ownerController = new AbortController()
	const provider = createWorkbenchBridge(declaration, Renderer)
	const application = provider()
	const dom = document.createElement('div')
	try {
		await act(() =>
			application.render({
				dom,
				moduleName: 'pluxel_workbench_query/views/query',
				__pluxelWorkbench: {
					profile: 1,
					handle: openedHandles[0],
					host,
					ownerSignal: ownerController.signal,
				},
			}),
		)
	} catch (error) {
		act(() => application.destroy({ dom, moduleName: 'query' }))
		ownerController.abort()
		for (const handle of openedHandles) handle[Symbol.dispose]()
		throw error
	}
	return {
		dom,
		abortOwner() {
			ownerController.abort()
		},
		async replaceApi(nextApi: object) {
			const handle = await open(nextApi)
			openedHandles.push(handle)
			await act(() =>
				application.render({
					dom,
					moduleName: 'pluxel_workbench_query/views/query',
					__pluxelWorkbench: {
						profile: 1,
						handle,
						host,
						ownerSignal: ownerController.signal,
					},
				}),
			)
		},
		async dispose() {
			act(() => application.destroy({ dom, moduleName: 'query' }))
			ownerController.abort()
			for (const handle of openedHandles) handle[Symbol.dispose]()
		},
	}
}
