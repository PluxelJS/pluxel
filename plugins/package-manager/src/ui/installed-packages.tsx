import {
	Alert,
	Anchor,
	Badge,
	Box,
	Button,
	Checkbox,
	Group,
	Paper,
	Stack,
	Text,
	TextInput,
	Title,
} from '@mantine/core'
import type { WorkbenchNavigation } from '@pluxel/workbench/react'
import { IconSearch, IconTrash } from '@tabler/icons-react'
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
	packageMutationLimit,
	type ManagedPackage,
	type PackageManagerSnapshot,
} from '../contracts.ts'
import type { PackageUsage } from './package-usage.ts'

type Props = Readonly<{
	snapshot: PackageManagerSnapshot
	usage: readonly PackageUsage[] | null | undefined
	usageError: unknown
	busy: boolean
	navigation: WorkbenchNavigation | null
	onRemove(names: readonly string[], expectedRevision: number): void
}>

type RemovalSelection = Readonly<{ packages: readonly ManagedPackage[]; revision: number }>

export function InstalledPackages({
	snapshot,
	usage,
	usageError,
	busy,
	navigation,
	onRemove,
}: Props) {
	const [query, setQuery] = useState('')
	const [runningOnly, setRunningOnly] = useState(false)
	const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
	const [review, setReview] = useState<RemovalSelection>()
	const reviewButton = useRef<HTMLButtonElement>(null)
	const usageByName = useMemo(() => new Map(usage?.map((pkg) => [pkg.name, pkg])), [usage])
	const managed = snapshot.packages
	const managedNames = new Set(managed.map((pkg) => pkg.name))
	const currentSelection = managed.filter((pkg) => selected.has(pkg.name))
	const hasUsage = usage != null && usageError == null
	const needle = query.trim().toLowerCase()
	const matches = (name: string) => {
		const plugins = hasUsage ? usageByName.get(name)?.plugins : undefined
		return (
			(!runningOnly ||
				!hasUsage ||
				plugins?.some((plugin) => plugin.lifecycleState === 'running')) &&
			(name.toLowerCase().includes(needle) ||
				plugins?.some((plugin) => plugin.label.toLowerCase().includes(needle)))
		)
	}
	const visibleManaged = managed.filter((pkg) => matches(pkg.name))
	const visibleApplication = hasUsage
		? usage.filter((pkg) => !managedNames.has(pkg.name) && matches(pkg.name))
		: []
	const toggle = (name: string) => {
		setSelected((previous) => {
			const next = new Set(previous)
			if (next.has(name)) next.delete(name)
			else next.add(name)
			return next
		})
	}

	return (
		<Stack gap="md">
			{review ? (
				<RemovalReview
					review={review}
					snapshot={snapshot}
					usageByName={hasUsage ? usageByName : undefined}
					busy={busy}
					onCancel={() => {
						setReview(undefined)
						requestAnimationFrame(() => reviewButton.current?.focus())
					}}
					onConfirm={() => {
						setReview(undefined)
						setSelected(new Set())
						onRemove(
							review.packages.map((pkg) => pkg.name),
							review.revision,
						)
					}}
				/>
			) : null}
			{managed.length > 0 || (hasUsage && usage.length > 0) ? (
				<Group align="center" gap="sm">
					<TextInput
						type="search"
						aria-label="Search installed packages"
						placeholder="Search packages or plugins"
						leftSection={<IconSearch size={15} />}
						value={query}
						onChange={(event) => setQuery(event.currentTarget.value)}
						style={{ flex: '1 1 16rem' }}
					/>
					{hasUsage ? (
						<Checkbox
							label="Running only"
							checked={runningOnly}
							onChange={(event) => setRunningOnly(event.currentTarget.checked)}
						/>
					) : null}
				</Group>
			) : null}
			<section aria-label="Managed packages">
				<Stack gap="xs">
					<Group justify="space-between">
						<Title order={4}>Managed packages</Title>
						{managed.length > 0 ? (
							<Group gap="xs">
								{currentSelection.length > 0 ? (
									<Text size="xs" c="dimmed" role="status">
										{currentSelection.length} selected
									</Text>
								) : null}
								<Button
									ref={reviewButton}
									size="xs"
									variant="light"
									color="red"
									leftSection={<IconTrash size={14} />}
									disabled={busy || Boolean(review) || currentSelection.length === 0}
									onClick={() =>
										setReview({ packages: currentSelection, revision: snapshot.revision })
									}
								>
									Review removal
								</Button>
							</Group>
						) : null}
					</Group>
					{visibleManaged.length > 0 ? (
						<PackageGrid>
							{visibleManaged.map((pkg) => (
								<Paper component="li" aria-label={pkg.name} key={pkg.name} withBorder p="sm">
									<Stack gap={5}>
										<Group gap="xs" wrap="nowrap" align="flex-start">
											<Checkbox
												aria-label={`Select ${pkg.name}`}
												checked={selected.has(pkg.name)}
												disabled={
													busy ||
													Boolean(review) ||
													(!selected.has(pkg.name) &&
														currentSelection.length >= packageMutationLimit)
												}
												onChange={() => toggle(pkg.name)}
											/>
											<Text size="sm" fw={600} style={{ overflowWrap: 'anywhere' }}>
												{pkg.name}
											</Text>
										</Group>
										<Text size="xs" c="dimmed">
											{pkg.installedVersion ?? 'Not downloaded'} ·{' '}
											{pkg.entryFile ? 'Source published' : 'Not published'}
											{pkg.requested !== pkg.installedVersion
												? ` · Requested ${pkg.requested}`
												: ''}
										</Text>
										{pkg.marketRegistry ? (
											<Text size="xs" c="dimmed" style={{ overflowWrap: 'anywhere' }}>
												Checked registry: {pkg.marketRegistry}
											</Text>
										) : null}
										{hasUsage ? (
											<PluginNodes usage={usageByName.get(pkg.name)} navigation={navigation} />
										) : null}
									</Stack>
								</Paper>
							))}
						</PackageGrid>
					) : (
						<Text size="sm" c="dimmed">
							{managed.length > 0 ? 'No matching managed packages.' : 'No managed packages yet.'}
						</Text>
					)}
				</Stack>
			</section>
			<section aria-label="Application packages">
				<Stack gap="xs">
					<Title order={4}>Application packages</Title>
					{usageError != null ? (
						<Alert color="yellow" title="Application plugin status unavailable">
							{usageError instanceof Error ? usageError.message : String(usageError)}
						</Alert>
					) : usage === null ? (
						<Text size="sm" c="dimmed">
							This view has no access to application plugin status.
						</Text>
					) : usage === undefined ? (
						<Text size="sm" c="dimmed" role="status">
							Reading application plugin status…
						</Text>
					) : visibleApplication.length > 0 ? (
						<PackageGrid>
							{visibleApplication.map((pkg) => (
								<Paper component="li" aria-label={pkg.name} key={pkg.name} withBorder p="sm">
									<Stack gap={5}>
										<Text size="sm" fw={600} style={{ overflowWrap: 'anywhere' }}>
											{pkg.name}
										</Text>
										<PluginNodes usage={pkg} navigation={navigation} />
									</Stack>
								</Paper>
							))}
						</PackageGrid>
					) : (
						<Text size="sm" c="dimmed">
							No other application packages match.
						</Text>
					)}
				</Stack>
			</section>
		</Stack>
	)
}

