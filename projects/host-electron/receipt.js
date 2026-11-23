const receipt = JSON.parse(decodeURIComponent(location.hash.slice(1)))
const output = document.getElementById('receipt')
if (!output) throw new Error('Missing receipt element')
output.textContent = JSON.stringify(receipt, null, 2)
