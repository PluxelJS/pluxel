// @vitest-environment jsdom

import { parsePluginDefinitionAddress, parsePluginNodeAddress } from '@pluxel/core'
import { parseWorkbenchDeclarationIdentity } from '@pluxel/core/federation'
import { StrictMode, act, useState, type ReactNode, type ComponentType } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { type RpcStub, type RpcTarget } from 'capnweb'
import { workbench } from '@pluxel/workbench'
import {
	openWorkbenchEntry,
	type WorkbenchLayoutEntry,
	type WorkbenchSessionApi,
} from '@pluxel/workbench/client'
import {
	createWorkbenchRenderer,
	type WorkbenchHostFacade,
	type WorkbenchMutationState,
	type WorkbenchQueryResult,
	type WorkbenchRendererScope,
} from '@pluxel/workbench/react'
import {
	createWorkbenchBridge,
	readWorkbenchBridgeIdentity,
	readWorkbenchBridgeProvider,
} from '@pluxel/workbench/internal/react'

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)

interface QueryApi extends RpcTarget {
	snapshot(): Readonly<{ value: number }>
}

const rendererEntry = './fixtures/query.tsx'
const QueryWorkbench = workbench.define(import.meta.url, {
	query: workbench.view<QueryApi>({
		renderer: rendererEntry,
		placement: { kind: 'tab', label: 'Query' },
	}),
})
const OtherWorkbench = workbench.define(import.meta.url, {
	other: workbench.view<QueryApi>({
		renderer: rendererEntry,
		placement: { kind: 'tab', label: 'Other' },
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
	it('lends each Bridge root to its own consumers and keeps their caches independent', async () => {
		const scope = createWorkbenchRenderer(QueryWorkbench.query)
		const borrowed = new Set<RpcStub<QueryApi>>()
		const snapshots = new Set<Readonly<{ value: number }>>()
		let observedHost: WorkbenchHostFacade | undefined
		let renderedProps: Readonly<Record<string, never>> | undefined
		const query = scope.query(({ api }) => {
			borrowed.add(api)
			return { queryKey: ['snapshot'], queryFn: () => api.snapshot() }
		})
		const mutation = scope.mutation(({ api }) => {
			borrowed.add(api)
			return { mutationFn: () => api.snapshot() }
		})
		function Consumer() {
			const current = scope.useWorkbench()
			borrowed.add(current.api)
			observedHost = current.host
			mutation.useMutation()
			const { data } = query.useQuery()
			if (data) snapshots.add(data)
			return <span>{data?.value ?? 'pending'}</span>
		}
		const Page = scope.render(function Page() {
			const [visible, setVisible] = useState(true)
			return (
				<StrictMode>
					<button type="button" aria-label="Hide one consumer" onClick={() => setVisible(false)} />
					{visible && <Consumer />}
					<Consumer />
				</StrictMode>
			)
		})
		function Renderer(props: Readonly<Record<string, never>>) {
			renderedProps = props
			return <Page />
		}
		const firstValue = { value: 1 }
		const secondValue = { value: 2 }
		const firstApi = { snapshot: vi.fn(() => firstValue), dup: vi.fn(), [Symbol.dispose]: vi.fn() }
		const secondApi = {
			snapshot: vi.fn(() => secondValue),
			dup: vi.fn(),
			[Symbol.dispose]: vi.fn(),
		}
		await using first = await renderOpened(Renderer, firstApi)
		await using second = await renderOpened(Renderer, secondApi)
		await vi.waitFor(() => {
			expect(first.dom.textContent).toBe('11')
			expect(second.dom.textContent).toBe('22')
		})
		expect(readWorkbenchBridgeProvider(first.provider)).toBe(first.provider)
		expect(readWorkbenchBridgeIdentity(first.provider)).toEqual(identity)
		expect(renderedProps).toEqual({})
		expect(observedHost).toBe(host)
		expect(borrowed).toEqual(new Set([firstApi, secondApi]))
		for (const value of [firstValue, secondValue]) {
			expect(snapshots.has(value)).toBe(true)
			expect(Object.isFrozen(value)).toBe(true)
		}
		await act(async () => first.dom.querySelector('button')!.click())
		expect(first.dom.textContent).toBe('1')
		await first.dispose()
		expect(second.dom.textContent).toBe('22')
		for (const api of [firstApi, secondApi]) {
			expect(api.snapshot).toHaveBeenCalledOnce()
			expect(api.dup).not.toHaveBeenCalled()
			expect(api[Symbol.dispose]).not.toHaveBeenCalled()
		}
	})

	it('rejects the wrong descriptor before a renderer can invoke its RPC API', async () => {
		using _consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
		const snapshot = vi.fn()
		const wrong = createWorkbenchRenderer(OtherWorkbench.other)
		const WrongRenderer = wrong.render(function WrongRenderer() {
			const { api } = wrong.useWorkbench()
			void api.snapshot()
			return null
		})
		await using opened = await renderOpened(WrongRenderer, { snapshot })
		expect(opened.dom.textContent).toContain('descriptor identity does not match this renderer')
		expect(snapshot).not.toHaveBeenCalled()
	})

	it('rejects unsupported query options when the factory binds to an owner', async () => {
		using _consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
		const scope = createWorkbenchRenderer(QueryWorkbench.query)
		const unsupportedQuery = scope.query((() => ({
			queryKey: ['malformed'],
			queryFn: () => ({ value: 1 }),
			select: (result: { value: number }) => result.value,
		})) as never)
		function Page(): ReactNode {
			unsupportedQuery.useQuery()
			return null
		}
		await using opened = await renderOpened(scope.render(Page))
		expect(opened.dom.textContent).toMatch(/unsupported option "select"/i)
	})

	it('shares one subscription and coalesces notifications during setup and the first read', async () => {
		const events: string[] = []
		const firstRead = Promise.withResolvers<ReturnType<typeof disposableValue>>()
		const secondRead = Promise.withResolvers<ReturnType<typeof disposableValue>>()
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
					next()
					return { [Symbol.dispose]: watchDispose }
				},
			},
		}))
		function Child(): ReactNode {
			const value = query.useQuery()
			return <span>{value.data?.value ?? 'pending'}</span>
		}
		function Page(): ReactNode {
			return (
				<StrictMode>
					<Child />
					<Child />
				</StrictMode>
			)
		}
		await using opened = await renderOpened(scope.render(Page))

		await vi.waitFor(() => expect(queryFn).toHaveBeenCalledTimes(1))
		expect(events).toEqual(['watch', 'read-1'])
		act(() => {
			invalidate!()
			invalidate!()
		})
		expect(queryFn).toHaveBeenCalledOnce()
		firstRead.resolve(disposableValue(1, firstDispose))
		await vi.waitFor(() => expect(queryFn).toHaveBeenCalledTimes(2))
		secondRead.resolve(disposableValue(2, secondDispose))
		await vi.waitFor(() => expect(opened.dom.textContent).toBe('22'))
		expect(events).toEqual(['watch', 'read-1', 'read-2'])
		expect(queryFn).toHaveBeenCalledTimes(2)
		expect(watchDispose).not.toHaveBeenCalled()
		expect(firstDispose).toHaveBeenCalledTimes(1)
		expect(secondDispose).toHaveBeenCalledTimes(1)

		await opened.dispose()
		expect(watchDispose).toHaveBeenCalledTimes(1)
	})

	it('disposes a watch that resolves after the renderer closes without starting a read', async () => {
		const watch = Promise.withResolvers<Disposable>()
		const settledWatchDispose = vi.fn()
		const subscribe = vi.fn(() => watch.promise)
		const queryFn = vi.fn(() => ({ value: 1 }))
		const scope = createWorkbenchRenderer(QueryWorkbench.query)
		const query = scope.query(() => ({
			queryKey: ['late-watch'],
			queryFn,
			workbench: { subscribe },
		}))
		function Page(): ReactNode {
			query.useQuery()
			return null
		}
		await using opened = await renderOpened(scope.render(Page))
		await vi.waitFor(() => expect(subscribe).toHaveBeenCalledOnce())
		await opened.dispose()

		watch.resolve({ [Symbol.dispose]: settledWatchDispose })
		await vi.waitFor(() => expect(settledWatchDispose).toHaveBeenCalledOnce())
		expect(queryFn).not.toHaveBeenCalled()
	})

	it('closes renderer resources synchronously when the host owner signal aborts', async () => {
		const read = Promise.withResolvers<ReturnType<typeof disposableValue>>()
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
		function Page(): ReactNode {
			query.useQuery()
			return null
		}
		await using opened = await renderOpened(scope.render(Page))
		await vi.waitFor(() => expect(readSignal?.aborted).toBe(false))

		opened.abortOwner()
		expect(readSignal?.aborted).toBe(true)
		expect(subscriptionDispose).toHaveBeenCalledTimes(1)

		read.resolve(disposableValue(1, resultDispose))
		await vi.waitFor(() => expect(resultDispose).toHaveBeenCalledTimes(1))
	})

	it('keeps query ownership coherent when one render creates many inactive keys', async () => {
		const read = Promise.withResolvers<ReturnType<typeof disposableValue>>()
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
		function Child({ input }: Readonly<{ input: number }>): ReactNode {
			query.useQuery(input)
			return null
		}
		function Page(): ReactNode {
			return Array.from({ length: 129 }, (_, input) => <Child key={input} input={input} />)
		}
		await using opened = await renderOpened(scope.render(Page))
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
		function Child({ slot, input }: Readonly<{ slot: number; input: number }>): ReactNode {
			return <span data-slot={slot}>{query.useQuery(input).data?.value ?? 'pending'},</span>
		}
		function Page(): ReactNode {
			const [first, setFirst] = useState(0)
			replaceFirst = () => setFirst(64)
			return Array.from({ length: 64 }, (_, slot) => (
				<Child key={slot} slot={slot} input={slot === 0 ? first : slot} />
			))
		}
		await using opened = await renderOpened(scope.render(Page))
		await vi.waitFor(() => expect(queryFn).toHaveBeenCalledTimes(64))

		await act(async () => replaceFirst())
		await vi.waitFor(() => expect(queryFn).toHaveBeenCalledTimes(65))
		expect(opened.dom.querySelector('[data-slot="0"]')?.textContent).toBe('64,')
		expect(opened.dom.textContent).not.toMatch(/too many active query keys/i)
	})

	it('shares structural keys and rejects unsafe or oversized invalidation keys', async () => {
		type Input = Readonly<{ a: number; b: number }>
		const queryFn = vi.fn(({ a, b }: Input) => ({ value: a + b }))
		const scope = createWorkbenchRenderer(QueryWorkbench.query)
		const query = scope.queryFamily((_context, input: Input) => ({
			queryKey: ['sum', input],
			queryFn: () => queryFn(input),
		}))
		const mutationFn = vi.fn<(input: unknown) => void>()
		const mutation = scope.mutation(() => ({
			mutationFn,
			workbench: { invalidates: (input: unknown) => [query.target(input as Input)] },
		}))
		let invalidate!: WorkbenchMutationState<unknown, void>
		function Sum({ input }: { input: Input }) {
			return <span>{query.useQuery(input).data?.value ?? 'pending'}</span>
		}
		await using opened = await renderOpened(
			scope.render(function Page() {
				invalidate = mutation.useMutation()
				return (
					<>
						<Sum input={{ a: 1, b: 2 }} />
						<Sum input={{ b: 2, a: 1 }} />
					</>
				)
			}),
		)
		await vi.waitFor(() => expect(opened.dom.textContent).toBe('33'))
		expect(queryFn).toHaveBeenCalledOnce()

		class ArrayKey extends Array<unknown> {}
		const hiddenIndex = ['unsafe']
		Object.defineProperty(hiddenIndex, '0', { value: 'unsafe', enumerable: false })
		for (const [input, code] of [
			[new ArrayKey('unsafe'), 'WORKBENCH_RESOURCE_KEY_INVALID'],
			[
				Object.defineProperty({ a: 1, b: 2 }, 'hidden', { value: 3 }),
				'WORKBENCH_RESOURCE_KEY_INVALID',
			],
			[hiddenIndex, 'WORKBENCH_RESOURCE_KEY_INVALID'],
			[{ a: 1, b: 2, extra: 'x'.repeat(16_385) }, 'WORKBENCH_RESOURCE_LIMIT_EXCEEDED'],
		] as const) {
			await act(async () => {
				await expect(invalidate.mutateAsync(input)).rejects.toMatchObject({ code })
			})
		}
		expect(mutationFn).not.toHaveBeenCalled()
	})

	it('remounts local state and lets the new owner mutate while the old owner is still settling', async () => {
		const firstResult = Promise.withResolvers<ReturnType<typeof disposableValue>>()
		const firstDispose = vi.fn()
		const firstApi = { snapshot: vi.fn(() => firstResult.promise) }
		const secondApi = { snapshot: vi.fn(() => ({ value: 2 })) }
		const scope = createWorkbenchRenderer(QueryWorkbench.query)
		const save = scope.mutation(({ api }) => ({
			mutationFn: (_value: number) => api.snapshot(),
		}))
		let mutation: WorkbenchMutationState<number, Readonly<{ value: number }>> | undefined
		let setLocal!: (value: number) => void
		function Page(): ReactNode {
			const [local, updateLocal] = useState(0)
			setLocal = updateLocal
			mutation = save.useMutation()
			return <p>{`${local}:${mutation.status}:${mutation.data?.value ?? 'none'}`}</p>
		}
		await using opened = await renderOpened(scope.render(Page), firstApi)
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
	})

	it('re-establishes an async subscription before reading after observer reactivation', async () => {
		const firstSubscription = Promise.withResolvers<Disposable>()
		const secondSubscription = Promise.withResolvers<Disposable>()
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
		await using opened = await renderObserver(scope, function Observer() {
			return <span>{query.useQuery().data?.value ?? 'pending'}</span>
		})
		await vi.waitFor(() => expect(subscribe).toHaveBeenCalledTimes(1))
		expect(queryFn).not.toHaveBeenCalled()

		await opened.setVisible(false)
		await opened.setVisible(true)
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
		await using opened = await renderObserver(scope, function Observer() {
			return <span>{query.useQuery().data?.value ?? 'pending'}</span>
		})
		await vi.waitFor(() => expect(subscribe).toHaveBeenCalledTimes(1))

		await opened.setVisible(false)
		await vi.waitFor(() => expect(firstSubscription.dispose).toHaveBeenCalledTimes(1))
		await opened.setVisible(true)
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
		const staleRead = Promise.withResolvers<ReturnType<typeof disposableValue>>()
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
		await using opened = await renderObserver(scope, function Observer() {
			return <span>{query.useQuery().data?.value ?? 'pending'}</span>
		})
		await vi.waitFor(() => expect(opened.dom.textContent).toBe('1'))
		act(() => latestInvalidate?.())
		await vi.waitFor(() => expect(queryFn).toHaveBeenCalledTimes(2))

		await opened.setVisible(false)
		await vi.waitFor(() => expect(staleSignal?.aborted).toBe(true))
		await opened.setVisible(true)
		await vi.waitFor(() => expect(subscribe).toHaveBeenCalledTimes(2))
		await vi.waitFor(() => expect(opened.dom.textContent).toBe('3'))
		expect(queryFn).toHaveBeenCalledTimes(3)

		staleRead.resolve(disposableValue(2, staleDispose))
		await vi.waitFor(() => expect(staleDispose).toHaveBeenCalledTimes(1))
		expect(opened.dom.textContent).toBe('3')
	})

	it('keeps cached data and revokes invalidation when renewing the subscription fails', async () => {
		const subscribeFailure = new Error('reactivated subscription failed')
		const firstDispose = vi.fn()
		let failedInvalidate!: () => void
		const subscribe = vi
			.fn()
			.mockImplementationOnce(() => ({ [Symbol.dispose]: firstDispose }))
			.mockImplementationOnce(({ invalidate }: { invalidate: () => void }) => {
				failedInvalidate = invalidate
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
		await using opened = await renderObserver(scope, function Observer() {
			observed = query.useQuery()
			return <span>{`${observed.status}:${observed.data?.value ?? 'none'}`}</span>
		})
		await vi.waitFor(() => expect(opened.dom.textContent).toBe('success:1'))

		await opened.setVisible(false)
		expect(firstDispose).toHaveBeenCalledTimes(1)
		await opened.setVisible(true)
		await vi.waitFor(() => expect(opened.dom.textContent).toBe('error:1'))
		expect(observed.error).toBe(subscribeFailure)

		await act(async () => failedInvalidate())
		expect(subscribe).toHaveBeenCalledTimes(2)
		expect(queryFn).toHaveBeenCalledTimes(1)
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
		function Child({ input }: Readonly<{ input: number }>): ReactNode {
			savedQuery = query.useQuery(input)
			savedMutation = mutation.useMutation()
			return <span>{savedQuery.data?.value ?? 'pending'}</span>
		}
		function Page(): ReactNode {
			const [visible, updateVisible] = useState(true)
			const [input, updateInput] = useState(1)
			setVisible = updateVisible
			setInput = updateInput
			return visible ? <Child input={input} /> : <span>hidden</span>
		}
		await using opened = await renderOpened(scope.render(Page))
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
	})

	it('keeps successful data when a background refresh fails', async () => {
		const failure = new Error('background failed')
		const queryFn = vi.fn().mockResolvedValueOnce({ value: 1 }).mockRejectedValueOnce(failure)
		const scope = createWorkbenchRenderer(QueryWorkbench.query)
		const query = scope.query(() => ({ queryKey: ['background-failure'], queryFn }))
		let observed: WorkbenchQueryResult<Readonly<{ value: number }>> | undefined
		function Page(): ReactNode {
			observed = query.useQuery()
			return <p>{`${observed.status}:${observed.data?.value ?? 'none'}`}</p>
		}
		await using opened = await renderOpened(scope.render(Page))
		await vi.waitFor(() => expect(opened.dom.textContent).toBe('success:1'))

		act(() => observed!.invalidate())
		await vi.waitFor(() => expect(opened.dom.textContent).toBe('error:1'))
		expect(observed).toMatchObject({ error: failure, isStale: true, data: { value: 1 } })
	})

	it('keeps a shared subscription leased across concurrent disabled refetch cancellation', async () => {
		const cancelledRead = Promise.withResolvers<Readonly<{ value: number }>>()
		const latestRead = Promise.withResolvers<Readonly<{ value: number }>>()
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
		function Page(): ReactNode {
			observed = query.useQuery()
			return <p>{observed.data?.value ?? 'pending'}</p>
		}
		await using opened = await renderOpened(scope.render(Page))
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
		await vi.waitFor(() => {
			expect(subscriptionDisposers[1]).toHaveBeenCalledOnce()
			expect(opened.dom.textContent).toBe('3')
		})
	})

	it('turns a throwing retry predicate into query error state and cancels retries on close', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
		try {
			const readFailure = new Error('read failed')
			const retryFailure = new Error('retry predicate failed')
			const retry = vi.fn(() => {
				throw retryFailure
			})
			const retryingFn = vi.fn(async () => {
				throw readFailure
			})
			const retryDelay = vi.fn(() => 100)
			const scope = createWorkbenchRenderer(QueryWorkbench.query)
			const throwing = scope.query(() => ({
				queryKey: ['retry-predicate'],
				queryFn: async () => {
					throw readFailure
				},
				retry,
			}))
			const retrying = scope.query(() => ({
				queryKey: ['retry-close'],
				queryFn: retryingFn,
				retry: 5,
				retryDelay,
			}))
			let observed: WorkbenchQueryResult<never> | undefined
			function Page(): ReactNode {
				observed = throwing.useQuery()
				retrying.useQuery()
				return null
			}
			await using opened = await renderOpened(scope.render(Page))
			await act(() => vi.advanceTimersByTimeAsync(0))
			expect(observed).toMatchObject({ status: 'error', error: retryFailure })
			expect(retry).toHaveBeenCalledExactlyOnceWith(0, readFailure)
			expect(retryDelay).toHaveBeenCalledExactlyOnceWith(0, readFailure)
			expect(retryingFn).toHaveBeenCalledOnce()
			await opened.dispose()
			await act(() => vi.advanceTimersByTimeAsync(100))
			expect(retryingFn).toHaveBeenCalledOnce()
		} finally {
			vi.useRealTimers()
		}
	})

	it('uses TanStack retryDelay semantics without retrying Workbench boundary failures', async () => {
		const readFailure = new Error('transient read failure')
		const retryDelay = vi.fn((_failureCount: number, _error: unknown) => 0)
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
		function Page(): ReactNode {
			const retriedResult = retried.useQuery()
			boundaryResult = boundary.useQuery()
			return <p>{`${retriedResult.data?.value ?? 'pending'}:${boundaryResult.status}`}</p>
		}
		await using opened = await renderOpened(scope.render(Page))
		await vi.waitFor(() => expect(opened.dom.textContent).toBe('3:error'))
		expect(retriedQueryFn).toHaveBeenCalledTimes(3)
		expect(retryDelay.mock.calls.map(([failureCount]) => failureCount)).toEqual([0, 1])
		expect(boundaryQueryFn).toHaveBeenCalledTimes(1)
		expect(boundaryRetryDelay).not.toHaveBeenCalled()
		expect(boundaryResult?.error).toMatchObject({ code: 'WORKBENCH_NON_PORTABLE_VALUE' })
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
		function Page(): ReactNode {
			first.useQuery()
			second.useQuery()
			return null
		}
		await using opened = await renderOpened(scope.render(Page))
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
	it('is single-flight per hook, consumes its result, invalidates, and resets settled state', async () => {
		const result = Promise.withResolvers<Readonly<{ value: number }>>()
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
		function Page(): ReactNode {
			const snapshot = query.useQuery()
			mutation = save.useMutation()
			return <p>{`${snapshot.data?.value ?? 'pending'}:${mutation.status}`}</p>
		}
		await using opened = await renderOpened(scope.render(Page))
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
	})

	it('rejects invalid mutation targets before invoking the mutation', async () => {
		const scope = createWorkbenchRenderer(QueryWorkbench.query)
		const query = scope.query(() => ({
			queryKey: ['invalidates-validation'],
			queryFn: () => ({ value: 1 }),
		}))
		const keyedQuery = scope.queryFamily((_context, id: number) => ({
			queryKey: ['keyed', id],
			queryFn: () => ({ value: id }),
		}))
		const foreignScope = createWorkbenchRenderer(QueryWorkbench.query)
		const foreignQuery = foreignScope.query(() => ({
			queryKey: ['foreign'],
			queryFn: () => ({ value: 1 }),
		}))
		const mutationFn = vi.fn<(targets: unknown) => void>()
		const mutation = scope.mutation(() => ({
			mutationFn,
			workbench: { invalidates: (targets: unknown) => targets as never },
		}))
		let state!: WorkbenchMutationState<unknown, void>
		function Page(): ReactNode {
			state = mutation.useMutation()
			return null
		}
		await using _opened = await renderOpened(scope.render(Page))

		await act(async () => state.mutate(null))
		expect(state).toMatchObject({
			status: 'error',
			error: { message: '[workbench/react] mutation invalidates() must return an array' },
		})
		const sparseTargets: unknown[] = []
		sparseTargets.length = 1
		for (const { targets, error } of [
			{
				targets: Array.from({ length: 129 }, () => query),
				error: { code: 'WORKBENCH_RESOURCE_LIMIT_EXCEEDED' },
			},
			{
				targets: sparseTargets,
				error: { message: '[workbench/react] mutation invalidates must be a dense array' },
			},
			{ targets: [query, foreignQuery], error: { code: 'WORKBENCH_RENDERER_SCOPE_MISMATCH' } },
			{
				targets: [keyedQuery.target(Number.NaN)],
				error: { code: 'WORKBENCH_RESOURCE_KEY_INVALID' },
			},
		]) {
			await act(async () => {
				await expect(state.mutateAsync(targets)).rejects.toMatchObject(error)
			})
			expect(state).toMatchObject({ status: 'error', error })
		}
		expect(mutationFn).not.toHaveBeenCalled()
	})

	it('invalidates exact or broad keyed targets once and leaves unrelated data alone', async () => {
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
		const invalidateAllFn = vi.fn<() => void>()
		const family = query.all()
		const allTargets = vi.fn(() => [family, family, family])
		const invalidateAll = scope.mutation(() => ({
			mutationFn: invalidateAllFn,
			workbench: { invalidates: allTargets },
		}))
		let exactState: WorkbenchMutationState<Key, void> | undefined
		let allState: WorkbenchMutationState<void, void> | undefined
		function Page(): ReactNode {
			const first = query.useQuery('first')
			const second = query.useQuery('second')
			const separate = unrelated.useQuery('first')
			exactState = invalidateExact.useMutation()
			allState = invalidateAll.useMutation()
			return (
				<p>{`${first.data?.value ?? 0}${second.data?.value ?? 0}${separate.data?.value ?? 0}`}</p>
			)
		}
		await using opened = await renderOpened(scope.render(Page))
		await vi.waitFor(() => expect(opened.dom.textContent).toBe('111'))

		await act(async () => {
			await exactState!.mutateAsync('first')
		})
		await vi.waitFor(() => expect(opened.dom.textContent).toBe('211'))

		await act(async () => {
			await allState!.mutateAsync()
		})
		expect(invalidateAllFn).toHaveBeenCalledExactlyOnceWith()
		expect(allTargets).toHaveBeenCalledExactlyOnceWith()
		await vi.waitFor(() => expect(opened.dom.textContent).toBe('321'))
		expect(reads).toEqual({ first: 3, second: 2 })
	})

	it('refreshes after a rejected write and after an unreadable write receipt', async () => {
		const domainFailure = new Error('write outcome is unknown')
		const disposeReceipt = vi.fn()
		const mutationFn = vi
			.fn<() => Promise<{ receipt: undefined }>>()
			.mockRejectedValueOnce(domainFailure)
			.mockResolvedValueOnce(
				Object.defineProperty({ receipt: undefined }, Symbol.dispose, {
					value: disposeReceipt,
				}),
			)
		let reads = 0
		const scope = createWorkbenchRenderer(QueryWorkbench.query)
		const query = scope.query(() => ({
			queryKey: ['settle-invalidation'],
			queryFn: () => ({ value: ++reads }),
		}))
		const mutation = scope.mutation(() => ({ mutationFn, workbench: { invalidates: [query] } }))
		let state!: WorkbenchMutationState<void, { receipt: undefined }>
		await using opened = await renderOpened(
			scope.render(function Page() {
				state = mutation.useMutation()
				return <p>{query.useQuery().data?.value ?? 'pending'}</p>
			}),
		)
		await vi.waitFor(() => expect(opened.dom.textContent).toBe('1'))
		await act(async () => expect(state.mutateAsync()).rejects.toBe(domainFailure))
		await vi.waitFor(() => expect(opened.dom.textContent).toBe('2'))
		expect(state.status).toBe('error')

		await act(async () => {
			await expect(state.mutateAsync()).rejects.toMatchObject({
				code: 'WORKBENCH_NON_PORTABLE_VALUE',
			})
		})
		await vi.waitFor(() => expect(opened.dom.textContent).toBe('3'))
		expect(state.status).toBe('error')
		expect(disposeReceipt).toHaveBeenCalledOnce()
	})

	it('rejects promptly on renderer close while still disposing the late result', async () => {
		const result = Promise.withResolvers<Readonly<{ value: number }>>()
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
		function Page(): ReactNode {
			mutation = save.useMutation()
			return <p>{mutation.status}</p>
		}
		await using opened = await renderOpened(scope.render(Page))
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

function disposableDeferred<Value>() {
	const operation = Promise.withResolvers<Value>()
	const dispose = vi.fn()
	const promise = operation.promise as Promise<Value> & Disposable
	Object.defineProperty(promise, Symbol.dispose, { value: dispose })
	return { ...operation, promise, dispose }
}

const moduleName = 'pluxel_workbench_query/views/query'
const federatedViewRef = {
	profile: 1,
	producer: 'pluxel_workbench_query',
	buildRevision: 'build-1',
	manifestUrl: '/__pluxel/runtime/federation/pluxel_workbench_query/build-1/mf-manifest.json',
	expose: './views/query',
	descriptor: identity,
} as const
const entry: WorkbenchLayoutEntry = {
	descriptor: identity as Extract<typeof identity, { kind: 'view' }>,
	target: { node, displayName: 'Query' },
	renderer: node,
	definitionRevisions: { target: 1, renderer: 1 },
	placement: QueryWorkbench.query.placement,
	federatedViewRef,
}

async function openQueryView(api: object) {
	if (!(Symbol.dispose in api)) Object.defineProperty(api, Symbol.dispose, { value() {} })
	const session = {
		async openEntry() {
			return {
				ok: true,
				value: { kind: 'local', api, params: {}, federatedViewRef },
				[Symbol.dispose]() {},
			}
		},
	} as unknown as RpcStub<WorkbenchSessionApi>
	const result = await openWorkbenchEntry(session, entry, { layoutRevision: 1 })
	if (!result.ok) throw new Error('Expected the query view to open')
	return result.handle
}

async function renderOpened(Renderer: ComponentType, api: object = {}) {
	const handles = [await openQueryView(api)]
	const controller = new AbortController()
	const provider = createWorkbenchBridge(identity, Renderer)
	const application = provider()
	const dom = document.createElement('div')
	const render = (handle: (typeof handles)[number]) =>
		act(() =>
			application.render({
				dom,
				moduleName,
				__pluxelWorkbench: { profile: 1, handle, host, ownerSignal: controller.signal },
			}),
		)
	let closed = false
	async function dispose() {
		if (closed) return
		closed = true
		try {
			await act(async () => application.destroy({ dom, moduleName }))
		} finally {
			controller.abort()
			for (const handle of handles) handle[Symbol.dispose]()
		}
	}

	try {
		await render(handles[0]!)
	} catch (error) {
		await dispose()
		throw error
	}

	return {
		dom,
		provider,
		abortOwner: () => controller.abort(),
		async replaceApi(nextApi: object) {
			const handle = await openQueryView(nextApi)
			handles.push(handle)
			await render(handle)
		},
		dispose,
		[Symbol.asyncDispose]: dispose,
	}
}

async function renderObserver(
	scope: WorkbenchRendererScope<typeof QueryWorkbench.query>,
	Observer: ComponentType,
) {
	let updateVisibility!: (visible: boolean) => void
	const opened = await renderOpened(
		scope.render(function Page() {
			const [visible, setVisible] = useState(true)
			updateVisibility = setVisible
			return visible ? <Observer /> : null
		}),
	)
	return {
		...opened,
		setVisible: (visible: boolean) => act(async () => updateVisibility(visible)),
	}
}
