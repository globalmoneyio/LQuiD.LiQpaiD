import { Account } from "near-api-js";
import { context, u128, PersistentVector, PersistentMap } from "near-sdk-as";
import { AccountId, Amount } from "./main";
 
/** 
 * Exporting a new class PostedMessage so it can be used outside of this file.
 */
@nearBindgen
export class Word {
  lang: string = "en-us";
  constructor(public text: string, lang: string = "en-us") {
    this.lang = lang;
  }
}

@nearBindgen
export class PostedMessage {
    premium: boolean;
    sender: string;
    constructor(public text: string) {
      this.premium = context.attachedDeposit >= u128.from('10000000000000000000000');
      this.sender = context.sender;
    }
  }

/** 
 * collections.vector is a persistent collection. Any changes to it will
 * be automatically saved in the storage.
 * The parameter to the constructor needs to be unique across a single contract.
 * It will be used as a prefix to all keys required to store data in the storage.
 */

export const messages = new PersistentVector<PostedMessage>("m");

const balances = new PersistentMap<string, u64>("b:");
const approves = new PersistentMap<string, u64>("a:");

/*
const actPoolCltrl = new PersistentMap<string, u128>("aPc");
const actPoolDebt = new PersistentMap<string, u128>("aPd");
const defPoolCltrl = new PersistentMap<string, u128>("dPc");
const defPoolDebt = new PersistentMap<string, u128>("dPd");
*/

const CDPs = new PersistentMap<string, CDP>("cdps");

// Store the necessary data for a Collateralized Debt Position (CDP)
class CDP {
  debt: u128;
  coll: u128;
  stake: u128;
  status: Status;
  arrayIndex: u128;
}

// --- Data structures ---
export enum Status { nonExistent, active, closed }

@nearBindgen
export class TroveMgr {
 
  constructor() {}

  getCDPStatus(address: AccountId): u16 {
    let cdp: CDP = CDPs.getSome(address);
    return cdp.status
  }
  setCDPStatus(address: AccountId, _num: u16): void {
    var cdp: CDP = CDPs.getSome(address);
    
    if (_num == 0)
      cdp.status = Status.nonExistent;
    else if (_num == 1 )
      cdp.status = Status.active;
    else if (_num == 2 )  
      cdp.status = Status.closed;

    CDPs.set(address, cdp);
  }

  increaseCDPColl(_user: AccountId, _collIncrease: Amount): Amount  {
    var cdp: CDP = CDPs.getSome(_user);
    let newColl: u128 = u128.add(cdp.coll, _collIncrease);
    cdp.coll = newColl;
    CDPs.set(_user, cdp);
    return newColl;
  }
  decreaseCDPColl(_user: AccountId, _collDecrease: Amount): Amount {
    var cdp: CDP = CDPs.getSome(_user);
    let newColl: u128 = u128.sub(cdp.coll, _collDecrease);
    cdp.coll = newColl;
    CDPs.set(_user, cdp);
    return newColl;
  }
  increaseCDPDebt(_user: AccountId, _debtIncrease: Amount): Amount {
    var cdp: CDP = CDPs.getSome(_user);
    let newDebt: u128 = u128.add(cdp.debt, _debtIncrease);
    cdp.debt = newDebt;
    CDPs.set(_user, cdp);
    return newDebt;
  }
  decreaseCDPDebt(_user: AccountId, _debtDecrease: Amount): Amount {
    var cdp: CDP = CDPs.getSome(_user);
    let newDebt: u128 = u128.sub(cdp.debt, _debtDecrease);
    cdp.debt = newDebt;
    CDPs.set(_user, cdp);
    return newDebt;
  }
}

@nearBindgen
export class PoolMgr {
  activeColl: u128;
  activeDebt: u128;
   
  constructor() {}

  withdrawCLV(_account: AccountId, _CLV: Amount) { // TODO
    activePool.increaseCLV(_CLV);  
    CLV.mint(_account, _CLV);  
  }

  repayCLV(_account: AccountId, _CLV: Amount) { // TODO
    activePool.decreaseCLV(_CLV);
    CLV.burn(_account, _CLV);
  }

  addColl(_NEAR: Amount) { // payable
    // Send ETH to Active Pool and increase its recorded ETH balance
  }
  
  // Transfer the specified amount of ETH to _account and updates the total active collateral
  withdrawColl(_account: AccountId, _NEAR: Amount) { // TODOs
    activePool.sendETH(_account, _NEAR);
  }
}
 

class Pool {
  getETH() {

  }
  
  getCLV() {

  }
}


