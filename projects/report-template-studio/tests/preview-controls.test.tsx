// @vitest-environment jsdom
import { MantineProvider } from '@mantine/core'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type {
	TypstPreview,
	TypstPreviewState,
	TypstPreviewViewOptions,
	TypstPreviewZoom,
} from '@pluxel/plugin-typst/browser'
import { Preview } from '../src/renderer/preview'
import { WorkspaceController } from '../src/renderer/workspace'
import type { PreviewResult } from '../src/shared/contracts'

// The shared View owns SVG sizing/coordinates; these cases exercise the Studio host controls.
const views: PreviewViewDouble[] = []
class PreviewViewDouble {
	state: TypstPreviewState = { currentPage: 1, pageCount: 0, currentHeading: -1, zoom: 'fit-width' }
	constructor(readonly options: TypstPreviewViewOptions) {
		views.push(this)
	}
	update(state: Partial<TypstPreviewState>) {
		this.state = { ...this.state, ...state }
		this.options.onStateChange?.(this.state)
	}
	show = vi.fn(async (preview: TypstPreview) => {
		this.update({ preview, pageCount: preview.navigation.pages.length })
		return true
	})
	refresh = () => this.update({})
	setZoom = vi.fn((zoom: TypstPreviewZoom) => {
		this.update({ zoom })
		return true
	})
	jumpToPage = vi.fn((currentPage: number) => {
		this.update({ currentPage })
		return true
	})
	jumpToPosition = vi.fn(() => true)
	revealSource = vi.fn(() => false)
	dispose = vi.fn(async () => {})
}
vi.mock('@pluxel/plugin-typst/browser', () => ({
	TypstPreviewView: class {
		constructor(options: TypstPreviewViewOptions) {
			return new PreviewViewDouble(options)
		}
	},
}))
vi.mock('@myriaddreamin/typst.ts', () => ({
	createTypstRenderer: () => ({ init: async () => {} }),
}))
vi.mock('../src/renderer/api', () => ({ onDesktopConnectionChange: vi.fn(), api: {} }))

let workspace: WorkspaceController
const result: PreviewResult = {
	projectId: 'project',
	entry: 'report/main.ts',
	revision: '1',
	clientRevision: 1,
	sourceRevision: 'source',
	sourceVersions: {},
	preview: {
		sessionId: 'preview',
		revision: 1,
		compilerVersion: '0.7.0',
		format: 'vector',
		data: new Uint8Array(),
		navigation: {
			pages: Array.from({ length: 5 }, (_, index) => ({
				page: index + 1,
				width: 595,
				height: 842,
			})),
			points: [],
			outline: Array.from({ length: 30 }, (_, index) => ({
				title: `章节 ${index} · 长标题保留完整提示`,
				page: Math.floor(index / 6) + 1,
				level: 1,
				x: 24,
				y: index * 24,
			})),
		},
	},
}
beforeEach(() => {
	workspace = new WorkspaceController({ id: 'project', name: 'Project', root: '/project' })
	vi.stubGlobal(
		'ResizeObserver',
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	)
	vi.stubGlobal(
		'matchMedia',
		vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })),
	)
})
afterEach(() => {
	cleanup()
	workspace.dispose()
	views.length = 0
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
})
const content = (value = result) => (
	<MantineProvider>
		<Preview result={value} workspace={workspace} entry={value.entry} />
	</MantineProvider>
)
async function mount() {
	const rendered = render(content())
	await screen.findByRole('combobox', { name: '预览缩放' })
	return rendered
}

