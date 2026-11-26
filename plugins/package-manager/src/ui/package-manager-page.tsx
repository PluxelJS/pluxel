import {
	Alert,
	Badge,
	Box,
	Button,
	Code,
	Group,
	Loader,
	Paper,
	Stack,
	Tabs,
	Text,
	Textarea,
	Title,
} from '@mantine/core'
import { WorkbenchMantineProvider } from '@pluxel/workbench/mantine'
import type { WorkbenchHostFacade } from '@pluxel/workbench/react'
import { IconDownload, IconRefresh } from '@tabler/icons-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type {
	LocalPackageLocation,
	PackageInstallConfirmation,
	PackageInstallPlan,
	PackageMutationFailure,
	PackageMutationResult,
} from '../contracts.ts'
import type {
	createPackageManagerResources,
	PrepareInstallInput,
} from './package-manager.resources.ts'
import { versionRelation } from './package-version.ts'
import { PackageDocumentExplorer, type DocumentReader } from './package-document-explorer.tsx'
import { packageThemeStyles } from './package-theme.ts'
import { marketplaceStyles } from './marketplace.styles.ts'
import type { createRegistryDiscovery } from './registry-discovery.tsx'
import { InstalledPackages } from './installed-packages.tsx'
import { InstallHostImpact } from './install-host-impact.tsx'
import type { MarketSelectionItem } from './market-install-selection.tsx'
import { WorkbenchMarketplace } from './marketplace-workbench.tsx'
import type { MarketplaceData } from './marketplace.tsx'

type PackageManagerResources = ReturnType<typeof createPackageManagerResources>

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

function failureMessage({ input, message }: PackageMutationFailure): string {
	return input ? `${input}: ${message}` : message
}

function parseSpecs(value: string): string[] {
	return [
		...new Set(
			value
				.split(/[\n,;]+/)
				.map((item) => item.trim())
				.filter(Boolean),
		),
	]
}

