import { Service } from '../../src/utils/decorators'
import { NotDecorated } from './not-decorated'

@Service()
export class NotPerson extends NotDecorated {
	// constructor() {
	public hasNose(): boolean {
		return false
	}
}
