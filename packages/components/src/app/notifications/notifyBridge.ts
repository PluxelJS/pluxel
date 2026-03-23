import { type NotificationData, notifications } from '@mantine/notifications'

type NotificationCenterPush = (input: {
	id?: string
	title?: string
	message?: string
	color?: string
}) => void

let pushToCenter: NotificationCenterPush | null = null

export function setNotificationCenterPush(push: NotificationCenterPush | null) {
	pushToCenter = push
	return () => {
		if (pushToCenter === push) pushToCenter = null
	}
}

function getText(value: NotificationData['message']) {
	if (typeof value === 'string') return value
	if (!value) return ''
	if (typeof value === 'number' || typeof value === 'boolean') return String(value)
	if (typeof value === 'object' && 'props' in value) {
		const children = (value as any).props?.children
		if (typeof children === 'string') return children
	}
	return ''
}

export function notifyAndRecord(payload: NotificationData) {
	const displayedId = notifications.show(payload)
	const id =
		typeof payload.id === 'string'
			? payload.id
			: typeof displayedId === 'string'
				? displayedId
				: undefined

	pushToCenter?.({
		id,
		title: typeof payload.title === 'string' ? payload.title : undefined,
		message: getText(payload.message),
		color: typeof payload.color === 'string' ? payload.color : undefined,
	})

	return displayedId
}
