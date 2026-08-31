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
import { useWorkbench } from '@pluxel/runtime/workbench/react'
import { IconDownload, IconRefresh, IconTrash } from '@tabler/icons-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PackageManagerSnapshot, PackageMutationResult } from '../contracts.ts'
import { PackageManagerWorkbench } from '../workbench.ts'

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

function copySnapshot(input: PackageManagerSnapshot): PackageManagerSnapshot {
	return Object.freeze({
		revision: input.revision,
		engine: input.engine,
		rootDir: input.rootDir,
		entriesDir: input.entriesDir,
		packages: Object.freeze(
			input.packages.map((pkg) =>
				Object.freeze({
					name: pkg.name,
					requested: pkg.requested,
					installedVersion: pkg.installedVersion,
					entryFile: pkg.entryFile,
				}),
			),
		),
		dependenciesWithBuildScripts: Object.freeze([...input.dependenciesWithBuildScripts]),
	})
}

function copyMutationResult(input: PackageMutationResult): PackageMutationResult {
	const succeeded = Object.freeze([...input.succeeded])
	if (input.ok) return Object.freeze({ ok: true, succeeded, failed: Object.freeze([] as const) })
	return Object.freeze({
		ok: false,
		succeeded,
		failed: Object.freeze(
			input.failed.map((failure) =>
				Object.freeze({
					input: failure.input,
					code: failure.code,
					message: failure.message,
				}),
			) as [PackageMutationResult['failed'][number], ...PackageMutationResult['failed'][number][]],
		),
	})
}

function disposeRemoteValue(input: unknown): void {
	const dispose =
		input && (typeof input === 'object' || typeof input === 'function')
			? (input as Partial<Disposable>)[Symbol.dispose]
			: undefined
	if (typeof dispose === 'function') dispose.call(input)
}

export function Manager() {
	const { api, host } = useWorkbench(PackageManagerWorkbench.manager)
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
			using next = await api.snapshot()
			if (requestId.current !== current) return
			setSnapshot(copySnapshot(next))
			setError(undefined)
		} catch (caught) {
			if (requestId.current === current) setError(messageOf(caught))
		} finally {
			if (requestId.current === current) setLoading(false)
		}
	}, [api])

	useEffect(() => {
		void refresh()
		return () => {
			requestId.current += 1
		}
	}, [refresh])

	const mutate = async (operation: () => PromiseLike<PackageMutationResult>) => {
		if (busy) return
		setBusy(true)
		try {
			const remoteResult = await operation()
			let result: PackageMutationResult
			try {
				result = copyMutationResult(remoteResult)
			} finally {
				disposeRemoteValue(remoteResult)
			}
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
		await mutate(() => api.install(requested))
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
													onClick={() => void mutate(() => api.remove([pkg.name]))}
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

export default Manager
