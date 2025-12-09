// file: src/app.ts
import { fsm } from "./machine";

const { S, E, createMachine } = fsm;

// 大量同构实例
const list = Array.from({ length: 300 }, () => createMachine());

await list[0].dispatch(E.start, "job-A");
await list[0].dispatch(E.stop);

console.log(list[0].getState() === S.stopped); // true
console.log(list[0].isFinal()); // true

// 也可以用 sync
const sm = fsm.createMachineSync();
sm.syncDispatch(E.start, "job-B");
sm.syncDispatch(E.stop);
