import { createFileRoute } from '@tanstack/react-router'

// WorkbenchShell renders each workspace document independently of the router outlet.
export const Route = createFileRoute('/_workbench/$')({ component: () => null })
