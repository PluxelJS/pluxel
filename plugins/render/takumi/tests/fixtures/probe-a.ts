import { probe, type ProbeInput } from './probe.ts'
export default function taskA(input: ProbeInput) {
	return probe('a', input)
}
