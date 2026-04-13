import { Button, Group, Stack, Text, Textarea } from '@mantine/core'
import { useClipboard } from '@mantine/hooks'
import { useState } from 'react'
import { useAutoFormCtx } from '../../index'

export function SnapshotPanel() {
	const { form } = useAutoFormCtx<any>()
	const clipboard = useClipboard({ timeout: 1200 })
	const [input, setInput] = useState('')
	const [error, setError] = useState<string | null>(null)

	return (
		<form.Subscribe selector={(state) => ({ values: state.values })}>
			{({ values }) => {
				const json = JSON.stringify(values, null, 2)
				return (
					<Stack gap="xs">
						<Group gap="xs">
							<Button
								variant={clipboard.copied ? 'filled' : 'light'}
								size="xs"
								onClick={() => clipboard.copy(json)}
								type="button"
							>
								{clipboard.copied ? '已复制' : '复制当前值'}
							</Button>
						</Group>
						<Textarea
							value={input}
							onChange={(event) => setInput(event.currentTarget.value)}
							minRows={5}
							placeholder="粘贴 JSON..."
							autosize
							styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
						/>
						{error ? (
							<Text size="xs" c="red">
								{error}
							</Text>
						) : null}
						<Group gap="xs">
							<Button
								size="xs"
								onClick={() => {
									try {
										const parsed = JSON.parse(input)
										form.reset(parsed)
										setError(null)
									} catch (err) {
										setError(err instanceof Error ? err.message : 'JSON 解析失败')
									}
								}}
								type="button"
							>
								导入并重置
							</Button>
							<Button
								variant="default"
								size="xs"
								onClick={() => {
									setInput('')
									setError(null)
								}}
								type="button"
							>
								清空
							</Button>
						</Group>
					</Stack>
				)
			}}
		</form.Subscribe>
	)
}
