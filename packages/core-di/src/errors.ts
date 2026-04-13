import type { NodeKey, Token } from './graph'

const showHandle = (value: unknown): string => {
	if (typeof value === 'string') return value
	if (typeof value === 'symbol') return value.description ?? '(symbol)'
	if (typeof value === 'function') return value.name || '(anonymous)'
	if (value && typeof value === 'object') {
		const ctorName = (value as { constructor?: { name?: string } }).constructor?.name
		return ctorName ? `[object ${ctorName}]` : '[object]'
	}
	return String(value)
}

export type GraphBuildIssue =
	| {
			kind: 'InvalidDeclaration'
			nodeKey: NodeKey
			message: string
	  }
	| {
			kind: 'TokenConflict'
			token: Token
			owners: readonly NodeKey[]
	  }
	| {
			kind: 'MissingDependency'
			nodeKey: NodeKey
			token: Token
	  }
	| {
			kind: 'CircularDependency'
			chain: readonly NodeKey[]
	  }

export class GraphBuildError extends Error {
	public readonly issues: readonly GraphBuildIssue[]

	constructor(issues: readonly GraphBuildIssue[]) {
		super('core-di graph build failed')
		this.issues = issues
		Object.setPrototypeOf(this, GraphBuildError.prototype)
	}

	public format(): string {
		if (this.issues.length === 0) return 'No build issues.'
		return this.issues
			.map((issue) => {
				switch (issue.kind) {
					case 'InvalidDeclaration':
						return `[InvalidDeclaration] ${showHandle(issue.nodeKey)} | ${issue.message}`
					case 'TokenConflict':
						return `[TokenConflict] ${showHandle(issue.token)} | owners: ${issue.owners.map(showHandle).join(', ')}`
					case 'MissingDependency':
						return `[MissingDependency] ${showHandle(issue.nodeKey)} -> ${showHandle(issue.token)}`
					case 'CircularDependency':
						return `[CircularDependency] ${issue.chain.map(showHandle).join(' -> ')}`
				}
			})
			.join('\n')
	}

	public override toString(): string {
		return this.format()
	}
}
