import type { TypstRenderer } from '@myriaddreamin/typst.ts/renderer'
import type { TypstNavigationPoint, TypstPreview } from '../preview-contract.js'
import { pointAtPreview, pointAtSource, type SourcePosition } from './navigation.js'

// typst.ts 0.7.0 emits internal destinations as this fixed SVG callback, even with js: false.
// Read only its numeric arguments; the View owns scrolling and never executes renderer scripts.
const coordinate = '([-+]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][-+]?\\d+)?)'
const locationHandler = new RegExp(
	`^handleTypstLocation\\(this,\\s*(\\d+),\\s*${coordinate},\\s*${coordinate}\\);\\s*return false;?$`,
)
type LinkPosition = { page: number; x: number; y: number }

/** Numeric ratios use CSS print units: 1 means 100%, or 96 CSS pixels per 72 Typst points. */
export type TypstPreviewZoom = 'fit-width' | 'fit-page' | number

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
	/** Defaults to fit-width. Fit-page uses the largest page width and height in the document. */
	readonly zoom: TypstPreviewZoom
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
	/** A completed, unmodified pointer click on non-link content. The callback is not awaited. */
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
	private svg?: SVGSVGElement
	private readingAnchor?: LinkPosition
	private layout?: { width: number; height: number; svgWidth: number }
	private updatingLayout = false
	private links = new WeakMap<Element, LinkPosition | null>()
	private currentState: TypstPreviewState = Object.freeze({
		zoom: 'fit-width',
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
		this.container.addEventListener('click', this.linkClick)
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

	/** Set the scale policy, even before showing a document. Invalid values leave state unchanged. */
	setZoom(zoom: TypstPreviewZoom): boolean {
		if (
			this.closed ||
			(zoom !== 'fit-width' &&
				zoom !== 'fit-page' &&
				(typeof zoom !== 'number' || !Number.isFinite(zoom) || zoom <= 0))
		)
			return false
		if (zoom === this.currentState.zoom) return true
		this.readingAnchor = this.captureAnchor(this.currentState.currentPage) ?? this.readingAnchor
		this.currentState = Object.freeze({ ...this.currentState, zoom })
		this.layout = undefined
		if (this.currentState.preview) this.refresh()
		else this.publishState(this.currentState.currentPage, this.currentState.currentHeading)
		return !this.closed
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
			this.readingAnchor = this.captureAnchor(this.currentState.currentPage) ?? this.readingAnchor
			this.clearHighlight()
			this.container.innerHTML = svg
			this.svg = this.container.querySelector<SVGSVGElement>('svg.typst-doc') ?? undefined
			this.layout = undefined
			this.pages = [...this.container.querySelectorAll<SVGGraphicsElement>('.typst-page')]
			this.links = new WeakMap()
			for (const link of this.container.querySelectorAll<SVGAElement>('a[onclick]')) {
				const match = locationHandler.exec(link.getAttribute('onclick')?.trim() ?? '')
				if (!match) continue
				link.removeAttribute('onclick')
				const position = { page: Number(match[1]), x: Number(match[2]), y: Number(match[3]) }
				const valid =
					Number.isSafeInteger(position.page) &&
					position.page >= 1 &&
					position.page <= this.pages.length &&
					Number.isFinite(position.x) &&
					Number.isFinite(position.y)
				this.links.set(link, valid ? position : null)
				link.setAttribute('tabindex', '0')
				link.setAttribute('aria-label', `跳转到第 ${position.page} 页的引用目标`)
				for (const [name, value] of Object.entries(position))
					link.setAttribute(`data-typst-link-${name}`, String(value))
			}
			this.displayedRevision = packet.revision
			this.currentState = Object.freeze({
				preview: packet,
				zoom: this.currentState.zoom,
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
		if (this.closed || !this.currentState.preview || this.updatingLayout) return
		if (!this.updateLayout()) {
			this.publishState(this.currentState.currentPage, this.currentState.currentHeading)
			return
		}
		const viewport = this.scrollContainer
		const threshold =
			viewport.getBoundingClientRect().top + Math.min(120, viewport.clientHeight / 3)
		let currentPage = 1
		for (const [index, page] of this.pages.entries()) {
			if (this.pageTop(page) <= threshold) currentPage = index + 1
		}
		// A short final page may fit below the tracking threshold at maximum scroll.
		const atBottom =
			this.pages.length > 0 &&
			viewport.scrollHeight > viewport.clientHeight &&
			viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 2
		if (atBottom) currentPage = this.pages.length
		const headingThreshold = atBottom
			? viewport.getBoundingClientRect().top + viewport.clientHeight
			: threshold
		let currentHeading = -1
		for (const [index, item] of this.currentState.preview.navigation.outline.entries()) {
			const matrix = this.pages[item.page - 1]?.getScreenCTM()
			if (matrix && matrix.b * item.x + matrix.d * item.y + matrix.f <= headingThreshold)
				currentHeading = index
		}
		this.readingAnchor = this.captureAnchor(currentPage) ?? this.readingAnchor
		this.publishState(currentPage, currentHeading)
	}

	private captureAnchor(page: number): LinkPosition | undefined {
		const viewport = this.scrollContainer
		if (viewport.clientWidth <= 0 || viewport.clientHeight <= 0) return undefined
		const inverse = this.pages[page - 1]?.getScreenCTM()?.inverse()
		if (!inverse) return undefined
		const bounds = viewport.getBoundingClientRect()
		const x = bounds.left + viewport.clientWidth / 2
		const y = bounds.top + Math.min(120, viewport.clientHeight / 3)
		return {
			page,
			x: inverse.a * x + inverse.c * y + inverse.e,
			y: inverse.b * x + inverse.d * y + inverse.f,
		}
	}

	private updateLayout(): boolean {
		const svg = this.svg
		const viewport = this.scrollContainer
		if (viewport.clientWidth <= 0 || viewport.clientHeight <= 0) return false
		if (!svg) return true
		const style = viewport.ownerDocument.defaultView?.getComputedStyle(viewport)
		const padding = (value?: string) => Number.parseFloat(value ?? '0') || 0
		const width = viewport.clientWidth - padding(style?.paddingLeft) - padding(style?.paddingRight)
		const height =
			viewport.clientHeight - padding(style?.paddingTop) - padding(style?.paddingBottom)
		const documentWidth = svg.viewBox.baseVal.width
		if (width <= 0 || height <= 0 || documentWidth <= 0) return false
		const maxPageHeight = Math.max(
			...this.pages.map((page) => Number(page.getAttribute('data-page-height'))),
		)
		const zoom = this.currentState.zoom
		const scale =
			typeof zoom === 'number'
				? (zoom * 96) / 72
				: zoom === 'fit-page' && maxPageHeight > 0
					? Math.min(width / documentWidth, height / maxPageHeight)
					: width / documentWidth
		const svgWidth = documentWidth * scale
		if (
			this.layout?.width === width &&
			this.layout.height === height &&
			this.layout.svgWidth === svgWidth
		)
			return true
		this.updatingLayout = true
		try {
			this.layout = { width, height, svgWidth }
			svg.style.width = `${svgWidth}px`
			svg.style.maxWidth = 'none'
			svg.style.height = 'auto'
			svg.style.display = 'block'
			const anchor = this.readingAnchor
			const matrix =
				anchor && this.pages[Math.min(anchor.page, this.pages.length) - 1]?.getScreenCTM()
			if (anchor && matrix) {
				const bounds = viewport.getBoundingClientRect()
				viewport.scrollTo({
					left:
						viewport.scrollLeft +
						matrix.a * anchor.x +
						matrix.c * anchor.y +
						matrix.e -
						bounds.left -
						viewport.clientWidth / 2,
					top:
						viewport.scrollTop +
						matrix.b * anchor.x +
						matrix.d * anchor.y +
						matrix.f -
						bounds.top -
						Math.min(120, viewport.clientHeight / 3),
				})
			}
		} finally {
			this.updatingLayout = false
		}
		return true
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
		const bounds = viewport.getBoundingClientRect()
		const screenX = matrix.a * position.x + matrix.c * position.y + matrix.e
		const screenY = matrix.b * position.x + matrix.d * position.y + matrix.f
		const inset = Math.min(16, viewport.clientWidth / 3)
		const horizontal =
			screenX < bounds.left + inset
				? screenX - bounds.left - inset
				: screenX > bounds.right - inset
					? screenX - bounds.right + inset
					: 0
		viewport.scrollTo({
			left: viewport.scrollLeft + horizontal,
			top: viewport.scrollTop + screenY - bounds.top - Math.min(120, viewport.clientHeight / 3),
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

	private followLink(link: Element): void {
		const preview = this.currentState.preview
		const position = this.links.get(link)
		if (!this.closed && preview && position && this.isNavigationCurrent?.(preview) !== false)
			this.jumpToPosition(position)
	}

	private linkClick = (event: MouseEvent): void => {
		const link = (event.target as Element | null)?.closest?.('a')
		if (!link || !this.links.has(link)) return
		// Suppress the renderer's placeholder href="#", including stale and modified clicks.
		event.preventDefault()
		// Pointer activation already passed the drag/revision checks in pointerUp.
		if (event.detail === 0 && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey)
			this.followLink(link)
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
		const link = target?.closest?.('a')
		if (link) {
			this.followLink(link)
			return
		}
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
		this.container.removeEventListener('click', this.linkClick)
		this.scrollContainer.removeEventListener('scroll', this.refresh)
		this.closing = this.tail.then(() => {
			this.container.replaceChildren()
			this.pages = []
			this.svg = undefined
			this.readingAnchor = undefined
			this.layout = undefined
			this.links = new WeakMap()
			this.currentState = Object.freeze({
				zoom: this.currentState.zoom,
				pageCount: 0,
				currentPage: 1,
				currentHeading: -1,
			})
			return undefined
		})
		return this.closing
	}

	[Symbol.asyncDispose](): Promise<void> {
		return this.dispose()
	}
}
