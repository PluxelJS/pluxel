import { WorkbenchMarketplace, createWorkbenchMarketplaceData } from './marketplace-workbench.tsx'
import { marketplaceResources as resources, marketplaceScope } from './marketplace.scope.ts'
import { marketplaceStyles } from './marketplace.styles.ts'

const data = createWorkbenchMarketplaceData(resources)

export function MarketplacePage() {
	const { host } = marketplaceScope.useWorkbench()
	const snapshotQuery = resources.packageManagerSnapshotQuery.useQuery()
	const preparation = resources.prepareInstallMutation.useMutation()
	const confirmation = resources.confirmInstallMutation.useMutation()
	const snapshot = snapshotQuery.data
	const busy =
		snapshotQuery.isPending ||
		snapshotQuery.isFetching ||
		preparation.isPending ||
		confirmation.isPending
	const plan = preparation.data?.ok ? preparation.data.plan : undefined
	const attempted = confirmation.status !== 'idle'
	const error = snapshotQuery.error ?? preparation.error ?? confirmation.error
	const failure =
		preparation.data && preparation.data.ok === false
			? preparation.data.failed.map((item) => item.message).join('\n')
			: undefined
	return (
		<main className="plx-marketplace" data-color-scheme={host.colorScheme} style={{ padding: 24 }}>
			<style>{marketplaceStyles}</style>
			<div className="pm-stack">
				<header className="pm-between">
					<div className="pm-stack" style={{ gap: 6 }}>
						<h2>Plugin marketplace</h2>
						<p className="pm-muted">Discover tools for your application.</p>
					</div>
					<button
						type="button"
						className="pm-button"
						disabled={busy}
						onClick={() => void snapshotQuery.refetch().catch((): void => {})}
					>
						Refresh
					</button>
				</header>
				{error || failure ? (
					<div className="pm-error" role="alert">
						<p>{failure ?? (error instanceof Error ? error.message : String(error))}</p>
					</div>
				) : null}
				{preparation.isPending ? (
					<p className="pm-loading" role="status">
						Preparing packages for review…
					</p>
				) : null}
				{confirmation.data ? (
					<section className="pm-note" role="status">
						<strong>
							{confirmation.data.ok
								? 'Package sources published'
								: 'Package operation needs attention'}
						</strong>
						{confirmation.data.succeeded.length > 0 ? (
							<p>
								Published: {confirmation.data.succeeded.join(', ')}. Check plugin status for
								activation.
							</p>
						) : null}
						{confirmation.data.failed.map((item, index) => (
							<p key={index}>
								{item.input}: {item.message}
							</p>
						))}
					</section>
				) : null}
				{plan && !preparation.isPending ? (
					<section className="pm-review" aria-label="Installation review">
						<h3>Review installation</h3>
						<p>These exact versions have been prepared. Confirm to publish their plugin entries.</p>
						{plan.packages.map((pkg) => (
							<div key={pkg.name} className="pm-between">
								<code>{pkg.name}</code>
								<span>
									{pkg.previousVersion && pkg.previousVersion !== pkg.version
										? pkg.previousVersion + ' → '
										: ''}
									{pkg.version}
								</span>
							</div>
						))}
						{plan.dependenciesWithBuildScripts.length > 0 ? (
							<p className="pm-small">
								Dependencies with build scripts: {plan.dependenciesWithBuildScripts.join(', ')}.
							</p>
						) : null}
						<p className="pm-small pm-muted">
							{plan.sourceUpdates === 'next-start'
								? 'Package changes become available on the next application start.'
								: 'Check plugin status after applying package changes.'}{' '}
							Review expires at {new Date(plan.expiresAt).toLocaleTimeString()}.
						</p>
						<div className="pm-inline">
							<button
								type="button"
								className="pm-button pm-primary"
								disabled={busy || attempted}
								onClick={() => confirmation.mutate(plan.id)}
							>
								Confirm installation
							</button>
							<button
								type="button"
								className="pm-button pm-quiet"
								disabled={busy}
								onClick={() => preparation.reset()}
							>
								{attempted ? 'Close review' : 'Discard review'}
							</button>
						</div>
						{attempted ? (
							<p className="pm-small pm-muted">
								Prepare a new review to make another installation attempt.
							</p>
						) : null}
					</section>
				) : null}
				{snapshot && !snapshot.ignoreScripts ? (
					<p className="pm-note">
						Preparation may run build scripts allowed by this application:{' '}
						{snapshot.allowBuilds.join(', ')}.
					</p>
				) : null}
				{snapshot ? (
					<WorkbenchMarketplace
						markets={snapshot.markets}
						data={data}
						busy={busy}
						colorScheme={host.colorScheme}
						onPrepare={(selection) => {
							confirmation.reset()
							preparation.mutate({ kind: 'market', ...selection })
						}}
					/>
				) : snapshotQuery.isPending ? (
					<p role="status" className="pm-muted">
						Loading market connections…
					</p>
				) : null}
			</div>
		</main>
	)
}

export default marketplaceScope.render(MarketplacePage)