function PackageGrid({ children }: Readonly<{ children: ReactNode }>) {
	return (
		<Box
			component="ul"
			m={0}
			p={0}
			style={{
				listStyle: 'none',
				display: 'grid',
				gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 18rem), 1fr))',
				gap: 'var(--mantine-spacing-xs)',
			}}
		>
			{children}
		</Box>
	)
}

function PluginNodes({
	usage,
	navigation,
}: Readonly<{ usage?: PackageUsage; navigation: Props['navigation'] }>) {
	if (!usage)
		return (
			<Text size="xs" c="dimmed">
				No plugin nodes reported for this package.
			</Text>
		)
	const items = usage.plugins.map((plugin) => (
		<Group key={plugin.route} justify="space-between" gap={4}>
			{navigation ? (
				<Anchor
					component="button"
					type="button"
					size="xs"
					ta="left"
					style={{ overflowWrap: 'anywhere' }}
					onClick={() =>
						navigation.openDocument({ path: `/plugins/${plugin.route}`, title: plugin.label })
					}
				>
					{plugin.label}
				</Anchor>
			) : (
				<Text size="xs">{plugin.label}</Text>
			)}
			<Text size="xs" c={plugin.lifecycleState === 'running' ? 'teal' : 'dimmed'}>
				{plugin.lifecycleState === 'running' ? 'Running' : 'Stopped'}
				{plugin.availability === 'unavailable' ? ' · Unavailable' : ''}
				{plugin.lifecycleState === 'running' && plugin.activationReason === 'dependency'
					? ' · Dependency'
					: ''}
			</Text>
		</Group>
	))
	if (items.length === 1) return items[0]
	return (
		<details>
			<Text component="summary" size="xs" style={{ cursor: 'pointer' }}>
				{usage.plugins.length} plugin nodes ·{' '}
				{usage.plugins.filter((plugin) => plugin.lifecycleState === 'running').length} running
			</Text>
			<Stack gap={3} mt={4}>
				{items}
			</Stack>
		</details>
	)
}