export function PackageManagerPage({
	host,
	state: { snapshotQuery, usageQuery, preparation, confirmation, removal },
	RegistryDiscovery,
	marketData,
	localReaders,
	title,
	initialTab,
}: Readonly<{
	host: WorkbenchHostFacade
	state: ReturnType<PackageManagerResources['usePackageManager']>
	RegistryDiscovery: ReturnType<typeof createRegistryDiscovery>
	marketData: MarketplaceData
	localReaders: Record<LocalPackageLocation['source'], DocumentReader>
	title: string
	initialTab: 'market' | 'installed'
}>) {
	const [inspected, setInspected] = useState<LocalPackageLocation>()
	const openedFrom = useRef<HTMLButtonElement>(null)
	const snapshot = snapshotQuery.data
	const [managedQuery, setManagedQuery] = useState('')
	const [specs, setSpecs] = useState('')
	const [marketSelection, setMarketSelection] = useState<readonly MarketSelectionItem[]>([])
	const [marketOpened, setMarketOpened] = useState(initialTab === 'market')
	const [inputError, setInputError] = useState<string>()
	const [tab, setTab] = useState<string | null>(initialTab)
	const hasMarketTab = initialTab === 'market' || Boolean(snapshot?.markets.length)
	const loading = snapshotQuery.isPending || snapshotQuery.isFetching
	const mutating = preparation.isPending || confirmation.isPending || removal.isPending
	// A settled mutation has invalidated the snapshot, but its authoritative read may still be pending.
	const busy = loading || mutating
	const plan = preparation.data?.ok ? preparation.data.plan : undefined
	const confirmAttempted = confirmation.status !== 'idle'

	const manage = (name: string) => {
		setInspected(undefined)
		setManagedQuery(name)
		setTab('installed')
	}
	const prepare = (input: PrepareInstallInput) => {
		confirmation.reset()
		preparation.mutate(input)
	}

	const editSelection = (items: readonly MarketSelectionItem[]) => {
		preparation.reset()
		setMarketSelection(items)
	}
	const confirm = async (reviewed: PackageInstallPlan) => {
		const result = await confirmation.mutateAsync(reviewed.id)
		// Published entries and failed entries have separate receipts even when they share a plan.
		const completed = new Set(result.succeeded)
		const selected = reviewed.packages.filter((pkg) => pkg.market && completed.has(pkg.name))
		if (selected.length > 0) {
			setMarketSelection((current) =>
				current.filter(
					(item) =>
						!selected.some(
							(pkg) =>
								pkg.name === item.name &&
								pkg.market?.registry === item.registry &&
								pkg.market.marketId === item.marketId,
						),
				),
			)
		}
		if (result.ok) preparation.reset()
	}

	return (
		<WorkbenchMantineProvider colorScheme={host.colorScheme}>
			<Stack
				gap="md"
				p="lg"
				className="plx-package-ui plx-package-manager"
				data-color-scheme={host.colorScheme}
			>
				<style>{packageThemeStyles}</style>
				<Group justify="space-between" align="flex-start">
					<Title order={3}>{title}</Title>
					<Button
						variant="light"
						leftSection={<IconRefresh size={16} />}
						loading={loading}
						disabled={mutating}
						onClick={() => void Promise.allSettled([snapshotQuery.refetch(), usageQuery.refetch()])}
					>
						Refresh
					</Button>
				</Group>

				{snapshotQuery.status === 'error' ? (
					<Alert color="red">{messageOf(snapshotQuery.error)}</Alert>
				) : null}
				{preparation.status === 'error' ? (
					<Alert color="red" title="Could not prepare installation">
						{messageOf(preparation.error)}
					</Alert>
				) : null}
				{preparation.data && preparation.data.ok === false ? (
					<Alert
						color="red"
						title="Could not prepare installation"
						style={{ whiteSpace: 'pre-wrap' }}
					>
						{preparation.data.failed.map(failureMessage).join('\n')}
					</Alert>
				) : null}
				{preparation.isPending ? (
					<Group>
						<Loader size="sm" />
						<Text>Preparing packages for review…</Text>
					</Group>
				) : null}
				{confirmation.status === 'error' ? (
					<Alert color="red" title="Installation result unavailable">
						{messageOf(confirmation.error)} Refresh packages before preparing again.
					</Alert>
				) : null}
				{removal.status === 'error' ? (
					<Alert color="red" title="Removal result unavailable">
						{messageOf(removal.error)} Refresh packages before retrying.
					</Alert>
				) : null}
				{confirmation.data ? (
					<MutationReceipt
						result={confirmation.data}
						action="install"
						onManage={() =>
							manage(
								confirmation.data?.succeeded.length === 1 ? confirmation.data.succeeded[0]! : '',
							)
						}
						sourceUpdates={snapshot?.sourceUpdates ?? null}
					/>
				) : null}
				{removal.data ? (
					<MutationReceipt
						result={removal.data}
						action="remove"
						sourceUpdates={snapshot?.sourceUpdates ?? null}
					/>
				) : null}

				{plan && !preparation.isPending ? (
					<InstallationReview
						key={plan.id}
						plan={plan}
						stale={snapshot !== undefined && plan.baseRevision !== snapshot.revision}
						busy={busy}
						confirmAttempted={confirmAttempted}
						onConfirm={() => void confirm(plan).catch((): void => {})}
						onDiscard={() => preparation.reset()}
					/>
				) : null}

				{snapshot?.pendingRemovals.length ? (
					<Alert color="yellow" title="Package removal needs retry">
						<Stack gap="xs">
							<Text size="sm">
								These packages were removed from the selection, but their published entries still
								need to be withdrawn.
							</Text>
							{snapshot.pendingRemovals.map((name) => (
								<Group key={name} justify="space-between">
									<Code>{name}</Code>
									<Button
										variant="light"
										disabled={busy}
										onClick={() =>
											removal.mutate({ names: [name], expectedRevision: snapshot.revision })
										}
									>
										Retry removal
									</Button>
								</Group>
							))}
						</Stack>
					</Alert>
				) : null}

				{snapshot && !snapshot.ignoreScripts ? (
					<Alert color="yellow" title="Preparation may run build scripts">
						Preparing a package downloads its dependencies and may execute scripts allowed by this
						application: <Code>{snapshot.allowBuilds.join(', ')}</Code>.
					</Alert>
				) : null}

				<Tabs
					value={tab}
					onChange={(next) => {
						setTab(next)
						if (next === 'market') setMarketOpened(true)
					}}
					keepMounted={false}
				>
					<Tabs.List aria-label="Package management">
						{hasMarketTab ? <Tabs.Tab value="market">Marketplace</Tabs.Tab> : null}
						<Tabs.Tab value="installed">Installed</Tabs.Tab>
						<Tabs.Tab value="direct">Find plugins</Tabs.Tab>
					</Tabs.List>
					<Tabs.Panel value="direct" pt="md">
						<Stack gap="lg">
							<RegistryDiscovery
								managed={snapshot?.packages ?? []}
								busy={busy}
								onReview={(spec) => prepare({ kind: 'direct', specs: [spec] })}
								onManage={manage}
							/>
							<details>
								<summary>Review multiple package names</summary>
								<form
									onSubmit={(event) => {
										event.preventDefault()
										const requested = parseSpecs(specs)
										if (requested.length === 0) {
											setInputError('Enter at least one npm package specifier.')
											return
										}
										setInputError(undefined)
										prepare({ kind: 'direct', specs: requested })
									}}
								>
									<Stack gap="sm">
										<Textarea
											label="npm packages"
											description="One package per line, for example @scope/plugin@latest. Review exact versions before applying."
											minRows={3}
											value={specs}
											error={inputError}
											disabled={busy}
											onChange={(event) => setSpecs(event.currentTarget.value)}
										/>
										<Group>
											<Button
												type="submit"
												leftSection={<IconDownload size={16} />}
												loading={preparation.isPending}
												disabled={busy}
											>
												Review package list
											</Button>
											{snapshot?.markets.length === 0 ? (
												<Text size="sm" c="dimmed">
													Packages are checked against the application registry.
												</Text>
											) : null}
										</Group>
									</Stack>
								</form>
							</details>
						</Stack>
					</Tabs.Panel>
					{hasMarketTab ? (
						<Tabs.Panel value="market" pt="md" keepMounted={marketOpened}>
							{snapshot ? (
								<WorkbenchMarketplace
									snapshot={snapshot}
									data={marketData}
									host={host}
									title={title}
									busy={busy}
									items={marketSelection}
									onChange={editSelection}
									onPrepare={(requests) => prepare({ kind: 'market', requests })}
									usage={usageQuery.status === 'error' ? undefined : usageQuery.data}
								/>
							) : loading ? (
								<Text size="sm" c="dimmed" role="status">
									Loading market connections…
								</Text>
							) : null}
						</Tabs.Panel>
					) : null}
					<Tabs.Panel value="installed" pt="md">
						{loading && !snapshot ? (
							<Group>
								<Loader size="sm" />
								<Text>Loading packages…</Text>
							</Group>
						) : null}
						{snapshot ? (
							<>
								{inspected && (
									<div className="plx-marketplace" data-color-scheme={host.colorScheme}>
										<style>{marketplaceStyles}</style>
										<PackageDocumentExplorer
											name={inspected.path[0]!}
											source={
												inspected.source === 'managed'
													? 'Managed installation'
													: 'Application installation'
											}
											backLabel="Back to installed packages"
											reader={localReaders[inspected.source]}
											onClose={() => {
												setInspected(undefined)
												requestAnimationFrame(() =>
													openedFrom.current?.focus({ preventScroll: false }),
												)
											}}
										/>
									</div>
								)}
								<div hidden={Boolean(inspected)}>
									<InstalledPackages
										key={managedQuery}
										initialQuery={managedQuery}
										onInspect={(loc, button) => {
											openedFrom.current = button
											setInspected(loc)
										}}
										snapshot={snapshot}
										usage={usageQuery.data}
										usageError={usageQuery.status === 'error' ? usageQuery.error : undefined}
										busy={busy}
										navigation={host.navigation}
										onRemove={(names, expectedRevision) =>
											removal.mutate({ names, expectedRevision })
										}
									/>
								</div>
							</>
						) : null}
					</Tabs.Panel>
				</Tabs>
			</Stack>
		</WorkbenchMantineProvider>
	)
}

