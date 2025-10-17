import { EventEmitter } from 'events';


export enum EEventBusEventType {
  StateChange = "STATE_CHANGE",
}

const eventBus = new EventEmitter();
export default eventBus;