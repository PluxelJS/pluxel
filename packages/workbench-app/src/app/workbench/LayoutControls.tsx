import type { ReactNode } from 'react'

function joinClasses(...values: Array<string | undefined>) {
	return values.filter(Boolean).join(' ')
}

type WorkbenchToolbarButtonProps = {
	active?: boolean
	ariaLabel?: string
	children: ReactNode
	className?: string
	onClick: () => void
	title?: string
}

function WorkbenchToolbarButton({
	active,
	ariaLabel,
	children,
	className,
	onClick,
	title,
}: WorkbenchToolbarButtonProps) {
	return (
		<button
			type="button"
			className={joinClasses('plx-workbench__toolbarButton', className)}
			data-active={active === undefined ? undefined : active ? 'true' : 'false'}
			aria-label={ariaLabel}
			aria-pressed={active}
			title={title ?? ariaLabel}
			onClick={onClick}
		>
			{children}
		</button>
	)
}

export function WorkbenchLayoutControls({
	children,
	className,
}: {
	children: ReactNode
	className?: string
}) {
	return <div className={joinClasses('plx-workbench__layoutControls', className)}>{children}</div>
}

export function WorkbenchLayoutButton({
	active,
	children,
	label,
	onClick,
	shortcut,
	title,
}: {
	active: boolean
	children: ReactNode
	label: string
	onClick: () => void
	shortcut?: string
	title?: string
}) {
	return (
		<WorkbenchToolbarButton
			active={active}
			ariaLabel={label}
			className={joinClasses(
				'plx-workbench__toolbarButton--layout',
				shortcut ? 'plx-workbench__toolbarButton--withShortcut' : undefined,
			)}
			onClick={onClick}
			title={title ?? (shortcut ? `${label} (${shortcut})` : label)}
		>
			{children}
			{shortcut ? <kbd className="plx-workbench__layoutShortcut">{shortcut}</kbd> : null}
		</WorkbenchToolbarButton>
	)
}

export function WorkbenchLayoutToggleButton({
	hiddenIcon,
	hideLabel,
	onClick,
	shortcut,
	showIcon,
	showLabel,
	visible,
}: {
	hiddenIcon: ReactNode
	hideLabel: string
	onClick: () => void
	shortcut?: string
	showIcon: ReactNode
	showLabel: string
	visible: boolean
}) {
	const label = visible ? hideLabel : showLabel
	return (
		<WorkbenchLayoutButton active={visible} label={label} onClick={onClick} shortcut={shortcut}>
			{visible ? hiddenIcon : showIcon}
		</WorkbenchLayoutButton>
	)
}

export function WorkbenchActionButton({
	children,
	className,
	label,
	onClick,
	title,
}: {
	children: ReactNode
	className?: string
	label?: string
	onClick: () => void
	title?: string
}) {
	return (
		<WorkbenchToolbarButton
			ariaLabel={label}
			className={joinClasses('plx-workbench__toolbarButton--action', className)}
			onClick={onClick}
			title={title}
		>
			{children}
		</WorkbenchToolbarButton>
	)
}