function RemovalReview({
	review,
	snapshot,
	usageByName,
	busy,
	onCancel,
	onConfirm,
}: Readonly<{
	review: RemovalSelection
	snapshot: PackageManagerSnapshot
	usageByName?: ReadonlyMap<string, PackageUsage>
	busy: boolean
	onCancel(): void
	onConfirm(): void
}>) {
	const element = useRef<HTMLDivElement>(null)
	useLayoutEffect(() => {
		element.current?.scrollIntoView?.({ block: 'nearest' })
		element.current?.focus({ preventScroll: true })
	}, [])
	const stale = snapshot.revision !== review.revision
	return (
		<Paper ref={element} withBorder p="md" role="region" aria-label="Removal review" tabIndex={-1}>
			<Stack gap="xs">
				<Title order={4}>Review removal</Title>
				<Text size="sm">
					Removing these packages withdraws their managed source entries. Stored files and plugin
					data are retained.
				</Text>
				<Box component="ul" pl="md" my={0}>
					{review.packages.map((pkg) => {
						const running =
							usageByName
								?.get(pkg.name)
								?.plugins.filter((plugin) => plugin.lifecycleState === 'running').length ?? 0
						return (
							<li key={pkg.name}>
								<Group gap="xs">
									<Text size="sm" style={{ overflowWrap: 'anywhere' }}>
										{pkg.name}
										{pkg.installedVersion ? `@${pkg.installedVersion}` : ''}
									</Text>
									{pkg.marketRegistry ? (
										<Text size="xs" c="dimmed" style={{ overflowWrap: 'anywhere' }}>
											{pkg.marketRegistry}
										</Text>
									) : null}
									{running > 0 ? (
										<Badge color="yellow" variant="light">
											{running} running
										</Badge>
									) : null}
								</Group>
							</li>
						)
					})}
				</Box>
				<Text size="xs" c="dimmed">
					{snapshot.sourceUpdates === 'next-start'
						? 'The application reads the new selection on its next start.'
						: snapshot.sourceUpdates === 'live'
							? 'The application reconciles the withdrawn entries after removal.'
							: 'Check application plugin status after removal.'}
				</Text>
				{!snapshot.ignoreScripts ? (
					<Text size="sm">
						Resolving remaining packages may run approved build scripts for{' '}
						{snapshot.allowBuilds.join(', ')}.
					</Text>
				) : null}
				{stale ? (
					<Alert color="yellow">
						The installation changed. Cancel and review the current selection.
					</Alert>
				) : null}
				<Group gap="xs">
					<Button color="red" disabled={busy || stale} onClick={onConfirm}>
						Confirm removal
					</Button>
					<Button variant="subtle" onClick={onCancel}>
						Cancel
					</Button>
				</Group>
			</Stack>
		</Paper>
	)
}
