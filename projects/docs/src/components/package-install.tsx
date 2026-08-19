'use client'

import { Check, Copy } from 'lucide-react'
import { useState } from 'react'

type PackageManager = 'nypm' | 'npm' | 'pnpm' | 'yarn' | 'bun'

const managers: PackageManager[] = ['nypm', 'npm', 'pnpm', 'yarn', 'bun']

function installCommand(manager: PackageManager, packages: string, dev: boolean, global: boolean) {
	const flag = dev ? '-D ' : global ? '-g ' : ''
	if (manager === 'nypm') return `npx nypm add ${flag}${packages}`
	if (manager === 'npm') return `npm install ${flag}${packages}`
	if (manager === 'yarn' && global) return `yarn global add ${packages}`
	return `${manager} add ${flag}${packages}`
}

export function PackageInstall({
	packages,
	dev = false,
	global = false,
}: {
	packages: string
	dev?: boolean | string
	global?: boolean | string
}) {
	const devDependency = dev === true || dev === 'true'
	const globalInstall = global === true || global === 'true'
	const [manager, setManager] = useState<PackageManager>('nypm')
	const [copied, setCopied] = useState(false)
	const command = installCommand(manager, packages, devDependency, globalInstall)

	return (
		<div className="package-install not-prose">
			<div className="package-install-tabs" role="group" aria-label="选择包管理器">
				{managers.map((item) => (
					<button
						key={item}
						type="button"
						aria-pressed={manager === item}
						onClick={() => {
							setManager(item)
							setCopied(false)
						}}
					>
						{item}
					</button>
				))}
			</div>
			<div className="package-install-command">
				<code>{command}</code>
				<button
					type="button"
					aria-label={copied ? '已复制安装命令' : '复制安装命令'}
					title={copied ? '已复制' : '复制'}
					onClick={() => {
						void navigator.clipboard.writeText(command).then(
							() => {
								setCopied(true)
								window.setTimeout(() => setCopied(false), 1500)
								return undefined
							},
							() => {
								setCopied(false)
								return undefined
							},
						)
					}}
				>
					{copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
				</button>
			</div>
		</div>
	)
}
