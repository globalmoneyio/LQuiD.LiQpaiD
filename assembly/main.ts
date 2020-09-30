/*
 * Flow of NEAR:
 * Lives in three Pools: the ActivePool, the DefaultPool and the StabilityPool. 
 * When an operation is made, NEAR is transferred in one of three ways:
  * From a user to a Pool
  * From a Pool to a user
  * From one Pool to another Pool
 * Ether is recorded on an individual level, but stored in aggregate in a Pool.  
 * An active trove with collateral and debt has a struct in the CDPManager that
 * stores its collateral value in a u128, but its actual NEAR is in the balance
 * the contract. 
 * Likewise, a StabilityPool depositor who has earned some collateral gain from
 * their deposit will have a computed ETH gain based on a variable in the PoolManager. 
 * But their actual withdrawable ether is in the balance of the StabilityPool contract.
 *
 */


import { Context, logging, storage, u128, PersistentMap } from "near-sdk-as";
import { 
  ERR_INVALID_ACCOUNT,
  ERR_CDP_INACTIVE,
  ERR_IN_RECOVERY,
  ERR_ICR_BELOW_MCR,
  ERR_CCR_BELOW_TCR,
  ERR_OVERDRAW_ETH,
  ERR_COL_VAL_BELOW_MIN,
  ERR_AMT_BELOW_ZERO,
  ERR_REPAY_OVER

} from "./errors";

import {
  recordCreatedEvent,
  recordUpdatedEvent
} from './events'

import { 
  CDP, CDPs, TroveMgr, PoolMgr
} from "./model";

var cdpManager: TroveMgr;
var poolManager: PoolMgr;
var priceFeedAddress: string;

const CLV = "clv.testnet";
const DENOM = 1000000000000000000;
const MCR = 1100000000000000000; // Minimal collateral ratio.
const CCR = 1500000000000000000; // Critical system collateral ratio. If the total system collateral (TCR) falls below the CCR, Recovery Mode is triggered.
const MIN_COLL_IN_USD = 20000000000000000000;

export type AccountId = string
export type Amount = u128

// const result = new Array<PostedMessage>(numMessages);

// --- Borrower Trove Operations ---

export function init(initialOwner: string): void {
  cdpManager = new TroveMgr();
  poolManager = new PoolMgr();
}

export function getCDPs(): PersistentMap<AccountId, CDP> {
  return CDPs
}

export function get_cdp(owner_id: AccountId): CDP {
  assert(CDPs.contains(owner_id), ERR_INVALID_ACCOUNT)
  return CDPs.getSome(owner_id)
}

// payable
export function openLoan(_CLVAmount: Amount) { 
  let user: AccountId = Context.sender; 
  let value: Amount = Context.attachedDeposit;
  let price: u128 = u128.from(42); //TODO priceFeed.getPrice(); 

  _requireValueIsGreaterThan20Dollars(value, price);
  
  let ICR: u128 = _computeICR (value, _CLVAmount, price);  

  if (_CLVAmount > u128.Zero) {
      _requireNotInRecoveryMode();
      _requireICRisAboveMCR(ICR);

      _requireNewTCRisAboveCCR(<i64>value, <i64>_CLVAmount, price); //TODO
  }
  
  // Update loan properties
  cdpManager.setCDPStatus(user, 1);
  cdpManager.increaseCDPColl(user, value);
  cdpManager.increaseCDPDebt(user, _CLVAmount);
  
  let stake: Amount = cdpManager.updateStakeAndTotalStakes(user); 
  
  // sortedCDPs.insert(user, ICR, price, _hint, _hint); 
  let arrayIndex: u128 = cdpManager.addCDPOwnerToArray(user);
  recordCreatedEvent(user, arrayIndex);
  
  // Tell PM to move the ether to the Active Pool, and mint CLV to the borrower
  poolManager.addColl(value); 
  poolManager.withdrawCLV(user, _CLVAmount); 
 
  recordUpdatedEvent(user, _CLVAmount, value, stake); 
}

