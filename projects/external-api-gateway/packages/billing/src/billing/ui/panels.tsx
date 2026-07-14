import {
	Alert,
	Badge,
	Button,
	Card,
	Group,
	NumberInput,
	NumberFormatter,
	ScrollArea,
	SimpleGrid,
	Stack,
	Table,
	Text,
	TextInput,
	Title,
} from '@mantine/core'
import { rpcErrorMessage } from '@pluxel/runtime/web'
import { IconCheck, IconTrash } from '@tabler/icons-react'
import { useMemo, useState } from 'react'
import { DEFAULT_ZHIPU_LAYOUT_MODEL } from '@repo/external-api-gateway-shared/constants'
import type { BillingRateDoc, BillingUsageRecord } from '../contracts'
import { useBillingModel } from './runtime'

function StatCard({ label, value }: { label: string; value: React.ReactNode }) {
	return (
		<Card withBorder radius="md" p="md">
			<Stack gap={4}>
				<Text size="xs" c="dimmed">
					{label}
				</Text>
				<Text fw={700} size="lg">
					{value}
				</Text>
			</Stack>
		</Card>
	)
}

export function BillingDashboard() {
	return (
		<Stack gap="lg" p="md">
			<Group justify="space-between">
				<Stack gap={2}>
					<Title order={3}>Usage Billing</Title>
					<Text size="sm" c="dimmed">
						按用户、服务商和操作聚合外部 API 成本
					</Text>
				</Stack>
				<Badge variant="light">Gateway-wide</Badge>
			</Group>
			<BillingPanel />
		</Stack>
	)
}

export function BillingPanel() {
	const model = useBillingModel()
	const api = model.commands
	const overview = model.overview.useSnapshot().items.find((item) => item.id === 'overview')
	const records = [...model.records.useSnapshot().items]
		.sort((left, right) => right.at - left.at)
		.slice(0, 30)
	const users = [...model.users.useSnapshot().items]
		.sort((left, right) => right.totalCostCny - left.totalCostCny)
		.slice(0, 10)
	const providers = [...model.providers.useSnapshot().items]
		.sort((left, right) => right.totalCostCny - left.totalCostCny)
		.slice(0, 10)
	const rates = [...model.rates.useSnapshot().items]
		.sort(
			(left, right) =>
				left.provider.localeCompare(right.provider) ||
				left.operation.localeCompare(right.operation) ||
				String(left.model ?? '').localeCompare(String(right.model ?? '')),
		)
		.slice(0, 100)
	const [error, setError] = useState<string | null>(null)
	const avgLatency = overview?.requestCount
		? Math.round((overview.totalLatencyMs / overview.requestCount) * 10) / 10
		: 0

	const clear = async () => {
		try {
			await api.clearUsage()
			setError(null)
		} catch (caught) {
			setError(rpcErrorMessage(caught, '清空用量失败'))
		}
	}

	return (
		<Stack gap="md">
			<Group justify="space-between">
				<Title order={4}>用量总览</Title>
				<Button
					variant="light"
					color="red"
					leftSection={<IconTrash size={16} />}
					onClick={() => void clear()}
				>
					清空
				</Button>
			</Group>
			{error ? <Alert color="red">{error}</Alert> : null}
			<SimpleGrid cols={{ base: 2, md: 4 }}>
				<StatCard label="请求数" value={overview?.requestCount ?? 0} />
				<StatCard
					label="总成本"
					value={
						<NumberFormatter
							value={overview?.totalCostCny ?? 0}
							prefix="¥"
							decimalScale={6}
							thousandSeparator
						/>
					}
				/>
				<StatCard label="错误数" value={overview?.errorCount ?? 0} />
				<StatCard label="平均耗时" value={`${avgLatency} ms`} />
			</SimpleGrid>
			<SimpleGrid cols={{ base: 1, md: 2 }}>
				<SummaryTable
					title="用户"
					rows={users.map((u) => [u.userId, u.requestCount, u.totalCostCny])}
				/>
				<SummaryTable
					title="服务商 / 操作"
					rows={providers.map((p) => [
						`${p.provider}:${p.operation}`,
						p.requestCount,
						p.totalCostCny,
					])}
				/>
			</SimpleGrid>
			<RatePanel
				rates={rates}
				onSave={(input) => api.upsertRate(input)}
				onError={(message) => setError(message)}
			/>
			<RecordTable records={records} />
		</Stack>
	)
}

