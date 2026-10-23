import type { TypstRenderer } from '@myriaddreamin/typst.ts/renderer'
import type { TypstNavigationPoint, TypstPreview } from '../preview-contract.js'
import { pointAtPreview, pointAtSource, type SourcePosition } from './navigation.js'

export type {
	TypstPreview,
	TypstNavigation,
	TypstNavigationPoint,
	TypstOutlineItem,
	TypstPage,
} from '../preview-contract.js'
export type { TypstDiagnostic } from '../errors.js'
export { pointAtPreview, pointAtSource, type SourcePosition } from './navigation.js'

/** A read-only snapshot. The preview is the exact packet most recently displayed. */
export interface TypstPreviewState {
	readonly preview?: TypstPreview
	readonly pageCount: number
	readonly currentPage: number
	/** Index into preview.navigation.outline, or -1 before the first heading. */
	readonly currentHeading: number
}

export interface TypstPreviewViewOptions {
	readonly container: HTMLElement
	readonly renderer: Pick<TypstRenderer, 'runWithSession' | 'manipulateData' | 'renderSvg'>
	readonly sessionId: string
	/** Defaults to container. Owns scrolling, while container owns the rendered SVG. */
	readonly scrollContainer?: HTMLElement
	/** Called synchronously after display or viewport state changes; never after disposal. */
	readonly onStateChange?: (state: TypstPreviewState) => void
	/**
	 * Host-owned source/draft currency check, evaluated for each navigation action.
	 * Defaults to true. Asynchronous host navigation must recheck after awaiting.
	 */
	readonly isNavigationCurrent?: (preview: TypstPreview) => boolean
	/** A completed, unmodified pointer click. The callback is not awaited. */
	readonly onNavigate?: (hit: {
		readonly preview: TypstPreview
		readonly point: TypstNavigationPoint
	}) => void
}

/** Owns a container; the initialized upstream renderer remains caller-owned. */
export class TypstPreviewView implements AsyncDisposable {
	private readonly container: HTMLElement
	private readonly renderer: Pick<TypstRenderer, 'runWithSession' | 'manipulateData' | 'renderSvg'>
	private readonly sessionId: string
	private readonly scrollContainer: HTMLElement
	private readonly onStateChange?: TypstPreviewViewOptions['onStateChange']
	private readonly isNavigationCurrent?: TypstPreviewViewOptions['isNavigationCurrent']
	private readonly onNavigate?: TypstPreviewViewOptions['onNavigate']
	private pages: SVGGraphicsElement[] = []
	private currentState: TypstPreviewState = Object.freeze({
		pageCount: 0,
		currentPage: 1,
		currentHeading: -1,
	})
	private pointerStart?: {
		x: number
		y: number
		pointerId: number
		dragged: boolean
		preview?: TypstPreview
	}
	private highlight?: SVGRectElement
	private highlightTimer?: ReturnType<typeof setTimeout>
	private readonly resizeObserver?: ResizeObserver
	private newestRevision = 0
	private displayedRevision = 0
	private generation = 0
	private closed = false
	private tail: Promise<unknown> = Promise.resolve()
	private closing?: Promise<void>

	constructor(options: TypstPreviewViewOptions) {
		if (!options.sessionId) throw new TypeError('Preview requires a sessionId')
		this.container = options.container
		this.renderer = options.renderer
		this.sessionId = options.sessionId
		this.scrollContainer = options.scrollContainer ?? options.container
		this.onStateChange = options.onStateChange
		this.isNavigationCurrent = options.isNavigationCurrent
		this.onNavigate = options.onNavigate
		this.container.addEventListener('pointerdown', this.pointerDown)
		this.container.addEventListener('pointermove', this.pointerMove)
		this.container.addEventListener('pointercancel', this.pointerCancel)
		this.container.addEventListener('pointerup', this.pointerUp)
		this.scrollContainer.addEventListener('scroll', this.refresh, { passive: true })
		if (typeof ResizeObserver !== 'undefined') {
			this.resizeObserver = new ResizeObserver(this.refresh)
			this.resizeObserver.observe(this.scrollContainer)
			if (this.container !== this.scrollContainer) this.resizeObserver.observe(this.container)
		}
	}

	get state(): TypstPreviewState {
		return this.currentState
	}