// payable
// Send ETH as collateral to a CDP
export function addColl(_user: AccountId) {
  var isFirstCollDeposit: bool = false;
  let value: Amount = Context.attachedDeposit;
  let price: u128 = u128.from(42); // TODO priceFeed.getPrice();
  let status: u16 = cdpManager.getCDPStatus(_user);

  // If non-existent or closed, open a new trove
  if (status == 0 || status == 2 ) {
      _requireValueIsGreaterThan20Dollars(value, price);

      isFirstCollDeposit = true; 
      cdpManager.setCDPStatus(_user, 1);
  }  
  // Update the CDP's coll and stake
  let newColl: Amount = cdpManager.increaseCDPColl(_user, value);
  let stake: u128 = cdpManager.updateStakeAndTotalStakes(_user);
  
  if (isFirstCollDeposit) {     
      let arrayIndex: u128 = cdpManager.addCDPOwnerToArray(_user);
      recordCreatedEvent(_user, arrayIndex);
  }
  // Tell PM to move the ether to the Active Pool
  poolManager.addColl(value);

  let debt: Amount = cdpManager.getCDPDebt(_user);
  recordUpdatedEvent(_user, debt, newColl, stake);
}

// Withdraw ETH collateral from a CDP
export function withdrawColl(_amount: Amount) {
  let user: AccountId = Context.sender; 
  let status: u16 = cdpManager.getCDPStatus(user);

  _requireCDPisActive(status);
  _requireNotInRecoveryMode();
 
  let price: u128 = u128.from(42); // TODO priceFeed.getPrice();

  cdpManager.applyPendingRewards(user);

  let debt: Amount = cdpManager.getCDPDebt(user);
  let coll: Amount = cdpManager.getCDPColl(user);
  
  _requireCollAmountIsWithdrawable(coll, _amount, price);

  let newICR: u128 = _getNewICRFromTroveChange(coll, debt, -int(_amount), 0, price); //TODO
  _requireICRisAboveMCR(newICR);
  
  // Update the CDP's coll and stake
  let newColl: Amount = cdpManager.decreaseCDPColl(user, _amount);
  let stake: u128 = cdpManager.updateStakeAndTotalStakes(user);

  if (newColl == u128.Zero) { 
      cdpManager.closeCDP(user);  
  }  else { 
      // sortedCDPs.reInsert(user, newICR, price, _hint, _hint);
  }

  // Remove _amount ETH from ActivePool and send it to the user
  poolManager.withdrawColl(user, _amount);

  recordUpdatedEvent(user, debt, newColl, stake); 
}

// Withdraw CLV tokens from a CDP: mint new CLV to the owner, and increase the debt accordingly
export function withdrawCLV(_amount: u128) {
  let user: AccountId = Context.sender; 
  let status: u16 = cdpManager.getCDPStatus(user);

  _requireCDPisActive(status);
  _requireNonZeroAmount(_amount); 
  _requireNotInRecoveryMode();
  
  let price: u128 = u128.from(42); // TODO priceFeed.getPrice();
  cdpManager.applyPendingRewards(user);

  let debt: Amount = cdpManager.getCDPDebt(user);
  let coll: Amount = cdpManager.getCDPColl(user);
  
  let newICR: u128 = _getNewICRFromTroveChange(coll, debt, 0, int(_amount), price); //TODO
  _requireICRisAboveMCR(newICR);

  _requireNewTCRisAboveCCR(0, int(_amount), price); //TODO
  
  // Increase the CDP's debt
  let newDebt: Amount = cdpManager.increaseCDPDebt(user, _amount);
 
  // Update CDP's position in sortedCDPs
  // sortedCDPs.reInsert(user, newICR, price, _hint, _hint);

  // Mint the given amount of CLV to the owner's address and add them to the ActivePool
  poolManager.withdrawCLV(user, _amount);
  
  let stake: u128 = cdpManager.getCDPStake(user);
  recordUpdatedEvent(user, newDebt, coll, stake); 
}

// Repay CLV tokens to a CDP: Burn the repaid CLV tokens, and reduce the debt accordingly
export function repayCLV(_amount: u128) {
  let user: AccountId = Context.sender; 
  let status: u16 = cdpManager.getCDPStatus(user);
  _requireCDPisActive(status);

  let price: u128 = u128.from(42); // TODO priceFeed.getPrice();
  cdpManager.applyPendingRewards(user);

  let debt: Amount = cdpManager.getCDPDebt(user);
  _requireCLVRepaymentAllowed(debt, -int(_amount)); //TODO
  
  // Update the CDP's debt
  let newDebt: Amount = cdpManager.decreaseCDPDebt(user, _amount);
 
  let newICR: u128 = cdpManager.getCurrentICR(user, price);
  
  // Update CDP's position in sortedCDPs
  // sortedCDPs.reInsert(user, newICR, price, _hint, _hint);

  // Burn the received amount of CLV from the user's balance, and remove it from the ActivePool
  poolManager.repayCLV(user, _amount);
  
  let coll: Amount = cdpManager.getCDPColl(user);
  let stake: u128 = cdpManager.getCDPStake(user);
  recordUpdatedEvent(user, newDebt, coll, stake); 
}

