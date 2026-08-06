import {
	Alert,
	Badge,
	Button,
	Card,
	Code,
	Group,
	Loader,
	Stack,
	Table,
	Text,
	Textarea,
	Title,
} from '@mantine/core'
import { createWorkbenchUi } from '@pluxel/runtime/workbench/ui'
import { IconDownload, IconRefresh, IconTrash } from '@tabler/icons-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PackageManagerSnapshot, PackageMutationResult } from '../contracts.ts'
import { PackageManagerWorkbenchUi } from '../workbench-contract.ts'

const ui = createWorkbenchUi(PackageManagerWorkbenchUi)

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
	const { manager } = ui.useResources()
	const requestId = useRef(0)
	const [snapshot, setSnapshot] = useState<PackageManagerSnapshot>()
	const [specs, setSpecs] = useState('')
	const [loading, setLoading] = useState(true)
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string>()

	const refresh = useCallback(async () => {
		const current = ++requestId.current
		setLoading(true)
		try {
			const next = await manager.snapshot()
			if (requestId.current !== current) return
			setSnapshot(next)
			setError(undefined)
		} catch (caught) {
			if (requestId.current === current) setError(messageOf(caught))
		} finally {
			if (requestId.current === current) setLoading(false)
		}
	}, [manager])

	useEffect(() => {
		void refresh()
		return () => {
			requestId.current += 1
		}
	}, [refresh])

	const mutate = async (operation: () => Promise<PackageMutationResult>) => {
		if (busy) return
		setBusy(true)
		try {
			const result = await operation()
			setError(mutationMessage(result))
			await refresh()
		} catch (caught) {
			setError(messageOf(caught))
		} finally {
			setBusy(false)
		}
	}

	const install = async () => {
		const requested = parseSpecs(specs)
		if (requested.length === 0) {
			setError('Enter at least one npm package specifier.')
			return
		}
		await mutate(() => manager.install(requested))
	}

	return (
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
					onClick={() => void refresh()}
				>
					Refresh
				</Button>
			</Group>

			{error ? (
				<Alert color="red" style={{ whiteSpace: 'pre-wrap' }}>
					{error}
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
							loading={busy}
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
												onClick={() => void mutate(() => manager.remove([pkg.name]))}
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
	)
}

export default ui.define({ Manager })
