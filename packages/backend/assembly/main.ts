/*
 * Flow of NEAR:
 * Lives in three Pools: the ActivePool, the DefaultPool and the StabilityPool. 
 * When an operation is made, NEAR is transferred in one of three ways:
  * From a user to a Pool
  * From a Pool to a user
  * From one Pool to another Pool
 * 
 * NEAR is recorded on an individual level, but stored in aggregate in a Pool.  
 * An active trove with collateral and debt has a struct in the CDPManager that
 * stores its collateral value in a u128, but its actual NEAR is in the balance
 * the contract. 
 * 
 * Likewise, a StabilityPool depositor who has earned some collateral gain from
 * their deposit will have a computed NEAR gain based on a variable in the PoolManager. 
 * But their actual withdrawable NEAR is in the balance of the StabilityPool contract.
 */
import { Context, u128, storage, math } from "near-sdk-as";
import { 
  PCT, MCR, CCR, LOGIC_CONTRACT,
  _computeICR, min, CDP, CDPs, 
  CDPOwners, AccountId, Amount, 
  TroveMgr, PoolMgr, LiquidationValues
} from "./model";
import {
  emitCDPliquidatedEvent,
  emitCDPcreatedEvent,
  emitCDPupdatedEvent
} from './events'
import { 
  ERR_AMT_BELOW_ZERO,
  ERR_ICR_BELOW_MCR,
  ERR_CCR_BELOW_TCR,
  ERR_NEW_TCR_WORSE,
  ERR_OVERDRAW_NEAR,
  ERR_CDP_INACTIVE,
  ERR_IN_RECOVERY,
  ERR_REPAY_OVER,
  ERR_REDEEM_OVER
} from "./errors";

let cdpManager: TroveMgr;
let poolManager: PoolMgr;

export function init(): void {
  this.cdpManager = new TroveMgr();
  this.poolManager = new PoolMgr();
}

// TODO Oracle Cross Contract Call
// https://www.crowdcast.io/e/hacktherainbow/register?session=14
// https://github.com/smartcontractkit/near-protocol-contracts
export function getPrice(): u128 {
  if (storage.contains("price"))
    return storage.getSome<u128>("price");
  else 
    return u128.Zero;
}
export function setPrice(newPrice: u128): void {  
  storage.set<u128>("price", newPrice);
}

export function getCDPs(): Map<AccountId, CDP> {
  let map: Map<AccountId, CDP> = new Map<AccountId, CDP>();
  for (let i = 0; i < CDPOwners.length; i++) {
    let owner: AccountId = CDPOwners[i];
    map.set(owner, CDPs.getSome(owner));
  }
  return map;
}
export function getCDP(owner_id: AccountId): CDP {
  return CDPs.get(owner_id, new CDP()) as CDP;
}
export function getSPdebt(): Amount {
  return this.poolManager.getStableLQD();
}
export function getSPdep(owner: AccountId): Amount {
  return this.poolManager.getStabilityPoolDeposit(owner);
}
// get a user’s pending NEAR gain in stability deposit?
export function getSPgains(owner: AccountId): Amount {
  return this.poolManager.getStabilityPoolNEARgain(owner);
}
export function getTotalColl(): Amount {
  return this.poolManager.getActiveLQD();
}
export function getTotalDebt(): Amount {
  return this.poolManager.getActiveNEAR();
}

