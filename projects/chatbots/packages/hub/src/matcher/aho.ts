export type AhoPattern<T> = { pattern: string; value: T }
export type AhoMatch<T> = { index: number; end: number; pattern: string; value: T }

type Entry<T> = { pattern: string; key: string; value: T }
const ASCII_SIZE = 128

/** Compact-alphabet typed-array Aho-Corasick automaton. */
export class AhoMatcher<T = string> {
	private readonly entries: Entry<T>[]
	private readonly ascii = new Int32Array(ASCII_SIZE).fill(-1)
	private readonly unicode = new Map<number, number>()
	private readonly alphabetSize: number
	private readonly next: Int32Array
	private readonly outputs: Array<readonly number[]>

	constructor(
		patterns: readonly (string | AhoPattern<T>)[],
		private readonly caseInsensitive = false,
	) {
		this.entries = patterns.flatMap((raw) => {
			const pattern = typeof raw === 'string' ? raw : raw.pattern
			const key = caseInsensitive ? pattern.toLowerCase() : pattern
			return key ? [{ pattern, key, value: (typeof raw === 'string' ? raw : raw.value) as T }] : []
		})
		let alphabetSize = 0
		for (const entry of this.entries)
			for (let index = 0; index < entry.key.length; index++) {
				const code = entry.key.charCodeAt(index)
				if (code < ASCII_SIZE) {
					if (this.ascii[code] !== -1) continue
					this.ascii[code] = alphabetSize++
				} else if (!this.unicode.has(code)) this.unicode.set(code, alphabetSize++)
			}
		this.alphabetSize = alphabetSize
		if (this.entries.length === 0 || alphabetSize === 0) {
			this.next = new Int32Array(0)
			this.outputs = [[]]
			return
		}

		const states: Array<Map<number, number>> = [new Map()]
		const outputs: number[][] = [[]]
		for (let patternIndex = 0; patternIndex < this.entries.length; patternIndex++) {
			let state = 0
			const key = this.entries[patternIndex]!.key
			for (let keyIndex = 0; keyIndex < key.length; keyIndex++) {
				const alpha = this.alpha(key.charCodeAt(keyIndex))
				let target = states[state]!.get(alpha)
				if (target === undefined) {
					target = states.length
					states[state]!.set(alpha, target)
					states.push(new Map())
					outputs.push([])
				}
				state = target
			}
			outputs[state]!.push(patternIndex)
		}

		const next = new Int32Array(states.length * alphabetSize).fill(-1)
		const fail = new Int32Array(states.length)
		for (let state = 0; state < states.length; state++)
			for (const [alpha, target] of states[state]!) next[state * alphabetSize + alpha] = target
		const queue = new Int32Array(states.length)
		let head = 0
		let tail = 0
		for (let alpha = 0; alpha < alphabetSize; alpha++) {
			const target = next[alpha]
			if (target > 0) queue[tail++] = target
			else next[alpha] = 0
		}
		while (head < tail) {
			const state = queue[head++]!
			for (let alpha = 0; alpha < alphabetSize; alpha++) {
				const offset = state * alphabetSize + alpha
				const target = next[offset]
				if (target === -1) {
					next[offset] = next[fail[state]! * alphabetSize + alpha]!
					continue
				}
				const fallback = next[fail[state]! * alphabetSize + alpha]!
				fail[target] = fallback
				if (outputs[fallback]!.length > 0)
					outputs[target] = outputs[target]!.concat(outputs[fallback]!)
				queue[tail++] = target
			}
		}
		this.next = next
		this.outputs = outputs.map((items) => Object.freeze(items.slice()))
	}

	find(input: string): AhoMatch<T>[] {
		if (!input || this.entries.length === 0 || this.alphabetSize === 0) return []
		const folded = this.caseInsensitive ? foldInput(input) : undefined
		const text = folded?.text ?? input
		const matches: AhoMatch<T>[] = []
		let state = 0
		for (let index = 0; index < text.length; index++) {
			const alpha = this.alpha(text.charCodeAt(index))
			if (alpha < 0) {
				state = 0
				continue
			}
			state = this.next[state * this.alphabetSize + alpha]!
			for (const hit of this.outputs[state]!) {
				const entry = this.entries[hit]!
				const end = index + 1
				matches.push({
					index: folded?.starts[end - entry.key.length] ?? end - entry.key.length,
					end: folded?.ends[end - 1] ?? end,
					pattern: entry.pattern,
					value: entry.value,
				})
			}
		}
		return matches
	}

	private alpha(code: number): number {
		return code < ASCII_SIZE ? this.ascii[code]! : (this.unicode.get(code) ?? -1)
	}
}

function foldInput(input: string): { text: string; starts: number[]; ends: number[] } {
	let text = ''
	const starts: number[] = []
	const ends: number[] = []
	for (let index = 0; index < input.length; ) {
		const codePoint = input.codePointAt(index)!
		const source = String.fromCodePoint(codePoint)
		const folded = source.toLowerCase()
		text += folded
		for (let offset = 0; offset < folded.length; offset++) {
			starts.push(index)
			ends.push(index + source.length)
		}
		index += source.length
	}
	return { text, starts, ends }
}
