type SquareJob = {
	value: number
}

type SquareResult = {
	squared: number
}

export default async function run(job: SquareJob): Promise<SquareResult> {
	return {
		squared: job.value * job.value,
	}
}