export function openLoan(_LQDAmount: Amount): void { // payable
  let user: AccountId = Context.predecessor; 
  let value: Amount = Context.attachedDeposit;
  let price = getPrice();

  let ICR: u128 = _computeICR(value, _LQDAmount, price);  

  if (_LQDAmount > u128.Zero) {
    _requireICRisAboveMCR(ICR);
    
    if (!_checkRecoveryMode)
      _requireNewTCRisAboveCCR(value, 1, _LQDAmount, 1, price); 
    //else
    //  assert(!_isICRovereqTCR(ICR), ERR_NEW_TCR_WORSE);
  }
  var fee: Amount = u128.Zero;
  if (poolManager.getTotalLQD() > u128.One) {
    fee = u128.mul( _LQDAmount, u128.div(
            _LQDAmount, poolManager.getTotalLQD()
          ));
  }  
  // Update loan properties
  cdpManager.setCDPStatus(user, 1);
  cdpManager.increaseCDPColl(user, value);
  cdpManager.mintDebt(user, _LQDAmount, fee);
  
  let stake: Amount = cdpManager.updateStakeAndTotalStakes(user, poolManager.getTotalNEAR()); 

  let arrayIndex = cdpManager.addCDPOwnerToArray(user);
  emitCDPcreatedEvent(user, arrayIndex);
  
  // Tell PM to move the NEAR to the Active Pool, and mint LQD to the borrower
  poolManager.addColl(value); 
  poolManager.withdrawLQD(user, _LQDAmount); 
 
  emitCDPupdatedEvent(user, _LQDAmount, value, stake); 
}

export function addColl(_user: AccountId): void { // payable
  var isFirstCollDeposit: bool = false;
  let value: Amount = Context.attachedDeposit;
  let price = getPrice();
  let status: u16 = cdpManager.getCDPStatus(_user);

  // If non-existent or closed, open a new trove
  if (status == 0 || status == 2 ) {
      isFirstCollDeposit = true; 
      cdpManager.setCDPStatus(_user, 1);
  }  
  // Update the CDP's coll and stake
  let newColl: Amount = cdpManager.increaseCDPColl(_user, value);
  let stake: u128 = cdpManager.updateStakeAndTotalStakes(_user, poolManager.getTotalNEAR());
  
  if (isFirstCollDeposit) {     
      let arrayIndex = cdpManager.addCDPOwnerToArray(_user);
      emitCDPcreatedEvent(_user, arrayIndex);
  }
  // Tell PM to move the NEAR to the Active Pool
  poolManager.addColl(value);

  let debt: Amount = cdpManager.getCDPDebt(_user);
  emitCDPupdatedEvent(_user, debt, newColl, stake);
}

// Withdraw collateral from a CDP
export function withdrawColl(_amount: Amount): void {
  let user: AccountId = Context.predecessor; 
  let status = cdpManager.getCDPStatus(user);

  _requireCDPisActive(status);
  _requireNotInRecoveryMode();
 
  let price = getPrice();
  let debt: Amount = cdpManager.getCDPDebt(user);
  let coll: Amount = cdpManager.getCDPColl(user);
  
  _requireCollAmountIsWithdrawable(coll, _amount, price);

  let newICR: u128 = _getNewICRFromTroveChange(coll, debt, price, _amount, 0, u128.Zero, 0); 
  _requireICRisAboveMCR(newICR);
  
  // Update the CDP's coll and stake
  let newColl: Amount = cdpManager.decreaseCDPColl(user, _amount);
  let stake: u128 = cdpManager.updateStakeAndTotalStakes(user, poolManager.getTotalNEAR());

  if (newColl == u128.Zero) { 
      cdpManager.closeCDP(user);  
  }

  // Remove _amount NEAR from ActivePool and send it to the user
  poolManager.withdrawColl(user, _amount);

  emitCDPupdatedEvent(user, debt, newColl, stake); 
}

