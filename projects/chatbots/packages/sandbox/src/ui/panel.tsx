import {
	Badge,
	Button,
	Card,
	Group,
	ScrollArea,
	Stack,
	Text,
	TextInput,
	Title,
} from '@mantine/core'
import { rpcErrorMessage } from '@pluxel/runtime/web'
import { useState } from 'react'
import { sandboxUi } from './runtime.ts'
export function SandboxPanel() {
	const model = sandboxUi.useResources()
	const messages = model.messages.useQuery().rows
	const [messageText, setMessageText] = useState('/ping')
	const [conversationId, setConversationId] = useState('default')
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const send = async () => {
		if (!messageText.trim()) return
		setBusy(true)
		try {
			await model.commands.send({ text: messageText, conversationId })
			setMessageText('')
			setError(null)
		} catch (caught) {
			setError(rpcErrorMessage(caught, '发送失败'))
		} finally {
			setBusy(false)
		}
	}
	return (
		<Stack p="md" h="100%">
			<Group justify="space-between">
				<div>
					<Title order={4}>消息沙箱</Title>
					<Text size="sm" c="dimmed">
						不需要平台凭据，直接验证完整 Hub、身份、权限和命令管线。
					</Text>
				</div>
				<Button variant="subtle" color="red" onClick={() => void model.commands.reset()}>
					清空
				</Button>
			</Group>
			{error ? <Text c="red">{error}</Text> : null}
			<Card withBorder style={{ flex: 1, minHeight: 260 }}>
				<ScrollArea h="100%">
					<Stack>
						{messages.map((message) => (
							<Group
								key={`${message.direction}:${message.id}`}
								justify={message.direction === 'outbound' ? 'flex-end' : 'flex-start'}
							>
								<Card withBorder maw="75%">
									<Group gap="xs">
										<Badge size="xs" color={message.direction === 'outbound' ? 'blue' : 'gray'}>
											{message.direction}
										</Badge>
										<Text size="xs" c="dimmed">
											{message.actor.displayName ?? message.actor.id}
										</Text>
									</Group>
									<Text style={{ whiteSpace: 'pre-wrap' }}>{message.text}</Text>
								</Card>
							</Group>
						))}
					</Stack>
				</ScrollArea>
			</Card>
			<Group align="end">
				<TextInput
					label="会话"
					value={conversationId}
					onChange={(event) => setConversationId(event.currentTarget.value)}
					w={180}
				/>
				<TextInput
					label="消息"
					value={messageText}
					onChange={(event) => setMessageText(event.currentTarget.value)}
					onKeyDown={(event) => {
						if (event.key === 'Enter') void send()
					}}
					style={{ flex: 1 }}
				/>
				<Button loading={busy} onClick={() => void send()}>
					发送
				</Button>
			</Group>
		</Stack>
	)
}
