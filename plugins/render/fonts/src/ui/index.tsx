import {
	Alert,
	Badge,
	Button,
	Card,
	FileButton,
	Group,
	Progress,
	ScrollArea,
	Select,
	Stack,
	Table,
	Text,
	TextInput,
	Title,
} from '@mantine/core'
import { IconRefresh, IconTrash, IconUpload } from '@tabler/icons-react'
import { useMemo, useState } from 'react'
import type { FontSelectionSnapshot, FontsManagerSnapshot } from '../workbench-contracts.ts'

const FONT_ACCEPT = '.ttf,.otf,.ttc,.woff,.woff2,font/ttf,font/otf,font/woff,font/woff2'

function messageOf(error: unknown): string {
	return error instanceof Error
		? error.message
		: typeof error === 'string'
			? error
			: 'Unknown font management error'
}

function bytesLabel(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
	return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}

function defaultFontOptions(snapshot: FontSelectionSnapshot | undefined) {
	const options = new Map(
		['sans-serif', 'serif', 'monospace'].map((genericFamily) => [
			genericFamily,
			{ value: genericFamily, label: `${genericFamily} · generic` },
		]),
	)
	for (const item of snapshot?.families ?? []) {
		if (options.has(item.family)) continue
		options.set(item.family, {
			value: item.family,
			label: `${item.family} · ${item.source === 'system' ? 'system' : 'registered'}`,
		})
	}
	const selected = snapshot?.defaultFont.preferredFamily
	if (selected && !options.has(selected)) {
		options.set(selected, { value: selected, label: `${selected} · unavailable` })
	}
	return [...options.values()]
}

type FontManagerContentProps = Readonly<{
	snapshot: FontsManagerSnapshot | undefined
	loading: boolean
	saving: boolean
	error: unknown | null
	onRefresh(): void
	onPreferredFamilyChange(family: string | null): void
	onInstall(file: File, family: string): Promise<boolean>
	onRemove(id: string): void
}>

