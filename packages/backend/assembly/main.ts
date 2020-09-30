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

import { Context, u128, PersistentMap } from "near-sdk-as";
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
  AccountId, Amount, CDP, CDPs, TroveMgr, PoolMgr, _computeICR, getPrice, CDPOwners
} from "./model";

var cdpManager: TroveMgr;
var poolManager: PoolMgr;


const CLV = "clv.testnet";
// const priceFeedAddress;
const DENOM = 1000000000000000000;
const MCR = 1100000000000000000; // Minimal collateral ratio.
const CCR = 1500000000000000000; // Critical system collateral ratio. If the total system collateral (TCR) falls below the CCR, Recovery Mode is triggered.
const MIN_COLL_IN_USD = 20000000000000000000;

// const result = new Array<PostedMessage>(numMessages);

export function init(initialOwner: string): void {
  cdpManager = new TroveMgr();
  poolManager = new PoolMgr();
}

export function getCDPs(): Map<AccountId, CDP> {
  let map: Map<AccountId, CDP> = new Map<AccountId, CDP>();
  for (let i: usize = 0; i < CDPOwners.length; i++) {
    let owner: AccountId = CDPOwners[i];
    map.set(owner, CDPs.getSome(owner));
  }
  return map;
}

export function get_cdp(owner_id: AccountId): CDP {
  assert(CDPs.contains(owner_id), ERR_INVALID_ACCOUNT)
  return CDPs.getSome(owner_id)
}

// payable
export function openLoan(_CLVAmount: Amount) { 
  let user: AccountId = Context.sender; 
  let value: Amount = Context.attachedDeposit;
  let price: u128 = u128.from(getPrice());

  _requireValueIsGreaterThan20Dollars(value, price);
  
  let ICR: u128 = _computeICR (value, _CLVAmount, price);  

  if (_CLVAmount > u128.Zero) {
      _requireNotInRecoveryMode();
      _requireICRisAboveMCR(ICR);

      _requireNewTCRisAboveCCR(value, true, _CLVAmount, true, price); 
  }
  
  // Update loan properties
  cdpManager.setCDPStatus(user, 1);
  cdpManager.increaseCDPColl(user, value);
  cdpManager.increaseCDPDebt(user, _CLVAmount);
  
  let stake: Amount = cdpManager.updateStakeAndTotalStakes(user); 

  let arrayIndex = cdpManager.addCDPOwnerToArray(user);
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
  let price: u128 = u128.from(getPrice());
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
      let arrayIndex = cdpManager.addCDPOwnerToArray(_user);
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
 
  let price: u128 = u128.from(getPrice());
  let debt: Amount = cdpManager.getCDPDebt(user);
  let coll: Amount = cdpManager.getCDPColl(user);
  
  _requireCollAmountIsWithdrawable(coll, _amount, price);

  let newICR: u128 = _getNewICRFromTroveChange(coll, debt, _amount, false, u128.Zero, false, price); 
  _requireICRisAboveMCR(newICR);
  
  // Update the CDP's coll and stake
  let newColl: Amount = cdpManager.decreaseCDPColl(user, _amount);
  let stake: u128 = cdpManager.updateStakeAndTotalStakes(user);

  if (newColl == u128.Zero) { 
      cdpManager.closeCDP(user);  
  }

  // Remove _amount ETH from ActivePool and send it to the user
  poolManager.withdrawColl(user, _amount);

  recordUpdatedEvent(user, debt, newColl, stake); 
}

