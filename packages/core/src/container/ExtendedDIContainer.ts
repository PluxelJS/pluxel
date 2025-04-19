import { DiodContainer, type ServiceMap } from 'diod'

export class ExtendedDIContainer extends DiodContainer {
	public getServices(): ServiceMap {
		return this.services
	}
}
