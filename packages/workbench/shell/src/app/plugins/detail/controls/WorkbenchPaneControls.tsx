import {
	IconLayout2,
	IconLayoutBottombarCollapse,
	IconLayoutBottombarExpand,
	IconLayoutSidebarLeftCollapse,
	IconLayoutSidebarLeftExpand,
	IconLayoutSidebarRightCollapse,
	IconLayoutSidebarRightExpand,
} from '@tabler/icons-react'
import { useHotkey, useHotkeySequence } from '@tanstack/react-hotkeys'
import { memo, useCallback, useEffect, useMemo, useRef } from 'react'
import { useActiveWorkbenchTabId, useWorkbenchLayout } from '../../../workbench/context'
import {
	WORKBENCH_HOTKEYS,
	WORKBENCH_HOTKEY_LABELS,
	WORKBENCH_HOTKEY_SEQUENCES,
} from '../../../workbench/shortcuts'
import {
	WorkbenchLayoutControlGroup,
	type WorkbenchLayoutControl,
} from '../../../workbench/LayoutControls'
import { usePluginWorkbenchLayout } from '../workbench/context'

// TanStack sequences prevent defaults only on completion; reserve the VS Code chord prefix too.
const reserveFocusModeSequencePrefix = (): void => {}

export const WorkbenchPaneControls = memo(function WorkbenchPaneControls() {
	const { leftPaneAvailable, leftPaneVisible, setLeftPaneVisible, toggleLeftPane } =
		useWorkbenchLayout()
	const activeTabId = useActiveWorkbenchTabId()
	const {
		dockVisible,
		rightPaneVisible,
		setDockVisible,
		setRightPaneVisible,
		toggleDock,
		toggleRightPane,
	} = usePluginWorkbenchLayout()
	const focusSnapshotRef = useRef<{
		leftPaneVisible: boolean
		dockVisible: boolean
		rightPaneVisible: boolean
	} | null>(null)

	const focusMode = useMemo(
		() => leftPaneAvailable && !leftPaneVisible && !dockVisible && !rightPaneVisible,
		[dockVisible, leftPaneAvailable, leftPaneVisible, rightPaneVisible],
	)

	useEffect(() => {
		focusSnapshotRef.current = null
	}, [activeTabId])

	const toggleFocusMode = useCallback(() => {
		if (focusMode) {
			const snapshot = focusSnapshotRef.current
			if (leftPaneAvailable) setLeftPaneVisible(snapshot?.leftPaneVisible ?? true)
			setDockVisible(snapshot?.dockVisible ?? true)
			setRightPaneVisible(snapshot?.rightPaneVisible ?? true)
			focusSnapshotRef.current = null
			return
		}

		focusSnapshotRef.current = {
			leftPaneVisible,
			dockVisible,
			rightPaneVisible,
		}
		if (leftPaneAvailable) setLeftPaneVisible(false)
		setDockVisible(false)
		setRightPaneVisible(false)
	}, [
		dockVisible,
		focusMode,
		leftPaneAvailable,
		leftPaneVisible,
		rightPaneVisible,
		setDockVisible,
		setLeftPaneVisible,
		setRightPaneVisible,
	])

	useHotkey(WORKBENCH_HOTKEY_SEQUENCES.toggleFocusMode[0], reserveFocusModeSequencePrefix, {
		ignoreInputs: true,
		preventDefault: true,
		stopPropagation: false,
	})
	useHotkey(WORKBENCH_HOTKEYS.toggleRightPane, toggleRightPane, {
		ignoreInputs: true,
		preventDefault: true,
	})
	useHotkey(WORKBENCH_HOTKEYS.toggleDock, toggleDock, {
		ignoreInputs: true,
		preventDefault: true,
	})
	useHotkeySequence(WORKBENCH_HOTKEY_SEQUENCES.toggleFocusMode, toggleFocusMode, {
		ignoreInputs: true,
		preventDefault: true,
	})

	const controls: WorkbenchLayoutControl[] = []
	if (leftPaneAvailable) {
		controls.push({
			id: 'left',
			kind: 'toggle',
			hiddenIcon: <IconLayoutSidebarLeftCollapse size={18} />,
			hideLabel: '隐藏插件列表',
			onClick: toggleLeftPane,
			shortcut: WORKBENCH_HOTKEY_LABELS.togglePluginRail,
			showIcon: <IconLayoutSidebarLeftExpand size={18} />,
			showLabel: '显示插件列表',
			visible: leftPaneVisible,
		})
	}
	controls.push(
		{
			id: 'right',
			kind: 'toggle',
			hiddenIcon: <IconLayoutSidebarRightCollapse size={18} />,
			hideLabel: '隐藏辅助侧栏',
			onClick: toggleRightPane,
			shortcut: WORKBENCH_HOTKEY_LABELS.toggleRightPane,
			showIcon: <IconLayoutSidebarRightExpand size={18} />,
			showLabel: '显示辅助侧栏',
			visible: rightPaneVisible,
		},
		{
			id: 'dock',
			kind: 'toggle',
			hiddenIcon: <IconLayoutBottombarCollapse size={18} />,
			hideLabel: '隐藏底部面板',
			onClick: toggleDock,
			shortcut: WORKBENCH_HOTKEY_LABELS.toggleDock,
			showIcon: <IconLayoutBottombarExpand size={18} />,
			showLabel: '显示底部面板',
			visible: dockVisible,
		},
		{
			active: focusMode,
			children: <IconLayout2 size={18} />,
			id: 'focus',
			kind: 'action',
			label: focusMode ? '恢复周边面板' : '聚焦工作区',
			onClick: toggleFocusMode,
			shortcut: WORKBENCH_HOTKEY_LABELS.toggleFocusMode,
		},
	)

	return <WorkbenchLayoutControlGroup controls={controls} />
})
