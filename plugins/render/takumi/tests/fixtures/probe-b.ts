import { probe, type ProbeInput } from './probe.ts'
export default function taskB(input: ProbeInput) {
	return probe('b', input)
}