// Withdraw LQD tokens from a CDP: mint new LQD to the owner, and increase the debt accordingly
export function withdrawLQD(_amount: Amount): void {
  let user: AccountId = Context.predecessor; 
  let status: u16 = cdpManager.getCDPStatus(user);

  _requireCDPisActive(status);
  _requireNonZeroAmount(_amount); 
  _requireNotInRecoveryMode();
  
  let price = getPrice();

  let debt: Amount = cdpManager.getCDPDebt(user);
  let coll: Amount = cdpManager.getCDPColl(user);
  
  let newICR: u128 = _getNewICRFromTroveChange(coll, debt, price, u128.Zero, 0, _amount, 1);
  _requireICRisAboveMCR(newICR);

  _requireNewTCRisAboveCCR(u128.Zero, 0, _amount, 1, price); 
  
  var fee: Amount = u128.Zero;
  if (poolManager.getTotalLQD() > u128.One) {
    fee = u128.mul(
      _amount, u128.div( _amount, poolManager.getTotalLQD())
    ); 
  }
  // Increase the CDP's debt
  let newDebt: Amount = cdpManager.mintDebt(user, _amount, fee);
 
  // Mint the given amount of LQD to the owner's address and add them to the ActivePool
  poolManager.withdrawLQD(user, _amount);
  
  let stake: u128 = cdpManager.getCDPStake(user);
  emitCDPupdatedEvent(user, newDebt, coll, stake); 
}

// Repay LQD tokens to a CDP: Burn the repaid LQD tokens, and reduce the debt accordingly
export function repayLQD(_amount: u128): void {
  let user: AccountId = Context.predecessor; 
  let status: u16 = cdpManager.getCDPStatus(user);
  _requireCDPisActive(status);

  let debt: Amount = cdpManager.getCDPDebt(user);
  _requireLQDRepaymentAllowed(debt, _amount);
  
  // Update the CDP's debt
  let newDebt: Amount = cdpManager.burnDebt(user, _amount);
  // Burn the received amount of LQD from the user's balance, and remove it from the ActivePool
  poolManager.repayLQD(user, _amount);
  
  let coll: Amount = cdpManager.getCDPColl(user);
  let stake: u128 = cdpManager.getCDPStake(user);
  emitCDPupdatedEvent(user, newDebt, coll, stake); 
}

export function closeLoan(): void {
  let user: AccountId = Context.predecessor; 
  let status: u16 = cdpManager.getCDPStatus(user);
  _requireCDPisActive(status);
  _requireNotInRecoveryMode();
  
  let debt: Amount = cdpManager.getCDPDebt(user);
  let coll: Amount = cdpManager.getCDPColl(user);

  cdpManager.closeCDP(user);

  // Tell PM to burn the debt from the user's balance, and send the collateral back to the user
  poolManager.repayLQD(user, debt);
  poolManager.withdrawColl(user, coll);

  emitCDPupdatedEvent(user, u128.Zero, u128.Zero, u128.Zero);
}

/* 
 * If NEAR is sent, the operation is considered 
 * as an increase in collateral, and the first parameter 
 * _collWithdrawal is ignored  
*/
export function adjustLoan(_collWithdrawal: Amount, _debtChange: u128, _isDebtIncrease: i32): void { // payable
  let user: AccountId = Context.predecessor;
  let value: Amount = Context.attachedDeposit;
  let price = getPrice();
  var collChange: u128 = _collWithdrawal;
  var isCollIncrease = 0;
  if (value != u128.Zero) {
    collChange = value;
    isCollIncrease = 1;
  } else if (_isDebtIncrease) {
    _requireNotInRecoveryMode();
  }
  _requireCDPisActive(cdpManager.getCDPStatus(user));
  let debt: Amount = cdpManager.getCDPDebt(user);
  let coll: Amount = cdpManager.getCDPColl(user);
  let newICR: u128 = _getNewICRFromTroveChange(coll, debt, price, collChange, isCollIncrease, _debtChange, _isDebtIncrease);
  // --- Checks --- 
  _requireICRisAboveMCR(newICR);
  _requireNewTCRisAboveCCR(collChange, isCollIncrease, _debtChange, _isDebtIncrease, price);
  _requireCollAmountIsWithdrawable(coll, _collWithdrawal, price);
  //  --- Effects --- 
  let newColl: Amount = _updateTroveColl(user, collChange, isCollIncrease);
  let newDebt: Amount = _updateTroveDebt(user, _debtChange, _isDebtIncrease);
  let stake = cdpManager.updateStakeAndTotalStakes(user, poolManager.getTotalNEAR());
  // Close a CDP if it is empty, otherwise
  if (newDebt == u128.Zero && newColl == u128.Zero) {
      cdpManager.closeCDP(user);
  } 
  _moveTokensFromAdjustment(user, collChange, isCollIncrease, _debtChange, _isDebtIncrease);   
  emitCDPupdatedEvent(user, newDebt, newColl, stake); 
}

