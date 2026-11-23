import { useLayoutEffect, useRef, type ReactNode } from 'react'

export function PackageViewer({
	name,
	description,
	metadata,
	actions,
	backLabel,
	onClose,
	navigation,
	children,
}: Readonly<{
	name: string
	description?: string | null
	metadata?: ReactNode
	actions?: ReactNode
	backLabel: string
	onClose(): void
	navigation?: ReactNode
	children: ReactNode
}>) {
	const region = useRef<HTMLElement>(null)
	const header = useRef<HTMLElement>(null)
	useLayoutEffect(() => {
		const element = region.current
		const bar = header.current
		if (!element || !bar || typeof ResizeObserver === 'undefined') return undefined
		const port = scrollContainer(element)
		const measure = () => {
			element.style.setProperty('--pm-header-height', bar.offsetHeight + 'px')
			if (port && port !== element.ownerDocument.scrollingElement)
				element.style.setProperty('--pm-scrollport-height', port.clientHeight + 'px')
		}
		measure()
		const observer = new ResizeObserver(measure)
		observer.observe(bar)
		if (port && port !== element.ownerDocument.scrollingElement) observer.observe(port)
		return () => observer.disconnect()
	}, [])

	return (
		<section ref={region} className="pm-details" aria-label="Package details">
			<header ref={header} className="pm-detail-header">
				<div className="pm-detail-heading">
					<div className="pm-detail-title">
						<h2 title={name}>
							<PackageName name={name} />
						</h2>
						{metadata}
					</div>
					<div className="pm-detail-actions">{actions}</div>
				</div>
				<div className="pm-detail-navigation">
					<nav className="pm-return" aria-label="Package navigation">
						<button
							type="button"
							className="pm-button pm-quiet pm-back"
							aria-keyshortcuts="Escape"
							onClick={onClose}
						>
							<svg
								width="16"
								height="16"
								viewBox="0 0 20 20"
								fill="none"
								stroke="currentColor"
								aria-hidden="true"
							>
								<path d="m9 4-6 6 6 6M3 10h14" />
							</svg>
							{backLabel}
						</button>
						<kbd aria-hidden="true">Esc</kbd>
					</nav>
					{navigation}
				</div>
			</header>
			{description ? <p className="pm-detail-description">{description}</p> : null}
			{children}
		</section>
	)
}

export function scrollContainer(element: HTMLElement): Element | null {
	const { ownerDocument } = element
	for (let parent = element.parentElement; parent; parent = parent.parentElement) {
		const overflow = ownerDocument.defaultView?.getComputedStyle(parent).overflowY
		if (overflow === 'auto' || overflow === 'scroll') return parent
	}
	return ownerDocument.scrollingElement
}

export function PackageName({ name }: Readonly<{ name: string }>) {
	const slash = name.indexOf('/')
	if (slash < 0) return name
	return (
		<>
			<span className="pm-scope">{name.slice(0, slash + 1)}</span>
			{name.slice(slash + 1)}
		</>
	)
}

export function Fact({ label, children }: Readonly<{ label: string; children: ReactNode }>) {
	return (
		<div className="pm-fact">
			<dt>{label}</dt>
			<dd>{children}</dd>
		</div>
	)
}

export function TabBar({
	value,
	tabs,
	onChange,
	label,
}: Readonly<{
	value: string
	tabs: readonly string[]
	onChange(value: string): void
	label: string
}>) {
	return (
		<nav className="pm-tabs" aria-label={label}>
			{tabs.map((tab) => (
				<button
					key={tab}
					type="button"
					aria-pressed={value === tab.toLowerCase()}
					onClick={() => onChange(tab.toLowerCase())}
				>
					{tab}
				</button>
			))}
		</nav>
	)
}
export function DependencyList({
	items,
}: {
	items: readonly { name: string; range: string; kind: string; link?: ReactNode }[]
}) {
	return items.length > 0 ? (
		<dl className="pm-dependencies">
			{items.map(({ name, range, kind, link }) => (
				<div key={name}>
					<dt>{link ?? <code>{name}</code>}</dt>
					<dd>
						<span className="pm-muted">{range}</span>
						<span className="pm-badge">{kind}</span>
					</dd>
				</div>
			))}
		</dl>
	) : (
		<p className="pm-muted">No dependencies declared.</p>
	)
}
