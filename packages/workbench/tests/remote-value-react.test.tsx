// @vitest-environment jsdom
import { act, StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { afterEach, expect, it, vi } from 'vitest'
import { useRemoteValue } from '@pluxel/workbench/react'

afterEach(() => vi.unstubAllGlobals())

it('does not acquire during SSR or abandoned suspended render', async () => {
	vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
	const read = vi.fn(() => 1)
	const subscribe = vi.fn(() => ({ [Symbol.dispose]() {} }))
	function Value() {
		useRemoteValue({ read, subscribe })
		return null
	}
	renderToString(<Value />)
	const pending = new Promise<never>(() => {})
	function Suspended() {
		useRemoteValue({ read, subscribe })
		throw pending
	}
	const root = createRoot(document.createElement('div'))
	await act(() =>
		root.render(
			<Suspense fallback="loading">
				<Suspended />
			</Suspense>,
		),
	)
	await act(() => root.unmount())
	expect(read).not.toHaveBeenCalled()
	expect(subscribe).not.toHaveBeenCalled()
})

it('acquires once through StrictMode replay and releases late subscription after unmount', async () => {
	vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
	const dispose = vi.fn()
	let resolve!: (value: Disposable) => void
	const subscribe = vi.fn(
		() =>
			new Promise<Disposable>((done) => {
				resolve = done
			}),
	)
	const read = vi.fn(() => 1)
	function Value() {
		useRemoteValue({ read, subscribe })
		return null
	}
	const root = createRoot(document.createElement('div'))
	await act(() =>
		root.render(
			<StrictMode>
				<Value />
			</StrictMode>,
		),
	)
	expect(subscribe).toHaveBeenCalledTimes(1)
	await act(() => root.unmount())
	await act(async () => resolve({ [Symbol.dispose]: dispose }))
	expect(dispose).toHaveBeenCalledTimes(1)
	expect(read).not.toHaveBeenCalled()
})

it('isolates dependency changes from late reads', async () => {
	vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
	let resolve!: (value: string) => void
	const first = new Promise<string>((done) => {
		resolve = done
	})
	const dispose = vi.fn()
	function Value({ id }: { id: number }) {
		const value = useRemoteValue(
			{ read: () => (id === 1 ? first : 'new'), subscribe: () => ({ [Symbol.dispose]: dispose }) },
			[id],
		)
		return value.state === 'ready' ? value.value : value.state
	}
	const container = document.createElement('div')
	const root = createRoot(container)
	await act(() => root.render(<Value id={1} />))
	await act(() => root.render(<Value id={2} />))
	await act(async () => resolve('old'))
	expect(container.textContent).toBe('new')
	expect(dispose).toHaveBeenCalledTimes(1)
	await act(() => root.unmount())
	expect(dispose).toHaveBeenCalledTimes(2)
})
