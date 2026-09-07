import { deepFreeze } from '../internal/freeze'
import { compareStrings } from '../internal/compare'
import { CommandError, type Command, type CommandContext, type Registration } from '../types'
import { compileEntry, configError, type CompiledEntry } from './compile'
import { tokenizeArgv } from './tokenize'
import { parseCandidate, syntaxError } from './parse'
import type {
	ArgvBinding,
	ArgvCommandDescriptor,
	ArgvInput,
	ArgvResolution,
	ArgvRouterOptions,
	ArgvToken,
} from './types'

type TrieNode<Ctx extends CommandContext> = {
	next: Map<string, TrieNode<Ctx>>
	entry?: CompiledEntry<Ctx>
	route?: string
	consumed?: number
}

export class ArgvRouter<Ctx extends CommandContext = CommandContext, Output = unknown> {
	private readonly caseInsensitive: boolean
	private readonly maxTextLength: number
	private readonly entries = new Map<string, CompiledEntry<Ctx>>()
	private readonly root: TrieNode<Ctx> = { next: new Map() }
	private revision = 0
	private listRevision = -1
	private listCache: readonly ArgvCommandDescriptor[] = []

	constructor(options?: ArgvRouterOptions) {
		this.caseInsensitive = options?.caseInsensitive !== false
		const maxTextLength = options?.maxTextLength ?? 16 * 1024
		if (!Number.isSafeInteger(maxTextLength) || maxTextLength <= 0) {
			throw new CommandError('COMMAND_CONFIG', 'Invalid command configuration', {
				message: 'argv maxTextLength must be a positive safe integer',
				details: { field: 'maxTextLength', reason: 'invalid_limit' },
			})
		}
		this.maxTextLength = maxTextLength
	}

	bind<I, O extends Output>(command: Command<I, O, Ctx>, binding: ArgvBinding<I>): Registration {
		const name = command.name
		if (this.entries.has(name)) {
			throw configError(
				`Command "${name}" already has an argv binding`,
				name,
				'routes',
				'duplicate_binding',
			)
		}
		const entry = compileEntry(command, binding)
		this.assertRoutesAvailable(entry)
		this.insertRoutes(entry)
		this.entries.set(name, entry)
		this.bumpRevision()
		let active = true
		return Object.freeze({
			name,
			dispose: () => {
				if (!active) return
				active = false
				if (this.entries.get(name) !== entry) return
				this.entries.delete(name)
				this.removeRoutes(entry)
				this.bumpRevision()
			},
		})
	}

	resolve(input: ArgvInput): ArgvResolution<Ctx, Output> | undefined {
		const prepared = prepareArgvInput(input)
		if (prepared.source.length > this.maxTextLength) {
			throw syntaxError(`Command input exceeds ${this.maxTextLength} characters`, {
				reason: 'input_too_long',
			})
		}
		const { source, tokens } = prepared
		const matched = this.match(tokens)
		if (!matched) return undefined
		return {
			command: matched.entry.command as Command<any, Output, Ctx>,
			route: matched.route,
			candidate: parseCandidate(matched.entry, tokens, matched.consumed, source),
		}
	}

	list(): readonly ArgvCommandDescriptor[] {
		if (this.listRevision === this.revision) return this.listCache
		this.listCache = deepFreeze(
			[...this.entries.values()]
				.map((entry) => entry.descriptor)
				.sort((left, right) => compareStrings(left.routes[0]!, right.routes[0]!)),
		)
		this.listRevision = this.revision
		return this.listCache
	}

	private normalize(value: string): string {
		return this.caseInsensitive ? value.toLowerCase() : value
	}

	private match(tokens: readonly ArgvToken[]) {
		let node = this.root
		let best: { entry: CompiledEntry<Ctx>; route: string; consumed: number } | undefined
		for (let index = 0; index < tokens.length; index += 1) {
			const next = node.next.get(this.normalize(tokens[index]!.value))
			if (!next) break
			node = next
			if (node.entry && node.route && node.consumed !== undefined) {
				best = { entry: node.entry, route: node.route, consumed: node.consumed }
			}
		}
		return best
	}

	private assertRoutesAvailable(entry: CompiledEntry<Ctx>): void {
		for (const routeTokens of entry.tokenizedRoutes) {
			let node: TrieNode<Ctx> | undefined = this.root
			for (const token of routeTokens) {
				node = node.next.get(this.normalize(token))
				if (!node) break
			}
			if (node?.entry) {
				throw configError(
					`Route "${routeTokens.join(' ')}" is already bound to "${node.entry.descriptor.name}"`,
					entry.command.name,
					'routes',
					'route_conflict',
				)
			}
		}
	}

	private insertRoutes(entry: CompiledEntry<Ctx>): void {
		for (const routeTokens of entry.tokenizedRoutes) {
			let node = this.root
			for (const token of routeTokens) {
				const normalized = this.normalize(token)
				let next = node.next.get(normalized)
				if (!next) {
					next = { next: new Map() }
					node.next.set(normalized, next)
				}
				node = next
			}
			node.entry = entry
			node.route = routeTokens.join(' ')
			node.consumed = routeTokens.length
		}
	}

	private removeRoutes(entry: CompiledEntry<Ctx>): void {
		for (const routeTokens of entry.tokenizedRoutes) {
			const path: Array<{ parent: TrieNode<Ctx>; key: string; node: TrieNode<Ctx> }> = []
			let node = this.root
			for (const token of routeTokens) {
				const key = this.normalize(token)
				const next = node.next.get(key)
				if (!next) break
				path.push({ parent: node, key, node: next })
				node = next
			}
			if (node.entry !== entry) continue
			delete node.entry
			delete node.route
			delete node.consumed
			for (let index = path.length - 1; index >= 0; index -= 1) {
				const current = path[index]!
				if (current.node.entry || current.node.next.size > 0) break
				current.parent.next.delete(current.key)
			}
		}
	}

	private bumpRevision(): void {
		this.revision += 1
		this.listRevision = -1
	}
}

function prepareArgvInput(input: ArgvInput): { source: string; tokens: ArgvToken[] } {
	if (typeof input === 'string') return { source: input, tokens: tokenizeArgv(input) }
	const source = argvInputSource(input)
	let offset = 0
	const tokens = input.map((value) => {
		const start = offset
		const end = start + value.length
		offset = end + 1
		return { value, raw: value, start, end }
	})
	return { source, tokens }
}

function argvInputSource(input: ArgvInput): string {
	return typeof input === 'string' ? input : input.join(' ')
}

export function createArgvRouter<Ctx extends CommandContext = CommandContext, Output = unknown>(
	options?: ArgvRouterOptions,
): ArgvRouter<Ctx, Output> {
	return new ArgvRouter<Ctx, Output>(options)
}
