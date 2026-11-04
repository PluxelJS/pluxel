import {
	Alert,
	Badge,
	Button,
	Card,
	Code,
	Group,
	Loader,
	MantineProvider,
	Stack,
	Table,
	Tabs,
	Text,
	Textarea,
	Title,
} from '@mantine/core'
import { IconDownload, IconRefresh, IconTrash } from '@tabler/icons-react'
import { useState } from 'react'
import type { PackageInstallPlan, PackageMutationResult } from '../contracts.ts'
import {
	confirmInstallMutation,
	managerScope,
	packageManagerSnapshotQuery,
	prepareInstallMutation,
	removePackagesMutation,
	type PrepareInstallInput,
} from './manager.scope.ts'
import { Marketplace } from './marketplace.tsx'

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
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

export function Manager() {
	const { host } = managerScope.useWorkbench()
	const snapshotQuery = packageManagerSnapshotQuery.useQuery()
	const preparation = prepareInstallMutation.useMutation()
	const confirmation = confirmInstallMutation.useMutation()
	const removal = removePackagesMutation.useMutation()
	const snapshot = snapshotQuery.data
	const [specs, setSpecs] = useState('')
	const [inputError, setInputError] = useState<string>()
	const [tab, setTab] = useState<string | null>('installed')
	const loading = snapshotQuery.isPending || snapshotQuery.isFetching
	const mutating = preparation.isPending || confirmation.isPending || removal.isPending
	// A settled mutation has invalidated the snapshot, but its authoritative read may still be pending.
	const busy = loading || mutating
	const plan = preparation.data?.ok ? preparation.data.plan : undefined
	const confirmAttempted = confirmation.status !== 'idle'

	const prepare = (input: PrepareInstallInput) => {
		confirmation.reset()
		preparation.mutate(input)
	}

	return (
		<MantineProvider forceColorScheme={host.colorScheme}>
			<Stack gap="md" p="md">
				<Group justify="space-between" align="flex-start">
					<Stack gap={2}>
						<Title order={3}>Plugin packages</Title>
						<Text size="sm" c="dimmed">
							Find, review and install packages for this application.
						</Text>
					</Stack>
					<Button
						variant="light"
						leftSection={<IconRefresh size={16} />}
						loading={loading}
						disabled={mutating}
						onClick={() => void snapshotQuery.refetch().catch((): void => {})}
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
						{preparation.data.failed
							.map((failure) => `${failure.input}: ${failure.message}`)
							.join('\n')}
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
						plan={plan}
						busy={busy}
						confirmAttempted={confirmAttempted}
						onConfirm={() => confirmation.mutate(plan.id)}
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
									<Button variant="light" disabled={busy} onClick={() => removal.mutate([name])}>
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

				<Tabs value={tab} onChange={setTab} keepMounted={false}>
					<Tabs.List>
						<Tabs.Tab value="installed">
							Installed{snapshot ? ` (${snapshot.packages.length})` : ''}
						</Tabs.Tab>
						<Tabs.Tab value="direct">Direct install</Tabs.Tab>
						{snapshot?.markets.length ? <Tabs.Tab value="market">Marketplace</Tabs.Tab> : null}
					</Tabs.List>
					<Tabs.Panel value="direct" pt="md">
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
										Review installation
									</Button>
									{snapshot?.markets.length === 0 ? (
										<Text size="sm" c="dimmed">
											No market configured. Install directly from npm.
										</Text>
									) : null}
								</Group>
							</Stack>
						</form>
					</Tabs.Panel>
					{snapshot?.markets.length ? (
						<Tabs.Panel value="market" pt="md">
							<Marketplace
								markets={snapshot.markets}
								busy={busy}
								onPrepare={(request) => prepare({ kind: 'market', ...request })}
							/>
						</Tabs.Panel>
					) : null}
					<Tabs.Panel value="installed" pt="md">
						{loading && !snapshot ? (
							<Group>
								<Loader size="sm" />
								<Text>Loading packages…</Text>
							</Group>
						) : null}
						{snapshot?.packages.length === 0 ? (
							<Text c="dimmed">
								No managed packages yet. Install a package directly
								{snapshot.markets.length > 0 ? ' or browse the marketplace' : ''}.
							</Text>
						) : null}
						{snapshot?.packages.length ? (
							<Table.ScrollContainer minWidth={580}>
								<Table highlightOnHover>
									<Table.Thead>
										<Table.Tr>
											<Table.Th>Package</Table.Th>
											<Table.Th>Version</Table.Th>
											<Table.Th>Installation</Table.Th>
											<Table.Th>Action</Table.Th>
										</Table.Tr>
									</Table.Thead>
									<Table.Tbody>
										{snapshot.packages.map((pkg) => (
											<Table.Tr key={pkg.name}>
												<Table.Td>
													<Text size="sm" fw={500}>
														{pkg.name}
													</Text>
													<Text size="xs" c="dimmed">
														Requested: {pkg.requested}
													</Text>
												</Table.Td>
												<Table.Td>{pkg.installedVersion ?? 'Not downloaded'}</Table.Td>
												<Table.Td>
													<Text size="sm">
														{pkg.entryFile ? 'Source published' : 'Not published'}
													</Text>
												</Table.Td>
												<Table.Td>
													<Button
														size="xs"
														variant="subtle"
														color="red"
														leftSection={<IconTrash size={14} />}
														disabled={busy}
														onClick={() => removal.mutate([pkg.name])}
													>
														Remove
													</Button>
												</Table.Td>
											</Table.Tr>
										))}
									</Table.Tbody>
								</Table>
							</Table.ScrollContainer>
						) : null}
						{snapshot?.packages.length ? (
							<Text size="sm" c="dimmed" mt="sm">
								{activationMessage(snapshot.sourceUpdates)} Removing packages keeps their stored
								data.
							</Text>
						) : null}
					</Tabs.Panel>
				</Tabs>
			</Stack>
		</MantineProvider>
	)
}

