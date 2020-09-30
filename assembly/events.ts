
import { Context, u128, PersistentDeque, logging } from "near-sdk-as";

@nearBindgen
export class CDPCreatedEvent {
    _user: string;
    arrayIndex: u128;
    date: u64;
}

@nearBindgen
export class CDPUpdatedEvent {
    _user: string;
    _debt: u128;
    _coll: u128;
    _stake: u128;
    date: u64;
}

export const createdEvents = new PersistentDeque<CDPCreatedEvent>("created");
export const updatedEvents = new PersistentDeque<CDPUpdatedEvent>("updated");

export function recordCreatedEvent(_user: string, arrayIndex: u128): void {
    logging.log("[call] recordCreatedEvent(" + _user + ", " + arrayIndex + ")");
    const created = new CDPCreatedEvent();
    created._user = _user;
    created.arrayIndex = arrayIndex;
    created.date = <u64>Context.blockIndex;
    createdEvents.pushFront(created);
}

export function recordUpdatedEvent(_user: string, _debt: u128, _coll: u128, _stake: u128): void {
    logging.log("[call] recordUpdatedEvent(" + _user + ", " + _debt + ", " + _coll + ", " + _stake + ")");
    const updated = new CDPUpdatedEvent();
    updated._user = _user;
    updated._debt = _debt;
    updated._coll = _coll;
    updated._stake = _stake;
    updated.date = <u64>Context.blockIndex;
    updatedEvents.pushFront(updated);
}