// Withdraw CLV tokens from a CDP: mint new CLV to the owner, and increase the debt accordingly
export function withdrawCLV(_amount: Amount) {
  let user: AccountId = Context.sender; 
  let status: u16 = cdpManager.getCDPStatus(user);

  _requireCDPisActive(status);
  _requireNonZeroAmount(_amount); 
  _requireNotInRecoveryMode();
  
  let price: u128 = u128.from(getPrice());

  let debt: Amount = cdpManager.getCDPDebt(user);
  let coll: Amount = cdpManager.getCDPColl(user);
  
  let newICR: u128 = _getNewICRFromTroveChange(coll, debt, u128.Zero, false, _amount, true, price);
  _requireICRisAboveMCR(newICR);

  _requireNewTCRisAboveCCR(u128.Zero, false, _amount, true, price); 
  
  // Increase the CDP's debt
  let newDebt: Amount = cdpManager.increaseCDPDebt(user, _amount);
 
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

  let debt: Amount = cdpManager.getCDPDebt(user);
  _requireCLVRepaymentAllowed(debt, _amount);
  
  // Update the CDP's debt
  let newDebt: Amount = cdpManager.decreaseCDPDebt(user, _amount);
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
  
  let debt: Amount = cdpManager.getCDPDebt(user);
  let coll: Amount = cdpManager.getCDPColl(user);

  cdpManager.closeCDP(user);

  // Tell PM to burn the debt from the user's balance, and send the collateral back to the user
  poolManager.repayCLV(user, debt);
  poolManager.withdrawColl(user, coll);

  recordUpdatedEvent(user, u128.Zero, u128.Zero, u128.Zero);
}

// payable
/* If ether is sent, the operation is considered as an increase in ether, and the first parameter 
_collWithdrawal is ignored  */
export function adjustLoan(_collWithdrawal: Amount, _debtChange: u128, _isDebtIncrease: bool) {
  let user: AccountId = Context.sender; 
  let value: Amount = Context.attachedDeposit;

  _requireCDPisActive(cdpManager.getCDPStatus(user));
  _requireNotInRecoveryMode();
  
  let price: u128 = u128.from(getPrice());

  // If Ether is sent, grab the amount. Otherwise, grab the specified collateral withdrawal
  var collChange: u128 = _collWithdrawal;
  var isCollIncrease: bool = false;
  if (value != u128.Zero) {
    collChange = value;
    isCollIncrease = true;
  }

  let debt: Amount = cdpManager.getCDPDebt(user);
  let coll: Amount = cdpManager.getCDPColl(user);
  let newICR: u128 = _getNewICRFromTroveChange(coll, debt, collChange, isCollIncrease,_debtChange, _isDebtIncrease, price);
 
  // --- Checks --- 
  _requireICRisAboveMCR(newICR);
  _requireNewTCRisAboveCCR(collChange, isCollIncrease, _debtChange, _isDebtIncrease, price);
  if (!_isDebtIncrease) { _requireCLVRepaymentAllowed(debt, _debtChange); }
  _requireCollAmountIsWithdrawable(coll, _collWithdrawal, price);

  //  --- Effects --- 
  let newColl: Amount = _updateTroveColl(user, collChange, isCollIncrease);
  let newDebt: Amount = _updateTroveDebt(user, _debtChange, _isDebtIncrease);
  let stake: u128 = cdpManager.updateStakeAndTotalStakes(user);
 
  // Close a CDP if it is empty, otherwise
  if (newDebt == u128.Zero && newColl == u128.Zero) {
      cdpManager.closeCDP(user);
  } 
  _moveTokensAndETHfromAdjustment(user, collChange, isCollIncrease, _debtChange, _isDebtIncrease);   
  recordUpdatedEvent(user, newDebt, newColl, stake); 
}

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

function _requireValueIsGreaterThan20Dollars(_amount: Amount, _price: u128): void {
  assert(_getUSDValue(_amount, _price) >= u128.from(MIN_COLL_IN_USD),  
  ERR_COL_VAL_BELOW_MIN);
}

// Update trove's coll and debt based on whether they increase or decrease
function _updateTroveColl(_user: AccountId, _collChange: Amount, _isCollIncrease: bool ): Amount {
  var newColl: Amount;
  if (_isCollIncrease) {
    newColl = cdpManager.increaseCDPColl(_user, u128.from(_collChange));
  } else {
    newColl = cdpManager.decreaseCDPColl(_user, u128.from(_collChange));
  }
  return newColl;
}

