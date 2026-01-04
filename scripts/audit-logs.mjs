import { spawnSync } from 'node:child_process'

/**
 * Log usage audit (Codex/Audit Spec).
 *
 * This intentionally uses ripgrep for speed and low false-negative risk.
 * If a check is too strict, add an exclusion glob (not a weaker regex).
 */

const RG = 'rg'
const BASE_ARGS = [
	'-n',
	'--hidden',
	'--glob',
	'!**/node_modules/**',
	'--glob',
	'!**/*.md',
	'--glob',
	'!**/*.hbs',
]

/** @type {{ name: string; pattern: string; args?: string[] }[]} */
const checks = [
	{
		name: 'PLX-ERR-001: no {error}/{err} placeholder in message strings',
		// Match `{error}` / `{ err }` *inside the first string literal argument*.
		// This avoids false positives from structured props like `{ error }`.
		pattern:
			String.raw`\.(trace|debug|info|warn|error|fatal)\(\s*(["'])` +
			String.raw`(?:(?!\2).)*\{\s*(error|err)\s*\}(?:(?!\2).)*\2`,
	},
	{
		name: 'PLX-ERR-001: no ${error}/${err} interpolation in tagged templates',
		pattern: String.raw`\.(warn|error|fatal)` + String.raw`[^` + '`' + String.raw`]*\$\{\s*(error|err)\b`,
	},
	{
		name: 'PLX-ERR-001: no error string concatenation at call site',
		pattern: String.raw`\.(warn|error|fatal)\([^\n]*\+[^\n]*(String\(\s*(error|err)\s*\)|(error|err)\.(stack|message)\b)`,
	},
]

function runCheck(check) {
	const res = spawnSync(RG, [...BASE_ARGS, '-P', check.pattern, '.'], {
		stdio: 'pipe',
		encoding: 'utf8',
	})

	// rg: 0 = matches, 1 = no matches, 2 = error
	if (res.status === 1) return { ok: true, output: '' }
	if (res.status === 0) return { ok: false, output: res.stdout.trimEnd() }

	const err = res.stderr?.trim() || `rg exited with code ${res.status}`
	throw new Error(`${check.name}: ${err}`)
}

const failures = []
for (const check of checks) {
	const { ok, output } = runCheck(check)
	if (!ok) failures.push({ name: check.name, output })
}

if (failures.length) {
	console.error('Log audit failed:\n')
	for (const f of failures) {
		console.error(`- ${f.name}`)
		console.error(f.output)
		console.error('')
	}
	process.exit(1)
}

console.log('Log audit passed.')
