import { extensionVendorPackages } from '@pluxel/plugin-ui'
import type { ResolveOptions } from 'vite'

export function toBrowserBundleResolve(resolve: ResolveOptions): ResolveOptions {
	const conditions = Array.isArray(resolve.conditions) ? resolve.conditions : null
	if (!conditions) return resolve

	const filtered = conditions.filter((c) => c !== '@pluxel/source' && c !== 'source' && c !== '@pluxel/hmr')
	if (filtered.length === conditions.length) return resolve

	return { ...resolve, conditions: filtered }
}

export function looksLikeLegacyBrokenBundle(code: string): boolean {
	// 典型坏产物：把 `import { Foo as bar }` 直接拼进了解构，导致语法错误
	// `const { Foo as bar } = window.__PLUXEL_VENDORS__[...]`
	const head = code.slice(0, 20000)
	// 注意：不要用宽泛的 `{ ... as ... }` 检测，否则会误判字符串
	//（例如 "as a constructor"）导致每次请求都删文件 → 无限编译/无限加载。
	if (
		/window\.__PLUXEL_VENDORS__/.test(head) &&
		/\bconst\s*\{\s*[^}]*\bas\s+[\w$]+[^}]*\}\s*=\s*window\.__PLUXEL_VENDORS__/.test(head)
	) {
		return true
	}
	// 旧 worker 使用 app build，会生成“可执行脚本”而不是“可 import 模块”，最终没有任何 export。
	// dynamic import 不会报错，但拿到空 module namespace，导致 UI 永远不注册。
	if (!/\bexport\s+/.test(code) && !/\bexport\{/.test(code)) {
		return true
	}
	// 兼容之前遇到的 node-only / side-effect import 输出
	if (/from\s+["']node:module["']/.test(head) || /createRequire\(/.test(head)) return true
	if (/import\s+["']react\/jsx-runtime["'];?/.test(head)) return true
	// 浏览器没有 process，全量 bundle 里出现 process.env 说明有 node-style env 检测残留
	if (/\bprocess\.env\b/.test(head)) return true
	return false
}

export function transformVendorImports(
	code: string,
	vendorPackages: readonly string[] = extensionVendorPackages,
): string {
	let result = code

	// Defensive: strip Node-only createRequire helpers that may appear in SSR-oriented outputs.
	// These modules are executed in the browser.
	result = result.replace(
		/^\s*import\s+\{\s*createRequire\s*\}\s+from\s+["'](?:node:module|module)["'];?\s*$/gm,
		'',
	)
	result = result.replace(/^\s*createRequire\s*\(\s*import\.meta\.url\s*\)\s*;?\s*$/gm, '')

	for (const pkg of vendorPackages) {
		const normalized = pkg.replace(/\//g, '_')
		const viteStaticImportPattern = new RegExp(
			`(from\\s*["'])/node_modules/\\.vite/deps/${escapeRegex(normalized)}\\.js(?:\\?[^"']*)?(["'])`,
			'g',
		)
		const viteDynamicImportPattern = new RegExp(
			`(import\\s*\\(\\s*["'])/node_modules/\\.vite/deps/${escapeRegex(normalized)}\\.js(?:\\?[^"']*)?(["']\\s*\\))`,
			'g',
		)
		result = result.replace(viteStaticImportPattern, `$1${pkg}$2`)
		result = result.replace(viteDynamicImportPattern, `$1${pkg}$2`)

		const patterns = [
			new RegExp(`import\\s*\\{([^}]+)\\}\\s*from\\s*["']${escapeRegex(pkg)}["'];?`, 'g'),
			new RegExp(`import\\s*\\*\\s*as\\s+(\\w+)\\s*from\\s*["']${escapeRegex(pkg)}["'];?`, 'g'),
			new RegExp(`import\\s+(\\w+)\\s*from\\s*["']${escapeRegex(pkg)}["'];?`, 'g'),
			new RegExp(
				`import\\s+(\\w+)\\s*,\\s*\\{([^}]+)\\}\\s*from\\s*["']${escapeRegex(pkg)}["'];?`,
				'g',
			),
		]

		result = result.replace(patterns[0]!, (_, names: string) => {
			const destructure = rewriteVendorNamedImports(names, pkg)
			return destructure ? destructure : ''
		})

		result = result.replace(patterns[1]!, (_, name: string) => {
			return `var ${name} = window.__PLUXEL_VENDORS__["${pkg}"];`
		})

		result = result.replace(patterns[3]!, (_, defaultName: string, namedImports: string) => {
			const named = rewriteVendorNamedImports(namedImports, pkg)
			const defaultLine = `var ${defaultName} = window.__PLUXEL_VENDORS__["${pkg}"].default || window.__PLUXEL_VENDORS__["${pkg}"];`
			return named ? `${defaultLine}\n${named}` : defaultLine
		})

		result = result.replace(patterns[2]!, (_, name: string) => {
			return `var ${name} = window.__PLUXEL_VENDORS__["${pkg}"].default || window.__PLUXEL_VENDORS__["${pkg}"];`
		})

		// Side-effect-only imports are invalid in browser for bare specifiers (no import map).
		// Example: `import "react/jsx-runtime";`
		const sideEffectImport = new RegExp(
			`(^|\\n)\\s*import\\s*["']${escapeRegex(pkg)}["'];?\\s*(?=\\n|$)`,
			'g',
		)
		result = result.replace(sideEffectImport, '$1')
	}

	return result
}

export function normalizeJsxRuntime(code: string): string {
	return code
		.replaceAll('react/jsx-dev-runtime', 'react/jsx-runtime')
		.replaceAll('react_jsx-dev-runtime', 'react_jsx-runtime')
		.replaceAll('jsxDevRuntime', 'jsxRuntime')
		.replaceAll('_jsxDEV', '_jsx')
		.replaceAll('jsxDEV', 'jsx')
}

function rewriteVendorNamedImports(names: string, pkg: string): string {
	const parts = names
		.split(',')
		.map((part) => part.trim())
		.filter(Boolean)
		.map((part) => {
			const match = part.match(/^([\w$]+)\s+as\s+([\w$]+)$/)
			if (match) {
				return `${match[1]}: ${match[2]}`
			}
			return part
		})

	if (!parts.length) return ''
	return `var { ${parts.join(', ')} } = window.__PLUXEL_VENDORS__["${pkg}"];`
}

function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