export function FontManagerContent({
	snapshot,
	loading,
	saving,
	error,
	onRefresh,
	onPreferredFamilyChange,
	onInstall,
	onRemove,
}: FontManagerContentProps) {
	const [file, setFile] = useState<File | null>(null)
	const [family, setFamily] = useState('')

	const managedBytes = useMemo(
		() => snapshot?.managedFonts.reduce((total, font) => total + font.byteLength, 0) ?? 0,
		[snapshot],
	)
	const defaultOptions = useMemo(() => defaultFontOptions(snapshot), [snapshot])

	const install = async () => {
		if (!file) return
		if (await onInstall(file, family)) {
			setFile(null)
			setFamily('')
		}
	}

	return (
		<Stack gap="md" p="md">
			<Group justify="space-between" align="flex-start">
				<Stack gap={2}>
					<Title order={4}>服务端字体</Title>
					<Text size="sm" c="dimmed">
						字体由 @pluxel/fonts 统一持久化并注入服务端 Canvas registry。
					</Text>
				</Stack>
				<Button
					variant="subtle"
					size="xs"
					leftSection={<IconRefresh size={14} />}
					loading={loading}
					disabled={saving}
					onClick={onRefresh}
				>
					刷新
				</Button>
			</Group>

			{error ? <Alert color="red">{messageOf(error)}</Alert> : null}

			<Card withBorder radius="md">
				<Stack gap="sm">
					<Group justify="space-between" align="flex-start">
						<Stack gap={0}>
							<Text fw={600}>默认字体</Text>
							<Text size="xs" c="dimmed">
								新建 Canvas 等 renderer 会读取这个 provider 级默认值；已有 context 不会被改写。
							</Text>
						</Stack>
						{snapshot ? <Badge variant="light">{snapshot.defaultFont.source}</Badge> : null}
					</Group>
					<Select
						label="Managed preference"
						description={
							snapshot
								? `当前解析为 ${snapshot.defaultFont.family}；清空后恢复 host 配置或系统自动选择。`
								: '正在读取系统字体…'
						}
						placeholder="使用 host / system 默认值"
						data={defaultOptions}
						value={snapshot?.defaultFont.preferredFamily ?? null}
						disabled={!snapshot || loading || saving}
						searchable
						clearable
						onChange={onPreferredFamilyChange}
					/>
				</Stack>
			</Card>

			<Card withBorder radius="md">
				<Stack gap="sm">
					<Group justify="space-between">
						<Text fw={600}>安装字体</Text>
						{snapshot ? (
							<Badge variant="light">
								{snapshot.managedFonts.length} / {snapshot.limits.maxFonts}
							</Badge>
						) : null}
					</Group>
					<Group align="end" grow>
						<FileButton onChange={setFile} accept={FONT_ACCEPT}>
							{(props) => (
								<Button
									{...props}
									variant="default"
									leftSection={<IconUpload size={16} />}
									disabled={loading || saving}
								>
									{file?.name ?? '选择字体文件'}
								</Button>
							)}
						</FileButton>
						<TextInput
							label="Family alias（可选）"
							placeholder="Brand Sans"
							value={family}
							disabled={saving}
							onChange={(event) => setFamily(event.currentTarget.value)}
						/>
						<Button
							loading={saving}
							disabled={!file || !snapshot || loading}
							onClick={() => void install()}
						>
							安装
						</Button>
					</Group>
					{file && snapshot ? (
						<Stack gap={4}>
							<Group justify="space-between">
								<Text size="xs" c="dimmed">
									{bytesLabel(file.size)} / {bytesLabel(snapshot.limits.maxFontBytes)}
								</Text>
								<Text size="xs" c={file.size > snapshot.limits.maxFontBytes ? 'red' : 'dimmed'}>
									{file.size > snapshot.limits.maxFontBytes ? '超过上限' : '等待安装'}
								</Text>
							</Group>
							<Progress
								value={Math.min(100, (file.size / snapshot.limits.maxFontBytes) * 100)}
								color={file.size > snapshot.limits.maxFontBytes ? 'red' : 'blue'}
								size="xs"
							/>
						</Stack>
					) : null}
				</Stack>
			</Card>

			<Card withBorder radius="md">
				<Stack gap="sm">
					<Group justify="space-between">
						<Stack gap={0}>
							<Text fw={600}>Pluxel 管理字体</Text>
							<Text size="xs" c="dimmed">
								已持久化 {bytesLabel(managedBytes)}；Fonts provider 停止时原生注册会自动撤销。
							</Text>
						</Stack>
					</Group>
					<ScrollArea>
						<Table miw={620}>
							<Table.Thead>
								<Table.Tr>
									<Table.Th>文件</Table.Th>
									<Table.Th>Family</Table.Th>
									<Table.Th>大小</Table.Th>
									<Table.Th w={48} />
								</Table.Tr>
							</Table.Thead>
							<Table.Tbody>
								{snapshot?.managedFonts.map((font) => (
									<Table.Tr key={font.id}>
										<Table.Td>{font.fileName}</Table.Td>
										<Table.Td>
											{font.family ?? (font.resolvedFamilies.join(', ') || '字体内置名称')}
										</Table.Td>
										<Table.Td>{bytesLabel(font.byteLength)}</Table.Td>
										<Table.Td>
											<Button
												variant="subtle"
												color="red"
												size="compact-xs"
												aria-label={`删除 ${font.fileName}`}
												disabled={loading || saving}
												onClick={() => onRemove(font.id)}
											>
												<IconTrash size={14} />
											</Button>
										</Table.Td>
									</Table.Tr>
								))}
							</Table.Tbody>
						</Table>
					</ScrollArea>
					{!loading && snapshot?.managedFonts.length === 0 ? (
						<Text size="sm" c="dimmed" ta="center" py="md">
							尚未安装 Pluxel 管理字体。
						</Text>
					) : null}
				</Stack>
			</Card>

			<Text size="xs" c="dimmed">
				已发现 {snapshot?.families.filter(({ source }) => source === 'system').length ?? 0} 个系统
				family；Native registry 共可见 {snapshot?.families.length ?? 0} 个 family。
			</Text>
		</Stack>
	)
}

type FontSelectionContentProps = Readonly<{
	snapshot: FontSelectionSnapshot | undefined
	loading: boolean
	saving: boolean
	error: unknown | null
	onRefresh(): void
	onPreferredFamilyChange(family: string | null): void
}>

export function FontSelectionContent({
	snapshot,
	loading,
	saving,
	error,
	onRefresh,
	onPreferredFamilyChange,
}: FontSelectionContentProps) {
	const options = useMemo(() => defaultFontOptions(snapshot), [snapshot])

	return (
		<Stack gap="md" p="md">
			<Group justify="space-between" align="flex-start">
				<Stack gap={2}>
					<Title order={4}>字体选择</Title>
					<Text size="sm" c="dimmed">
						候选字体与默认值由 @pluxel/fonts 统一提供；上传和删除请在 FontsPlugin 页面管理。
					</Text>
				</Stack>
				<Button
					variant="subtle"
					size="xs"
					leftSection={<IconRefresh size={14} />}
					loading={loading}
					disabled={saving}
					onClick={onRefresh}
				>
					刷新
				</Button>
			</Group>

			{error ? <Alert color="red">{messageOf(error)}</Alert> : null}
			<Card withBorder radius="md">
				<Select
					label="Pluxel 默认字体"
					description={
						snapshot
							? `当前解析为 ${snapshot.defaultFont.family}；清空后恢复 host 配置或系统自动选择。`
							: '正在读取 FontsPlugin 字体候选…'
					}
					placeholder="使用 host / system 默认值"
					data={options}
					value={snapshot?.defaultFont.preferredFamily ?? null}
					disabled={!snapshot || loading || saving}
					searchable
					clearable
					onChange={onPreferredFamilyChange}
				/>
			</Card>
		</Stack>
	)
}
