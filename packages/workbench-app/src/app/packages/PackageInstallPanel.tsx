import { Badge, Button, Checkbox, Group, Paper, Stack, Text, Textarea } from '@mantine/core'
import type { FormEventHandler } from 'react'

interface PackageInstallPanelProps {
	busy: boolean
	forceInstall: boolean
	installInput: string
	pendingInstallSpecs: string[]
	installing: boolean
	onForceInstallChange: (value: boolean) => void
	onInstallInputChange: (value: string) => void
	onSubmit: FormEventHandler<HTMLFormElement>
}

export function PackageInstallPanel({
	busy,
	forceInstall,
	installInput,
	pendingInstallSpecs,
	installing,
	onForceInstallChange,
	onInstallInputChange,
	onSubmit,
}: PackageInstallPanelProps) {
	return (
		<Paper
			withBorder
			radius="sm"
			component="form"
			onSubmit={onSubmit}
			p="sm"
			style={{ minHeight: 0 }}
		>
			<Stack gap="sm">
				<Group gap="xs" wrap="wrap">
					<Text fw={700} size="sm">
						安装
					</Text>
					<Badge variant="light" color="gray" size="xs">
						换行/逗号分隔
					</Badge>
				</Group>
				<Textarea
					placeholder="pluxel-plugin-redis&#10;@scope/pkg@1.0.0"
					value={installInput}
					onChange={(event) => onInstallInputChange(event.currentTarget.value)}
					minRows={4}
					autosize
					maxRows={7}
					style={{ flex: '0 0 auto' }}
				/>
				{pendingInstallSpecs.length > 0 && (
					<Group gap={4} wrap="wrap">
						{pendingInstallSpecs.slice(0, 4).map((spec) => (
							<Badge key={spec} color="gray" variant="light" size="sm">
								{spec}
							</Badge>
						))}
						{pendingInstallSpecs.length > 4 && (
							<Badge color="gray" variant="light" size="sm">
								+{pendingInstallSpecs.length - 4}
							</Badge>
						)}
					</Group>
				)}
				<Group justify="space-between" align="center" mt="auto" wrap="wrap" gap="xs">
					<Checkbox
						label="强制安装"
						checked={forceInstall}
						onChange={(event) => onForceInstallChange(event.currentTarget.checked)}
						size="xs"
					/>
					<Button type="submit" loading={installing} disabled={busy && !installing} size="sm">
						{pendingInstallSpecs.length > 1 ? `安装 ${pendingInstallSpecs.length} 个` : '安装'}
					</Button>
				</Group>
			</Stack>
		</Paper>
	)
}