//TODO
export function redeemCollateral(_LQDamount: Amount): void {
  
  let price = getPrice();
  var currentUser: AccountId;
  var remainingLQD = _LQDamount;

  for (let i = 0; i < CDPOwners.length; i++) {
    if (remainingLQD == u128.Zero)
      break;
    if (cdpManager.getCurrentICR(currentUser, price) < MCR) 
      continue;
    currentUser = CDPOwners[i];
    let redeemed: string[] = cdpManager.redeemCollateralFromCDP(
      poolManager.getActiveNEAR(), poolManager.getActiveLQD(),
      remainingLQD, price, currentUser ).split(",");
    let redeemedDebt = u128.fromString(redeemed[0]);
    let redeemedColl = u128.fromString(redeemed[1]);
    remainingLQD = u128.sub(remainingLQD, redeemedDebt);  
    poolManager.redeemCollateral(currentUser, redeemedDebt, redeemedColl);
  }
  assert(remainingLQD == u128.Zero, ERR_REDEEM_OVER);
}

// deposit stablecoins to Stability Pool
export function provideToSP(_amount: Amount): void {
  let user: AccountId = Context.predecessor;
  poolManager.depositStableLQD(user, _amount);
  // TODO
  // emit UserDepositChanged(user, newDeposit); 
}

// withdraws the user's accumulated collateral and debt gains from the Stability Pool to their address
export function withdrawFromSP(_amount: Amount): void {
  let user: AccountId = Context.predecessor;
  poolManager.withdrawStableLQD(user, _amount);
  
  // TODO
  // emit ETHGainWithdrawn(user, ETHGain, CLVLoss);
  // emit UserDepositChanged(user, CLVremainder);
} 

export function liquidate(_user: AccountId): void {
  _requireCDPisActive(cdpManager.getCDPStatus(_user));

  let price = getPrice();
  let stableLQD: Amount = poolManager.getStableLQD();
  let recoveryMode: bool = _checkRecoveryMode();
  
  let ICR = cdpManager.getCurrentICR(_user, price);
  var V: LiquidationValues;

  if ( !recoveryMode ) {
    V = _liquidateNormalMode(_user, ICR, price, stableLQD);
  } else {
    V = _liquidateRecoveryMode(_user, ICR, price, stableLQD);
  }  
  poolManager.offset(V.debtToOffset, V.collToSendToSP);
  _redistributeDebtAndColl(V.debtToRedistribute, V.collToRedistribute);
}


// ----------------------------------------------------------------------------
// Helper functions
// ----------------------------------------------------------------------------

// TODO
// function _applyPendingRewards(_user: AccountId): void {
//   if (cdpManager.hasPendingGains(_user)) { 
//     _requireCDPisActive(cdpManager.getCDPStatus(_user));
//     let pendingNEAReward = cdpManager.getPendingCollateralGain(_user);
//     let pendingLQDebtPenalty = cdpManager.getPendingLQDebtPenalty(_user);  
//     // Apply pending rewards to trove's state
//     cdpManager.increaseCDPColl(_user, pendingNEAReward);
//     cdpManager.mintDebt(_user, pendingLQDebtPenalty, u128.Zero);
//   }
// }

