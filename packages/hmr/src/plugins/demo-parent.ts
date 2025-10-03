import { field, query, resolver } from '@gqloom/core'
import * as v from 'valibot'

const User = v.object({
	__typename: v.nullish(v.literal('User')),
	id: v.number(),
	name: v.string(),
})

const Book = v.object({
	__typename: v.nullish(v.literal('Book')),
	id: v.number(),
	title: v.string(),
	authorID: v.number(),
})

const _userMapp = new Map([
	[1, { id: 1, name: 'Cao Xueqin' }],
	[2, { id: 2, name: 'Wu Chengen' }],
])

const bookMap = new Map([
	[1, { id: 1, title: 'Dream of Red Mansions', authorID: 1 }],
	[2, { id: 2, title: 'Journey to the West', authorID: 2 }],
])

export const bookResolver = resolver.of(Book, {
	books: query(v.array(Book)).resolve(() => Array.from(bookMap.values())),
})

export const bookRelations = resolver.of(Book, {
	author: field(v.nullish(User)).resolve((book) => {
		return _userMapp.get(book.authorID) ?? null
	}),
})

export const demoBookModule = [bookResolver, bookRelations]
