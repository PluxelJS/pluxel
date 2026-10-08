import { request } from 'launcher:bridge';
import { exit } from 'node:process';
const timers = new Set();
function assert(condition, message) { if (!condition) throw new Error(message); }
export async function dispatch(input) {
  const { method, params } = JSON.parse(input);
  if (method === 'echo') return request(input);
  if (method === 'exit') { exit(7); }
  if (method === 'globalExit') { process.exit(7); }
  if (method === 'throw') throw new Error('expected dispatch failure');
  if (method === 'reject') { Promise.reject(new Error('expected unhandled rejection')); await new Promise(r => setTimeout(r, 2)); }
  if (method === 'timerThrow') { await new Promise(resolve => { setTimeout(() => { throw new Error('expected timer callback failure'); }, 1); setTimeout(resolve, 5); }); }
  if (method === 'import') await import(params.name);
  if (method === 'web') {
    const bytes = new Uint8Array([0, 255, 128, 13, 10, 65, 228, 184, 173]);
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: 'application/octet-stream' }), '中文.bin');
    const fileBytes = new Uint8Array(await form.get('file').arrayBuffer());
    assert(fileBytes.length === bytes.length && fileBytes.every((n,i) => n === bytes[i]), 'Blob -> FormData corrupted binary bytes');
    const response = await fetch(new URL(params.url), {method: 'POST', body: form});
    assert(response.headers.get('x-received-origin') === 'absent', 'fetch fabricated an Origin header');
    const clone = response.clone();
    const body = new Uint8Array(await response.arrayBuffer());
    assert(body.some((_,i) => bytes.every((n,j) => body[i+j] === n)), 'multipart upload corrupted file bytes');
    const clonedBody = await clone.arrayBuffer();
    assert(clonedBody.byteLength === body.length, 'response clone differs');
    const abort = new AbortController(); const reason = new Error('owned abort'); abort.abort(reason);
    try { await fetch(params.url, {signal:abort.signal}); throw new Error('abort accepted'); } catch (error) { assert(error === reason, 'abort lost reason identity'); }
  }
  if (method === 'interval') { const id = setInterval(() => {}, 10); timers.add(id); }
  if (method === 'spin') while (true) {}
  return JSON.stringify({ok:true, method});
}
export async function close() { for (const timer of timers) clearInterval(timer); timers.clear(); }
