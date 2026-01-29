import { ActionIcon, Group, TextInput } from '@mantine/core'
import { IconBan, IconPlayerPlay, IconPlayerStop, IconSearch, IconX } from '@tabler/icons-react'
import type React from 'react'

export type StatusFilterState = {
	running: boolean
	stopped: boolean
	disabled: boolean
}

type Props = {
	value: string
	onChange: (value: string) => void
	inputRef: React.RefObject<HTMLInputElement>
	statusFilter: StatusFilterState
	onToggleStatus: (key: keyof StatusFilterState) => void
}

export function SearchBar({ value, onChange, inputRef, statusFilter, onToggleStatus }: Props) {
	const clearBtn = value ? (
		<ActionIcon size="sm" variant="subtle" onClick={() => onChange('')}>
			<IconX size={14} />
		</ActionIcon>
	) : undefined

	const rightSection = (
		<Group gap={2} wrap="nowrap">
			{clearBtn}
			<ActionIcon
				size="sm"
				variant={statusFilter.running ? 'filled' : 'subtle'}
				color={statusFilter.running ? 'green' : undefined}
				onClick={() => onToggleStatus('running')}
				title="只看运行中"
				aria-label="运行中"
				aria-pressed={statusFilter.running}
			>
				<IconPlayerPlay size={12} />
			</ActionIcon>
			<ActionIcon
				size="sm"
				variant={statusFilter.stopped ? 'filled' : 'subtle'}
				color={statusFilter.stopped ? 'gray' : undefined}
				onClick={() => onToggleStatus('stopped')}
				title="只看停止"
				aria-label="停止"
				aria-pressed={statusFilter.stopped}
			>
				<IconPlayerStop size={12} />
			</ActionIcon>
			<ActionIcon
				size="sm"
				variant={statusFilter.disabled ? 'filled' : 'subtle'}
				color={statusFilter.disabled ? 'red' : undefined}
				onClick={() => onToggleStatus('disabled')}
				title="只看禁用"
				aria-label="禁用"
				aria-pressed={statusFilter.disabled}
			>
				<IconBan size={12} />
			</ActionIcon>
		</Group>
	)

	return (
		<TextInput
			ref={inputRef}
			placeholder="搜索（名称/ID，@包 #tag v:版本）"
			value={value}
			onChange={(e) => onChange(e.currentTarget.value)}
			leftSection={<IconSearch size={14} />}
			rightSection={rightSection}
			rightSectionWidth={clearBtn ? 120 : 96}
			rightSectionPointerEvents="auto"
			size="xs"
			variant="filled"
			radius="sm"
		/>
	)
}
