import {
	Alert,
	Anchor,
	Badge,
	Button,
	Card,
	Code,
	Group,
	Loader,
	NativeSelect,
	Stack,
	Text,
	TextInput,
	Title,
} from '@mantine/core'
import { useState } from 'react'
import type { MarketInstallRequest, PackageMarket } from '../contracts.ts'
import { marketPackagesQuery, marketReleaseQuery, marketReleasesQuery } from './manager.scope.ts'

type MarketplaceProps = Readonly<{
	markets: readonly PackageMarket[]
	busy: boolean
	onPrepare(request: MarketInstallRequest): void
}>

export function Marketplace({ markets, busy, onPrepare }: MarketplaceProps) {
	const [selectedMarket, setSelectedMarket] = useState<string>()
	const market = markets.find((item) => item.id === selectedMarket) ?? markets[0]
	if (!market) return null
	return (
		<Stack gap="md">
			<NativeSelect
				label="Market"
				description={market.url}
				value={market.id}
				data={markets.map((item) => ({ value: item.id, label: item.id }))}
				onChange={(event) => setSelectedMarket(event.currentTarget.value)}
			/>
			<MarketPackages key={market.id} marketId={market.id} busy={busy} onPrepare={onPrepare} />
		</Stack>
	)
}

function MarketPackages({
	marketId,
	busy,
	onPrepare,
}: Omit<MarketplaceProps, 'markets'> & Readonly<{ marketId: string }>) {
	const [searchDraft, setSearchDraft] = useState('')
	const [search, setSearch] = useState('')
	const [cursors, setCursors] = useState<string[]>([])
	const [selection, setSelection] = useState<Readonly<{ name: string; latest: string | null }>>()
	const cursor = cursors.at(-1)
	const packages = marketPackagesQuery.useQuery({
		marketId,
		query: { query: search, limit: 20, ...(cursor ? { cursor } : {}) },
	})
	const page = packages.data?.ok ? packages.data.value : undefined
	const error =
		packages.status === 'error'
			? String(packages.error)
			: packages.data && packages.data.ok === false
				? packages.data.error.message
				: undefined
	return (
		<Stack gap="md">
			<form
				onSubmit={(event) => {
					event.preventDefault()
					setSearch(searchDraft.trim())
					setCursors([])
					setSelection(undefined)
				}}
			>
				<Group align="flex-end">
					<TextInput
						label="Search packages"
						value={searchDraft}
						onChange={(event) => setSearchDraft(event.currentTarget.value)}
						style={{ flex: 1 }}
					/>
					<Button type="submit" variant="light">
						Search
					</Button>
				</Group>
			</form>
			{error ? (
				<Alert color="red" title="Market unavailable">
					<Stack gap="xs">
						<Text size="sm">{error}</Text>
						<Text size="sm">Direct installation is still available.</Text>
						<Button
							variant="light"
							loading={packages.isFetching}
							onClick={() => void packages.refetch().catch((): void => {})}
						>
							Retry market
						</Button>
					</Stack>
				</Alert>
			) : null}
			{packages.isFetching ? <Loader size="sm" aria-label="Loading market packages" /> : null}
			{!selection && page?.packages.length === 0 ? (
				<Text c="dimmed">No matching packages.</Text>
			) : null}
			{!selection
				? page?.packages.map((pkg) => (
						<Card key={pkg.name} withBorder>
							<Group justify="space-between" align="flex-start">
								<Stack gap={4} style={{ minWidth: 0, flex: '1 1 220px' }}>
									<Text fw={600} style={{ overflowWrap: 'anywhere' }}>
										{pkg.name}
									</Text>
									{pkg.description ? <Text size="sm">{pkg.description}</Text> : null}
									<Text size="xs" c="dimmed">
										{pkg.latest ? `Latest: ${pkg.latest}` : 'No latest release available'}
									</Text>
								</Stack>
								<Button
									variant="light"
									style={{ flexShrink: 0 }}
									onClick={() => setSelection({ name: pkg.name, latest: pkg.latest })}
								>
									View versions
								</Button>
							</Group>
						</Card>
					))
				: null}
			{page && !selection ? (
				<Group>
					<Button
						variant="subtle"
						disabled={cursors.length === 0 || packages.isFetching}
						onClick={() => {
							setCursors((current) => current.slice(0, -1))
							setSelection(undefined)
						}}
					>
						Previous
					</Button>
					<Text size="sm">Page {cursors.length + 1}</Text>
					<Button
						variant="subtle"
						disabled={!page.nextCursor || packages.isFetching}
						onClick={() => {
							const next = page.nextCursor
							if (next) setCursors((current) => [...current, next])
							setSelection(undefined)
						}}
					>
						Next
					</Button>
				</Group>
			) : null}
			{selection ? (
				<ReleaseVersions
					key={selection.name}
					marketId={marketId}
					name={selection.name}
					latest={selection.latest}
					busy={busy}
					onPrepare={onPrepare}
					onClose={() => setSelection(undefined)}
				/>
			) : null}
		</Stack>
	)
}

