import { Badge, Tooltip } from '@mantine/core'
import { useEffect, useState } from 'react'

export function SavedStatus({ dirty, savedAt }: { dirty: boolean; savedAt?: number }) {
	const [now, setNow] = useState(Date.now)
	useEffect(() => {
		if (!savedAt || dirty) return undefined
		const id = setInterval(() => setNow(Date.now), 1000)
		return () => clearInterval(id)
	}, [savedAt, dirty])

	if (dirty)
		return (
			<Badge variant="light" color="yellow">
				已修改
			</Badge>
		)
	if (!savedAt)
		return (
			<Badge variant="light" color="gray">
				未修改
			</Badge>
		)

	const sec = Math.max(0, Math.floor((now - savedAt) / 1000))
	return (
		<Tooltip label={new Date(savedAt).toLocaleString()}>
			<Badge variant="light" color="green">
				已保存 {sec}s 前
			</Badge>
		</Tooltip>
	)
}

