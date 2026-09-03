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
	Text,
	Textarea,
	Title,
} from '@mantine/core'
import { IconDownload, IconRefresh, IconTrash } from '@tabler/icons-react'
import { useState } from 'react'
import type { PackageMutationResult } from '../contracts.ts'
import {
	installPackagesMutation,
	managerScope,
	packageManagerSnapshotQuery,
	removePackagesMutation,
} from './manager.scope.ts'

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

function mutationMessage(result: PackageMutationResult): string | undefined {
	if (result.failed.length === 0) return undefined
	return result.failed.map((failure) => `${failure.input}: ${failure.message}`).join('\n')
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
	const installPackages = installPackagesMutation.useMutation()
	const removePackages = removePackagesMutation.useMutation()
	const snapshot = snapshotQuery.data
	const [specs, setSpecs] = useState('')
	const [error, setError] = useState<string>()
	const loading = snapshotQuery.isPending || snapshotQuery.isFetching
	const mutating = installPackages.isPending || removePackages.isPending
	// mutateAsync settles after cache invalidation, not after the authoritative snapshot refetch.
	// Keep write controls closed until that refresh has caught up.
	const busy = loading || mutating
	const visibleError =
		error ?? (snapshotQuery.status === 'error' ? messageOf(snapshotQuery.error) : undefined)

	const refresh = async () => {
		try {
			await snapshotQuery.refetch()
			setError(undefined)
		} catch (caught) {
			setError(messageOf(caught))
		}
	}

	const applyMutation = async (operation: Promise<PackageMutationResult>) => {
		try {
			const result = await operation
			setError(mutationMessage(result))
		} catch (caught) {
			setError(messageOf(caught))
		}
	}

	const install = async () => {
		const requested = parseSpecs(specs)
		if (requested.length === 0) {
			setError('Enter at least one npm package specifier.')
			return
		}
		await applyMutation(installPackages.mutateAsync(requested))
	}

	return (
		<MantineProvider forceColorScheme={host.colorScheme}>
			<Stack gap="md" p="md">
				<Group justify="space-between" align="flex-start">
					<Stack gap={2}>
						<Title order={3}>Managed plugin packages</Title>
						<Text size="sm" c="dimmed">
							Powered by the pnpm Rust engine. Package publication and plugin activation remain
							separate.
						</Text>
					</Stack>
					<Button
						variant="light"
						leftSection={<IconRefresh size={16} />}
						loading={loading}
						disabled={mutating}
						onClick={() => void refresh()}
					>
						Refresh
					</Button>
				</Group>

				{visibleError ? (
					<Alert color="red" style={{ whiteSpace: 'pre-wrap' }}>
						{visibleError}
					</Alert>
				) : null}

				{snapshot?.dependenciesWithBuildScripts.length ? (
					<Alert color="yellow" title="Dependencies declare build scripts">
						Execution follows the host&apos;s exact build policy. Reported dependencies:{' '}
						<Code>
							{snapshot.dependenciesWithBuildScripts.slice(0, 8).join(', ')}
							{snapshot.dependenciesWithBuildScripts.length > 8 ? ', …' : ''}
						</Code>
					</Alert>
				) : null}

				<Card withBorder>
					<Stack gap="sm">
						<Textarea
							label="Install package specs"
							description="One package per line, for example @scope/plugin@latest."
							minRows={3}
							value={specs}
							disabled={busy}
							onChange={(event) => setSpecs(event.currentTarget.value)}
						/>
						<Group>
							<Button
								leftSection={<IconDownload size={16} />}
								loading={mutating}
								disabled={busy}
								onClick={() => void install()}
							>
								Install
							</Button>
							{snapshot ? <Badge variant="light">pnpm {snapshot.engine}</Badge> : null}
						</Group>
					</Stack>
				</Card>

				<Card withBorder p={0}>
					{loading && !snapshot ? (
						<Group p="md">
							<Loader size="sm" />
							<Text>Loading packages…</Text>
						</Group>
					) : (
						<Table.ScrollContainer minWidth={720}>
							<Table striped highlightOnHover>
								<Table.Thead>
									<Table.Tr>
										<Table.Th>Package</Table.Th>
										<Table.Th>Requested</Table.Th>
										<Table.Th>Installed</Table.Th>
										<Table.Th>Source</Table.Th>
										<Table.Th>Action</Table.Th>
									</Table.Tr>
								</Table.Thead>
								<Table.Tbody>
									{snapshot?.packages.map((pkg) => (
										<Table.Tr key={pkg.name}>
											<Table.Td>
												<Code>{pkg.name}</Code>
											</Table.Td>
											<Table.Td>{pkg.requested}</Table.Td>
											<Table.Td>{pkg.installedVersion ?? 'not materialized'}</Table.Td>
											<Table.Td>{pkg.entryFile ? 'published' : 'not published'}</Table.Td>
											<Table.Td>
												<Button
													size="xs"
													variant="subtle"
													color="red"
													leftSection={<IconTrash size={14} />}
													disabled={busy}
													onClick={() => void applyMutation(removePackages.mutateAsync([pkg.name]))}
												>
													Remove
												</Button>
											</Table.Td>
										</Table.Tr>
									))}
								</Table.Tbody>
							</Table>
						</Table.ScrollContainer>
					)}
				</Card>

				{snapshot ? (
					<Text size="xs" c="dimmed">
						Managed root: <Code>{snapshot.rootDir}</Code>; dynamic entries:{' '}
						<Code>{snapshot.entriesDir}</Code>
					</Text>
				) : null}
			</Stack>
		</MantineProvider>
	)
}

export default managerScope.render(Manager)
