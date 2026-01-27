import { describe, expect, test } from 'bun:test'

import GraphQLPluginDefault, { GraphQLPlugin } from './index'

describe('@pluxel/graphql', () => {
	test('default export matches named GraphQLPlugin', () => {
		expect(GraphQLPluginDefault).toBe(GraphQLPlugin)
	})
})

