import { useLayoutEffect, useRef, useState, type ComponentType, type ReactNode } from 'react'
import { DependencyList, Fact, PackageViewer, TabBar, scrollContainer } from './package-viewer.tsx'
import { Readme } from './marketplace-readme.tsx'
import type { PackageDocument } from '../package-document.ts'

export type DocumentStep = { name: string; range?: string }
export type DocumentRead = { data?: PackageDocument | null; error?: unknown; refetch(): unknown }
export type DocumentReader = ComponentType<{
	path: readonly DocumentStep[]
	children(read: DocumentRead): ReactNode
}>
type Visit = { step: DocumentStep; tab: string; top?: number; focus?: string }

export function PackageDocumentExplorer({
	name,
	range,
	source,
	backLabel,
	reader: Reader,
	onClose,
}: {
	name: string
	range?: string
	source: 'Managed installation' | 'Application installation' | 'Public npm'
	backLabel: string
	reader: DocumentReader
	onClose(): void
}) {
	const [visits, setVisits] = useState<Visit[]>([{ step: { name, range }, tab: 'readme' }])
	const view = useRef<HTMLDivElement>(null)
	const current = visits[visits.length - 1]!
	const path = visits.map((v) => v.step)

	const restore = useRef(false)
	const pendingFocus = useRef<string>(undefined)
	useLayoutEffect(() => {
		const el = view.current
		if (!el) return
		const port = scrollContainer(el)
		if (restore.current) {
			if (port && current.top !== undefined) port.scrollTop = current.top
			const target = Array.from(
				el.querySelectorAll<HTMLButtonElement>('[data-package-dependency]'),
			).find((button) => button.dataset.packageDependency === current.focus)
			pendingFocus.current = target ? undefined : current.focus
			const focus = target ?? el
			focus.focus({ preventScroll: true })
		} else {
			pendingFocus.current = undefined
			el.scrollIntoView?.({ block: 'start' })
			el.focus({ preventScroll: true })
		}
		restore.current = false
	}, [visits.length])
	function back() {
		restore.current = true
		if (visits.length > 1) setVisits(visits.slice(0, -1))
		else onClose()
	}
	useLayoutEffect(() => {
		const el = view.current
		if (!el) return undefined
		function onKey(event: KeyboardEvent) {
			if (event.key === 'Escape' && !event.isComposing && !event.defaultPrevented) {
				event.preventDefault()
				event.stopPropagation()
				back()
			}
		}
		el.addEventListener('keydown', onKey)
		return () => el.removeEventListener('keydown', onKey)
	})

	return (
		<div
			ref={view}
			className="pm-detail-anchor"
			role="region"
			aria-label={current.step.name}
			tabIndex={-1}
		>
			<Reader path={path}>
				{(read) => {
					const doc = read.data
					return (
						<PackageViewer
							name={doc?.name ?? current.step.name}
							description={doc?.description}
							metadata={doc?.version && <code className="pm-badge">{doc.version}</code>}
							actions={<span className="pm-no-release">{source}</span>}
							backLabel={
								visits.length > 1 ? 'Back to ' + visits[visits.length - 2]!.step.name : backLabel
							}
							onClose={back}
							navigation={
								doc && (
									<TabBar
										label="Package information"
										value={current.tab}
										tabs={['README', 'Dependencies']}
										onChange={(tab) => setVisits([...visits.slice(0, -1), { ...current, tab }])}
									/>
								)
							}
						>
							{read.error ? (
								<div role="alert" className="pm-error">
									{read.error instanceof Error ? read.error.message : String(read.error)}{' '}
									<button type="button" className="pm-button" onClick={() => void read.refetch()}>
										Retry
									</button>
								</div>
							) : doc === undefined ? (
								<p role="status" className="pm-muted">
									Loading package…
								</p>
							) : !doc ? (
								<p role="status" className="pm-muted">
									{source === 'Public npm'
										? 'No public npm package or version matches this selection.'
										: 'This package is unavailable in this installation.'}
								</p>
							) : null}
							{doc && (
								<div className="pm-overview">
									<aside className="pm-package-meta" aria-label="Package facts">
										<dl className="pm-facts">
											{doc.license && <Fact label="License">{doc.license}</Fact>}
											<Fact label="Dependencies">{doc.dependencies.length}</Fact>
											{current.step.range && (
												<Fact label="Requested range">
													<code>{current.step.range}</code>
												</Fact>
											)}
										</dl>
									</aside>
									<section
										className="pm-document"
										aria-label={
											current.tab === 'readme' ? 'Package README' : 'Package dependencies'
										}
									>
										{current.tab === 'readme' ? (
											<>
												<h3>{source === 'Public npm' ? 'Registry README' : 'Installed README'}</h3>
												<Readme value={doc.readme} />
											</>
										) : (
											<DependencyList
												items={doc.dependencies.map((dep) => ({
													name: dep.name,
													range: dep.range,
													kind: dep.plugin ? dep.plugin + ' plugin' : dep.kind,
													link: (
														<button
															type="button"
															className="pm-dependency-link"
															data-package-dependency={dep.name}
															ref={(button) => {
																if (
																	button &&
																	pendingFocus.current === dep.name &&
																	button.ownerDocument.activeElement === view.current
																) {
																	pendingFocus.current = undefined
																	button.focus({ preventScroll: true })
																}
															}}
															onClick={(event) => {
																const port = scrollContainer(event.currentTarget)
																setVisits([
																	...visits.slice(0, -1),
																	{ ...current, top: port?.scrollTop, focus: dep.name },
																	{ step: { name: dep.name, range: dep.range }, tab: 'readme' },
																])
															}}
														>
															<code>{dep.name}</code>
														</button>
													),
												}))}
											/>
										)}
									</section>
								</div>
							)}
						</PackageViewer>
					)
				}}
			</Reader>
		</div>
	)
}
