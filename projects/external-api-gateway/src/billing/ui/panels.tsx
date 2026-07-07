import {
	Alert,
	Badge,
	Button,
	Card,
	Group,
	NumberFormatter,
	ScrollArea,
	SimpleGrid,
	Stack,
	Table,
	Text,
	Title,
} from '@mantine/core'
import { rpcErrorMessage } from '@pluxel/runtime/web/ui'
import { IconTrash } from '@tabler/icons-react'
import { useMemo, useState } from 'react'
import type {
	BillingOverviewDoc,
	BillingProviderSummaryDoc,
	BillingUsageRecord,
	BillingUserSummaryDoc,
} from '../contracts'
import { billingPlugin } from './runtime'

type BillingUiApp = {
	rpc: {
		clearUsage(): Promise<{ ok: true }>
	}
	db: {
		useDocById(collection: 'overview', id: 'overview'): BillingOverviewDoc | undefined
		useList(
			collection: 'records',
			spec?: { limit?: number; sort?: Partial<Record<keyof BillingUsageRecord, 1 | -1>> },
		): BillingUsageRecord[]
		useList(
			collection: 'users',
			spec?: { limit?: number; sort?: Partial<Record<keyof BillingUserSummaryDoc, 1 | -1>> },
		): BillingUserSummaryDoc[]
		useList(
			collection: 'providers',
			spec?: { limit?: number; sort?: Partial<Record<keyof BillingProviderSummaryDoc, 1 | -1>> },
		): BillingProviderSummaryDoc[]
	}
}

function useBillingApp(): BillingUiApp {
	return billingPlugin.use() as unknown as BillingUiApp
}

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
	const app = useBillingApp()
	const overview = app.db.useDocById('overview', 'overview')
	const records = app.db.useList('records', { limit: 30, sort: { at: -1 } })
	const users = app.db.useList('users', { limit: 10, sort: { totalCostCny: -1 } })
	const providers = app.db.useList('providers', { limit: 10, sort: { totalCostCny: -1 } })
	const [error, setError] = useState<string | null>(null)
	const avgLatency = overview?.requestCount
		? Math.round((overview.totalLatencyMs / overview.requestCount) * 10) / 10
		: 0

	const clear = async () => {
		try {
			await app.rpc.clearUsage()
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
			<RecordTable records={records} />
		</Stack>
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
						{rows.map(([label, count, cost]) => (
							<Table.Tr key={label}>
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
