console.log('start')
import * as v from 'valibot'
const schema = v.object({ id: v.number(), name: v.optional(v.string(), 'x') })
console.log('keys', Object.keys(schema))
console.log('type', schema.type)
console.dir(schema, { depth: 3 })
