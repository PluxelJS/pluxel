import { Box, Stack, Text, Title } from '@mantine/core'
import { formatPluginDefinitionReference, formatPluginNodeReference } from '@pluxel/core'
import type { PackageHostImpact, PackageInstallPlan } from '../contracts.ts'

const definitionAction = {
	add: 'Add',
	replace: 'Replace',
	remove: 'Remove',
	unverified: 'Unverified change for',
}

export function InstallHostImpact({
	impact,
	review,
}: {
	impact: PackageInstallPlan['hostImpact']
	review: PackageInstallPlan['dependencyReview']
}) {
	return (
		<Stack
			component="section"
			aria-label="Host impact"
			gap={4}
			style={{ overflowWrap: 'anywhere' }}
		>
			<Title order={5}>Host impact</Title>
			{impact === null ? (
				<Text size="sm">The Host was unavailable for this review.</Text>
			) : impact.length === 0 ? (
				<Text size="sm">No managed package entries will change.</Text>
			) : (
				impact.map((pkg) => (
					<Stack key={pkg.name} gap={2}>
						<Text size="sm" fw={600}>
							{pkg.name}
						</Text>
						{!pkg.definitionsKnown && (
							<Text size="sm">
								The candidate has no verified list of root plugin exports. Its export changes are
								unknown.
							</Text>
						)}
						{pkg.definitionsKnown && pkg.definitions.length === 0 && (
							<Text size="sm">No affected root plugin exports.</Text>
						)}
						{pkg.definitions.length > 0 && (
							<Box component="ul" pl="md" m={0}>
								{pkg.definitions.map(renderDefinitionImpact)}
							</Box>
						)}
					</Stack>
				))
			)}
			{review && (
				<>
					<DependencyReview review={review} />
					<Text size="sm">
						If startup fails because the configuration requires a missing Host service, open the
						node in Installed for details.
					</Text>
				</>
			)}
		</Stack>
	)
}

function renderDefinitionImpact(definition: PackageHostImpact['definitions'][number]) {
	const reference = formatPluginDefinitionReference(definition.address)
	return (
		<li key={reference}>
			<Text size="sm">
				{definitionAction[definition.change]} <code>{reference}</code>
			</Text>
			{definition.dependencies?.requires.length ? (
				<Text size="sm">
					Requires{' '}
					{definition.dependencies.requires.map(formatPluginDefinitionReference).join(', ')}
				</Text>
			) : null}
			{definition.dependencies?.optional.length ? (
				<Text size="sm">
					Optional integrations:{' '}
					{definition.dependencies.optional.map(formatPluginDefinitionReference).join(', ')}
				</Text>
			) : null}
			{definition.dependencies?.provides && (
				<Text size="sm">
					Provides {formatPluginDefinitionReference(definition.dependencies.provides)}
				</Text>
			)}
			{definition.nodes.map((node) => (
				<Stack key={formatPluginNodeReference(node.address)} gap={0} mb={4}>
					<Text size="sm">
						{node.address.variant === 'fork' ? `Fork ${node.address.forkId}` : 'Default instance'}
						{' · '}
						{node.running ? 'Running' : 'Not running'}
					</Text>
					{node.requiredConsumers.length > 0 && (
						<Text size="sm">
							Required by {node.requiredConsumers.map(formatPluginNodeReference).join(', ')}
						</Text>
					)}
					{node.optionalConsumers.length > 0 && (
						<Text size="sm">
							Used optionally by {node.optionalConsumers.map(formatPluginNodeReference).join(', ')}
						</Text>
					)}
				</Stack>
			))}
		</li>
	)
}

const missingFacts = {
	exports: 'root export list',
	dependencies: 'dependency declarations',
	forkability: 'fork support',
	'source-ownership': 'source ownership after publication',
}

function DependencyReview({
	review,
}: {
	review: NonNullable<PackageInstallPlan['dependencyReview']>
}) {
	if (review.status === 'invalid') return <Text size="sm">Catalog conflict: {review.message}</Text>
	if (review.status === 'incomplete')
		return (
			<Stack gap={2}>
				<Text size="sm" fw={600}>
					Dependency projection incomplete
				</Text>
				{review.missing.map((item, i) => (
					<Text size="sm" key={i}>
						{item.definition ? formatPluginDefinitionReference(item.definition) : item.packageName}:
						missing {missingFacts[item.reason]}
					</Text>
				))}
			</Stack>
		)
	const { introduced, resolved, bindings, unprovided } = review
	return (
		<Stack gap={2}>
			<Text fw={600} size="sm">
				Projected Host policy changes
			</Text>
			<Text size="sm">
				This projection uses declared package roots and retained Host definitions. The Host
				discovers new cross-package re-exports when it loads the entries.
			</Text>
			{review.liveRejections.length > 0 && (
				<Text size="sm">
					With these declarations, a live replacement would keep the current catalog.{' '}
					{review.liveRejections.map((issue) => issue.message).join('. ')}
				</Text>
			)}
			{introduced.length === 0 && resolved.length === 0 && bindings.length === 0 && (
				<Text size="sm">No changes to required bindings or policy issues.</Text>
			)}
			{unprovided.map(({ definition, requirement, kind }) => (
				<Text
					size="sm"
					key={
						formatPluginDefinitionReference(definition) +
						':' +
						formatPluginDefinitionReference(requirement)
					}
				>
					{formatPluginDefinitionReference(definition)}: no {kind} provider in the projected catalog
					for {formatPluginDefinitionReference(requirement)}
				</Text>
			))}
			{introduced.map((issue, i) => (
				<Text size="sm" key={'new' + i}>
					New issue: {issue.message}
				</Text>
			))}
			{resolved.map((issue, i) => (
				<Text size="sm" key={'resolved' + i}>
					Resolved issue: {issue.message}
				</Text>
			))}
			{bindings.map(({ consumer, requirement, previous, selected }) => (
				<Text
					size="sm"
					key={
						formatPluginNodeReference(consumer) + ':' + formatPluginDefinitionReference(requirement)
					}
				>
					{formatPluginNodeReference(consumer)} requires{' '}
					{formatPluginDefinitionReference(requirement)}:{' '}
					{previous ? formatPluginNodeReference(previous) : 'unbound'} →{' '}
					{selected ? formatPluginNodeReference(selected) : 'unbound'}
				</Text>
			))}
		</Stack>
	)
}
