import { useMatches } from '@tanstack/react-router'

const EMPTY_SEARCH: Record<string, unknown> = {}

export function useCurrentPathname() {
	return useMatches({
		select: (matches) => {
			const last = matches[matches.length - 1]
			return last?.pathname ?? '/'
		},
		structuralSharing: true,
	})
}

export function useCurrentSearch() {
	return useMatches({
		select: (matches) => {
			const last = matches[matches.length - 1]
			return last?.search ?? EMPTY_SEARCH
		},
		structuralSharing: true,
	})
}
