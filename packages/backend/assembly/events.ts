
import { Context, u128, PersistentDeque, logging } from "near-sdk-as";
import { AccountId } from "./model";

@nearBindgen
export class TroveCreatedEvent {
    _usr: string;
    arrayIndex: i32;
    date: u64;
}

@nearBindgen
export class TroveUpdatedEvent {
    _usr: string;
    _debt: u128;
    _coll: u128;
    _stake: u128;
    date: u64;
}

@nearBindgen
export class TroveLiquidatedEvent {
    _usr: string;
    _debt: u128;
    _collat: u128;
    _mode: string;
    date: u64;
}

export const createdEvents = new PersistentDeque<TroveCreatedEvent>("created");
export const updatedEvents = new PersistentDeque<TroveUpdatedEvent>("updated");
export const liquidatedEvents = new PersistentDeque<TroveLiquidatedEvent>("liquidated");

export function emitTroveCreatedEvent(_usr: string, arrayIndex: i32): void {
    logging.log("[call] TroveCreatedEvent(" + _usr + ")");
    const created = new TroveCreatedEvent();
    created._usr = _usr;
    created.arrayIndex = arrayIndex;
    created.date = <u64>Context.blockIndex;
    createdEvents.pushFront(created);
}

export function emitSPdepositUpdated(_usr: AccountId, _debtChange: u128): void {
    // TODO
}

export function emitTroveUpdatedEvent(_usr: string, _debt: u128, _collat: u128, _stake: u128): void {
    logging.log(
        "[call] CDPupdatedEvent(" 
        + _usr + ", "
        + _debt.toString() + ", " 
        + _collat.toString() + ", " 
        + _stake.toString() + ")"
    ); 
    const updated = new TroveUpdatedEvent();
    updated._usr = _usr;
    updated._debt = _debt;
    updated._coll = _collat;
    updated._stake = _stake;
    updated.date = <u64>Context.blockIndex;
    updatedEvents.pushFront(updated);
}

export function emitTroveLiquidatedEvent(_usr: string, _debt: u128, _collat: u128, _mode: string): void {
    logging.log(
        "[call] CDPliquidatedEvent(" 
        + _usr + ", " 
        + _debt.toString() + ", " 
        + _collat.toString() + ", " 
        + _mode + ")"
    );
    const liquidated = new TroveLiquidatedEvent();
    liquidated._usr = _usr;
    liquidated._debt = _debt;
    liquidated._collat = _collat;
    liquidated._mode = _mode;
    liquidated.date = <u64>Context.blockIndex;
    liquidatedEvents.pushFront(liquidated);
}