it('keeps an in-progress page draft during scroll updates and commits only valid whole pages', async () => {
	await mount()
	const view = views[0]!
	const input = screen.getByRole('textbox', { name: '跳转到页' }) as HTMLInputElement
	expect((screen.getByRole('button', { name: '上一页' }) as HTMLButtonElement).disabled).toBe(true)
	act(() => input.focus())
	fireEvent.change(input, { target: { value: '2' } })
	act(() => view.update({ currentPage: 4 }))
	expect(input.value).toBe('2')
	fireEvent.keyDown(input, { key: 'Enter' })
	expect(view.jumpToPage).toHaveBeenCalledExactlyOnceWith(2)
	expect(input.value).toBe('2')
	view.jumpToPage.mockClear()
	for (const value of ['', '0', '1.5', '6', 'letters']) {
		act(() => input.focus())
		fireEvent.change(input, { target: { value } })
		act(() => input.blur())
		expect(input.value).toBe('2')
	}
	act(() => input.focus())
	fireEvent.change(input, { target: { value: '5' } })
	fireEvent.keyDown(input, { key: 'Escape' })
	expect(view.jumpToPage).not.toHaveBeenCalled()
	expect(input.value).toBe('2')
	act(() => input.focus())
	fireEvent.change(input, { target: { value: '5' } })
	fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
	expect(document.activeElement).toBe(input)
	expect(view.jumpToPage).not.toHaveBeenCalled()
	act(() => input.blur())
	expect(view.jumpToPage).toHaveBeenCalledExactlyOnceWith(5)
	expect((screen.getByRole('button', { name: '下一页' }) as HTMLButtonElement).disabled).toBe(true)
})

it('delegates fitting and numeric zoom to the View and keeps the choice when replacing a result', async () => {
	const rendered = await mount()
	const select = screen.getByRole('combobox', { name: '预览缩放' }) as HTMLSelectElement
	expect(select.value).toBe('fit-width')
	expect(Array.from(select.options, (option) => option.value)).toEqual([
		'fit-width',
		'fit-page',
		'0.5',
		'0.75',
		'1',
		'1.25',
		'1.5',
		'2',
	])
	fireEvent.change(select, { target: { value: 'fit-page' } })
	expect(views[0]!.setZoom).toHaveBeenLastCalledWith('fit-page')
	fireEvent.change(select, { target: { value: '1.5' } })
	expect(views[0]!.setZoom).toHaveBeenLastCalledWith(1.5)
	rendered.rerender(
		content({ ...result, revision: '2', preview: { ...result.preview, revision: 2 } }),
	)
	await waitFor(() => expect(views).toHaveLength(2))
	await waitFor(() => expect(views[1]!.state.zoom).toBe(1.5))
	expect(select.value).toBe('1.5')
	expect(views[0]!.dispose).toHaveBeenCalledOnce()
})

it('reveals the active outline item by scrolling only the navigation and restores toggle focus on close', async () => {
	await mount()
	const view = views[0]!
	const viewport = document.querySelector<HTMLElement>('.preview-scroll')!
	viewport.scrollTop = 400
	vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
		this: HTMLElement,
	) {
		if (this.classList.contains('preview-navigation')) return new DOMRect(0, 100, 160, 400)
		if (this.classList.contains('preview-heading')) {
			const index = Number(this.title.split(' ')[1])
			const nav = this.closest<HTMLElement>('.preview-navigation')!
			return new DOMRect(0, 140 + index * 28 - nav.scrollTop, 150, 28)
		}
		return new DOMRect(0, 0, 0, 0)
	})
	act(() => view.update({ currentHeading: 29, currentPage: 5 }))
	const toggle = screen.getByRole('button', { name: '目录与页面' })
	fireEvent.click(toggle)
	const nav = screen.getByRole('navigation', { name: '文档目录与页面' })
	expect(nav.scrollTop).toBeGreaterThan(0)
	expect(viewport.scrollTop).toBe(400)
	const previous = nav.scrollTop
	act(() => view.update({ currentHeading: 0, currentPage: 1 }))
	expect(nav.scrollTop).toBeLessThan(previous)
	expect(viewport.scrollTop).toBe(400)
	const first = screen.getByRole('button', { name: '章节 0 · 长标题保留完整提示，第 1 页' })
	expect(first.title).toBe('章节 0 · 长标题保留完整提示')
	fireEvent.click(first)
	expect(view.jumpToPosition).toHaveBeenCalledWith(result.preview.navigation.outline[0])
	fireEvent.click(screen.getByRole('button', { name: '关闭目录与页面' }))
	expect(screen.queryByRole('navigation', { name: '文档目录与页面' })).toBeNull()
	expect(document.activeElement).toBe(toggle)
})