function activationMessage(mode: PackageInstallPlan['sourceUpdates']): string {
	return mode === 'next-start'
		? 'Package changes become available on the next application start.'
		: mode === 'live'
			? 'Package changes are submitted to the application. Check plugin status for activation.'
			: 'Check plugin status after applying package changes.'
}

function planAction(pkg: PackageInstallPlan['packages'][number]) {
	if (
		pkg.market &&
		pkg.previousMarketRegistry &&
		pkg.previousMarketRegistry !== pkg.market.registry
	)
		return 'Change registry'
	if (!pkg.changed) return 'Unchanged'
	if (pkg.market && !pkg.previousMarketRegistry && pkg.previousVersion === pkg.version)
		return 'Verify source'
	switch (versionRelation(pkg.previousVersion, pkg.version)) {
		case 'older':
			return 'Downgrade'
		case 'newer':
			return 'Update'
		case 'different':
			return 'Change version'
		case 'installed':
			return 'Dependencies changed'
		default:
			return 'Add'
	}
}

function InstallationReview({
	plan,
	stale,
	busy,
	confirmAttempted,
	onConfirm,
	onDiscard,
}: Readonly<{
	plan: PackageInstallPlan
	stale: boolean
	busy: boolean
	confirmAttempted: boolean
	onConfirm(): void
	onDiscard(): void
}>) {
	const review = useRef<HTMLDivElement>(null)
	const [expired, setExpired] = useState(() => Date.now() >= plan.expiresAt)
	useEffect(() => {
		const timeout = setTimeout(() => setExpired(true), Math.max(0, plan.expiresAt - Date.now()))
		return () => clearTimeout(timeout)
	}, [plan.expiresAt])
	useLayoutEffect(() => {
		review.current?.scrollIntoView?.({ block: 'start' })
		review.current?.focus({ preventScroll: true })
	}, [plan.id])
	return (
		<Paper
			withBorder
			p="md"
			ref={review}
			tabIndex={-1}
			role="region"
			aria-label="Installation review"
			style={{ flexShrink: 0 }}
		>
			<Stack gap="sm">
				<Title order={4}>Review installation</Title>
				<Text size="sm">
					These exact versions have been prepared. Confirm to publish their plugin entries.
				</Text>
				<Box
					component="ul"
					m={0}
					p={0}
					style={{
						display: 'grid',
						gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 18rem), 1fr))',
						gap: 'var(--mantine-spacing-xs)',
						listStyle: 'none',
						maxHeight: 'min(38vh, 24rem)',
						overflowY: 'auto',
					}}
				>
					{plan.packages.map((pkg) => (
						<Paper component="li" key={pkg.name} withBorder p="xs">
							<Text size="sm" fw={600} style={{ overflowWrap: 'anywhere' }}>
								{pkg.name}
							</Text>
							{pkg.requiredBy?.map(({ name, range }) => (
								<Text key={name} size="sm">
									Required by {name} ({range})
								</Text>
							))}
							<Group gap="xs" mt={2}>
								<Text size="sm">
									{pkg.previousVersion && pkg.previousVersion !== pkg.version
										? `${pkg.previousVersion} → `
										: ''}
									{pkg.version}
								</Text>
								<Badge variant="light" color={pkg.changed ? 'blue' : 'gray'}>
									{planAction(pkg)}
								</Badge>
							</Group>
						</Paper>
					))}
				</Box>
				{plan.pendingRemovals.length > 0 && (
					<Text size="sm">Withdraw remaining entries for {plan.pendingRemovals.join(', ')}.</Text>
				)}
				<InstallHostImpact impact={plan.hostImpact} review={plan.dependencyReview} />
				<details>
					<summary>Sources and integrity</summary>
					<Stack gap="xs" mt="xs">
						{plan.packages.map((pkg) => (
							<Stack key={pkg.name} gap={2}>
								<Text size="sm">
									{pkg.name}@{pkg.version} ·{' '}
									{pkg.market
										? pkg.market.marketId + ' · ' + pkg.market.registry
										: 'Application npm configuration'}
								</Text>
								{pkg.market &&
								pkg.previousMarketRegistry &&
								pkg.market.registry !== pkg.previousMarketRegistry ? (
									<Text size="xs" c="dimmed">
										Previous checked registry: {pkg.previousMarketRegistry}
									</Text>
								) : null}
								<Code style={{ overflowWrap: 'anywhere' }}>{pkg.integrity}</Code>
							</Stack>
						))}
					</Stack>
				</details>
				{plan.dependenciesWithBuildScripts.length > 0 ? (
					<Text size="sm">
						Dependencies with build scripts:{' '}
						<Code>{plan.dependenciesWithBuildScripts.join(', ')}</Code>.
					</Text>
				) : null}
				<Text size="sm" c="dimmed">
					{activationMessage(plan.sourceUpdates)} Review expires at{' '}
					{new Date(plan.expiresAt).toLocaleTimeString()}.
				</Text>
				<Group>
					<Button disabled={busy || confirmAttempted || stale || expired} onClick={onConfirm}>
						Confirm installation
					</Button>
					<Button variant="subtle" disabled={busy} onClick={onDiscard}>
						{confirmAttempted ? 'Close review' : 'Discard review'}
					</Button>
				</Group>
				{(stale || expired) && !confirmAttempted ? (
					<Text size="sm" c="orange" role="status">
						{expired ? 'This review has expired.' : 'Managed packages changed after this review.'}{' '}
						Prepare a new review to continue.
					</Text>
				) : null}
				{confirmAttempted ? (
					<Text size="xs" c="dimmed">
						Prepare a new review to make another installation attempt.
					</Text>
				) : null}
			</Stack>
		</Paper>
	)
}