	/**
	 * Resolves true after displaying this revision; false for a stale or foreign packet.
	 * Renderer errors reject and preserve the previous picture. Retry is allowed.
	 * Keep packet bytes unchanged until this promise settles.
	 */
	async show(packet: TypstPreview): Promise<boolean> {
		if (this.closed) throw new Error('Typst preview is disposed')
		if (packet.sessionId !== this.sessionId) return false
		if (packet.format !== 'vector' || packet.compilerVersion !== '0.7.0') {
			throw new TypeError('Preview requires vector artifacts from typst.ts 0.7.0')
		}
		if (
			!Number.isSafeInteger(packet.revision) ||
			packet.revision < 1 ||
			!(packet.data instanceof Uint8Array)
		) {
			throw new TypeError('Invalid Typst preview revision or bytes')
		}
		if (packet.revision < this.newestRevision || packet.revision <= this.displayedRevision)
			return false
		this.newestRevision = packet.revision
		const generation = ++this.generation
		const current = () => !this.closed && generation === this.generation
		const work = this.tail.then(async () => {
			if (!current()) return false
			const svg = await this.renderer.runWithSession(async (renderSession) => {
				this.renderer.manipulateData({ renderSession, action: 'reset', data: packet.data })
				return this.renderer.renderSvg({
					renderSession,
					data_selection: { body: true, defs: true, css: true, js: false },
				})
			})
			if (!current()) return false
			this.clearHighlight()
			this.container.innerHTML = svg
			this.pages = [...this.container.querySelectorAll<SVGGraphicsElement>('.typst-page')]
			this.displayedRevision = packet.revision
			this.currentState = Object.freeze({
				preview: packet,
				pageCount: this.pages.length,
				currentPage: 1,
				currentHeading: -1,
			})
			this.refresh()
			return true
		})
		this.tail = work.catch(() => {})
		return work
	}

	/** Recompute page/outline tracking after attaching a detached container or changing layout. */
	refresh = (): void => {
		if (this.closed || !this.currentState.preview) return
		const viewport = this.scrollContainer
		const threshold =
			viewport.getBoundingClientRect().top + Math.min(120, viewport.clientHeight / 3)
		let currentPage = 1
		for (const [index, page] of this.pages.entries()) {
			if (this.pageTop(page) <= threshold) currentPage = index + 1
		}
		// A short final page may fit below the tracking threshold at maximum scroll.
		if (
			this.pages.length > 0 &&
			viewport.scrollHeight > viewport.clientHeight &&
			viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 2
		)
			currentPage = this.pages.length
		let currentHeading = -1
		for (const [index, item] of this.currentState.preview.navigation.outline.entries()) {
			const matrix = this.pages[item.page - 1]?.getScreenCTM()
			if (matrix && matrix.b * item.x + matrix.d * item.y + matrix.f <= threshold)
				currentHeading = index
		}
		this.publishState(currentPage, currentHeading)
	}

	/** Scroll to a one-based page, clamping to the displayed page range. */
	jumpToPage(requested: number): boolean {
		if (this.closed || !Number.isFinite(requested) || this.pages.length === 0) return false
		const next = Math.max(1, Math.min(this.pages.length, Math.round(requested)))
		const page = this.pages[next - 1]
		const viewport = this.scrollContainer
		viewport.scrollTo({
			top: viewport.scrollTop + this.pageTop(page) - viewport.getBoundingClientRect().top - 18,
		})
		this.refresh()
		return this.publishState(next, this.currentState.currentHeading)
	}

	/** Scroll to a page-local position in Typst points; SVG CTM accounts for zoom. */
	jumpToPosition(position: {
		readonly page: number
		readonly x: number
		readonly y: number
	}): boolean {
		if (this.closed) return false
		const matrix = this.pages[position.page - 1]?.getScreenCTM()
		if (!matrix) return false
		const viewport = this.scrollContainer
		const screenY = matrix.b * position.x + matrix.d * position.y + matrix.f
		viewport.scrollTo({
			top:
				viewport.scrollTop +
				screenY -
				viewport.getBoundingClientRect().top -
				Math.min(120, viewport.clientHeight / 3),
		})
		this.refresh()
		return this.publishState(position.page, this.currentState.currentHeading)
	}

