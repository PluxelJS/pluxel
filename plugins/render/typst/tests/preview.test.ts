import { describe, expect, it, vi } from 'vitest'
import type { RenderSession, TypstRenderer } from '@myriaddreamin/typst.ts'
import {
	TypstPreviewView,
	type TypstNavigationPoint,
	type TypstPreview,
	type TypstPreviewViewOptions,
} from '../src/browser/preview.js'

const packet = (revision: number, sessionId = 'session'): TypstPreview => ({
	sessionId,
	revision,
	format: 'vector',
	compilerVersion: '0.7.0',
	data: new Uint8Array([revision]),
	navigation: { points: [], outline: [], pages: [] },
})

function fixture(
	options: Pick<
		TypstPreviewViewOptions,
		'onNavigate' | 'onStateChange' | 'isNavigationCurrent'
	> = {},
	pageTops: readonly number[] = [],
) {
	const scroll = Object.assign(new EventTarget(), {
		clientHeight: 300,
		scrollHeight: pageTops.length > 0 ? 1000 : 0,
		scrollTop: 0,
		getBoundingClientRect: () => ({ top: 0 }),
		scrollTo({ top }: { top: number }) {
			this.scrollTop = top
			scroll.dispatchEvent(new Event('scroll'))
		},
	})
	const rectangles: {
		classList: { add: ReturnType<typeof vi.fn> }
		setAttribute: ReturnType<typeof vi.fn>
		remove: ReturnType<typeof vi.fn>
	}[] = []
	const pages = pageTops.map((top) => ({
		append: vi.fn(),
		getScreenCTM: () => ({
			a: 2,
			b: 0,
			c: 0,
			d: 2,
			e: 100,
			f: top - scroll.scrollTop,
			inverse: () => ({ a: 0.5, b: 0, c: 0, d: 0.5, e: -50, f: (scroll.scrollTop - top) / 2 }),
		}),
	}))
	const element = Object.assign(new EventTarget(), {
		innerHTML: 'old',
		querySelectorAll: () => pages,
		closest: () => pages[0],
		ownerDocument: {
			createElementNS: () => {
				const rectangle = { classList: { add: vi.fn() }, setAttribute: vi.fn(), remove: vi.fn() }
				rectangles.push(rectangle)
				return rectangle
			},
		},
		replaceChildren() {
			element.innerHTML = ''
		},
	})
	const container = element as unknown as HTMLElement
	const cleanup = vi.fn()
	const renderSession = {} as RenderSession
	const renderer: Pick<TypstRenderer, 'runWithSession' | 'manipulateData' | 'renderSvg'> = {
		runWithSession: vi.fn(async (...args: unknown[]) => {
			try {
				return await (args.at(-1) as (session: RenderSession) => Promise<unknown>)(renderSession)
			} finally {
				cleanup()
			}
		}) as TypstRenderer['runWithSession'],
		manipulateData: vi.fn(),
		renderSvg: vi.fn(async () => '<svg>new</svg>'),
	}
	return {
		container,
		scroll,
		pages,
		rectangles,
		renderer,
		cleanup,
		view: new TypstPreviewView({
			container,
			scrollContainer: scroll as unknown as HTMLElement,
			renderer,
			sessionId: 'session',
			...options,
		}),
	}
}

const text: TypstNavigationPoint = {
	path: '报表/排版.typ',
	line: 4,
	column: 3,
	endLine: 4,
	endColumn: 9,
	page: 1,
	x: 50,
	y: 60,
	width: 100,
	height: 12,
}

function pointer(container: HTMLElement, type: string, options: Partial<PointerEvent> = {}) {
	container.dispatchEvent(
		Object.assign(new Event(type), {
			button: 0,
			pointerId: 1,
			clientX: 220,
			clientY: 146,
			ctrlKey: false,
			metaKey: false,
			shiftKey: false,
			altKey: false,
			...options,
		}),
	)
}

