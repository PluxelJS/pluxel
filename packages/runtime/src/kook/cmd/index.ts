import { type Flags, type TypeFlag, typeFlag } from 'type-flag'
import { parseArgsStringToArgv } from './helper'

type Awaitable<T> = T | Promise<T>

/** —— 类型层：从 "cmd <a> [b]" 提取位置参数 —— */
type ParseRequired<T extends string> =
	T extends `${infer B} <${infer P}> ${infer A}`
		? { [K in P]: string } & ParseRequired<`${B} ${A}`>
		: T extends `${infer B} <${infer P}>`
			? { [K in P]: string }
			: {}
type ParseOptional<T extends string> =
	T extends `${infer B} [${infer P}] ${infer A}`
		? { [K in P]?: string } & ParseOptional<`${B} ${A}`>
		: T extends `${infer B} [${infer P}]`
			? { [K in P]?: string }
			: {}
export type ExtractCommandParams<T extends string> = ParseRequired<T> &
	ParseOptional<T>

/** —— 命令定义 —— */
export interface CommandSpec<P extends string, F extends Flags, C = unknown> {
	pattern: P
	flags: F
	flagOptions?: Parameters<typeof typeFlag>[2]

	usage?: string
	/** 仅命名 token（不能含 <...>/[...]），支持多词 */
	aliases?: string[]
	/** argv = flags + 位置参数；ctx 单独传入 */
	action: (
		argv: TypeFlag<F> & ExtractCommandParams<P>,
		ctx: C,
	) => Awaitable<string | void>
}

/** —— 编译后的命令 —— */
export interface Command<P extends string, F extends Flags, C = unknown> {
	name: string
	nameTokens: readonly string[]
	pattern: P
	aliases: readonly string[]
	toUsage(): string
	runTokens(tokens: string[], ctx: C): Promise<string | void>
	run(input: string, ctx: C): Promise<string | void>
}

