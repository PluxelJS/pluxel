import { Badge, Box, Divider, Group, Paper, Stack, Text } from '@mantine/core'
import type { BuiltinBadgeValue, BuiltinInfoCardBlock } from '@pluxel/runtime/web/extensions'
import { useSignalDbQueryState } from '@pluxel/runtime/web'
import {
	isObject,
	resolveSignalDbRef,
	stableSignalDbValueKey,
	useSignalDbForValues,
} from './_shared'

function isBadgeValue(value: unknown): value is BuiltinBadgeValue {
	return Boolean(value) && typeof value === 'object' && (value as any).kind === 'badge'
}

function formatValue(value: any): string {
	if (isBadgeValue(value)) return value.label
	if (value === null) return 'null'
	if (value === undefined) return ''
	if (typeof value === 'string') return value
	if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint')
		return String(value)
	if (typeof value === 'object' && value && value.kind === 'json') {
		try {
			return JSON.stringify(value.value, null, 2)
		} catch {
			return String(value.value)
		}
	}
	try {
		return JSON.stringify(value, null, 2)
	} catch {
		return String(value)
	}
}

function RenderValue({ value }: { value: any }) {
	if (isBadgeValue(value)) {
		return (
			<Badge
				size={value.size ?? 'xs'}
				variant={value.variant ?? 'light'}
				color={value.color ?? 'gray'}
				radius={value.radius ?? 'sm'}
			>
				{value.label}
			</Badge>
		)
	}
	return (
		<Text
			size="xs"
			style={{
				whiteSpace: 'pre-wrap',
				wordBreak: 'break-word',
				fontFamily:
					isObject(value) && value.kind === 'json'
						? 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace'
						: undefined,
			}}
		>
			{formatValue(value)}
		</Text>
	)
}

function shouldAutoSpanFullWidth(value: unknown): boolean {
	if (!isObject(value)) return false
	const kind = (value as any).kind
	return kind === 'json'
}

export function BuiltinInfoCard({
	pluginName,
	block,
}: {
	pluginName: string
	block: BuiltinInfoCardBlock
}) {
	const rows = Array.isArray(block.rows) ? block.rows : []
	const rowsKey = stableSignalDbValueKey(rows)
	const signalDbCollections = useSignalDbForValues(
		pluginName,
		rows.map((r) => r?.value),
	)

	const resolvedRows = useSignalDbQueryState(
		() =>
			rows.map((row) => {
				const value: any = row?.value
				if (!isObject(value)) return row
					if (value.kind === 'signaldb') {
						const nextValue = resolveSignalDbRef(value as any, signalDbCollections as any)
						return Object.assign({}, row, { value: nextValue as any })
					}
				return row
			}),
		[pluginName, rowsKey],
	)

	const layout = block.layout ?? {}
	const density = layout.density ?? 'comfortable'
	const variant = layout.variant ?? 'list'
	const valueAlign = layout.valueAlign ?? 'right'
	const columns =
		typeof layout.columns === 'number' && layout.columns >= 1 && layout.columns <= 4
			? (layout.columns as 1 | 2 | 3 | 4)
			: 2
	const labelPlacement = layout.labelPlacement ?? (variant === 'grid' ? 'top' : 'left')

	const cardPadding = density === 'compact' ? 'xs' : 'sm'
	const headerGap = density === 'compact' ? 2 : 4
	const bodyGap = density === 'compact' ? 4 : 6
	const descSize = density === 'compact' ? 'xs' : 'xs'
	const labelSize = density === 'compact' ? 'xs' : 'xs'

	return (
		<Paper withBorder radius="md" p={cardPadding} shadow="xs">
			<Stack gap={density === 'compact' ? 6 : 8}>
				{block.description ? (
					<Stack gap={headerGap}>
						<Text size={descSize} c="dimmed" style={{ lineHeight: 1.35 }}>
							{block.description}
						</Text>
					</Stack>
				) : null}

				{resolvedRows.length > 0 ? (
					<>
						{block.description ? <Divider /> : null}
						{variant === 'grid' || columns > 1 ? (
							<Box
								style={{
									display: 'grid',
									gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
									gap: density === 'compact' ? 8 : 10,
								}}
							>
								{resolvedRows.map((row, index) => {
									const span =
										typeof (row as any).span === 'number' && (row as any).span > 0
											? Math.min(columns, Math.max(1, Math.floor((row as any).span)))
											: shouldAutoSpanFullWidth(row.value)
												? columns
												: 1

									if (labelPlacement === 'left') {
										return (
											<Group
												key={`${row.label}:${index}`}
												justify="space-between"
												align="flex-start"
												gap="xs"
												style={{ gridColumn: `span ${span}`, minWidth: 0 }}
											>
												<Text size={labelSize} c="dimmed" style={{ minWidth: 72 }}>
													{row.label}
												</Text>
												<Box style={{ flex: 1, minWidth: 0, textAlign: valueAlign }}>
													<RenderValue value={row.value} />
												</Box>
											</Group>
										)
									}

									return (
										<Box
											key={`${row.label}:${index}`}
											style={{ gridColumn: `span ${span}`, minWidth: 0 }}
										>
											<Stack gap={density === 'compact' ? 2 : 3}>
												<Text size={labelSize} c="dimmed" lineClamp={1}>
													{row.label}
												</Text>
												<Box style={{ minWidth: 0, textAlign: 'left' }}>
													<RenderValue value={row.value} />
												</Box>
											</Stack>
										</Box>
									)
								})}
							</Box>
						) : (
							<Stack gap={bodyGap}>
								{resolvedRows.map((row, index) => (
									<Group
										key={`${row.label}:${index}`}
										justify="space-between"
										align="flex-start"
										gap="sm"
									>
										<Text size={labelSize} c="dimmed" style={{ minWidth: 84 }}>
											{row.label}
										</Text>
										<Box style={{ flex: 1, minWidth: 0, textAlign: valueAlign }}>
											<RenderValue value={row.value} />
										</Box>
									</Group>
								))}
							</Stack>
						)}
					</>
				) : null}
			</Stack>
		</Paper>
	)
}