function ReleaseVersions({
	marketId,
	name,
	latest,
	busy,
	onPrepare,
	onClose,
}: Omit<MarketplaceProps, 'markets'> &
	Readonly<{
		marketId: string
		name: string
		latest: string | null
		onClose(): void
	}>) {
	const [cursors, setCursors] = useState<string[]>([])
	const [version, setVersion] = useState('')
	const cursor = cursors.at(-1)
	const query = marketReleasesQuery.useQuery({
		marketId,
		name,
		query: { limit: 20, ...(cursor ? { cursor } : {}) },
	})
	const page = query.data?.ok ? query.data.value : undefined
	const error =
		query.status === 'error'
			? String(query.error)
			: query.data && query.data.ok === false
				? query.data.error.message
				: undefined
	return (
		<Stack gap="md">
			<Card withBorder aria-label="Available package versions">
				<Stack gap="sm">
					<Group justify="space-between">
						<Title order={4} style={{ overflowWrap: 'anywhere' }}>
							{name}
						</Title>
						<Button variant="subtle" onClick={onClose}>
							Close versions
						</Button>
					</Group>
					<Text size="sm" c="dimmed">
						Only versions indexed by this market are listed.{' '}
						{latest ? `Registry latest: ${latest}.` : 'The registry has no latest release.'}
					</Text>
					{query.isFetching ? <Loader size="sm" aria-label="Loading package versions" /> : null}
					{error ? (
						<Alert color="red" title="Versions unavailable">
							<Stack gap="xs">
								<Text size="sm">{error}</Text>
								<Button variant="light" onClick={() => void query.refetch().catch((): void => {})}>
									Retry versions
								</Button>
							</Stack>
						</Alert>
					) : null}
					{page?.releases.length === 0 ? (
						<Text c="dimmed">No indexed versions on this page.</Text>
					) : null}
					{page?.releases.length ? (
						<NativeSelect
							label="Package version"
							value={version}
							disabled={query.isFetching || Boolean(error)}
							data={[
								{ value: '', label: 'Select a version' },
								...page.releases.map((release) => ({
									value: release.version,
									label:
										release.version === latest ? `${release.version} (latest)` : release.version,
								})),
							]}
							onChange={(event) => setVersion(event.currentTarget.value)}
						/>
					) : null}
					{page && (cursors.length > 0 || page.nextCursor) ? (
						<Group>
							<Button
								variant="subtle"
								disabled={cursors.length === 0 || query.isFetching}
								onClick={() => {
									setCursors((current) => current.slice(0, -1))
									setVersion('')
								}}
							>
								Previous versions
							</Button>
							<Text size="sm">Page {cursors.length + 1}</Text>
							<Button
								variant="subtle"
								disabled={!page.nextCursor || query.isFetching}
								onClick={() => {
									const next = page.nextCursor
									if (next) setCursors((current) => [...current, next])
									setVersion('')
								}}
							>
								Next versions
							</Button>
						</Group>
					) : null}
				</Stack>
			</Card>
			{version ? (
				<ReleaseDetails
					key={version}
					selection={{ marketId, name, version }}
					busy={busy}
					onPrepare={onPrepare}
					onClose={() => setVersion('')}
				/>
			) : null}
		</Stack>
	)
}

function ReleaseDetails({
	selection,
	busy,
	onPrepare,
	onClose,
}: Omit<MarketplaceProps, 'markets'> &
	Readonly<{
		selection: MarketInstallRequest
		onClose(): void
	}>) {
	const query = marketReleaseQuery.useQuery(selection)
	const release = query.data?.ok ? query.data.value : undefined
	const error =
		query.status === 'error'
			? String(query.error)
			: query.data && query.data.ok === false
				? query.data.error.message
				: undefined
	return (
		<Card withBorder aria-label="Release details">
			<Stack gap="sm">
				<Group justify="space-between">
					<Title order={4} style={{ overflowWrap: 'anywhere' }}>
						{selection.name}@{selection.version}
					</Title>
					<Button variant="subtle" onClick={onClose}>
						Close details
					</Button>
				</Group>
				{query.isFetching ? <Loader size="sm" aria-label="Loading release details" /> : null}
				{error ? (
					<Alert color="red" title="Release unavailable">
						<Stack gap="xs">
							<Text size="sm">{error}</Text>
							<Button variant="light" onClick={() => void query.refetch().catch((): void => {})}>
								Retry release
							</Button>
						</Stack>
					</Alert>
				) : null}
				{release ? (
					<>
						<Text size="sm">
							Registry: <Code>{release.registry}</Code>
						</Text>
						{release.provenance.status === 'verified' ? (
							<Stack gap={4}>
								<Group>
									<Badge color="teal" variant="light">
										Source verified
									</Badge>
									<Anchor
										href={release.provenance.repository}
										target="_blank"
										rel="noopener noreferrer"
									>
										Source repository
									</Anchor>
									{release.provenance.buildUrl ? (
										<Anchor
											href={release.provenance.buildUrl}
											target="_blank"
											rel="noopener noreferrer"
										>
											Build
										</Anchor>
									) : null}
								</Group>
								<Text size="xs" c="dimmed" style={{ overflowWrap: 'anywhere' }}>
									Commit: {release.provenance.commit}
								</Text>
							</Stack>
						) : (
							<Text size="sm" c="dimmed">
								No verified build provenance.
							</Text>
						)}
						<Button disabled={busy || Boolean(error)} onClick={() => onPrepare(selection)}>
							Review installation
						</Button>
					</>
				) : null}
			</Stack>
		</Card>
	)
}