describe('TypstPreviewView', () => {
	it('uses a full reset, displays only the matching newer revision and cleans native sessions', async () => {
		const { view, renderer, container, cleanup } = fixture()
		expect(await view.show(packet(2))).toBe(true)
		expect(container.innerHTML).toBe('<svg>new</svg>')
		expect(renderer.manipulateData).toHaveBeenCalledWith(
			expect.objectContaining({ action: 'reset', data: packet(2).data }),
		)
		expect(cleanup).toHaveBeenCalledTimes(1)
		expect(await view.show(packet(1))).toBe(false)
		expect(await view.show(packet(2))).toBe(false)
		expect(await view.show(packet(3, 'foreign'))).toBe(false)
		expect(cleanup).toHaveBeenCalledTimes(1)
		await view.dispose()
	})

	it('does not flash a superseded in-flight render', async () => {
		const { view, renderer, container } = fixture()
		let finish!: (svg: string) => void
		vi.mocked(renderer.renderSvg).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve
				}),
		)
		const first = view.show(packet(1))
		await vi.waitFor(() => expect(finish).toBeDefined())
		const second = view.show(packet(2))
		finish('<svg>stale</svg>')
		expect(await first).toBe(false)
		expect(container.innerHTML).not.toBe('<svg>stale</svg>')
		expect(await second).toBe(true)
		expect(container.innerHTML).toBe('<svg>new</svg>')
		await view.dispose()
	})

	it('preserves the old picture on renderer failure and permits retry', async () => {
		const { view, renderer, container, cleanup } = fixture()
		vi.mocked(renderer.renderSvg).mockRejectedValueOnce(new Error('renderer failed'))
		await expect(view.show(packet(1))).rejects.toThrow('renderer failed')
		expect(container.innerHTML).toBe('old')
		expect(cleanup).toHaveBeenCalledTimes(1)
		expect(await view.show(packet(1))).toBe(true)
		await view.dispose()
	})

	it('waits for renderer cleanup during idempotent disposal and never commits afterward', async () => {
		const { view, renderer, container, cleanup } = fixture()
		let finish!: (svg: string) => void
		vi.mocked(renderer.renderSvg).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve
				}),
		)
		const first = view.show(packet(1))
		await vi.waitFor(() => expect(finish).toBeDefined())
		const queued = view.show(packet(2))
		const closing = view.dispose()
		expect(view.dispose()).toBe(closing)
		expect(cleanup).not.toHaveBeenCalled()
		finish('<svg>late</svg>')
		expect(await first).toBe(false)
		expect(await queued).toBe(false)
		await closing
		expect(cleanup).toHaveBeenCalledTimes(1)
		expect(container.innerHTML).toBe('')
		await expect(view.show(packet(3))).rejects.toThrow('disposed')
	})

	it('rejects incompatible and malformed packets without rendering', async () => {
		const { view, renderer } = fixture()
		await expect(
			view.show({ ...packet(1), compilerVersion: 'wrong' } as unknown as TypstPreview),
		).rejects.toThrow('0.7.0')
		await expect(view.show(packet(NaN))).rejects.toThrow('revision')
		expect(renderer.renderSvg).not.toHaveBeenCalled()
		await view.dispose()
	})

	it('publishes page and outline state, follows scrolling, and includes a short final page', async () => {
		const onStateChange = vi.fn()
		const { view, scroll } = fixture({ onStateChange }, [20, 420, 850])
		const preview = {
			...packet(1),
			navigation: {
				pages: [],
				points: [],
				outline: [
					{ title: '正文', level: 1, page: 1, x: 50, y: 0 },
					{ title: '附录', level: 1, page: 2, x: 50, y: 0 },
				],
			},
		}
		await view.show(preview)
		expect(view.state).toMatchObject({ preview, pageCount: 3, currentPage: 1, currentHeading: 0 })
		expect(view.jumpToPage(2)).toBe(true)
		expect(view.state).toMatchObject({ currentPage: 2, currentHeading: 1 })
		scroll.scrollTop = 700
		scroll.dispatchEvent(new Event('scroll'))
		expect(view.state.currentPage).toBe(3)
		expect(view.jumpToPage(NaN)).toBe(false)
		expect(view.jumpToPage(99)).toBe(true)
		expect(view.state.currentPage).toBe(3)
		await view.dispose()
		const notifications = onStateChange.mock.calls.length
		scroll.dispatchEvent(new Event('scroll'))
		expect(onStateChange).toHaveBeenCalledTimes(notifications)
	})

	it.each([
		{ action: 'page', disposeAt: 1 },
		{ action: 'position', disposeAt: 1 },
		{ action: 'source', disposeAt: 1 },
		{ action: 'source', disposeAt: 2 },
	])(
		'stops $action navigation when state notification $disposeAt disposes the view',
		async ({ action, disposeAt }) => {
			vi.useFakeTimers()
			try {
				const onStateChange = vi.fn()
				const { view, scroll, container, pages, rectangles } = fixture({ onStateChange }, [20])
				await view.show({
					...packet(1),
					navigation: { pages: [], outline: [], points: [text] },
				})
				// Native scroll events arrive later; exercise both synchronous navigation notifications.
				vi.spyOn(scroll, 'scrollTo').mockImplementation(({ top }) => {
					scroll.scrollTop = top
				})
				onStateChange.mockClear()
				onStateChange.mockImplementation(() => {
					if (onStateChange.mock.calls.length === disposeAt) void view.dispose()
				})
				const navigated =
					action === 'page'
						? view.jumpToPage(1)
						: action === 'position'
							? view.jumpToPosition(text)
							: view.revealSource({ path: text.path, line: 4, column: 5 })
				expect(navigated).toBe(false)
				expect(onStateChange).toHaveBeenCalledTimes(disposeAt)
				expect(rectangles).toHaveLength(0)
				expect(pages[0].append).not.toHaveBeenCalled()
				expect(vi.getTimerCount()).toBe(0)
				await view.dispose()
				expect(container.innerHTML).toBe('')
				scroll.dispatchEvent(new Event('scroll'))
				expect(onStateChange).toHaveBeenCalledTimes(disposeAt)
			} finally {
				vi.useRealTimers()
			}
		},
	)

	it('converts zoomed SVG clicks to page points and rejects drag, modified, canceled and stale intent', async () => {
		const onNavigate = vi.fn()
		let current = true
		const { view, container } = fixture({ onNavigate, isNavigationCurrent: () => current }, [20])
		const preview = { ...packet(1), navigation: { pages: [], outline: [], points: [text] } }
		await view.show(preview)
		pointer(container, 'pointerdown')
		pointer(container, 'pointerup')
		expect(onNavigate).toHaveBeenLastCalledWith({ preview, point: text })
		pointer(container, 'pointerdown')
		pointer(container, 'pointermove', { clientX: 230 })
		pointer(container, 'pointerup')
		pointer(container, 'pointerdown', { ctrlKey: true })
		pointer(container, 'pointerup')
		pointer(container, 'pointerdown')
		pointer(container, 'pointerup', { shiftKey: true })
		pointer(container, 'pointerdown')
		pointer(container, 'pointercancel')
		pointer(container, 'pointerup')
		pointer(container, 'pointerdown')
		pointer(container, 'pointerup', { pointerId: 2 })
		current = false
		pointer(container, 'pointerdown')
		pointer(container, 'pointerup')
		expect(onNavigate).toHaveBeenCalledTimes(1)
		current = true
		pointer(container, 'pointerdown')
		await view.show({ ...preview, revision: 2 })
		pointer(container, 'pointerup')
		expect(onNavigate).toHaveBeenCalledTimes(1)
		await view.dispose()
		pointer(container, 'pointerdown')
		pointer(container, 'pointerup')
		expect(onNavigate).toHaveBeenCalledTimes(1)
	})

	it('reveals repeated source near the selected page without a navigation loop and clears its highlight', async () => {
		vi.useFakeTimers()
		try {
			const onNavigate = vi.fn()
			let current = true
			const { view, pages, rectangles } = fixture(
				{ onNavigate, isNavigationCurrent: () => current },
				[20, 420],
			)
			const repeated = { ...text, page: 2 }
			await view.show({
				...packet(1),
				navigation: { pages: [], outline: [], points: [text, repeated] },
			})
			view.jumpToPage(2)
			expect(view.revealSource({ path: text.path, line: 4, column: 5 })).toBe(true)
			expect(pages[0].append).not.toHaveBeenCalled()
			expect(pages[1].append).toHaveBeenCalledWith(rectangles[0])
			expect(rectangles[0].setAttribute).toHaveBeenCalledWith('x', '48')
			expect(onNavigate).not.toHaveBeenCalled()
			vi.advanceTimersByTime(1400)
			expect(rectangles[0].remove).toHaveBeenCalledTimes(1)
			current = false
			expect(view.revealSource({ path: text.path, line: 4, column: 5 })).toBe(false)
			current = true
			view.revealSource({ path: text.path, line: 4, column: 5 })
			await view.dispose()
			expect(rectangles[1].remove).toHaveBeenCalledTimes(1)
			vi.advanceTimersByTime(1400)
			expect(rectangles[1].remove).toHaveBeenCalledTimes(1)
		} finally {
			vi.useRealTimers()
		}
	})
})