function MutationReceipt({
	onManage,
	result,
	action,
	sourceUpdates,
}: Readonly<{
	onManage?(): void
	sourceUpdates: PackageInstallPlan['sourceUpdates']
}> &
	(
		| { action: 'install'; result: PackageInstallConfirmation }
		| { action: 'remove'; result: PackageMutationResult }
	)) {
	const published = action === 'install' ? result.published : []
	const withdrawn = action === 'install' ? result.withdrawn : result.succeeded
	return (
		<Alert
			color={result.ok ? 'teal' : 'yellow'}
			title={
				result.ok
					? action === 'install'
						? 'Installation confirmed'
						: 'Package sources removed'
					: 'Package operation needs attention'
			}
		>
			<Stack gap="xs">
				{action === 'install' && result.succeeded.length > 0 && (
					<Text size="sm">Completed requests: {result.succeeded.join(', ')}</Text>
				)}
				{published.length > 0 && <Text size="sm">Published: {published.join(', ')}</Text>}
				{withdrawn.length > 0 && (
					<Text size="sm">
						{action === 'install' ? 'Withdrawn' : 'Removed'}: {withdrawn.join(', ')}
					</Text>
				)}
				{published.length > 0 || withdrawn.length > 0 ? (
					<Text size="sm">{activationMessage(sourceUpdates)}</Text>
				) : null}
				{onManage && result.succeeded.length > 0 && (
					<Group>
						<Button variant="default" size="xs" onClick={onManage}>
							Manage installed packages
						</Button>
					</Group>
				)}
				{result.failed.map((failure, index) => (
					<Text key={`${failure.input}:${index}`} size="sm">
						{failureMessage(failure)}
					</Text>
				))}
			</Stack>
		</Alert>
	)
}
