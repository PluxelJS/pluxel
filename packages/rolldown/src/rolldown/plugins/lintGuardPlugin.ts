import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { basename, dirname, join, resolve } from 'pathe'
import type { PluginContext } from 'rolldown'
import { type ViteCompatPlugin } from './compat.ts'

export interface LintGuardPluginOptions {
	cwd?: string
	/** Vite+ config with a lint block. Otherwise prefer oxlint.build.config.ts, then native Vite+ discovery. */
	configPath?: string
	paths?: string[]
	mode?: 'auto' | 'enforce' | 'off'
}

const DEFAULT_LINT_CONFIG_NAMES = ['oxlint.build.config.ts', 'vite.config.ts'] as const
const DEFAULT_LINT_PATH_CANDIDATES = [
	'src',
	'tests',
	'fsm',
	'parts',
	'vite.config.ts',
	'vitest.config.ts',
	'tsdown.config.ts',
] as const

function findUp(startDir: string, name: string): string | null {
	let current = resolve(startDir)
	for (;;) {
		const candidate = join(current, name)
		if (existsSync(candidate)) return candidate
		const parent = dirname(current)
		if (parent === current) return null
		current = parent
	}
}

function resolveLintConfig(cwd: string, options: LintGuardPluginOptions): string | null {
	if (options.configPath) return resolve(cwd, options.configPath)
	for (const configName of DEFAULT_LINT_CONFIG_NAMES) {
		const configPath = findUp(cwd, configName)
		if (configPath) return configPath
	}
	return null
}

function resolveLintPaths(cwd: string, paths?: string[]): string[] {
	const candidates = paths ?? [...DEFAULT_LINT_PATH_CANDIDATES]
	const resolved = candidates
		.map((entry) => resolve(cwd, entry))
		.filter((entry) => existsSync(entry))
	return resolved.length > 0 ? resolved : [cwd]
}

function runLint(ctx: PluginContext, options: LintGuardPluginOptions): void {
	const mode = options.mode ?? 'auto'
	if (mode === 'off') return

	const cwd = resolve(options.cwd ?? process.cwd())
	const configPath = resolveLintConfig(cwd, options)
	if (!configPath) {
		if (mode === 'enforce') {
			throw new Error(
				`pluxel-lint-guard: cannot find ${DEFAULT_LINT_CONFIG_NAMES.join(' or ')} from ${cwd}`,
			)
		}
		return
	}

	const paths = resolveLintPaths(cwd, options.paths)
	const vitePlusBin = fileURLToPath(import.meta.resolve('vite-plus/bin'))

	const args = [
		...(options.configPath || basename(configPath) === 'oxlint.build.config.ts'
			? ['-c', configPath]
			: []),
		'--quiet',
		'--report-unused-disable-directives-severity=error',
		...paths,
	]
	const result = spawnSync(process.execPath, [vitePlusBin, 'lint', ...args], {
		cwd,
		encoding: 'utf8',
		env: process.env,
	})

	if (result.status === 0) return

	const stderr = result.stderr?.trim()
	const stdout = result.stdout?.trim()
	const spawnError = result.error?.message?.trim()
	const detail = [stdout, stderr, spawnError].filter(Boolean).join('\n')
	ctx.error(
		detail || `pluxel-lint-guard failed with exit code ${String(result.status ?? 'unknown')}`,
	)
}

export function lintGuardPlugin(options: LintGuardPluginOptions = {}): ViteCompatPlugin {
	return {
		name: 'pluxel-lint-guard',
		buildStart() {
			runLint(this, options)
		},
	}
}