function activationMessage(mode: PackageInstallPlan['sourceUpdates']): string {
	return mode === 'next-start'
		? 'Package changes become available on the next application start.'
		: mode === 'live'
			? 'Package changes are submitted to the application. Check plugin status for activation.'
			: 'Check plugin status after applying package changes.'
}

function InstallationReview({
	plan,
	busy,
	confirmAttempted,
	onConfirm,
	onDiscard,
}: Readonly<{
	plan: PackageInstallPlan
	busy: boolean
	confirmAttempted: boolean
	onConfirm(): void
	onDiscard(): void
}>) {
	return (
		<Card withBorder aria-label="Installation review">
			<Stack gap="sm">
				<Title order={4}>Review installation</Title>
				<Text size="sm">
					These exact versions have been prepared. Confirm to publish their plugin entries.
				</Text>
				{plan.packages.map((pkg) => (
					<Group key={pkg.name} justify="space-between">
						<Stack gap={2}>
							<Code style={{ overflowWrap: 'anywhere' }}>{pkg.name}</Code>
							<Text size="sm">
								{pkg.previousVersion && pkg.previousVersion !== pkg.version
									? `${pkg.previousVersion} → `
									: ''}
								{pkg.version}
							</Text>
						</Stack>
						<Badge variant="light" color={pkg.changed ? 'blue' : 'gray'}>
							{pkg.changed
								? pkg.previousVersion
									? pkg.previousVersion === pkg.version
										? 'Dependencies'
										: 'Update'
									: 'Add'
								: 'Unchanged'}
						</Badge>
					</Group>
				))}
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
					<Button disabled={busy || confirmAttempted} onClick={onConfirm}>
						Confirm installation
					</Button>
					<Button variant="subtle" disabled={busy} onClick={onDiscard}>
						{confirmAttempted ? 'Close review' : 'Discard review'}
					</Button>
				</Group>
				{confirmAttempted ? (
					<Text size="xs" c="dimmed">
						Prepare a new review to make another installation attempt.
					</Text>
				) : null}
			</Stack>
		</Card>
	)
}

function MutationReceipt({
	result,
	action,
	sourceUpdates,
}: Readonly<{
	result: PackageMutationResult
	action: 'install' | 'remove'
	sourceUpdates: PackageInstallPlan['sourceUpdates']
}>) {
	return (
		<Alert
			color={result.ok ? 'teal' : 'yellow'}
			title={
				result.ok
					? action === 'install'
						? 'Package sources published'
						: 'Package sources removed'
					: 'Package operation needs attention'
			}
		>
			<Stack gap="xs">
				{result.succeeded.length > 0 ? (
					<Text size="sm">
						{action === 'install' ? 'Published' : 'Removed'}: {result.succeeded.join(', ')}.{' '}
						{activationMessage(sourceUpdates)}
					</Text>
				) : null}
				{result.failed.map((failure, index) => (
					<Text key={`${failure.input}:${index}`} size="sm">
						{failure.input}: {failure.message}
					</Text>
				))}
			</Stack>
		</Alert>
	)
}

export default managerScope.render(Manager)