export function closeLoan() {
  let user: AccountId = Context.sender; 
  let status: u16 = cdpManager.getCDPStatus(user);
  _requireCDPisActive(status);
  _requireNotInRecoveryMode();

  cdpManager.applyPendingRewards(user);
  
  let debt: Amount = cdpManager.getCDPDebt(user);
  let coll: Amount = cdpManager.getCDPColl(user);

  cdpManager.removeStake(user);
  cdpManager.closeCDP(user);

  // Tell PM to burn the debt from the user's balance, and send the collateral back to the user
  poolManager.repayCLV(user, debt);
  poolManager.withdrawColl(user, coll);

  recordUpdatedEvent(user, u128.Zero, u128.Zero, u128.Zero);
}

// payable
/* If ether is sent, the operation is considered as an increase in ether, and the first parameter 
_collWithdrawal is ignored  */
export function adjustLoan(_collWithdrawal: Amount, int _debtChange) {
  let user: AccountId = Context.sender; 
  let value: Amount = Context.attachedDeposit;

  _requireCDPisActive(cdpManager.getCDPStatus(user));
  _requireNotInRecoveryMode();
  
  let price: u128 = u128.from(42); // TODO priceFeed.getPrice();

  cdpManager.applyPendingRewards(user);

  // If Ether is sent, grab the amount. Otherwise, grab the specified collateral withdrawal
  int collChange = (value != u128.Zero) ? int(value) : -int(_collWithdrawal);

  let debt: Amount = cdpManager.getCDPDebt(user);
  let coll: Amount = cdpManager.getCDPColl(user);
 
  let newICR: u128 = _getNewICRFromTroveChange(coll, debt, collChange, _debtChange, price);
 
  // --- Checks --- 
  _requireICRisAboveMCR(newICR);
  _requireNewTCRisAboveCCR(collChange, _debtChange, price);
  _requireCLVRepaymentAllowed(debt, _debtChange);
  _requireCollAmountIsWithdrawable(coll, _collWithdrawal, price);

  //  --- Effects --- 
  let newColl: Amount = _updateTroveColl(user, collChange);
  let newDebt: Amount = _updateTroveDebt(user, _debtChange);
  
  let stake: u128 = cdpManager.updateStakeAndTotalStakes(user);
 
  // Close a CDP if it is empty, otherwise, re-insert it in the sorted list
  if (newDebt == u128.Zero && newColl == u128.Zero) {
      cdpManager.closeCDP(user);
  } else {
      // sortedCDPs.reInsert(_msgSender(), newICR, price, _hint, _hint);
  }

  //  --- Interactions ---
  _moveTokensAndETHfromAdjustment(user, collChange, _debtChange);   

  recordUpdatedEvent(user, newDebt, newColl, stake); 
}

// ALL DONE!
// ----------------------------------------------------------------------------
// Helper functions
// ----------------------------------------------------------------------------

function _getUSDValue(_coll: u128, _price: u128): u128 {
  var usdValue: u128 = u128.mul(_coll, _price);
  return u128.div(usdValue, u128.from(DENOM));
}

function _requireNonZeroAmount(_amount: u128): void {
  assert(_amount > u128.Zero, ERR_AMT_BELOW_ZERO);
}

function _requireCollAmountIsWithdrawable(_currentColl: u128, _collWithdrawal: u128, _price: u128): void {
  if (_collWithdrawal > u128.Zero) {
      assert(_collWithdrawal <= _currentColl, ERR_OVERDRAW_ETH);
      
      let newColl: u128 = u128.sub(_currentColl, _collWithdrawal);
      assert(_getUSDValue(newColl, _price) >= u128.from(MIN_COLL_IN_USD) || newColl == u128.Zero,
      ERR_COL_VAL_BELOW_MIN);
  }
}

function _requireCDPisActive(status: u16): void {
  assert(status == 1, ERR_CDP_INACTIVE);
}

function _requireNotInRecoveryMode(): void {
  assert(_checkRecoveryMode() == false, ERR_IN_RECOVERY);
}

function _requireICRisAboveMCR( _newICR: u128): void {
  assert(_newICR >= u128.from(MCR), ERR_ICR_BELOW_MCR);
}

function _requireValueIsGreaterThan20Dollars(_amount: u128, _price: u128): void {
  assert(_getUSDValue(_amount, _price) >= u128.from(MIN_COLL_IN_USD),  
  ERR_COL_VAL_BELOW_MIN);
}

