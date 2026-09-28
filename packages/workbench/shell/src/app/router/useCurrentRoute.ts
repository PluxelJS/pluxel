import { useRouterState } from '@tanstack/react-router'

export function useCurrentPathname() {
	return useRouterState({
		select: (s) => s.location.pathname,
	})
}

export function useCurrentSearch() {
	return useRouterState({
		select: (s) => s.location.search,
	})
}
