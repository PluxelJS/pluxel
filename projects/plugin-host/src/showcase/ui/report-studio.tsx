import {
	Alert,
	Badge,
	Button,
	Card,
	Code,
	Group,
	Image,
	Loader,
	MantineProvider,
	Paper,
	SimpleGrid,
	Stack,
	Table,
	Text,
	TextInput,
	Title,
} from '@mantine/core'
import type { RpcStub } from '@pluxel/runtime/capnweb'
import {
	useRemoteValue,
	useWorkbench,
	type WorkbenchHostFacade,
} from '@pluxel/runtime/workbench/react'
import { useMemo, useState } from 'react'
import {
	ReportStudioWorkbench,
	type ReportStudioApi,
	type ShowcaseArtifact,
	type ShowcaseSnapshot,
} from '../ReportStudio.workbench'

const INSPECTION_SURFACES = Object.freeze([
	['Catalog + lifecycle', 'Plugins'],
	['Providers + S3 forks', 'Dependencies'],
	['PluginPart settings', 'Config'],
	['Commands + telemetry', 'Agent tools · Logs'],
] as const)

const SHOWCASE_ROUTES = Object.freeze([
	'GET /showcase/status',
	'POST /showcase/generate/:title',
	'GET /showcase/artifacts/:id',
	'GET /showcase/metrics',
] as const)

export default function ReportStudio() {
	const { api, host } = useWorkbench(ReportStudioWorkbench.studio)
	return (
		<MantineProvider forceColorScheme={host.colorScheme}>
			<ReportStudioContent api={api} host={host} />
		</MantineProvider>
	)
}

