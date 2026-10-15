import { Button, Card, Chip } from '@heroui/react'
import { useState } from 'react'

/** Real HeroUI components, resolved directly by Takumi's React JSX parser. */
export function ReportCard({ title }: Readonly<{ title: string }>) {
	const [status] = useState('Ready to publish')
	return (
		<div className="dark w-full h-full bg-background text-foreground p-6">
			<Card className="h-full p-8 gap-4">
				<Card.Header className="gap-3">
					<Card.Description>PLUXEL REPORT STUDIO</Card.Description>
					<Card.Title className="text-3xl font-semibold">{title}</Card.Title>
				</Card.Header>
				<Card.Content className="gap-4">
					<Chip color="success" variant="soft">
						{status}
					</Chip>
					<p className="text-muted text-lg">HeroUI v3 · React JSX · shared Worker</p>
					<p className="text-muted text-sm">
						One report, six rendering engines, shared application capabilities.
					</p>
				</Card.Content>
				<Card.Footer className="justify-between">
					<Button variant="primary">View report</Button>
					<span className="text-muted text-sm">2026 · Architecture Lab</span>
				</Card.Footer>
			</Card>
		</div>
	)
}
