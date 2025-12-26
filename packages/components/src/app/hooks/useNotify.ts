import type { NotificationData } from '@mantine/notifications'
import { useCallback } from 'react'
import { notifyAndRecord } from '../notifications/notifyBridge'

export function useNotify() {
	return useCallback((payload: NotificationData) => {
		return notifyAndRecord(payload)
	}, [])
}