function _getLiquidationVals( _debt: Amount, _coll: Amount, _stableLQD: Amount): LiquidationValues {
  var V: LiquidationValues;
  // Offset as much debt & collateral as possible against the Stability Pool, and redistribute the remainder
  if ( _stableLQD > u128.Zero ) {
    /* 
     * If the debt is larger than the deposited CLV, offset an 
     * amount of debt equal to the latter, and send collateral
     * in proportion to the cancelled debt 
    */
    V.debtToOffset = min( _debt, _stableLQD );
    V.collToSendToSP = u128.div( u128.mul( _coll, V.debtToOffset ), _debt );
    
    V.debtToRedistribute = u128.sub( _debt, V.debtToOffset );
    V.collToRedistribute = u128.sub( _coll, V.collToSendToSP );
  } 
  else {
    V.debtToOffset = u128.Zero;
    V.collToSendToSP = u128.Zero;
    V.debtToRedistribute = _debt;
    V.collToRedistribute = _coll;
  }
  return V;
}

function _liquidateNormalMode( _user: AccountId, _ICR: u128, _price: u128, _stableLQD: Amount ): LiquidationValues {
  var V: LiquidationValues;
  
  // If ICR >= MCR, or is last trove, don't liquidate 
  if ( _ICR >= MCR || CDPOwners.length <= 1 ) return V;
  
  var cdpDebt = cdpManager.getCDPDebt(_user);
  var cdpColl = cdpManager.getCDPColl(_user);
  
  cdpManager.removeStake(_user); 
  V = _getLiquidationVals(cdpDebt, cdpColl, _stableLQD);  
  cdpManager.closeCDP(_user);
  emitCDPliquidatedEvent(_user, cdpDebt, cdpColl, "NormalMode");
  return V;
}

function _liquidateRecoveryMode( _user: AccountId, _ICR: u128, _price: u128, _stableLQD: Amount ): LiquidationValues {
  var V: LiquidationValues;
  var partial: string = ''; // false if the trove was fully liquidated

  // Never liquidate last trove
  if ( CDPOwners.length <= 1 ) return V;
  
  let cdpDebt = cdpManager.getCDPDebt(_user);
  var cdpColl = cdpManager.getCDPColl(_user);

  if ( _ICR <= PCT ) {
    cdpManager.removeStake(_user); 

    V.debtToOffset = u128.Zero;
    V.collToSendToSP = u128.Zero;
    
    V.debtToRedistribute = cdpDebt;
    V.collToRedistribute = cdpColl;
    
    cdpManager.closeCDP(_user);
  } 
  // if 100% < ICR < MCR, offset as much as possible, and redistribute the remainder
  else if ( (_ICR > PCT) && (_ICR < MCR) ) {
    cdpManager.removeStake(_user); 

    V = _getLiquidationVals(cdpDebt, cdpColl, _stableLQD);

    cdpManager.closeCDP(_user);
  }
  /* If 110% <= ICR < 150% and there is CLV in the Stability Pool, 
     only offset it as much as possible (no redistribution) */
  else if ( (_ICR >= MCR) && (_ICR < CCR) ) {
    if (!_stableLQD) return V;
    else partial = 'partial';
    // TODO
    // _applyPendingRewards(_user);
    cdpManager.removeStake(_user); 
    if (cdpDebt > _stableLQD) {
      V.debtToOffset = _stableLQD;
      let frac = u128.div(u128.mul(V.debtToOffset, cdpColl), cdpDebt);
      
      V.collToSendToSP = frac;
      V.collToRedistribute = u128.Zero;
      V.debtToRedistribute = u128.Zero;

      //partial new debt and coll
      cdpDebt = u128.sub(cdpDebt, _stableLQD);
      cdpColl = u128.sub(cdpColl, frac);

      cdpManager.burnDebt(_user, _stableLQD);
      cdpManager.decreaseCDPColl(_user, frac);
      
      // TODO
      //updateStakeAndTotalStakes(_user);  
    } 
    else if (cdpDebt <= _stableLQD) {
      V.debtToOffset = cdpDebt;
      V.collToSendToSP = cdpColl;
      V.debtToRedistribute = u128.Zero;
      V.collToRedistribute = u128.Zero;
    }
    cdpManager.closeCDP(_user);
  }
  emitCDPliquidatedEvent(_user, cdpDebt, cdpColl, "RecoveryMode");

  return V;
}

