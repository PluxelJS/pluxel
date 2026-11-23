import { useState, type FormEvent, type Ref } from 'react'
import type { MarketInstallRequest, MarketPackageIdentity } from '../market-contracts.ts'
import { MarketVersionPicker, type MarketplaceData, type MarketplaceProps } from './marketplace.tsx'
import { MarketContext } from './workbench-market-data.tsx'

export type MarketSelectionItem = MarketPackageIdentity &
	Readonly<{
		marketId: string
		latest: string | null
		version: string | null
	}>

export function MarketInstallSelection({
	formRef,
	items,
	data,
	busy,
	onChange,
	onPrepare,
	versionNote,
}: Readonly<{
	formRef: Ref<HTMLFormElement>
	items: readonly MarketSelectionItem[]
	data: MarketplaceData
	busy: boolean
	onChange(items: readonly MarketSelectionItem[]): void
	onPrepare(requests: readonly MarketInstallRequest[]): void
	versionNote: NonNullable<MarketplaceProps['versionNote']>
}>) {
	const [error, setError] = useState('')
	const submit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault()
		const choices = new FormData(event.currentTarget)
		const requests: MarketInstallRequest[] = []
		for (const { marketId, registry, name } of items) {
			const version = choices.get(name)
			if (typeof version !== 'string' || !version) {
				setError('Choose a checked version for ' + name + ' before reviewing the selection.')
				return
			}
			requests.push({ marketId, registry, name, version })
		}
		setError('')
		onPrepare(requests)
	}
	return (
		<form
			className="pm-install-selection"
			aria-label="Installation selection"
			ref={formRef}
			tabIndex={-1}
			hidden={items.length === 0}
			onSubmit={submit}
		>
			<style>{selectionStyles}</style>
			<div className="pm-between">
				<h3>
					{items.length} {items.length === 1 ? 'package selected' : 'packages selected'}
				</h3>
				<button
					className="pm-button pm-primary"
					type="submit"
					disabled={busy || items.length === 0}
				>
					Review selection
				</button>
			</div>
			{items.length > 0 ? (
				<ul className="pm-selected-packages">
					{items.map((item) => (
						<li key={JSON.stringify([item.marketId, item.registry, item.name])}>
							<div className="pm-selected-identity">
								<strong>{item.name}</strong>
								<span className="pm-small pm-muted">
									{item.marketId} · {item.registry}
								</span>
							</div>
							<MarketContext.Provider value={item.marketId}>
								<MarketVersionPicker
									data={data}
									identity={item}
									latest={item.latest}
									versionNote={versionNote}
									value={item.version}
									name={item.name}
									disabled={busy}
									onChange={(version) => {
										setError('')
										onChange(
											items.map((entry) =>
												entry.name === item.name ? { ...entry, version } : entry,
											),
										)
									}}
								/>
							</MarketContext.Provider>
							<button
								className="pm-button pm-remove-choice"
								type="button"
								disabled={busy}
								title={'Remove ' + item.name + ' from selection'}
								aria-label={'Remove ' + item.name + ' from selection'}
								onClick={() => {
									setError('')
									onChange(items.filter((entry) => entry.name !== item.name))
								}}
							>
								<span aria-hidden="true">×</span>
							</button>
						</li>
					))}
				</ul>
			) : null}
			{items.length > 0 && error ? (
				<p className="pm-selection-error" role="alert">
					{error}
				</p>
			) : null}
		</form>
	)
}

const selectionStyles = `
.plx-marketplace label.pm-market-choice { position: relative; z-index: 2; display: inline-flex; align-items: center; gap: 5px; margin: 0; color: var(--pm-muted); font-size: 12px; font-weight: 400; cursor: pointer; }
.plx-marketplace .pm-package-heading .pm-market-choice { order: 1; margin-inline-start: auto; }
.plx-marketplace .pm-package-heading .pm-market-choice > span { display: none; }
.plx-marketplace .pm-package-select { flex: none; width: 18px; height: 18px; min-height: 0; margin: 0; padding: 0; accent-color: var(--pm-accent); cursor: inherit; }
.plx-marketplace label.pm-market-choice:has(:disabled) { cursor: default; }
.plx-marketplace .pm-detail-actions .pm-market-choice { min-height: 30px; padding: 3px 9px; gap: 7px; border: 1px solid var(--pm-border); border-radius: 6px; color: var(--pm-ink); font-weight: 550; }
.plx-marketplace .pm-detail-actions .pm-market-choice:hover:has(:enabled), .plx-marketplace .pm-detail-actions .pm-market-choice:has(:checked) { border-color: var(--pm-accent); background: var(--pm-accent-soft); color: var(--pm-accent); }
.plx-marketplace .pm-detail-actions .pm-package-select { width: 15px; height: 15px; }
.plx-marketplace .pm-package-card:has(.pm-package-select:checked) { border-color: var(--pm-accent); background: var(--pm-accent-soft); }
.plx-marketplace .pm-install-selection { padding: 12px 14px; border: 1px solid var(--pm-border); border-radius: 8px; background: var(--pm-surface); }
.plx-marketplace .pm-install-selection h3 { font-size: 14px; }
.plx-marketplace .pm-selected-packages { list-style: none; display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 18rem), 1fr)); gap: 8px; max-height: min(38vh, 350px); overflow-y: auto; margin: 10px 0 0; padding: 2px; }
.plx-marketplace .pm-selected-packages > li { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-content: start; align-items: start; gap: 6px 10px; min-width: 0; padding: 8px 10px; border: 1px solid var(--pm-border); border-radius: 8px; background: var(--pm-canvas); }
.plx-marketplace .pm-selected-packages .pm-version-picker { min-width: 0; grid-column: 1 / -1; grid-row: 2; }
.plx-marketplace .pm-selected-packages .pm-version-field { max-width: none; }
.plx-marketplace .pm-selected-identity { min-width: 0; display: grid; overflow-wrap: anywhere; }
.plx-marketplace .pm-selected-identity > strong { font-size: 13px; }
.plx-marketplace .pm-remove-choice { grid-column: 2; grid-row: 1; width: 30px; min-height: 30px; padding: 0; color: var(--pm-muted); font-size: 18px; }
.plx-marketplace .pm-selected-packages .pm-pagination { gap: 4px; justify-content: flex-start; flex-wrap: wrap; }
.plx-marketplace .pm-selected-packages .pm-pagination button { min-height: 24px; padding: 2px; font-size: 11px; }
.plx-marketplace .pm-selection-error { margin-top: 6px; color: var(--pm-error); }
`
