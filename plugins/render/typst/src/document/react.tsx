import { useEffect, useRef, useState } from 'react'
import type { TypstPage, TypstPagePosition } from '../preview-contract.js'
import type {
	TypstDocumentLocation,
	TypstDocumentPoint,
	TypstDocumentPreviewData,
	TypstDocumentSelection,
} from './types.js'

export type {
	TypstDocumentLocation,
	TypstDocumentPreviewData,
	TypstDocumentSelection,
} from './types.js'

export interface TypstDocumentPreviewProps {
	preview: TypstDocumentPreviewData | null
	/** Current document revision. An older preview remains visible but cannot be interacted with. */
	revision: number
	/** Disable interaction while uncommitted local edits are pending. @default false */
	pending?: boolean
	/** A fresh object repeats the reveal even at the same position. */
	selection?: TypstDocumentSelection
	/** Follow selection changes; explicit requests reveal even when disabled. @default true */
	following?: boolean
	/** A page click selects exposed document content. Native links navigate within the preview. */
	onSelect(location: TypstDocumentLocation): void
	className?: string
	'aria-label'?: string
}

interface Highlight extends TypstPagePosition {
	width: number
	height: number
	location?: TypstDocumentLocation
}

function pointAtPosition(
	preview: TypstDocumentPreviewData,
	selection: TypstDocumentLocation,
	page: number,
): Highlight | undefined {
	// Document boundaries can precede every editable glyph. Prefer the actual
	// compiler destination to clamping position zero to the first body glyph.
	const destination = preview.targets.find(
		(target) =>
			target.location?.documentId === selection.documentId &&
			target.location.position === selection.position,
	)
	if (destination) return { ...destination, width: 2, height: 12 }
	const point = preview.points
		.filter((item) => item.documentId === selection.documentId)
		.sort((a, b) => {
			const distance = (item: TypstDocumentPoint) =>
				Math.max(item.position - selection.position, selection.position - item.endPosition, 0)
			const contains = (item: TypstDocumentPoint) =>
				selection.position >= item.position && selection.position < item.endPosition
			return (
				distance(a) - distance(b) ||
				Number(contains(b)) - Number(contains(a)) ||
				a.endPosition - a.position - (b.endPosition - b.position) ||
				Math.abs(a.page - page) - Math.abs(b.page - page)
			)
		})[0]
	return (
		point && {
			...point,
			location: { documentId: point.documentId, position: point.position },
		}
	)
}

function pointAtPage(points: readonly TypstDocumentPoint[], page: number, x: number, y: number) {
	let found: TypstDocumentPoint | undefined
	let distance = Infinity
	for (const point of points) {
		if (point.page !== page) continue
		const next = Math.hypot(
			Math.max(point.x - x, 0, x - point.x - point.width),
			Math.max(point.y - y, 0, y - point.y - point.height),
		)
		if (next > Math.max(6, point.height * 0.6)) continue
		if (
			next < distance ||
			(next === distance && point.width * point.height < found!.width * found!.height)
		) {
			found = point
			distance = next
		}
	}
	return found
}

function rectangle(
	point: { x: number; y: number; width: number; height: number },
	page: TypstPage,
) {
	return {
		left: `${(point.x / page.width) * 100}%`,
		top: `${(point.y / page.height) * 100}%`,
		width: `${(Math.max(point.width, 2) / page.width) * 100}%`,
		height: `${(Math.max(point.height, 2) / page.height) * 100}%`,
	}
}

function safeUrl(value: string) {
	if (/^\/(?!\/)/.test(value)) return value
	try {
		const url = new URL(value)
		return ['https:', 'http:', 'mailto:', 'tel:'].includes(url.protocol) ? url.href : undefined
	} catch {
		return undefined
	}
}

