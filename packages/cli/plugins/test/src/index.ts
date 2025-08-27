
### `templates/plugin/src/index.ts.hbs` ```hbs export function main() {
console.log('Hello from
test!') } if (import.meta.url === `file://${process.argv[1]}`)
main()