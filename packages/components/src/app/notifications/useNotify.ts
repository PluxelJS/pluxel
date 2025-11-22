import { notifications, type NotificationData } from '@mantine/notifications'
import { useCallback } from 'react'
import { useNotificationCenter } from './NotificationCenterProvider'

const getText = (value: NotificationData['message']) => {
	if (typeof value === 'string') return value
	if (!value) return ''
	if (typeof value === 'number' || typeof value === 'boolean') return String(value)
	if (typeof value === 'object' && 'props' in value) {
		const children = (value as any).props?.children
		if (typeof children === 'string') return children
	}
	return ''
}

export function useNotify() {
	const { push } = useNotificationCenter()

	return useCallback(
		(payload: NotificationData) => {
			const displayedId = notifications.show(payload)
			const id =
				typeof payload.id === 'string'
					? payload.id
					: typeof displayedId === 'string'
						? displayedId
						: undefined
			push({
				id,
				title: payload.title,
				message: getText(payload.message),
				color: payload.color,
			})
			return displayedId
		},
		[push],
	)
}