function _redistributeDebtAndColl(_debt: Amount, _coll: Amount): void {
  if (!_debt) { return; }

  let LQDInPool: Amount = poolManager.getStableLQD();
  let debtRemainder: Amount;
  let collRemainder: Amount;
  
  // Offset as much debt & collateral as possible against the Stability Pool
  if (LQDInPool > u128.Zero) { 
    // Transfer the debt & coll from the Active Pool to the Default Pool
    poolManager.stablePool.increaseLQD(_debt);
    poolManager.stablePool.receiveNEAR(_coll);
    poolManager.activePool.decreaseLQD(_debt);
    poolManager.activePool.recapNEAR(_coll);
    let debtToOffset = min(_debt, LQDInPool);  
    
    // Collateral to be added in proportion to the debt that is cancelled 
    var collToAdd = u128.mul(_coll, debtToOffset);
    collToAdd = u128.div(collToAdd, _debt);

    // Cancel the liquidated LQD debt with the LQD in the stability pool
    poolManager.stablePool.decreaseLQD(debtToOffset); 
    poolManager.repayLQD(LOGIC_CONTRACT, debtToOffset); 
   
    // Send NEAR from Active Pool to Stability Pool
    poolManager.activePool.recapNEAR(collToAdd);  
    poolManager.stablePool.receiveNEAR(collToAdd);  

    debtRemainder = u128.sub(_debt, debtToOffset);
    collRemainder = u128.sub(_coll, collToAdd);
  } else {
    debtRemainder = _debt;
    collRemainder = _coll;
  }
  // Transfer the debt & coll from the Active Pool to the Default Pool
  poolManager.activePool.decreaseLQD(debtRemainder);
  poolManager.activePool.recapNEAR(collRemainder);
  
  // TODO assign to everyone
  // As we are redistributing all the debt, 
  // but not all the collateral (0.5% goes to liquidator), 
  // the TCR slightly decreases
}

function _getUSDValue(_coll: u128, _price: u128): u128 {
  var usdValue = u128.mul(_coll, _price);
  return u128.div(usdValue, PCT);
}

function _requireNonZeroAmount(_amount: u128): void {
  assert(_amount > u128.Zero, ERR_AMT_BELOW_ZERO);
}

function _requireCollAmountIsWithdrawable(_currentColl: u128, _collWithdrawal: u128, _price: u128): void {
  if (_collWithdrawal > u128.Zero) {
      assert(_collWithdrawal <= _currentColl, ERR_OVERDRAW_NEAR);
      
      let newColl = u128.sub(_currentColl, _collWithdrawal);
      assert(_getUSDValue(newColl, _price) > u128.Zero, "Can't leave Trove empty");
  }
}

function _requireCDPisActive(status: u16): void {
  assert(status == 1, ERR_CDP_INACTIVE);
}

function _requireNotInRecoveryMode(): void {
  assert(_checkRecoveryMode() == false, ERR_IN_RECOVERY);
}

function _isICRovereqTCR( _ICR: u128): bool {
  return _ICR >= _getTCR();
}
function _requireICRisAboveMCR( _newICR: u128): void {
  assert(_newICR >= MCR, ERR_ICR_BELOW_MCR);
}

// Update trove's coll and debt based on whether they increase or decrease
function _updateTroveColl(_user: AccountId, _collChange: Amount, _isCollIncrease: i32 ): Amount {
  var newColl: Amount;
  if (_isCollIncrease) {
    newColl = cdpManager.increaseCDPColl(_user, _collChange);
  } else {
    newColl = cdpManager.decreaseCDPColl(_user, _collChange);
  }
  return newColl;
}

// Update trove's coll and debt based on whether they increase or decrease
function _updateTroveDebt(_user: AccountId, _debtChange: Amount, _isDebtIncrease: i32): Amount {
  var newDebt: Amount;
  if (_isDebtIncrease) {
    var fee: Amount = u128.Zero;
    if (poolManager.getTotalLQD() > u128.One) {
      fee = u128.mul( _debtChange, u128.div(
              _debtChange, poolManager.getTotalLQD()
            ));
    } newDebt = cdpManager.mintDebt(_user, _debtChange, fee);
  } else {
    newDebt = cdpManager.burnDebt(_user, _debtChange);
  }
  return newDebt;
}

