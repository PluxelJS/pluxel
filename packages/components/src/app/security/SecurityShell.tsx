import { Link, Outlet } from '@tanstack/react-router'
import { IconBox, IconShieldLock } from '@tabler/icons-react'
import { ColorSchemeToggle } from '../../theme'
import { HMR_SECURITY_BASE } from '../../runtime'
import { baseNavItems } from '../navigation/navConfig'
import '../workbench/styles.scss'

const statusPillStyle = {
	alignItems: 'center',
	background: 'color-mix(in srgb, var(--plx-accent-soft) 84%, transparent)',
	border: '1px solid color-mix(in srgb, var(--plx-accent) 26%, var(--plx-border) 74%)',
	borderRadius: 999,
	color: 'var(--plx-text)',
	display: 'inline-flex',
	fontSize: 11,
	fontWeight: 700,
	gap: 6,
	height: 22,
	padding: '0 10px',
}

const noteStyle = {
	color: 'var(--plx-text-muted)',
	fontSize: 11,
	paddingLeft: 10,
}

export function SecurityShell() {
	return (
		<div className="plx-workbench">
			<aside className="plx-workbench__activity" aria-label="安全导航">
				<div className="plx-workbench__activityBrand" aria-hidden="true">
					<IconBox size={20} stroke={1.8} />
				</div>

				<nav className="plx-workbench__activityList">
					{baseNavItems.map((item) =>
						item.href === HMR_SECURITY_BASE ? (
							<Link
								key={item.href}
								to={item.href}
								className="plx-workbench__activityItem"
								data-active="true"
								title={item.label}
							>
								{item.icon ?? <IconShieldLock size={18} stroke={1.7} />}
								<span className="plx-workbench__activityLabel">{item.label}</span>
							</Link>
						) : (
							<div
								key={item.href}
								className="plx-workbench__activityItem"
								aria-disabled="true"
								data-active="false"
								title={`${item.label} 暂不可用`}
								style={{ cursor: 'not-allowed', opacity: 0.4 }}
							>
								{item.icon}
								<span className="plx-workbench__activityLabel">{item.label}</span>
							</div>
						),
					)}
				</nav>
			</aside>

			<div className="plx-workbench__main">
				<header className="plx-workbench__topbar">
					<div className="plx-workbench__topbarTitle">
						<span className="plx-workbench__eyebrow">安全</span>
						<span className="plx-workbench__title">安全设置</span>
						<span className="plx-workbench__subtitle">管理访问验证与加密存储</span>
					</div>

					<div className="plx-workbench__topbarActions">
						<div style={statusPillStyle}>Host</div>
						<ColorSchemeToggle
							label="切换明暗模式"
							size="md"
							radius="md"
							className="plx-workbench__themeToggle"
						/>
					</div>
				</header>

				<div className="plx-workbench__editorTabStrip">
					<div style={noteStyle}>这里集中管理当前 host 的访问验证与加密存储。</div>
				</div>

				<div className="plx-workbench__body">
					<div className="plx-workbench__surface">
						<div className="plx-workbench__workspace">
							<div className="plx-workbench__workspaceContent">
								<Outlet />
							</div>
						</div>
					</div>
				</div>

				<div className="plx-workbench__statusbar">
					<div style={noteStyle}>其他控制面页面会按当前安全状态自动放行或拦截。</div>
				</div>
			</div>
		</div>
	)
}
