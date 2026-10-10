import { describe, expect, it, vi } from 'vitest'
import type { RenderSession, TypstRenderer } from '@myriaddreamin/typst.ts'
import { TypstPreviewView, type TypstPreview } from '../src/browser/preview.js'

const packet = (revision: number, sessionId = 'session'): TypstPreview => ({
	sessionId,
	revision,
	format: 'vector',
	compilerVersion: '0.7.0',
	data: new Uint8Array([revision]),
})

function fixture() {
	const element = {
		innerHTML: 'old',
		replaceChildren() {
			element.innerHTML = ''
		},
	}
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
		renderer,
		cleanup,
		view: new TypstPreviewView({ container, renderer, sessionId: 'session' }),
	}
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
})