	/** Reveal and briefly highlight a source span; this never calls onNavigate. */
	revealSource(position: SourcePosition): boolean {
		const preview = this.currentState.preview
		if (!preview || this.closed || this.isNavigationCurrent?.(preview) === false) return false
		const point = pointAtSource(preview.navigation.points, position, this.currentState.currentPage)
		const page = point && this.pages[point.page - 1]
		if (!point || !page || !this.jumpToPosition(point)) return false
		this.clearHighlight()
		const rectangle = this.container.ownerDocument.createElementNS(
			'http://www.w3.org/2000/svg',
			'rect',
		)
		rectangle.classList.add('preview-source-highlight')
		for (const [name, value] of Object.entries({
			x: point.x - 2,
			y: point.y - 2,
			width: point.width + 4,
			height: point.height + 4,
			rx: 2,
			fill: '#96f2d7',
			'fill-opacity': 0.45,
			stroke: '#12b886',
			'stroke-width': 1.3,
			'vector-effect': 'non-scaling-stroke',
			'pointer-events': 'none',
		}))
			rectangle.setAttribute(name, String(value))
		page.append(rectangle)
		this.highlight = rectangle
		this.highlightTimer = setTimeout(() => {
			rectangle.remove()
			if (this.highlight === rectangle) this.highlight = undefined
			this.highlightTimer = undefined
		}, 1400)
		return true
	}

	private publishState(currentPage: number, currentHeading: number): boolean {
		if (this.closed) return false
		this.currentState = Object.freeze({ ...this.currentState, currentPage, currentHeading })
		this.onStateChange?.(this.currentState)
		return !this.closed
	}

	private pageTop(page: SVGGraphicsElement): number {
		return page.getScreenCTM()?.f ?? page.getBoundingClientRect().top
	}

	private clearHighlight(): void {
		clearTimeout(this.highlightTimer)
		this.highlightTimer = undefined
		this.highlight?.remove()
		this.highlight = undefined
	}

	private pointerDown = (event: PointerEvent): void => {
		this.pointerStart =
			event.button === 0 && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
				? {
						x: event.clientX,
						y: event.clientY,
						pointerId: event.pointerId,
						dragged: false,
						preview: this.currentState.preview,
					}
				: undefined
	}

	private pointerMove = (event: PointerEvent): void => {
		const start = this.pointerStart
		if (
			start?.pointerId === event.pointerId &&
			Math.hypot(start.x - event.clientX, start.y - event.clientY) > 4
		)
			start.dragged = true
	}

	private pointerCancel = (): void => {
		this.pointerStart = undefined
	}

	private pointerUp = (event: PointerEvent): void => {
		const start = this.pointerStart
		this.pointerStart = undefined
		const preview = this.currentState.preview
		if (
			this.closed ||
			!start ||
			start.dragged ||
			start.pointerId !== event.pointerId ||
			event.button !== 0 ||
			event.ctrlKey ||
			event.metaKey ||
			event.altKey ||
			event.shiftKey ||
			Math.hypot(start.x - event.clientX, start.y - event.clientY) > 4 ||
			!preview ||
			start.preview !== preview ||
			this.isNavigationCurrent?.(preview) === false
		)
			return
		const target = event.target as Element | null
		const element = target?.closest?.<SVGGraphicsElement>('.typst-page')
		const page = element ? this.pages.indexOf(element) + 1 : 0
		const inverse = element?.getScreenCTM()?.inverse()
		if (!page || !inverse) return
		const point = pointAtPreview(
			preview.navigation.points,
			page,
			inverse.a * event.clientX + inverse.c * event.clientY + inverse.e,
			inverse.b * event.clientX + inverse.d * event.clientY + inverse.f,
		)
		if (point) this.onNavigate?.({ preview, point })
	}

	/** Waits for in-flight rendering and its upstream session cleanup. */
	dispose(): Promise<void> {
		if (this.closing) return this.closing
		this.closed = true
		this.pointerStart = undefined
		this.clearHighlight()
		this.resizeObserver?.disconnect()
		this.container.removeEventListener('pointerdown', this.pointerDown)
		this.container.removeEventListener('pointermove', this.pointerMove)
		this.container.removeEventListener('pointercancel', this.pointerCancel)
		this.container.removeEventListener('pointerup', this.pointerUp)
		this.scrollContainer.removeEventListener('scroll', this.refresh)
		this.closing = this.tail.then(() => {
			this.container.replaceChildren()
			this.pages = []
			this.currentState = Object.freeze({ pageCount: 0, currentPage: 1, currentHeading: -1 })
			return undefined
		})
		return this.closing
	}

	[Symbol.asyncDispose](): Promise<void> {
		return this.dispose()
	}
}
