import { useDroppable, type UniqueIdentifier } from '@dnd-kit/core'
import { Box } from '@mantine/core'
import type React from 'react'

export function DroppableContainer({
	id,
	children,
	disabled,
	minDropHeight = 0,
	style,
}: {
	id: UniqueIdentifier
	children: React.ReactNode
	disabled?: boolean
	minDropHeight?: number
	style?: React.CSSProperties
}) {
	const { setNodeRef, isOver } = useDroppable({ id, disabled })
	return (
		<Box
			ref={setNodeRef}
			data-droppable-id={String(id)}
			style={{
				outline: isOver ? '1px dashed var(--plx-accent)' : undefined,
				outlineOffset: isOver ? -1 : undefined,
				background: isOver ? 'var(--plx-accent-soft)' : undefined,
				borderRadius: 8,
				minHeight: minDropHeight,
				...style,
			}}
			role="group"
			aria-roledescription="droppable container"
		>
			{children}
		</Box>
	)
}
