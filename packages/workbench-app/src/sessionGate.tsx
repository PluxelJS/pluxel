import { Button, Center, Paper, Stack, Text, Title } from '@mantine/core'
import { useEffect, useState, type ReactNode } from 'react'
import type { RuntimeSessionEvent } from './runtime'
import {
	clearSessionReloadHistory,
	reserveSessionReload,
	sessionReloadDecision,
	sessionReloadDelay,
	type SessionReloadDecision,
} from './sessionReload'

export function InvalidatedSession({ cause }: { cause: RuntimeSessionEvent['cause'] }) {
	const [decision, setDecision] = useState<SessionReloadDecision>(() => {
		try {
			return sessionReloadDecision(cause, window.sessionStorage)
		} catch {
			return 'unavailable'
		}
	})
	useEffect(() => {
		if (decision !== 'automatic') return undefined
		// The App has unmounted: Bridges, opened handles and query caches are released.
		// A short delay lets closely spaced publication changes settle before bootstrap.
		const timer = window.setTimeout(() => {
			try {
				if (reserveSessionReload(window.sessionStorage)) {
					window.location.reload()
					return
				}
			} catch {}
			setDecision('unavailable')
		}, sessionReloadDelay(window.sessionStorage))
		return () => window.clearTimeout(timer)
	}, [decision])
	return (
		<GatePanel title={decision === 'automatic' ? '正在更新 Workbench' : 'Workbench 会话已更新'}>
			<Text c="dimmed">{sessionInvalidationMessage(cause)}</Text>
			<Text size="sm" role="status">
				{decision === 'automatic'
					? '正在自动重新载入，保留当前地址与工作区布局…'
					: decision === 'frequent'
						? '短时间内更新过于频繁，已暂停自动刷新。待更新完成后可重新载入。'
						: '请重新载入以建立新的会话。'}
			</Text>
			<Button
				onClick={() => {
					try {
						clearSessionReloadHistory(window.sessionStorage)
					} catch {}
					window.location.reload()
				}}
			>
				{decision === 'automatic' ? '立即重新载入' : '重新载入'}
			</Button>
		</GatePanel>
	)
}

function sessionInvalidationMessage(cause: RuntimeSessionEvent['cause']): string {
	switch (cause) {
		case 'workbench':
			return '插件或界面已更新，需要载入新版本。'
		case 'authentication':
			return '认证设置已变化，需要重新确认会话。'
		case 'service-restart':
			return 'Runtime 管理服务已重启，需要建立新的会话。'
	}
}

export function GatePanel({ title, children }: { title: string; children: ReactNode }) {
	return (
		<Center mih="100vh" p="md">
			<Paper withBorder shadow="sm" radius="md" p="xl" w="min(28rem, 100%)">
				<Stack>
					<Title order={2}>{title}</Title>
					{children}
				</Stack>
			</Paper>
		</Center>
	)
}
