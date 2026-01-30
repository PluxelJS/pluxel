import { Badge, Button, Group, Stack, Text, Textarea } from '@mantine/core'
import type { ObjectSchema } from 'valibot'

export interface PlaygroundState {
	code: string
	enabled: boolean
	error?: string
	schema?: ObjectSchema<any, any> | null
	lastRunAt?: number
}

export interface PlaygroundPanelProps {
	state: PlaygroundState
	onCodeChange: (value: string) => void
	onRun: () => void
	onReset: () => void
	onToggleEnabled: (next: boolean) => void
}

export function PlaygroundPanel({
	state,
	onCodeChange,
	onRun,
	onReset,
	onToggleEnabled,
}: PlaygroundPanelProps) {
	const canEnable = Boolean(state.schema)

	return (
		<Stack gap="xs">
			<Group justify="flex-end" align="center" gap="xs">
				{state.enabled ? (
					<Badge size="xs" color="grape">
						已启用
					</Badge>
				) : null}
				{state.schema ? (
					<Badge size="xs" variant="light">
						已编译
					</Badge>
				) : null}
			</Group>
			<Text size="xs" c="dimmed">
				输入 JS 代码，需返回 schema 或 {'{ schema, formOpts }'}。
			</Text>
			<Textarea
				value={state.code}
				onChange={(event) => onCodeChange(event.currentTarget.value)}
				minRows={10}
				autosize
				styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
			/>
			{state.error ? (
				<Text size="xs" c="red">
					{state.error}
				</Text>
			) : null}
			<Group justify="space-between" align="center">
				<Group gap="xs">
					<Button size="xs" onClick={onRun} type="button">
						运行
					</Button>
					<Button variant="default" size="xs" onClick={onReset} type="button">
						重置模板
					</Button>
				</Group>
				<Button
					variant={state.enabled ? 'filled' : 'light'}
					size="xs"
					onClick={() => onToggleEnabled(!state.enabled)}
					disabled={!canEnable && !state.enabled}
					color={state.enabled ? 'grape' : 'gray'}
					type="button"
				>
					{state.enabled ? '停用' : '应用到表单'}
				</Button>
			</Group>
		</Stack>
	)
}
