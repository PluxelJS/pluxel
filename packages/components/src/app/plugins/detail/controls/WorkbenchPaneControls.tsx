import {
	IconLayout2,
	IconLayoutBottombarCollapse,
	IconLayoutBottombarExpand,
	IconLayoutSidebarLeftCollapse,
	IconLayoutSidebarLeftExpand,
	IconLayoutSidebarRightCollapse,
	IconLayoutSidebarRightExpand,
} from '@tabler/icons-react'
import { memo, useEffect, useMemo, useRef } from 'react'
import { useWorkbenchLayout, useWorkbenchTabIdentity } from '../../../workbench/context'
import {
	WorkbenchLayoutButton,
	WorkbenchLayoutControls,
	WorkbenchLayoutToggleButton,
} from '../../../workbench/LayoutControls'
import { usePluginWorkbenchLayout } from '../workbench/context'

export const WorkbenchPaneControls = memo(function WorkbenchPaneControls() {
	const { leftPaneAvailable, leftPaneVisible, setLeftPaneVisible, toggleLeftPane } =
		useWorkbenchLayout()
	const { activeTabId } = useWorkbenchTabIdentity()
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

	const toggleFocusMode = () => {
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
	}

	const layoutToggles = [
		leftPaneAvailable
			? {
					key: 'left',
					hiddenIcon: <IconLayoutSidebarLeftCollapse size={18} />,
					hideLabel: '隐藏左栏',
					onClick: toggleLeftPane,
					showIcon: <IconLayoutSidebarLeftExpand size={18} />,
					showLabel: '显示左栏',
					visible: leftPaneVisible,
				}
			: null,
		{
			key: 'right',
			hiddenIcon: <IconLayoutSidebarRightCollapse size={18} />,
			hideLabel: '隐藏右栏',
			onClick: toggleRightPane,
			showIcon: <IconLayoutSidebarRightExpand size={18} />,
			showLabel: '显示右栏',
			visible: rightPaneVisible,
		},
		{
			key: 'dock',
			hiddenIcon: <IconLayoutBottombarCollapse size={18} />,
			hideLabel: '隐藏底部日志',
			onClick: toggleDock,
			showIcon: <IconLayoutBottombarExpand size={18} />,
			showLabel: '显示底部日志',
			visible: dockVisible,
		},
	].filter(Boolean)

	return (
		<WorkbenchLayoutControls>
			{layoutToggles.map(({ key, ...toggle }) => (
				<WorkbenchLayoutToggleButton key={key} {...toggle} />
			))}

			<WorkbenchLayoutButton
				active={focusMode}
				label={focusMode ? '恢复周边面板' : '聚焦工作区'}
				onClick={toggleFocusMode}
			>
				<IconLayout2 size={18} />
			</WorkbenchLayoutButton>
		</WorkbenchLayoutControls>
	)
})