function _moveTokensFromAdjustment(_user: AccountId, 
  _collChange: Amount, _isCollIncrease: i32,
  _debtChange: Amount, _isDebtIncrease: i32): void {

  if (!_isDebtIncrease){
    poolManager.repayLQD(_user, _debtChange);
  } else {
    poolManager.withdrawLQD(_user, _debtChange);
  }
  if (!_isCollIncrease) {
    poolManager.withdrawColl(_user, _collChange);
  } else {
    poolManager.addColl(_collChange);
  }
}

function _requireNewTCRisAboveCCR(
  _collChange: Amount, _isCollIncrease: i32, 
  _debtChange: Amount, _isDebtIncrease: i32, _price: u128): void {
  let newTCR = _getNewTCRFromTroveChange(_collChange, _isCollIncrease, _debtChange, _isDebtIncrease, _price);
  assert(newTCR >= CCR, ERR_CCR_BELOW_TCR);
}

function _requireNewTCRisAboveOldTCR(
  _collChange: Amount, _isCollIncrease: i32, 
  _debtChange: Amount, _isDebtIncrease: i32, _price: u128): void {
  let oldTCR = _getTCR();
  let newTCR = _getNewTCRFromTroveChange(_collChange, _isCollIncrease, _debtChange, _isDebtIncrease, _price);
  assert(newTCR >= oldTCR, ERR_NEW_TCR_WORSE);
}

function _requireLQDRepaymentAllowed(_currentDebt: Amount, _debtRepayment: Amount): void {
  assert(_debtRepayment <= _currentDebt, ERR_REPAY_OVER);
}

// Compute the new collateral ratio, considering the change in coll and debt. Assumes 0 pending rewards.
function _getNewICRFromTroveChange(
  _coll: Amount, _debt: Amount, _price: u128,
  _collChange: Amount, _isCollIncrease: i32,
  _debtChange: Amount, _isDebtIncrease: i32): u128 {

    var newColl: Amount = _coll;
    var newDebt: Amount = _debt;

    if (!_isCollIncrease) {
      newColl = u128.sub(_coll, _collChange);  
    } else {
      newColl = u128.add(_coll, _collChange);
    }
    if (!_isDebtIncrease) {
      newDebt = u128.sub(_debt, _debtChange);
    } else {
      newDebt = u128.add(_debt, _debtChange);
    }
    return _computeICR (newColl, newDebt, _price);
}

function _getNewTCRFromTroveChange(
  _collChange: Amount, _isCollIncrease: i32, 
  _debtChange: Amount, _isDebtIncrease: i32, _price: u128): u128 {
  
  var totalColl = poolManager.getTotalNEAR();
  var totalDebt = poolManager.getTotalLQD();
 
  if (!_isCollIncrease) {
    totalColl = u128.sub(totalColl, _collChange);
  } else {
    totalColl = u128.add(totalColl, _collChange);
  }
  if (!_isDebtIncrease) {
    totalDebt = u128.sub(totalDebt, _debtChange);
  } else {
    totalDebt = u128.add(totalDebt, _debtChange);
  }
  return _computeICR (totalColl, totalDebt, _price);
}


// Return the total collateral ratio (TCR) of the system, based on the most recent oracle price
function _getTCR(): u128 {
  let price = getPrice();

  let activeColl = poolManager.getActiveNEAR();
  let activeDebt = poolManager.getActiveLQD();
  
  return _computeICR(activeColl, activeDebt, price); 
}

function _checkRecoveryMode(): bool {
  let price = getPrice();

  let activeColl = poolManager.getActiveNEAR();
  let activeDebt = poolManager.getActiveLQD();
  
  let TCR = _computeICR(activeColl, activeDebt, price); 
  
  return TCR < CCR;
}