function _computeICR(_coll: u128, _debt: u128, _price: u128): u128 {
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

// Update trove's coll and debt based on whether they increase or decrease
function _updateTroveColl(_user: AccountId, _collChange: i64): Amount {
  var newColl: Amount;
  if (_collChange > 0) {
    newColl = cdpManager.increaseCDPColl(_user, u128.from(_collChange));
  } else {
    newColl = cdpManager.decreaseCDPColl(_user, u128.from(_collChange));
  }
  return newColl;
}

// Update trove's coll and debt based on whether they increase or decrease
function _updateTroveDebt(_user: AccountId, _debtChange: i64): Amount {
  var newDebt: Amount
  if (_debtChange > 0) {
    newDebt = cdpManager.increaseCDPDebt(_user, u128.from(_debtChange));
  } else {
    newDebt = cdpManager.decreaseCDPDebt(_user, u128.from(_debtChange));
  }
  return newDebt;
}

function _moveTokensAndETHfromAdjustment(_user: AccountId, _collChange: i64, _debtChange: i64): void {
  if (_debtChange > 0){
      poolManager.withdrawCLV(_user, u128.from(_debtChange));
  } else if (_debtChange < 0) {
      poolManager.repayCLV(_user, u128.from(_debtChange));
  }
  if (_collChange > 0 ) {
      poolManager.addColl.value(u128.from(_collChange))();
  } else if (_collChange < 0) {
      poolManager.withdrawColl(_user, u128.from(_collChange));
  }
}

function _requireNewTCRisAboveCCR(_collChange: i64, _debtChange: i64, _price: u128): void {
  let newTCR: u128 = _getNewTCRFromTroveChange(_collChange, _debtChange, _price);
  assert(newTCR >= u128.from(CCR), ERR_CCR_BELOW_TCR);
}

function _requireCLVRepaymentAllowed(_currentDebt: Amount, _debtChange: i64): void {
  if (_debtChange < 0) {
      assert(u128.from(_debtChange) <= _currentDebt, ERR_REPAY_OVER);
  }
}

// Compute the new collateral ratio, considering the change in coll and debt. Assumes 0 pending rewards.
function _getNewICRFromTroveChange(_coll: Amount, _debt: Amount, _collChange: i64, _debtChange: i64, _price: u128): u128 {
  var newColl: Amount = _coll;
  var newDebt: Amount = _debt;

  if (_collChange > 0) {
      newColl = u128.add(_coll, u128.from(_collChange));
  } else if (_collChange < 0) {
      newColl = u128.sub(_coll, u128.from(_collChange));
  }

  if (_debtChange > 0) {
      newDebt = u128.add(_debt, u128.from(_debtChange));
  } else if (_debtChange < 0) {
      newDebt = u128.sub(_debt, u128.from(_debtChange));
  }

  return _computeICR (newColl, newDebt, _price);
}

function _getNewTCRFromTroveChange(_collChange: i64, _debtChange: i64, _price: u128): u128 { // TODO
  
  let activeColl: Amount = activePool.getETH();
  let activeDebt: Amount = activePool.getCLV();
  let liquidatedColl: Amount = defaultPool.getETH();
  let closedDebt: Amount = defaultPool.getCLV();

  var totalColl: Amount = u128.add(activeColl, liquidatedColl);
  var totalDebt: Amount = u128.add(activeDebt, closedDebt);
 
  if (_collChange > 0) {
      totalColl = u128.add(totalColl, u128.from(_collChange));
  } else if (_collChange < 0) {
      totalColl = u128.sub(totalColl, u128.from(_collChange));
  }
  if (_debtChange > 0) {
      totalDebt = u128.add(totalDebt, u128.from(_debtChange));
  } else if (_debtChange < 0) {
      totalDebt = u128.sub(totalDebt, u128.from(_debtChange));
  }
  return _computeICR (totalColl, totalDebt, _price);
}

function _checkRecoveryMode(): bool { // TODO
  let price: u128 = u128.from(42); //TODO priceFeed.getPrice();

  let activeColl: Amount = activePool.getETH();
  let activeDebt: Amount = activePool.getCLV();
  let liquidatedColl: Amount = defaultPool.getETH();
  let closedDebt: Amount = defaultPool.getCLV();

  let totalCollateral: Amount = u128.add(activeColl, liquidatedColl);
  let totalDebt: Amount = u128.add(activeDebt, closedDebt); 

  let TCR: u128 = _computeICR (totalCollateral, totalDebt, price); 
  
  return TCR < u128.from(CCR);
}