/** Source-free page images with caret following, page selection and native document links. */
export function TypstDocumentPreview({
	preview,
	revision,
	pending = false,
	selection,
	following = true,
	onSelect,
	className,
	'aria-label': label = '文档预览',
}: TypstDocumentPreviewProps) {
	const current = Boolean(preview && preview.revision === revision && !pending)
	const scroller = useRef<HTMLDivElement>(null)
	const [target, setTarget] = useState<{ revision: number; point: Highlight }>()
	useEffect(() => {
		if (!current || !preview || !selection || (!following && !selection.explicit)) return
		setTarget((previous) => {
			const point = pointAtPosition(preview, selection, previous?.point.page ?? 1)
			return point ? { revision: preview.revision, point } : undefined
		})
	}, [selection, preview, current, following])
	const highlighted = current && target?.revision === preview?.revision ? target?.point : undefined
	useEffect(() => {
		const viewport = scroller.current
		if (!viewport || !highlighted || !preview) return
		const page = preview.pages.find((item) => item.page === highlighted.page)
		if (!page) return
		let frame = 0
		const scroll = () => {
			cancelAnimationFrame(frame)
			frame = requestAnimationFrame(() => {
				const paper = viewport.querySelector<HTMLElement>(
					`[data-document-page="${highlighted.page}"]`,
				)
				if (!paper || viewport.clientHeight === 0 || paper.clientWidth === 0) return
				const bounds = paper.getBoundingClientRect()
				viewport.scrollTop +=
					bounds.top -
					viewport.getBoundingClientRect().top +
					(highlighted.y / page.height) * bounds.height -
					viewport.clientHeight * 0.35
			})
		}
		const observer = new ResizeObserver(scroll)
		observer.observe(viewport)
		scroll()
		return () => {
			observer.disconnect()
			cancelAnimationFrame(frame)
		}
	}, [highlighted, preview])
	return (
		<div
			ref={scroller}
			className={`typst-document-preview${className ? ` ${className}` : ''}`}
			role="region"
			aria-label={label}
			aria-busy={pending || Boolean(preview && preview.revision !== revision)}
			data-preview-revision={preview?.revision}
		>
			{preview?.pages.map((page) => (
				<figure key={`${preview.revision}:${page.page}`}>
					<div className="typst-document-paper" data-document-page={page.page}>
						<button
							type="button"
							className="typst-document-preview-surface"
							aria-label={`在编辑器中定位第 ${page.page} 页`}
							disabled={!current}
							onClick={(event) => {
								if (!current || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey)
									return
								const bounds = event.currentTarget.getBoundingClientRect()
								const point =
									event.detail === 0
										? preview.points.find((item) => item.page === page.page)
										: pointAtPage(
												preview.points,
												page.page,
												((event.clientX - bounds.left) / bounds.width) * page.width,
												((event.clientY - bounds.top) / bounds.height) * page.height,
											)
								if (point) onSelect({ documentId: point.documentId, position: point.position })
							}}
						>
							<img
								src={page.url}
								width={page.width}
								height={page.height}
								alt={`第 ${page.page} 页`}
							/>
						</button>
						{current &&
							preview.links
								.filter((link) => link.page === page.page)
								.map((link, index) => {
									const title = `跳转到${link.title}`
									if (link.target.kind === 'url') {
										const href = safeUrl(link.target.url)
										return href ? (
											<a
												key={index}
												className="typst-document-preview-link"
												style={rectangle(link, page)}
												href={href}
												target="_blank"
												rel="noopener noreferrer"
												aria-label={title}
												title={title}
											/>
										) : null
									}
									const destination = link.target
									return (
										<button
											key={index}
											type="button"
											className="typst-document-preview-link"
											style={rectangle(link, page)}
											aria-label={title}
											title={title}
											onPointerDown={(event) => event.preventDefault()}
											onClick={(event) => {
												event.stopPropagation()
												setTarget({
													revision: preview.revision,
													point: { ...destination, width: 2, height: 12 },
												})
											}}
										/>
									)
								})}
						{highlighted?.page === page.page && (
							<span
								aria-hidden="true"
								className="typst-document-preview-highlight"
								data-document-id={highlighted.location?.documentId}
								data-position={highlighted.location?.position}
								style={rectangle(highlighted, page)}
							/>
						)}
					</div>
					<figcaption>第 {page.page} 页</figcaption>
				</figure>
			))}
		</div>
	)
}