function ReportStudioContent({
	api,
	host,
}: Readonly<{ api: RpcStub<ReportStudioApi>; host: WorkbenchHostFacade }>) {
	const [title, setTitle] = useState('Pluxel architecture in practice')
	const [busy, setBusy] = useState<'generate' | 'probe' | 'clear'>()
	const [error, setError] = useState<string>()
	const [preview, setPreview] = useState<ShowcaseArtifact>()
	const remote = useRemoteValue<ShowcaseSnapshot>(
		{
			read: async () => {
				const raw = await api.snapshot()
				try {
					return cloneSnapshot(raw)
				} finally {
					dispose(raw)
				}
			},
			subscribe: (invalidate) => api.watch(() => invalidate()),
		},
		[api],
	)

	const snapshot = remote.state === 'ready' ? remote.value : undefined
	const newest = snapshot?.artifacts.at(-1)
	const activePreview = preview ?? newest
	const providers = useMemo<readonly (readonly [string, string])[]>(
		() =>
			snapshot
				? ([
						['Renderer', snapshot.rendererProvider],
						['Cache', snapshot.cacheProvider],
						['Rates owner', snapshot.ratesProvider],
						['Draft S3 fork', snapshot.draftStorageProvider],
						['Release S3 fork', snapshot.releaseStorageProvider],
					] as const)
				: [],
		[snapshot],
	)

	const generate = async () => {
		setBusy('generate')
		setError(undefined)
		let raw: Awaited<ReturnType<typeof api.generate>> | undefined
		try {
			raw = await api.generate(title)
			setPreview(cloneArtifact(raw))
			host.notify({ title: 'Report generated', message: `${raw.engine} · ${raw.byteLength} bytes` })
		} catch (caught) {
			setError(messageOf(caught))
		} finally {
			dispose(raw)
			setBusy(undefined)
		}
	}

	const probe = async () => {
		setBusy('probe')
		setError(undefined)
		let raw: Awaited<ReturnType<typeof api.probeOutbound>> | undefined
		try {
			raw = await api.probeOutbound()
			if (!raw?.ok) setError(raw?.message ?? 'Outbound probe failed')
		} catch (caught) {
			setError(messageOf(caught))
		} finally {
			dispose(raw)
			setBusy(undefined)
		}
	}

	const clear = async () => {
		setBusy('clear')
		setError(undefined)
		let raw: Awaited<ReturnType<typeof api.clearCache>> | undefined
		try {
			raw = await api.clearCache()
			host.notify({ title: 'Preview cache cleared', message: `${raw.entries} entries remain` })
		} catch (caught) {
			setError(messageOf(caught))
		} finally {
			dispose(raw)
			setBusy(undefined)
		}
	}

	if (remote.state === 'loading') return <Loader size="sm" />
	if (remote.state === 'error') return <Alert color="red">{messageOf(remote.error)}</Alert>

	return (
		<Stack gap="lg">
			<div>
				<Badge variant="light" color="teal">
					LIVE COMPOSITION
				</Badge>
				<Title order={2} mt="xs">
					Pluxel Architecture Lab
				</Title>
				<Text c="dimmed" maw={820}>
					一次生成会经过 caller-aware Rates、Cache、可替换 renderer、共享 worker、两个 S3 fork、OTel
					和 Workbench observer。下面的结果来自真实插件调用链。
				</Text>
			</div>

			{error ? <Alert color="red">{error}</Alert> : null}

			<SimpleGrid cols={{ base: 1, md: 2 }}>
				<Paper withBorder p="md" radius="md">
					<Stack gap="sm">
						<Title order={4}>Generate a report</Title>
						<TextInput
							label="Report title"
							value={title}
							maxLength={80}
							disabled={busy !== undefined}
							onChange={(event) => setTitle(event.currentTarget.value)}
						/>
						<Group>
							<Button
								loading={busy === 'generate'}
								disabled={busy !== undefined}
								onClick={() => void generate()}
							>
								Render + publish
							</Button>
							<Button
								variant="light"
								loading={busy === 'probe'}
								disabled={busy !== undefined}
								onClick={() => void probe()}
							>
								Probe outbound HTTP
							</Button>
							<Button
								variant="subtle"
								loading={busy === 'clear'}
								disabled={busy !== undefined}
								onClick={() => void clear()}
							>
								Clear cache
							</Button>
						</Group>
						{snapshot.lastOutbound ? (
							<Group gap="xs">
								<Badge color={snapshot.lastOutbound.ok ? 'teal' : 'red'} variant="light">
									Outbound {snapshot.lastOutbound.status ?? 'failed'}
								</Badge>
								<Text size="xs" c="dimmed">
									{snapshot.lastOutbound.message}
								</Text>
							</Group>
						) : null}
						<Text size="xs" c="dimmed">
							切换 renderer、Cache/Rate backend 或 S3 dependency 后，Runtime 会重启真实 dependent
							closure；本页面的新 target 会反映新 generation。
						</Text>
					</Stack>
				</Paper>

				<Card withBorder radius="md" padding="md">
					<Title order={4}>Generated preview</Title>
					{activePreview ? (
						<Stack gap="xs" mt="sm">
							<Image src={artifactUrl(activePreview.id)} alt={activePreview.title} radius="sm" />
							<Group gap="xs">
								<Badge>{activePreview.engine}</Badge>
								<Badge color={activePreview.cacheHit ? 'teal' : 'blue'}>
									{activePreview.cacheHit ? 'cache hit' : 'fresh render'}
								</Badge>
								<Text size="xs" c="dimmed">
									{activePreview.byteLength.toLocaleString()} bytes
								</Text>
							</Group>
							<Code>{activePreview.objectKey}</Code>
						</Stack>
					) : (
						<Text c="dimmed" size="sm" mt="sm">
							Generate the first preview to exercise the graph.
						</Text>
					)}
				</Card>
			</SimpleGrid>

			<SimpleGrid cols={{ base: 1, md: 3 }}>
				<Metric label="Cache entries" value={snapshot.cache.entries} />
				<Metric label="Cache hits" value={snapshot.cache.localHits + snapshot.cache.backendHits} />
				<Metric
					label="Rate remaining"
					value={snapshot.lastRateDecision?.remaining ?? 'not sampled'}
				/>
			</SimpleGrid>

			<SimpleGrid cols={{ base: 1, lg: 2 }}>
				<Paper withBorder p="md" radius="md">
					<Title order={4} mb="sm">
						Active implementations
					</Title>
					<Table withTableBorder withRowBorders={false}>
						<Table.Tbody>
							{providers.map(([label, value]) => (
								<Table.Tr key={label}>
									<Table.Td w={160}>{label}</Table.Td>
									<Table.Td>
										<Code>{value}</Code>
									</Table.Td>
								</Table.Tr>
							))}
						</Table.Tbody>
					</Table>
				</Paper>

				<Paper withBorder p="md" radius="md">
					<Title order={4}>Inspect in Workbench</Title>
					<Stack gap="xs" mt="sm">
						{INSPECTION_SURFACES.map(([label, location]) => (
							<Group key={label} justify="space-between" wrap="nowrap">
								<Text size="sm">{label}</Text>
								<Badge variant="outline" color="gray">
									{location}
								</Badge>
							</Group>
						))}
					</Stack>
					<Title order={5} mt="lg">
						HTTP + metrics
					</Title>
					<Group gap="xs" mt="xs">
						{SHOWCASE_ROUTES.map((route) => (
							<Code key={route}>{route}</Code>
						))}
					</Group>
					<Text size="xs" c="dimmed" mt="sm">
						The generated MF2 Bridge renders this view; Agent tools expose the two showcase
						commands.
					</Text>
				</Paper>
			</SimpleGrid>
		</Stack>
	)
}

function Metric({ label, value }: { label: string; value: string | number }) {
	return (
		<Card withBorder radius="md">
			<Text size="xs" tt="uppercase" c="dimmed" fw={700}>
				{label}
			</Text>
			<Text size="xl" fw={700} mt={4}>
				{value}
			</Text>
		</Card>
	)
}

function cloneSnapshot(value: ShowcaseSnapshot): ShowcaseSnapshot {
	return Object.freeze({
		...value,
		cache: Object.freeze({ ...value.cache }),
		...(value.lastRateDecision
			? { lastRateDecision: Object.freeze({ ...value.lastRateDecision }) }
			: {}),
		artifacts: Object.freeze(value.artifacts.map(cloneArtifact)),
		...(value.lastOutbound ? { lastOutbound: Object.freeze({ ...value.lastOutbound }) } : {}),
	})
}

function artifactUrl(id: string): string {
	return `/showcase/artifacts/${encodeURIComponent(id)}`
}

function cloneArtifact(value: ShowcaseArtifact): ShowcaseArtifact {
	return Object.freeze({ ...value })
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

function dispose(value: unknown): void {
	const action =
		value && (typeof value === 'object' || typeof value === 'function')
			? (value as Partial<Disposable>)[Symbol.dispose]
			: undefined
	if (typeof action === 'function') action.call(value)
}
