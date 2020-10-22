
import { Context, u128, PersistentDeque, logging } from "near-sdk-as";

@nearBindgen
export class CDPCreatedEvent {
    _user: string;
    arrayIndex: usize;
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

@nearBindgen
export class CDPLiquidatedEvent {
    _user: string;
    _debt: u128;
    _coll: u128;
    _mode: string;
    date: u64;
}

export const createdEvents = new PersistentDeque<CDPCreatedEvent>("created");
export const updatedEvents = new PersistentDeque<CDPUpdatedEvent>("updated");
export const liquidatedEvents = new PersistentDeque<CDPLiquidatedEvent>("liquidated");

export function emitCDPcreatedEvent(_user: string, arrayIndex: usize): void {
    logging.log("[call] CDPcreatedEvent(" + _user + ", " + arrayIndex + ")");
    const created = new CDPCreatedEvent();
    created._user = _user;
    created.arrayIndex = arrayIndex;
    created.date = <u64>Context.blockIndex;
    createdEvents.pushFront(created);
}

export function emitCDPupdatedEvent(_user: string, _debt: u128, _coll: u128, _stake: u128): void {
    logging.log("[call] CDPupdatedEvent(" + _user + ", " + _debt + ", " + _coll + ", " + _stake + ")");
    const updated = new CDPUpdatedEvent();
    updated._user = _user;
    updated._debt = _debt;
    updated._coll = _coll;
    updated._stake = _stake;
    updated.date = <u64>Context.blockIndex;
    updatedEvents.pushFront(updated);
}

export function emitCDPliquidatedEvent(_user: string, _debt: u128, _coll: u128, _mode: string): void {
    logging.log("[call] CDPliquidatedEvent(" + _user + ", " + _debt + ", " + _coll + ", " + _mode + ")");
    const liquidated = new CDPLiquidatedEvent();
    liquidated._user = _user;
    liquidated._debt = _debt;
    liquidated._coll = _coll;
    liquidated._mode = _mode;
    liquidated.date = <u64>Context.blockIndex;
    liquidatedEvents.pushFront(liquidated);
}
