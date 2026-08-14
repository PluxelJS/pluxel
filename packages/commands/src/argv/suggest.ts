import { compareStrings } from '../internal/compare'

export type SuggestionCandidate = {
	compare: string
	display: string
}

export function closestSuggestions(
	candidates: readonly SuggestionCandidate[],
	options?: {
		normalize?: (value: string) => string
		displayToComparable?: (display: string) => string
	},
): string[] {
	const normalize = options?.normalize ?? ((value: string) => value)
	const displayToComparable = options?.displayToComparable ?? ((display: string) => display)
	const ranked = candidates
		.map(({ compare, display }) => {
			const comparable = displayToComparable(display)
			const normalizedInput = normalize(compare)
			const normalizedCandidate = normalize(comparable)
			return {
				display,
				exact: compare === comparable,
				distance: editDistance(normalizedInput, normalizedCandidate),
				length: normalizedCandidate.length,
			}
		})
		.filter(
			({ exact, distance, length }) =>
				(!exact && distance === 0) || (distance > 0 && distance <= suggestionDistance(length)),
		)
		.sort((left, right) =>
			left.distance === right.distance
				? compareStrings(left.display, right.display)
				: left.distance - right.distance,
		)
	return [...new Set(ranked.map(({ display }) => display))].slice(0, 3)
}

export function suggestionSuffix(suggestions: readonly string[]): string {
	return suggestions.length > 0
		? `. Did you mean ${suggestions.map((value) => JSON.stringify(value)).join(' or ')}?`
		: ''
}

function suggestionDistance(length: number): number {
	return Math.max(1, Math.min(3, Math.floor(length / 3)))
}

/** Optimal string-alignment distance, including one adjacent transposition as a single edit. */
function editDistance(left: string, right: string): number {
	let beforePrevious: number[] | undefined
	let previous = Array.from({ length: right.length + 1 }, (_, index) => index)
	for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
		const current = [leftIndex]
		for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
			const substitution =
				previous[rightIndex - 1]! + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1)
			current[rightIndex] = Math.min(
				previous[rightIndex]! + 1,
				current[rightIndex - 1]! + 1,
				substitution,
			)
			if (
				beforePrevious &&
				leftIndex > 1 &&
				rightIndex > 1 &&
				left[leftIndex - 1] === right[rightIndex - 2] &&
				left[leftIndex - 2] === right[rightIndex - 1]
			) {
				current[rightIndex] = Math.min(current[rightIndex]!, beforePrevious[rightIndex - 2]! + 1)
			}
		}
		beforePrevious = previous
		previous = current
	}
	return previous[right.length]!
}
