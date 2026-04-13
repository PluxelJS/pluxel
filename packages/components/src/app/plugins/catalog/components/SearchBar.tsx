import { ActionIcon, Group, TextInput } from '@mantine/core'
import {
	IconBan,
	IconFilterOff,
	IconPlayerPlay,
	IconPlayerStop,
	IconSearch,
	IconX,
	IconQuestionMark,
} from '@tabler/icons-react'
import type React from 'react'
import type { StatusFilterState } from '../filterModel'

type Props = {
	value: string
	onChange: (value: string) => void
	inputRef: React.RefObject<HTMLInputElement>
	statusFilter: StatusFilterState
	onToggleStatus: (key: keyof StatusFilterState) => void
	onResetFilters: () => void
	onOpenHelp: () => void
	hasActiveFilters: boolean
}

export function SearchBar({
	value,
	onChange,
	inputRef,
	statusFilter,
	onToggleStatus,
	onResetFilters,
	onOpenHelp,
	hasActiveFilters,
}: Props) {
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
				variant="subtle"
				onClick={onOpenHelp}
				title="查看快捷键和搜索语法"
				aria-label="查看帮助"
			>
				<IconQuestionMark size={12} />
			</ActionIcon>
			{hasActiveFilters ? (
				<ActionIcon
					size="sm"
					variant="subtle"
					onClick={onResetFilters}
					title="清空搜索和筛选 (Esc)"
					aria-label="清空搜索和筛选"
				>
					<IconFilterOff size={12} />
				</ActionIcon>
			) : null}
			<ActionIcon
				size="sm"
				variant={statusFilter.running ? 'filled' : 'subtle'}
				color={statusFilter.running ? 'green' : undefined}
				onClick={() => onToggleStatus('running')}
				title="运行中 (Alt+1)"
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
				title="停止 (Alt+2)"
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
				title="禁用 (Alt+3)"
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
			leftSectionPointerEvents="none"
			rightSection={rightSection}
			rightSectionWidth={hasActiveFilters ? 176 : clearBtn ? 144 : 120}
			rightSectionPointerEvents="auto"
			size="sm"
			variant="default"
			radius="md"
			aria-label="搜索插件"
		/>
	)
}