function RatePanel({
	rates,
	onSave,
	onError,
}: {
	rates: BillingRateDoc[]
	onSave: (input: Omit<BillingRateDoc, 'id' | 'updatedAt'>) => Promise<BillingRateDoc>
	onError: (message: string | null) => void
}) {
	const [provider, setProvider] = useState('zhipu')
	const [operation, setOperation] = useState('ocr.layout_parsing')
	const [model, setModel] = useState(DEFAULT_ZHIPU_LAYOUT_MODEL)
	const [unitName, setUnitName] = useState('request')
	const [unitCostCny, setUnitCostCny] = useState<number | string>(0)
	const [saving, setSaving] = useState(false)
	const canSave = Boolean(provider.trim() && operation.trim())

	const save = async () => {
		setSaving(true)
		try {
			await onSave({
				provider: provider.trim(),
				operation: operation.trim(),
				...(model.trim() ? { model: model.trim() } : {}),
				unitName: unitName.trim() || 'request',
				unitCostCny: Number(unitCostCny) || 0,
			})
			onError(null)
		} catch (caught) {
			onError(rpcErrorMessage(caught, '保存费率失败'))
		} finally {
			setSaving(false)
		}
	}

	return (
		<Card withBorder radius="md" p="md">
			<Stack gap="sm">
				<Group justify="space-between">
					<Title order={5}>费率</Title>
					<Button
						leftSection={<IconCheck size={16} />}
						loading={saving}
						disabled={!canSave}
						onClick={() => void save()}
					>
						保存费率
					</Button>
				</Group>
				<SimpleGrid cols={{ base: 1, md: 5 }}>
					<TextInput
						label="Provider"
						value={provider}
						onChange={(event) => setProvider(event.currentTarget.value)}
					/>
					<TextInput
						label="Operation"
						value={operation}
						onChange={(event) => setOperation(event.currentTarget.value)}
					/>
					<TextInput
						label="Model"
						value={model}
						onChange={(event) => setModel(event.currentTarget.value)}
					/>
					<TextInput
						label="Unit"
						value={unitName}
						onChange={(event) => setUnitName(event.currentTarget.value)}
					/>
					<NumberInput
						label="CNY / unit"
						value={unitCostCny}
						onChange={setUnitCostCny}
						min={0}
						decimalScale={8}
					/>
				</SimpleGrid>
				<ScrollArea h={220} type="auto">
					<Table striped highlightOnHover>
						<Table.Thead>
							<Table.Tr>
								<Table.Th>Provider</Table.Th>
								<Table.Th>Operation</Table.Th>
								<Table.Th>Model</Table.Th>
								<Table.Th>Unit</Table.Th>
								<Table.Th>单价</Table.Th>
							</Table.Tr>
						</Table.Thead>
						<Table.Tbody>
							{rates.map((rate) => (
								<Table.Tr key={rate.id}>
									<Table.Td>{rate.provider}</Table.Td>
									<Table.Td>{rate.operation}</Table.Td>
									<Table.Td>{rate.model ?? '-'}</Table.Td>
									<Table.Td>{rate.unitName}</Table.Td>
									<Table.Td>
										<NumberFormatter value={rate.unitCostCny} prefix="¥" decimalScale={8} />
									</Table.Td>
								</Table.Tr>
							))}
						</Table.Tbody>
					</Table>
				</ScrollArea>
			</Stack>
		</Card>
	)
}

function SummaryTable({ title, rows }: { title: string; rows: [string, number, number][] }) {
	return (
		<Card withBorder radius="md" p="md">
			<Stack gap="sm">
				<Title order={5}>{title}</Title>
				<Table striped>
					<Table.Thead>
						<Table.Tr>
							<Table.Th>维度</Table.Th>
							<Table.Th>请求</Table.Th>
							<Table.Th>成本</Table.Th>
						</Table.Tr>
					</Table.Thead>
					<Table.Tbody>
						{rows.map(([label, count, cost], index) => (
							<Table.Tr key={`${title}:${label}:${index}`}>
								<Table.Td>{label}</Table.Td>
								<Table.Td>{count}</Table.Td>
								<Table.Td>
									<NumberFormatter value={cost} prefix="¥" decimalScale={6} />
								</Table.Td>
							</Table.Tr>
						))}
					</Table.Tbody>
				</Table>
			</Stack>
		</Card>
	)
}

function RecordTable({ records }: { records: BillingUsageRecord[] }) {
	const rows = useMemo(
		() =>
			records.map((record) => (
				<Table.Tr key={record.id}>
					<Table.Td>{new Date(record.at).toLocaleTimeString()}</Table.Td>
					<Table.Td>{record.userId}</Table.Td>
					<Table.Td>{record.provider}</Table.Td>
					<Table.Td>{record.operation}</Table.Td>
					<Table.Td>
						<Badge color={record.ok ? 'teal' : 'red'} variant="light">
							{record.status}
						</Badge>
					</Table.Td>
					<Table.Td>
						<NumberFormatter value={record.costCny} prefix="¥" decimalScale={6} />
					</Table.Td>
				</Table.Tr>
			)),
		[records],
	)

	return (
		<Card withBorder radius="md" p="md">
			<Stack gap="sm">
				<Title order={5}>最近调用</Title>
				<ScrollArea h={320} type="auto">
					<Table striped highlightOnHover>
						<Table.Thead>
							<Table.Tr>
								<Table.Th>时间</Table.Th>
								<Table.Th>User</Table.Th>
								<Table.Th>Provider</Table.Th>
								<Table.Th>操作</Table.Th>
								<Table.Th>状态</Table.Th>
								<Table.Th>成本</Table.Th>
							</Table.Tr>
						</Table.Thead>
						<Table.Tbody>{rows}</Table.Tbody>
					</Table>
				</ScrollArea>
			</Stack>
		</Card>
	)
}
