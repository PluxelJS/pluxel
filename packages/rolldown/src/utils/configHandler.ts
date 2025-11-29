/**
 * 处理一段 valibot 源码字符串：
 * - v.optionalAsync(anyExpr, async () => ...) -> v.optional(anyExpr)
 * - pipe / pipeAsync 里移除 v.check / v.checkAsync / v.transform / v.transformAsync / v.transfrom
 */
export function normalizeSchemaSource(source: string): string {
	return walk(source)

	// 递归处理任意子串
	function walk(code: string): string {
		type Handler = (name: string, args: string[], full: string) => string | null

		const handlers: Record<string, Handler> = {
			optionalAsync: handleOptionalAsync,
			pipe: handlePipeLike,
			pipeAsync: handlePipeLike,
		}

		const names = Object.keys(handlers)

		let out = ''
		let i = 0

		// 跳过字符串字面量（防止匹配到 "v.optionalAsync(" 这种）
		let inSingle = false
		let inDouble = false
		let escape = false

		while (i < code.length) {
			const ch = code[i]

			if (escape) {
				out += ch
				escape = false
				i++
				continue
			}
			if (ch === '\\') {
				out += ch
				escape = true
				i++
				continue
			}

			if (inSingle) {
				out += ch
				if (ch === "'") inSingle = false
				i++
				continue
			}
			if (inDouble) {
				out += ch
				if (ch === '"') inDouble = false
				i++
				continue
			}

			if (ch === "'") {
				inSingle = true
				out += ch
				i++
				continue
			}
			if (ch === '"') {
				inDouble = true
				out += ch
				i++
				continue
			}

			// 不在字符串里，尝试匹配 v.xxx(
			if (ch === 'v' && code[i + 1] === '.') {
				let matched: string | null = null

				for (const name of names) {
					const prefix = `v.${name}(`
					if (code.startsWith(prefix, i)) {
						matched = name
						break
					}
				}

				if (matched) {
					const openParenIndex = i + 2 + matched.length // 指向 '('

					const parsed = parseCallArgs(code, openParenIndex)
					if (!parsed) {
						// 括号没配对之类的，保守原样输出
						out += ch
						i++
						continue
					}

					const { endIndex, args } = parsed
					const full = code.slice(i, endIndex + 1)

					const handler = handlers[matched]!
					const replacement = handler(matched, args, full)

					out += replacement ?? full
					i = endIndex + 1
					continue
				}
			}

			// 普通字符
			out += ch
			i++
		}

		return out
	}

	/**
	 * 从 '(' 的位置开始解析函数参数：
	 * - openParenIndex：指向 '(' 本身
	 * 返回闭合的 ')' 下标 + 顶层逗号分隔后的参数数组
	 */
	function parseCallArgs(
		code: string,
		openParenIndex: number,
	): { endIndex: number; args: string[] } | null {
		const args: string[] = []

		let depthParen = 0
		let depthBrace = 0
		let depthBracket = 0

		let inSingle = false
		let inDouble = false
		let escape = false

		let argStart = openParenIndex + 1

		for (let i = openParenIndex + 1; i < code.length; i++) {
			const ch = code[i]

			if (escape) {
				escape = false
				continue
			}
			if (ch === '\\') {
				escape = true
				continue
			}

			if (inSingle) {
				if (ch === "'") inSingle = false
				continue
			}
			if (inDouble) {
				if (ch === '"') inDouble = false
				continue
			}

			if (ch === "'") {
				inSingle = true
				continue
			}
			if (ch === '"') {
				inDouble = true
				continue
			}

			if (ch === '(') {
				depthParen++
				continue
			}
			if (ch === ')') {
				if (depthParen === 0 && depthBrace === 0 && depthBracket === 0) {
					const lastArg = code.slice(argStart, i)
					if (lastArg.trim()) {
						args.push(lastArg)
					}
					return { endIndex: i, args }
				}
				depthParen--
				continue
			}
			if (ch === '{') {
				depthBrace++
				continue
			}
			if (ch === '}') {
				depthBrace--
				continue
			}
			if (ch === '[') {
				depthBracket++
				continue
			}
			if (ch === ']') {
				depthBracket--
				continue
			}

			// 顶层逗号，切分参数
			if (ch === ',' && depthParen === 0 && depthBrace === 0 && depthBracket === 0) {
				args.push(code.slice(argStart, i))
				argStart = i + 1
			}
		}

		return null
	}

	// ---------- 具体规则 ----------

	/**
	 * v.optionalAsync(anyExpr, async () => ...) -> v.optional(anyExpr)
	 * 只用到第一个参数，其余参数丢弃。
	 * 第一个参数内部继续递归 walk，保证嵌套 optionalAsync 也会被处理。
	 */
	function handleOptionalAsync(_name: string, args: string[], full: string): string | null {
		if (!args.length) return full
		const inner = walk(args[0])
		return `v.optional(${inner.trim()})`
	}

	/**
	 * v.pipe(...) / v.pipeAsync(...)
	 * - 先对每个参数递归 walk
	 * - 然后把 v.check / v.checkAsync / v.transform / v.transformAsync / v.transfrom 整项过滤掉
	 * - 如果只剩一个参数，就拆掉 pipe，直接返回那个 schema
	 * - 如果全被删光了，保守返回原 full
	 */
	function handlePipeLike(name: string, args: string[], full: string): string | null {
		const normalized = args.map((a) => walk(a))
		const filtered: string[] = []

		for (const a of normalized) {
			const t = a.trim()

			// 匹配 v.check / v.checkAsync / v.transform / v.transformAsync / v.transfrom
			if (/^v\.(?:check(?:Async)?|transform(?:Async)?|transfrom)\b/.test(t)) {
				continue
			}

			if (t) filtered.push(a)
		}

		if (!filtered.length) {
			// 极端情况：pipe 里全都是 check/transform，保守不动
			return full
		}

		if (filtered.length === 1) {
			// 剩一个 schema，拆掉 pipe 更干净
			return filtered[0].trim()
		}

		return `v.${name}(${filtered.join(',')})`
	}
}
