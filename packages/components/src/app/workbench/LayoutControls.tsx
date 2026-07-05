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
}: {
	active: boolean
	children: ReactNode
	label: string
	onClick: () => void
}) {
	return (
		<WorkbenchToolbarButton
			active={active}
			ariaLabel={label}
			className="plx-workbench__toolbarButton--layout"
			onClick={onClick}
		>
			{children}
		</WorkbenchToolbarButton>
	)
}

export function WorkbenchLayoutToggleButton({
	hiddenIcon,
	hideLabel,
	onClick,
	showIcon,
	showLabel,
	visible,
}: {
	hiddenIcon: ReactNode
	hideLabel: string
	onClick: () => void
	showIcon: ReactNode
	showLabel: string
	visible: boolean
}) {
	return (
		<WorkbenchLayoutButton
			active={visible}
			label={visible ? hideLabel : showLabel}
			onClick={onClick}
		>
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