// Update trove's coll and debt based on whether they increase or decrease
function _updateTroveDebt(_user: AccountId, _debtChange: Amount, _isDebtIncrease: bool): Amount {
  var newDebt: Amount
  if (_isDebtIncrease) {
    newDebt = cdpManager.increaseCDPDebt(_user, u128.from(_debtChange));
  } else {
    newDebt = cdpManager.decreaseCDPDebt(_user, u128.from(_debtChange));
  }
  return newDebt;
}

function _moveTokensAndETHfromAdjustment(_user: AccountId, _collChange: Amount, _isCollIncrease: bool, _debtChange: Amount, _isDebtIncrease: bool): void {
  if (_isDebtIncrease){
      poolManager.withdrawCLV(_user, u128.from(_debtChange));
  } else {
      poolManager.repayCLV(_user, u128.from(_debtChange));
  }
  if (_isCollIncrease) {
      poolManager.addColl(u128.from(_collChange));
  } else {
      poolManager.withdrawColl(_user, u128.from(_collChange));
  }
}

function _requireNewTCRisAboveCCR(_collChange: Amount, _isCollIncrease: bool, _debtChange: Amount, _isDebtIncrease: bool, _price: u128): void {
  let newTCR: u128 = _getNewTCRFromTroveChange(_collChange, _isCollIncrease, _debtChange, _isDebtIncrease, _price);
  assert(newTCR >= u128.from(CCR), ERR_CCR_BELOW_TCR);
}

function _requireCLVRepaymentAllowed(_currentDebt: Amount, _debtRepayment: Amount): void {
  assert(_debtRepayment <= _currentDebt, ERR_REPAY_OVER);
}

// Compute the new collateral ratio, considering the change in coll and debt. Assumes 0 pending rewards.
function _getNewICRFromTroveChange(
  _coll: Amount, _debt: Amount,
  _collChange: Amount, _isCollIncrease: bool,
  _debtChange: Amount, _isDebtIncrease: bool, _price: u128): u128 {
    var newColl: Amount = _coll;
    var newDebt: Amount = _debt;

    if (_isCollIncrease > 0) {
        newColl = u128.add(_coll, u128.from(_collChange));
    } else {
        newColl = u128.sub(_coll, u128.from(_collChange));
    }

    if (_isDebtIncrease) {
        newDebt = u128.add(_debt, u128.from(_debtChange));
    } else {
        newDebt = u128.sub(_debt, u128.from(_debtChange));
    }

    return _computeICR (newColl, newDebt, _price);
}

function _getNewTCRFromTroveChange(_collChange: Amount, _isCollIncrease: bool, _debtChange: Amount, _isDebtIncrease: bool, _price: u128): u128 {
  
  let activeColl: Amount = poolManager.activePool.getNEAR();
  let activeDebt: Amount = poolManager.activePool.getLUSD();
  let liquidatedColl: Amount = poolManager.defaultPool.getNEAR();
  let closedDebt: Amount = poolManager.defaultPool.getLUSD();

  var totalColl: Amount = u128.add(activeColl, liquidatedColl);
  var totalDebt: Amount = u128.add(activeDebt, closedDebt);
 
  if (_isCollIncrease) {
      totalColl = u128.add(totalColl, u128.from(_collChange));
  } else {
      totalColl = u128.sub(totalColl, u128.from(_collChange));
  }
  if (_isDebtIncrease) {
      totalDebt = u128.add(totalDebt, u128.from(_debtChange));
  } else {
      totalDebt = u128.sub(totalDebt, u128.from(_debtChange));
  }
  return _computeICR (totalColl, totalDebt, _price);
}

function _checkRecoveryMode(): bool {
  let price: u128 = u128.from(getPrice());

  let activeColl: Amount = poolManager.activePool.getNEAR();
  let activeDebt: Amount = poolManager.activePool.getLUSD();
  let liquidatedColl: Amount = poolManager.defaultPool.getNEAR();
  let closedDebt: Amount = poolManager.defaultPool.getLUSD();

  let totalCollateral: Amount = u128.add(activeColl, liquidatedColl);
  let totalDebt: Amount = u128.add(activeDebt, closedDebt); 

  let TCR: u128 = _computeICR (totalCollateral, totalDebt, price); 
  
  return TCR < u128.from(CCR);
}