/** —— 定义命令（核心） —— */
export function defineCommand<P extends string, F extends Flags, C = unknown>(
	spec: CommandSpec<P, F, C>,
): Command<P, F, C> {
	const parts = spec.pattern.trim().split(/\s+/)

	// 取命名 token（遇到 <...>/[...] 停）
	const nameTokens: string[] = []
	let i = 0
	for (; i < parts.length; i++) {
		const p = parts[i]
		if (p.startsWith('<') || p.startsWith('[')) break
		nameTokens.push(p)
	}

	const required: string[] = []
	const optional: string[] = []
	for (; i < parts.length; i++) {
		const p = parts[i]
		if (p.startsWith('<') && p.endsWith('>')) required.push(p.slice(1, -1))
		else if (p.startsWith('[') && p.endsWith(']')) optional.push(p.slice(1, -1))
	}

	const name = nameTokens.join(' ')
	const rawAliases = spec.aliases ?? []
	// 校验别名仅含命名 token；同时做 normalize
	for (const a of rawAliases) {
		if (/[<\[]/.test(a))
			throw new Error(`Alias should not contain parameters: "${a}"`)
	}
	const aliases = Object.freeze(
		Array.from(new Set(rawAliases.map((s) => s.trim()).filter(Boolean))),
	)

	const usage =
		spec.usage ??
		`${name}${required.map((k) => ` <${k}>`).join('')}${optional.map((k) => ` [${k}]`).join('')}`
	const toUsage = () => usage

	const runCore = async (tokens: string[], ctx: C) => {
		// flags 完全交给 type-flag；strict 映射为 permissive
		const opts = spec.flagOptions
		const argv = typeFlag(spec.flags, tokens, opts)

		// 位置参数：来自 argv._
		const pos = argv._ as string[]
		if (pos.length < required.length) {
			throw new CommandError(
				`Expected ${required.length} args, got ${pos.length}. Usage: ${usage}`,
			)
		}

		// 写入位置参数
		const params: Record<string, string> = Object.create(null)
		for (let i = 0; i < required.length; i++) params[required[i]] = pos[i]
		for (let i2 = 0; i2 < optional.length; i2++) {
			const v = pos[required.length + i2]
			if (v !== undefined) params[optional[i2]] = v
		}

		const merged = Object.assign(
			Object.create(null),
			argv,
			params,
		) as TypeFlag<F> & ExtractCommandParams<P>
		return spec.action(merged, ctx)
	}

	const runTokens = (tokens: string[], ctx: C) => runCore(tokens, ctx)
	const run = (input: string, ctx: C) =>
		runCore(parseArgsStringToArgv(input), ctx)

	return {
		name,
		nameTokens,
		pattern: spec.pattern,
		aliases,
		toUsage,
		runTokens,
		run,
	}
}

/** —— Trie(FSM) 路由器：最长匹配；单词命令走快表 —— */
export function createCommandBus<C = unknown>(opts?: {
	prefix?: string
	caseInsensitive?: boolean
}) {
	type AnyCmd = Command<any, any, C>
	const norm = (s: string) => (opts?.caseInsensitive ? s.toLowerCase() : s)

	// 单词快表；全量注册表（修复 list() 漏多词命令）
	const byHead = new Map<string, AnyCmd>()
	const allCmds = new Set<AnyCmd>()

	// 多词 Trie
	type Node = { cmd?: AnyCmd; next: Map<string, Node> }
	const root: Node = { next: new Map() }

	const putTrie = (tokens: readonly string[], cmd: AnyCmd) => {
		let cur = root
		for (const raw of tokens) {
			const t = norm(raw)
			let n = cur.next.get(t)
			if (!n) cur.next.set(t, (n = { next: new Map() }))
			cur = n
		}
		cur.cmd = cmd
	}

	const findTrie = (tokens: string[]) => {
		let cur = root
		let lastCmd: AnyCmd | undefined
		let consumed = 0
		for (let i = 0; i < tokens.length; i++) {
			const t = norm(tokens[i])
			const n = cur.next.get(t)
			if (!n) break
			cur = n
			consumed = i + 1
			if (cur.cmd) lastCmd = cur.cmd
		}
		return lastCmd ? { cmd: lastCmd, consumed } : undefined
	}

	return {
		register<CMD extends AnyCmd>(cmd: CMD) {
			allCmds.add(cmd)
			const isSingle = cmd.nameTokens.length === 1
			if (isSingle) byHead.set(norm(cmd.nameTokens[0]), cmd)
			putTrie(cmd.nameTokens, cmd)
			for (const a of cmd.aliases) {
				const toks = a.split(/\s+/)
				if (toks.length === 1) byHead.set(norm(toks[0]), cmd)
				putTrie(toks, cmd)
			}
			return this
		},

		list(): AnyCmd[] {
			return Array.from(allCmds)
		},

		/** 分发（字符串入口）：一次分词，全链路复用 */
		async dispatch(input: string, ctx: C): Promise<string | void> {
			const all = parseArgsStringToArgv(input)
			if (!all.length) throw new CommandError('Empty input')

			// 前缀
			if (opts?.prefix) {
				const p = opts.prefix
				if (all[0]?.startsWith(p)) {
					all[0] = all[0].slice(p.length)
					if (!all[0]) all.shift()
				} else {
					throw new CommandError(`Missing prefix "${p}"`)
				}
			}
			if (!all.length) throw new CommandError('Missing command name')

			// 单词命令快速路径
			const fast = byHead.get(norm(all[0]))
			if (fast && fast.nameTokens.length === 1) {
				return fast.runTokens(all.slice(1), ctx)
			}

			// Trie 最长匹配
			const found = findTrie(all)
			if (!found) throw new CommandError(`Unknown command: ${all[0]}`)
			const rest = all.slice(found.consumed)
			return found.cmd.runTokens(rest, ctx)
		},
	}
}

/** 统一错误类型 */
export class CommandError extends Error {
	constructor(msg: string) {
		super(msg)
		this.name = 'CommandError'
	}
}

/** —— 新增：为特定 C 生成 define —— */
export function defineFor<C>() {
	return function define<P extends string, F extends Flags>(
		spec: CommandSpec<P, F, C>,
	) {
		return defineCommand<P, F, C>(spec)
	}
}
