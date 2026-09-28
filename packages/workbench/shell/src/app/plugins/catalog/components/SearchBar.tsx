import { ActionIcon, Group, TextInput } from '@mantine/core'
import {
	IconAlertTriangle,
	IconFilterOff,
	IconPlayerPlay,
	IconPlayerStop,
	IconSearch,
	IconX,
} from '@tabler/icons-react'
import type React from 'react'
import type { StatusCounts } from '../catalogOverview'
import type { StatusFilterState } from '../filterModel'

const ACTION_SIZE = 22
const ACTION_GAP = 2
const STATUS_ACTION_COUNT = 3
const RIGHT_SECTION_BREATHING_ROOM = 4
const BASE_RIGHT_SECTION_WIDTH =
	ACTION_SIZE * STATUS_ACTION_COUNT +
	ACTION_GAP * (STATUS_ACTION_COUNT - 1) +
	RIGHT_SECTION_BREATHING_ROOM
const OPTIONAL_ACTION_WIDTH = ACTION_SIZE + ACTION_GAP

type Props = {
	value: string
	onChange: (value: string) => void
	inputRef: React.RefObject<HTMLInputElement>
	statusFilter: StatusFilterState
	statusCounts: StatusCounts
	onToggleStatus: (key: keyof StatusFilterState) => void
	onResetStatusFilter: () => void
	hasActiveStatusFilter: boolean
}

export function SearchBar({
	value,
	onChange,
	inputRef,
	statusFilter,
	statusCounts,
	onToggleStatus,
	onResetStatusFilter,
	hasActiveStatusFilter,
}: Props) {
	const clearBtn = value ? (
		<ActionIcon
			size={ACTION_SIZE}
			variant="subtle"
			onClick={() => onChange('')}
			title="清空搜索"
			aria-label="清空搜索"
		>
			<IconX size={13} />
		</ActionIcon>
	) : undefined

	const rightSection = (
		<Group gap={ACTION_GAP} wrap="nowrap">
			{clearBtn}
			{hasActiveStatusFilter ? (
				<ActionIcon
					size={ACTION_SIZE}
					variant="subtle"
					onClick={onResetStatusFilter}
					title="恢复全部状态筛选"
					aria-label="恢复全部状态筛选"
				>
					<IconFilterOff size={12} />
				</ActionIcon>
			) : null}
			<ActionIcon
				size={ACTION_SIZE}
				variant={statusFilter.running ? 'filled' : 'subtle'}
				color={statusFilter.running ? 'green' : undefined}
				onClick={() => onToggleStatus('running')}
				title={`运行中 ${statusCounts.running} 个 · Alt+1`}
				aria-label={`运行中 ${statusCounts.running} 个`}
				aria-pressed={statusFilter.running}
			>
				<IconPlayerPlay size={12} />
			</ActionIcon>
			<ActionIcon
				size={ACTION_SIZE}
				variant={statusFilter.stopped ? 'filled' : 'subtle'}
				color={statusFilter.stopped ? 'gray' : undefined}
				onClick={() => onToggleStatus('stopped')}
				title={`已停止 ${statusCounts.stopped} 个 · Alt+2`}
				aria-label={`已停止 ${statusCounts.stopped} 个`}
				aria-pressed={statusFilter.stopped}
			>
				<IconPlayerStop size={12} />
			</ActionIcon>
			<ActionIcon
				size={ACTION_SIZE}
				variant={statusFilter.unavailable ? 'filled' : 'subtle'}
				color={statusFilter.unavailable ? 'red' : undefined}
				onClick={() => onToggleStatus('unavailable')}
				title={`不可用 ${statusCounts.unavailable} 个 · Alt+3`}
				aria-label={`不可用 ${statusCounts.unavailable} 个`}
				aria-pressed={statusFilter.unavailable}
			>
				<IconAlertTriangle size={12} />
			</ActionIcon>
		</Group>
	)

	return (
		<TextInput
			ref={inputRef}
			placeholder="搜索名称 / @包 / ref: / exec:"
			value={value}
			onChange={(e) => onChange(e.currentTarget.value)}
			leftSection={<IconSearch size={14} />}
			leftSectionPointerEvents="none"
			rightSection={rightSection}
			rightSectionWidth={
				BASE_RIGHT_SECTION_WIDTH +
				(clearBtn ? OPTIONAL_ACTION_WIDTH : 0) +
				(hasActiveStatusFilter ? OPTIONAL_ACTION_WIDTH : 0)
			}
			rightSectionPointerEvents="auto"
			size="xs"
			variant="default"
			radius="sm"
			aria-label="搜索插件"
		/>
	)
}
