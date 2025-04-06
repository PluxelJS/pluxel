import { DiodContainer } from 'diod'

export class ExtendedDIContainer extends DiodContainer {
	public getServices() {
		return this.services
	}
}
