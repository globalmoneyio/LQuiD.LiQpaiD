
import { context, u128, PersistentVector, PersistentMap } from "near-sdk-as";
import { ERR_USER_EXISTS } from './errors'
export type AccountId = string
export type Amount = u128

// Store the necessary data for a Collateralized Debt Position (CDP)
@nearBindgen
export class CDP {
  debt: u128;
  coll: u128;
  stake: u128;
  status: Status;
  arrayIndex: usize;
}
export enum Status { nonExistent, active, closed }

/** 
 * collections.vector is a persistent collection. Any changes to it will
 * be automatically saved in the storage.
 * The parameter to the constructor needs to be unique across a single contract.
 * It will be used as a prefix to all keys required to store data in the storage.
 */
export const CDPOwners = new PersistentVector<AccountId>("owners");

export const CDPs = new PersistentMap<AccountId, CDP>("cdps");

export function _computeICR(_coll: u128, _debt: u128, _price: u128): u128 {
  if (_debt > u128.Zero) {
      let newCollRatio: u128 = u128.mul(_coll, _price);
      return u128.div(newCollRatio, _debt);
  }
  // Return the maximal value for uint256 if the CDP has a debt of 0
  else if (_debt == u128.Zero) {
      return u128.Max; 
  }
  return u128.Zero;
}

export function getPrice() {
  return Math.floor(Math.random() * Math.floor(500));
}

@nearBindgen
export class TroveMgr {
  
  // snapshot of the value of totalStakes immediately after the last liquidation
  totalStakes: u128;  

  // snapshot of the total collateral in ActivePool and DefaultPool, immediately after the last liquidation.
  totalCollateral: u128;    

  constructor() {

  }
  addCDPOwnerToArray(_user: AccountId): usize {
    let index: usize = CDPOwners.length;
    assert(!CDPs.contains(_user), ERR_USER_EXISTS);
    CDPOwners.push(_user);
    var cdp: CDP = new CDP();
    cdp.arrayIndex = index;
    CDPs.set(_user, cdp);
    return index;
  }
  getCDPStatus(address: AccountId): u16 {
    var cdp: CDP;
    if(CDPs.contains(address)) {
      cdp = CDPs.getSome(address);
      return cdp.status
    }
    return 0;
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
  updateStakeAndTotalStakes(_user: AccountId) {
    var cdp: CDP = CDPs.getSome(_user);
    var newStake: u128; 
    
    if (this.totalCollateral == u128.Zero) {
        newStake = cdp.coll;
    } else {
        newStake = u128.mul(cdp.coll, this.totalStakes);
        newStake = u128.div(newStake, this.totalCollateral);
    }
    
    let oldStake: u128 = cdp.stake;
    cdp.stake = newStake;
    
    this.totalStakes = u128.sub(this.totalStakes, oldStake);
    this.totalStakes = u128.add(this.totalStakes, newStake);
  
    return newStake;
  }
  closeCDP(_user: AccountId): void {
    let cdp: CDP = CDPs.getSome(_user);
    cdp.status = Status.closed;
    cdp.coll = u128.Zero;
    cdp.debt = u128.Zero;
    this.totalStakes = u128.sub(this.totalStakes, cdp.stake);
    cdp.stake = u128.Zero;
    CDPs.set(_user, cdp);
    CDPOwners.swap_remove(cdp.arrayIndex);
  }
  removeStake() {

  }
  // Return the current collateral ratio (ICR) of a given CDP
  getCurrentICR(_user: AccountId, _price: u128): u128 {
    return _computeICR (this.getCDPColl(_user), this.getCDPDebt(_user), _price);      
  }
  getCDPColl(_user: AccountId): Amount {
    let cdp: CDP = CDPs.getSome(_user);
    return cdp.coll;
  }
  getCDPStake(_user: AccountId): Amount {
    let cdp: CDP = CDPs.getSome(_user);
    return cdp.stake;
  }
  getCDPDebt(_user: AccountId): Amount {
    let cdp: CDP = CDPs.getSome(_user);
    return cdp.debt;
  }
}

@nearBindgen
export class PoolMgr {
  activeColl: u128;
  activeDebt: u128;
  
  activePool: Pool;
  defaultPool: Pool;

  constructor() {
    this.activePool = new Pool();
    this.defaultPool = new Pool();
  }

  withdrawCLV(_account: AccountId, _CLV: Amount) { // TODO
    this.activePool.increaseLUSD(_CLV);  
    CLV.mint(_account, _CLV);  
  }

  repayCLV(_account: AccountId, _CLV: Amount) { // TODO
    this.activePool.decreaseLUSD(_CLV);
    CLV.burn(_account, _CLV);
  }

  addColl(_NEAR: Amount) { // payable
    // Send ETH to Active Pool and increase its recorded ETH balance

  }
  // Transfer the specified amount of ETH to _account and updates the total active collateral
  withdrawColl(_account: AccountId, _NEAR: Amount) { // TODOs
    this.activePool.sendNEAR(_account, _NEAR);
  }
}
 

class Pool {
  NEAR: Amount;  // deposited ether tracker
  LUSD: Amount;  // total outstanding CDP debt
    
  sendNEAR(_account: AccountId, _amount: Amount) {
    u128.sub(this.NEAR, _amount);

  }
  
  getNEAR(): Amount {
    return this.NEAR;
  }
  getLUSD(): Amount {
    return this.LUSD;
  }
}


