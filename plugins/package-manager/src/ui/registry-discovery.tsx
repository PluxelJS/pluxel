import {
	Alert,
	Checkbox,
	Badge,
	Button,
	Code,
	Group,
	Loader,
	Paper,
	Stack,
	Text,
	TextInput,
} from '@mantine/core'
import { IconSearch } from '@tabler/icons-react'
import { useLayoutEffect, useRef, useState } from 'react'
import { isPackageName } from '../package-document.ts'
import type { ManagedPackage } from '../contracts.ts'
import type { createPackageManagerResources } from './package-manager.resources.ts'

type Resources = ReturnType<typeof createPackageManagerResources>['registry']
type Actions = {
	managed: readonly ManagedPackage[]
	busy: boolean
	onReview(spec: string): void
	onManage(name: string): void
}

export function createRegistryDiscovery(registry: Resources) {
	function RegistryResults({
		includeAll,
		query,
		onCheck,
	}: {
		query: string
		includeAll: boolean
		onCheck(spec: string, button: HTMLButtonElement): void
	}) {
		const search = registry.search.useQuery({ query, includeAll })
		if (search.isPending) return <Text role="status">Searching registry…</Text>
		if (search.status === 'error')
			return (
				<Alert role="alert" color="red" title="Registry search unavailable">
					{search.error instanceof Error ? search.error.message : String(search.error)}{' '}
					<Button size="compact-sm" variant="subtle" onClick={() => void search.refetch()}>
						Retry search
					</Button>
				</Alert>
			)
		if (!search.data) return null
		return (
			<section aria-label="Registry results">
				<Stack gap="xs">
					<Text size="sm" c="dimmed" role="status">
						{search.data.packages.length} results · {search.data.registry}
					</Text>
					{search.data.packages.length === 0 && (
						<Text size="sm">
							Try another keyword, enable “Search all registry packages”, or check an exact name.
						</Text>
					)}
					{search.data.packages.map((pkg) => (
						<Paper key={pkg.name} withBorder p="sm">
							<Group justify="space-between" align="flex-start">
								<Stack gap={2} style={{ flex: '1 1 15rem', minWidth: 0 }}>
									<Text fw={600} style={{ overflowWrap: 'anywhere' }}>
										{pkg.name} <Code>{pkg.version}</Code>
									</Text>
									{pkg.description && <Text size="sm">{pkg.description}</Text>}
								</Stack>
								<Button
									variant="default"
									size="xs"
									aria-label={'Check ' + pkg.name + '@' + pkg.version}
									onClick={(event) => onCheck(pkg.name + '@' + pkg.version, event.currentTarget)}
								>
									Check package
								</Button>
							</Group>
						</Paper>
					))}
				</Stack>
			</section>
		)
	}

	function RegistryCheck({ spec, managed, busy, onReview, onManage }: Actions & { spec: string }) {
		const checked = registry.inspect.useQuery(spec)
		if (checked.isPending)
			return (
				<Group role="status">
					<Loader size="xs" />
					Checking {spec}…
				</Group>
			)
		if (checked.status === 'error')
			return (
				<Alert color="red" role="alert" title="Package lookup failed">
					{checked.error instanceof Error ? checked.error.message : String(checked.error)}{' '}
					<Button size="compact-sm" variant="subtle" onClick={() => void checked.refetch()}>
						Retry lookup
					</Button>
				</Alert>
			)
		const pkg = checked.data
		if (!pkg) return null
		const installed = managed.find((item) => item.name === pkg.name)
		return (
			<Paper component="section" aria-label="Plugin compatibility" withBorder p="md">
				<Stack gap="xs">
					<Group gap="xs">
						<Text fw={650} style={{ overflowWrap: 'anywhere' }}>
							{pkg.name}
						</Text>
						<Code>{pkg.version}</Code>
						<Badge color={pkg.check.ok ? 'teal' : 'red'}>
							{pkg.check.ok ? 'Manifest compatible' : 'Incompatible'}
						</Badge>
					</Group>
					<Text size="xs" c="dimmed">
						{pkg.registry}
					</Text>
					{pkg.description && <Text size="sm">{pkg.description}</Text>}
					{pkg.check.ok === true ? (
						<Text size="sm">
							Core peer <Code>{pkg.check.coreRange}</Code> · Host{' '}
							<Code>{pkg.check.coreVersion}</Code> · Root export <Code>{pkg.check.entry}</Code>
						</Text>
					) : (
						<Text role="status" size="sm">
							{pkg.check.reason}
						</Text>
					)}
					<Group gap="xs">
						{pkg.check.ok && installed?.installedVersion !== pkg.version && (
							<Button disabled={busy} onClick={() => onReview(pkg.name + '@' + pkg.version)}>
								Review installation
							</Button>
						)}
						{installed && (
							<Button variant="default" onClick={() => onManage(pkg.name)}>
								Manage installed {installed.installedVersion}
							</Button>
						)}
					</Group>
				</Stack>
			</Paper>
		)
	}

	return function RegistryDiscovery(actions: Actions) {
		const [input, setInput] = useState('')
		const [includeAll, setIncludeAll] = useState(false)
		const [query, setQuery] = useState('')
		const [spec, setSpec] = useState('')
		const result = useRef<HTMLDivElement>(null)
		const searchInput = useRef<HTMLInputElement>(null)
		const origin = useRef<HTMLButtonElement>(null)
		useLayoutEffect(() => {
			if (spec) {
				result.current?.scrollIntoView?.({ block: 'nearest' })
				result.current?.focus({ preventScroll: true })
			}
		}, [spec])
		const text = input.trim()
		const at = text.indexOf('@', 1)
		const exact =
			isPackageName(at < 0 ? text : text.slice(0, at)) &&
			(at < 0 || Boolean(text.slice(at + 1).trim()))
		return (
			<Stack gap="sm">
				<form
					onSubmit={(event) => {
						event.preventDefault()
						if (!text) return
						if (exact && at > 0) {
							setQuery('')
							setSpec(text)
						} else {
							setSpec('')
							setQuery(text)
						}
					}}
				>
					<Stack gap="xs">
						<TextInput
							ref={searchInput}
							type="search"
							label="Find plugins in your npm registry"
							description="Search by keyword, or check a package name with an optional version or tag."
							placeholder="Package name or keywords"
							leftSection={<IconSearch size={16} />}
							maxLength={214}
							value={input}
							onChange={(e) => {
								setInput(e.currentTarget.value)
								setQuery('')
								setSpec('')
							}}
						/>
						<Group gap="sm">
							<Button type="submit" disabled={!text}>
								{exact && at > 0 ? 'Check package' : 'Search registry'}
							</Button>
							{exact && at < 0 && (
								<Button
									variant="default"
									onClick={() => {
										setQuery('')
										setSpec(text)
									}}
								>
									Check exact name
								</Button>
							)}
							<Checkbox
								label="Search all registry packages"
								checked={includeAll}
								onChange={(event) => {
									setIncludeAll(event.currentTarget.checked)
									setSpec('')
								}}
							/>
						</Group>
					</Stack>
				</form>
				{spec && (
					<div ref={result} tabIndex={-1} role="region" aria-label={'Registry check for ' + spec}>
						<Stack gap="xs">
							<Group>
								<Button
									size="compact-sm"
									variant="subtle"
									onClick={() => {
										setSpec('')
										requestAnimationFrame(() =>
											(query ? origin.current : searchInput.current)?.focus(),
										)
									}}
								>
									{query ? 'Back to results' : 'Back to search'}
								</Button>
							</Group>
							<RegistryCheck key={spec} spec={spec} {...actions} />
						</Stack>
					</div>
				)}
				{query && (
					<div hidden={Boolean(spec)}>
						<RegistryResults
							includeAll={includeAll}
							key={query}
							query={query}
							onCheck={(next, button) => {
								origin.current = button
								setSpec(next)
							}}
						/>
					</div>
				)}
			</Stack>
		)
	}
}
