
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
 * their deposit will have a computed NEAR gain based on a variable in the poolMgr. 
 * But their actual withdrawable NEAR is in the balance of the StabilityPool contract.
 */

import { Context, u128, storage, math, context } from "near-sdk-as";
import { 
  PCT, MCR, CCR, LOGIC_CONTRACT,
  _computeICR, min, Trove, Troves, 
  TroveOwners, AccountId, Amount, Status, 
  TroveMgr, PoolMgr, LiquidationValues
} from "./model";
import {
  emitTroveLiquidatedEvent,
  emitTroveCreatedEvent,
  emitTroveUpdatedEvent
} from './events'
import { 
  ERR_NEW_ICR_UNDER_TCR,
  ERR_AMT_BELOW_ZERO,
  ERR_ICR_BELOW_MCR,
  ERR_CCR_BELOW_TCR,
  ERR_NEW_TCR_WORSE,
  ERR_OVERDRAW_NEAR,
  ERR_CDP_INACTIVE,
  ERR_IN_RECOVERY,
  ERR_REPAY_OVER,
  ERR_REDEEM_OVER,  
} from "./errors";

let troveMgr: TroveMgr;
let poolMgr: PoolMgr;

export function init(): void {
  troveMgr = new TroveMgr();
  poolMgr = new PoolMgr();
}

// ----------------------------------------------------------------------------
// Getters for UI
// ----------------------------------------------------------------------------

export function getTotalFees(): Amount {
  return troveMgr.getTotalFees();
}
export function getPrice(): u128 {
  if (storage.contains("price"))
    return storage.getSome<u128>("price");
  else
    return u128.One;
}
export function setPrice( newPrice: u128 ): void {  
  storage.set<u128>("price", newPrice);
}
export function getTroves(): Map<AccountId, Trove> {
  let map: Map<AccountId, Trove> = new Map<AccountId, Trove>();
  for ( let i = 0; i < TroveOwners.length; i++ ) {
    let owner: AccountId = TroveOwners[i];
    map.set( owner, Troves.getSome(owner) );
  }
  return map;
}
export function getCDP( owner_id: AccountId ): Trove {
  return troveMgr.getTrove(owner_id);
}
export function getSPdebt(): Amount {
  return poolMgr.getStableLQD();
}
export function getSPdep( owner: AccountId ): Amount {
  return poolMgr.getStabilityPoolDeposit(owner);
}
// get a user’s pending NEAR gain in stability deposit?
export function getSPgains( owner: AccountId ): Amount {
  return poolMgr.getStabilityPoolNEARgain(owner);
}
export function getTotalCollat(): Amount {
  return poolMgr.getActiveLQD();
}
export function getTotalDebt(): Amount {
  return poolMgr.getActiveNEAR();
}

// ----------------------------------------------------------------------------
// Contract actions
// ----------------------------------------------------------------------------

export function openTrove( _LQDAmt: Amount ): void { // payable
  // Context.contractName is the currently running contract
  let val = Context.attachedDeposit;
  let price = getPrice();
  let ICR = _computeICR( val, _LQDAmt, price );  
  _requireNonZeroAmt(_LQDAmt);
  _requireICRisAboveMCR(ICR);
  if (!_checkRecoveryMode())
    _requireNewTCRisAboveCCR( price, val, 1, _LQDAmt, 1 ); 
  else
    _requireNewICRisAboveTCR(ICR);
  let fee = _calculateFee(_LQDAmt);
  // signer, who started the promise chain
  // who came before you in the promise chain 
  let usr = Context.predecessor; 
  troveMgr.setStatus( usr, 1 ); // creates Trove
  troveMgr.increaseCollat( usr, val );
  troveMgr.mintDebt( usr, _LQDAmt, fee );

  let arrayIndex = troveMgr.addOwnerToArray(usr);
  // Tell PM to move the NEAR to the Active Pool, and mint LQD to the borrower
  poolMgr.addCollat(val);
  poolMgr.withdrawLQD( usr, _LQDAmt );
  emitTroveCreatedEvent( usr, arrayIndex );
  emitTroveUpdatedEvent( usr, _LQDAmt, val, 
  troveMgr.updateStakes( usr, poolMgr.getTotalNEAR() ) );
}

export function closeTrove(): void {
  let usr = Context.predecessor; 
  let status = troveMgr.getStatus(usr);
  _requireTroveActive(status);
  _requireNotInRecoveryMode();
  
  let debt  = troveMgr.getDebt(usr);
  let collat = troveMgr.getCollat(usr);

  troveMgr.close(usr);
  // Tell PM to burn the debt from the user's balance, and send the collateral back to the user
  poolMgr.repayLQD( usr, debt );
  poolMgr.withdrawCollat( usr, collat );
  emitTroveUpdatedEvent( usr, u128.Zero, u128.Zero, u128.Zero );
}

/* 
 * If NEAR is sent, the operation is considered 
 * as an increase in collateral, and the first parameter 
 * _collWithdrawal is ignored  
*/
export function adjustLoan( _collatWithdrawal: Amount, _debtChange: Amount, _isDebtIncrease: i32 ): void { // payable
  let usr = Context.predecessor;
  let val = Context.attachedDeposit;
  let price = getPrice();
  var collatChange = _collatWithdrawal;
  var isCollatIncrease = 0;
  if (val != u128.Zero) {
    collatChange = val;
    isCollatIncrease = 1;
  } else if (_isDebtIncrease) {
    _requireNotInRecoveryMode();
  }
  _requireTroveActive(troveMgr.getStatus(usr));
  let debt = troveMgr.getDebt(usr);
  let collat = troveMgr.getCollat(usr);
  let newICR = _getNewICRFromTroveChange(
    collat, debt, price, 
    collatChange, isCollatIncrease, 
    _debtChange, _isDebtIncrease
  );
  // --- Checks --- 
  if (_checkRecoveryMode())
    _requireNewICRisAboveTCR(newICR);
  else
    _requireICRisAboveMCR(newICR);  
  //  --- Effects --- 
  let newColl = _updateTroveColl( usr, collatChange, isCollatIncrease );
  let newDebt = _updateTroveDebt( usr, _debtChange, _isDebtIncrease );
  let stake = troveMgr.updateStakes( usr, poolMgr.getTotalNEAR() );
  // Close a CDP if it is empty, otherwise
  if ( newDebt == u128.Zero && newColl == u128.Zero ) {
    troveMgr.close(usr);
  } 
  _moveTokensFromAdjustment(
    usr, collatChange, isCollatIncrease, 
    _debtChange, _isDebtIncrease
  );   
  emitTroveUpdatedEvent( usr, newDebt, newColl, stake ); 
}

export function addCollat( _usr: AccountId ): void { // payable
  var isFirstCollDeposit = false;
  let val = Context.attachedDeposit;
  let status = troveMgr.getStatus(_usr);
  // If non-existent or closed, open a new Trove
  if ( status == Status.nonExistent || status == Status.closed ) {
      isFirstCollDeposit = true; 
      troveMgr.setStatus( _usr, 1 );
  }  
  // Update the Trove's collateral and stake, add to ActivePool
  let newCollat = troveMgr.increaseCollat( _usr, val );
  let stake = troveMgr.updateStakes( _usr, poolMgr.getTotalNEAR() );
  poolMgr.addCollat(val);
  var debt = u128.Zero;
  if (isFirstCollDeposit) {     
      let arrayIndex = troveMgr.addOwnerToArray(_usr);
      emitTroveCreatedEvent( _usr, arrayIndex );
  } 
  else debt = troveMgr.getDebt(_usr);
  emitTroveUpdatedEvent( _usr, debt, newCollat, stake );
}
// Withdraw collateral from a CDP
export function withdrawCollat( _amt: Amount ): void {
  _requireNonZeroAmt(_amt);
  let usr = Context.predecessor; 
  let status = troveMgr.getStatus(usr);
  _requireTroveActive(status);
  let price = getPrice();
  let debt = troveMgr.getDebt(usr);
  let collat = troveMgr.getCollat(usr);
  let newICR = _getNewICRFromTroveChange( 
    collat, debt, price, _amt, 0, u128.Zero, 0 
  ); 
  if (_checkRecoveryMode())
    _requireNewICRisAboveTCR(newICR);
  else
    _requireICRisAboveMCR(newICR);  
  // Update the CDP's coll and stake
  let newColl = troveMgr.decreaseCollat( usr, _amt );
  let stake = troveMgr.updateStakes( usr, poolMgr.getTotalNEAR() );
  // Remove _amount NEAR from ActivePool and send it to the user
  poolMgr.withdrawCollat( usr, _amt );
  emitTroveUpdatedEvent( usr, debt, newColl, stake); 
}

// Withdraw LQD tokens from a CDP: mint new LQD 
// to the owner, and increase debt accordingly
export function withdrawLQD( _LQDAmt: Amount ): void {
  _requireNonZeroAmt(_LQDAmt); 
  let usr = Context.predecessor; 
  let status = troveMgr.getStatus(usr);
  _requireTroveActive(status);

  let price = getPrice();
  let debt = troveMgr.getDebt(usr);
  let collat = troveMgr.getCollat(usr);
  let newICR: u128 = _getNewICRFromTroveChange(
    collat, debt, price, u128.Zero, 0, _LQDAmt, 1 
  );
  if ( _checkRecoveryMode() )
    _requireNewICRisAboveTCR(newICR);
  else {
    _requireICRisAboveMCR(newICR);  
    _requireNewTCRisAboveCCR( price, u128.Zero, 0, _LQDAmt, 1 ); 
  }
  let fee = _calculateFee(_LQDAmt);
  // Increase the CDP's debt
  troveMgr.mintDebt( usr, _LQDAmt, fee ); 
  // Mint the given amount of LQD to the owner's address and add them to the ActivePool
  poolMgr.withdrawLQD( usr, _LQDAmt );
  emitTroveUpdatedEvent( usr, troveMgr.getDebt(usr), collat, troveMgr.getStake(usr) ); 
}
// Repay LQD tokens to a CDP: Burn the repaid LQD tokens, and reduce the debt accordingly
export function repayLQD( _LQDAmt: Amount ): void {
  let usr = Context.predecessor; 
  let status = troveMgr.getStatus(usr);
  _requireTroveActive(status);
  let debt = troveMgr.getDebt(usr);
  _requireLQDRepaymentAllowed( debt, _LQDAmt );
  // Update the CDP's debt
  troveMgr.burnDebt(usr, _LQDAmt);
  // Burn the received amount of LQD from the user's balance, and remove it from the ActivePool
  poolMgr.repayLQD( usr, _LQDAmt );
  emitTroveUpdatedEvent( usr, troveMgr.getDebt(usr), 
  troveMgr.getCollat(usr), troveMgr.getStake(usr) ); 
}

// deposit stablecoins to Stability Pool
export function provideToSP( _amount: Amount ): void {
  let usr: AccountId = Context.predecessor;
  poolMgr.depositStableLQD( usr, _amount );
  // TODO
  // emit UserDepositChanged(user, newDeposit); 
}
// withdraws the user's accumulated collateral and debt gains from the Stability Pool to their address
// should allow withdrawal of ETH gain without touching the deposit
export function withdrawFromSP( _amount: Amount ): void {
  let usr = Context.predecessor;
  poolMgr.withdrawStableLQD( usr, _amount );
  
  // TODO
  // emit GainsWithdrawn(user, gain, loss);
  // emit UserDepositChanged(user, remainder);
}

export function redeemCollateral( _LQDamt: Amount ): void {
  let price = getPrice();
  var currentUser: AccountId;
  var remainingLQD = _LQDamt;
  
  for ( let i = 0; i < TroveOwners.length; i++ ) {
    if ( remainingLQD == u128.Zero )
      break;
    if ( troveMgr.getCurrentICR( currentUser, price ) < MCR ) 
      continue;
    
    currentUser = TroveOwners[i];
    
    let redeemed: string[] = troveMgr.redeemCollateralFrom( currentUser, 
      poolMgr.getActiveNEAR(), poolMgr.getActiveLQD(), 
      remainingLQD, price ).split(",");

    let redeemedDebt = u128.fromString(redeemed[0]);
    let redeemedColl = u128.fromString(redeemed[1]);
    
    remainingLQD = u128.sub( remainingLQD, redeemedDebt );  
    poolMgr.redeemCollateral( currentUser, redeemedDebt, redeemedColl );
  }
  assert( remainingLQD == u128.Zero, ERR_REDEEM_OVER );
} 

export function liquidate( _user: AccountId ): void {
  _requireTroveActive( troveMgr.getStatus(_user) );

  let price = getPrice();
  let stableLQD: Amount = poolMgr.getStableLQD();
  let recoveryMode: bool = _checkRecoveryMode();
  
  let ICR = troveMgr.getCurrentICR( _user, price );
  var V: LiquidationValues;

  if ( recoveryMode == 0 ) {
    V = _liquidateNormalMode( _user, ICR, price, stableLQD );
  } else {
    V = _liquidateRecoveryMode( _user, ICR, price, stableLQD );
  }  
  poolMgr.offset( V.debtToOffset, V.collatToSendToSP );

  _redistributeDebtAndColl( V.debtToRedistribute, V.collatToRedistribute );
}

// ----------------------------------------------------------------------------
// Assertion functions
// ----------------------------------------------------------------------------

function _requireNewICRisAboveTCR( ICR: u128 ): void {
  assert( ICR > _getTCR(), ERR_NEW_ICR_UNDER_TCR );
}
function _requireNewTCRisAboveCCR( _price: u128,
  _collChange: Amount, _isCollIncrease: i32, 
  _debtChange: Amount, _isDebtIncrease: i32 ): void {
  let newTCR = _getNewTCRFromTroveChange(
    _collChange, _isCollIncrease, 
    _debtChange, _isDebtIncrease, _price );
  assert( newTCR >= CCR, ERR_CCR_BELOW_TCR );
}
function _requireLQDRepaymentAllowed( _currentDebt: Amount, _debtRepayment: Amount ): void {
  assert( _debtRepayment <= _currentDebt, ERR_REPAY_OVER );
}
function _requireNonZeroAmt( _amt: Amount ): void {
  assert( _amt > u128.Zero, ERR_AMT_BELOW_ZERO );
}
function _requireTroveActive( status: Status ): void {
  assert( status == Status.active, ERR_CDP_INACTIVE );
}
function _requireNotInRecoveryMode(): void {
  assert( !_checkRecoveryMode(), ERR_IN_RECOVERY );
}
function _requireICRisAboveMCR( _newICR: u128 ): void {
  assert( _newICR >= MCR, ERR_ICR_BELOW_MCR );
}
// function _getUSDValue(_coll: u128, _price: u128): u128 {
//   var usdValue = u128.mul(_coll, _price);
//   return u128.div(usdValue, PCT);
// }
// function _requireCollatAmtWithdrawable( _currentColl: u128, _collatWithdrawal: u128, _price: u128 ): void {
//   if ( _collWithdrawal > u128.Zero ) {
//       assert( _collWithdrawal <= _currentColl, ERR_OVERDRAW_NEAR );
//       let newColl = u128.sub(_currentColl, _collWithdrawal);
//       assert(_getUSDValue(newColl, _price) > u128.Zero, "Can't leave Trove empty");
//   }
// }
// function _requireNewTCRisAboveOldTCR(
//   _collChange: Amount, _isCollIncrease: i32, 
//   _debtChange: Amount, _isDebtIncrease: i32, _price: u128): void {
//   let oldTCR = _getTCR();
//   let newTCR = _getNewTCRFromTroveChange(
//     _collChange, _isCollIncrease, 
//     _debtChange, _isDebtIncrease, _price );
//   assert( newTCR >= oldTCR, ERR_NEW_TCR_WORSE );
// }

// ----------------------------------------------------------------------------
// Helper functions
// ----------------------------------------------------------------------------

function _getLiquidationVals( _debt: Amount, _coll: Amount, _stableLQD: Amount ): LiquidationValues {
  var V: LiquidationValues;
  // Offset as much debt & collateral as possible against the Stability Pool, and redistribute the remainder
  if ( _stableLQD > u128.Zero ) {
    /* 
     * If the debt is larger than the deposited CLV, offset an 
     * amount of debt equal to the latter, and send collateral
     * in proportion to the cancelled debt 
    */
    V.debtToOffset = min( _debt, _stableLQD );
    V.collatToSendToSP = u128.div( u128.mul( _coll, V.debtToOffset ), _debt );
    V.debtToRedistribute = u128.sub( _debt, V.debtToOffset );
    V.collatToRedistribute = u128.sub( _coll, V.collatToSendToSP );
  } 
  else {
    V.debtToOffset = u128.Zero;
    V.collatToSendToSP = u128.Zero;
    V.debtToRedistribute = _debt;
    V.collatToRedistribute = _coll;
  }
  return V;
}

function _liquidateNormalMode( _usr: AccountId, _ICR: u128, _price: u128, _stableLQD: Amount ): LiquidationValues {
  var V: LiquidationValues;
  
  // If ICR >= MCR, or is last trove, don't liquidate 
  if ( _ICR >= MCR || TroveOwners.length <= 1 ) return V;
  
  var debt = troveMgr.getDebt(_usr);
  var collat = troveMgr.getCollat(_usr);
  
  troveMgr.removeStake(_usr); 
  V = _getLiquidationVals( debt, collat, _stableLQD );  
  troveMgr.close(_usr);

  emitTroveLiquidatedEvent( _usr, debt, collat, "NormalMode" );
  return V;
}

function _liquidateRecoveryMode( _usr: AccountId, _ICR: u128, _price: u128, _stableLQD: Amount ): LiquidationValues {
  var V: LiquidationValues;
  var partial: string = ''; // false if the trove was fully liquidated

  // Never liquidate last trove
  if ( TroveOwners.length <= 1 ) return V;
  
  let debt = troveMgr.getDebt(_usr);
  var collat = troveMgr.getCollat(_usr);

  if ( _ICR <= PCT ) {
    troveMgr.removeStake(_usr); 

    V.debtToOffset = u128.Zero;
    V.collatToSendToSP = u128.Zero;
    
    V.debtToRedistribute = debt;
    V.collatToRedistribute = collat;
    
    troveMgr.close(_usr);
  } 
  // if 100% < ICR < MCR, offset maximumally, redistribute remainder
  else if (( _ICR > PCT ) && ( _ICR < MCR )) {
    troveMgr.removeStake(_usr); 

    V = _getLiquidationVals( debt, collat, _stableLQD );

    troveMgr.close(_usr);
  }
  /* If 110% <= ICR < 150% and there is CLV in the Stability Pool, 
     only offset it as much as possible (no redistribution) */
  else if (( _ICR >= MCR ) && ( _ICR < CCR )) {
    if (!_stableLQD) return V;
    else partial = 'partial';
    // TODO
    // _applyPendingRewards(_user);
    troveMgr.removeStake(_usr); 
    if ( debt > _stableLQD ) {
      V.debtToOffset = _stableLQD;
      let frac = u128.div(
        u128.mul( V.debtToOffset, collat ), debt
      );
      V.collatToSendToSP = frac;
      V.collatToRedistribute = u128.Zero;
      V.debtToRedistribute = u128.Zero;

      //partial new debt and coll
      debt = u128.sub( debt, _stableLQD );
      debt = u128.sub( collat, frac );

      troveMgr.burnDebt( _usr, _stableLQD );
      troveMgr.decreaseCollat( _usr, frac );
      
      // TODO
      //updateStakeAndTotalStakes(_user);  
    } 
    else if ( debt <= _stableLQD ) {
      V.debtToOffset = debt;
      V.collatToSendToSP = collat;
      V.debtToRedistribute = u128.Zero;
      V.collatToRedistribute = u128.Zero;
    }
    troveMgr.close(_usr);
  }
  emitTroveLiquidatedEvent(_usr, debt, collat, "RecoveryMode");

  return V;
}

function _redistributeDebtAndColl( _debt: Amount, _coll: Amount ): void { 
  if (!_debt) { return; }

  let LQDInPool: Amount = poolMgr.getStableLQD();
  let debtRemainder: Amount;
  let collRemainder: Amount;
  
  // Offset as much debt & collateral as possible against the Stability Pool
  if ( LQDInPool > u128.Zero ) { 
    // Transfer the debt & coll from the Active Pool to the Default Pool
    poolMgr.stablePool.increaseLQD(_debt);
    poolMgr.stablePool.receiveNEAR(_coll);
    poolMgr.activePool.decreaseLQD(_debt);
    poolMgr.activePool.recapNEAR(_coll);
    let debtToOffset = min(_debt, LQDInPool);  
    
    // Collateral to be added in proportion to the debt that is cancelled 
    var collToAdd = u128.mul(_coll, debtToOffset);
    collToAdd = u128.div(collToAdd, _debt);

    // Cancel the liquidated LQD debt with the LQD in the stability pool
    poolMgr.stablePool.decreaseLQD(debtToOffset); 
    poolMgr.repayLQD(LOGIC_CONTRACT, debtToOffset); 
   
    // Send NEAR from Active Pool to Stability Pool
    poolMgr.activePool.recapNEAR(collToAdd);  
    poolMgr.stablePool.receiveNEAR(collToAdd);  

    debtRemainder = u128.sub(_debt, debtToOffset);
    collRemainder = u128.sub(_coll, collToAdd);
  } else {
    debtRemainder = _debt;
    collRemainder = _coll;
  }
  // Transfer the debt & coll from the Active Pool to the Default Pool
  poolMgr.activePool.decreaseLQD(debtRemainder);
  poolMgr.activePool.recapNEAR(collRemainder);
  
  // TODO assign to everyone
  // As we are redistributing all the debt, 
  // but not all the collateral (0.5% goes to liquidator), 
  // the TCR slightly decreases
}

function _calculateFee( _amt: Amount ): Amount {
  let totalLQD = poolMgr.getTotalLQD();
  if ( totalLQD > u128.One ) {
    return u128.mul( _amt, // TODO better fee formula
      u128.div( _amt, poolMgr.getTotalLQD() )
    );
  } 
  return u128.Zero;
}

// Update trove's coll and debt based on whether they increase or decrease
function _updateTroveColl( _usr: AccountId, _collatChange: Amount, _isCollatIncrease: i32 ): Amount {
  if (_isCollatIncrease)
    return troveMgr.increaseCollat( _usr, _collatChange );
  return troveMgr.decreaseCollat( _usr, _collatChange );
}

// Update trove's coll and debt based on whether they increase or decrease
function _updateTroveDebt( _usr: AccountId, _debtChange: Amount, _isDebtIncrease: i32 ): Amount {
  if (_isDebtIncrease) {
    var fee: Amount = u128.Zero;
    if (poolMgr.getTotalLQD() > u128.One)
      fee = u128.mul( _debtChange, u128.div(
                      _debtChange, poolMgr.getTotalLQD()
            )); 
    troveMgr.mintDebt( _usr, _debtChange, fee );
  } else
    troveMgr.burnDebt( _usr, _debtChange );
  return troveMgr.getDebt(_usr);
}

function _moveTokensFromAdjustment( _usr: AccountId, 
  _collatChange: Amount, _isCollatIncrease: i32,
  _debtChange: Amount, _isDebtIncrease: i32 ): void {
  if ( !_isDebtIncrease )
    poolMgr.repayLQD(_usr, _debtChange);
  else
    poolMgr.withdrawLQD(_usr, _debtChange);
  if ( !_isCollatIncrease )
    poolMgr.withdrawCollat( _usr, _collatChange );
  else
    poolMgr.addCollat(_collatChange);
}

// Compute the new collateral ratio, considering the change in coll and debt. Assumes 0 pending rewards.
function _getNewICRFromTroveChange(
  _collat: Amount, _debt: Amount, _price: u128,
  _collatChange: Amount, _isCollatIncrease: i32,
  _debtChange: Amount, _isDebtIncrease: i32 ): u128 {
    let newCollat: Amount;
    let newDebt: Amount;
    if (!_isCollatIncrease)
      newCollat = u128.sub( _collat, _collatChange );  
    else
      newCollat = u128.add( _collat, _collatChange );
    if (!_isDebtIncrease)
      newDebt = u128.sub( _debt, _debtChange );
    else
      newDebt = u128.add( _debt, _debtChange );
    return _computeICR( newCollat, newDebt, _price );
}

function _getNewTCRFromTroveChange(
  _collChange: Amount, _isCollIncrease: i32, 
  _debtChange: Amount, _isDebtIncrease: i32, _price: u128 ): u128 {
  
  var totalColl = poolMgr.getTotalNEAR();
  var totalDebt = poolMgr.getTotalLQD();
 
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
  return _computeICR(totalColl, totalDebt, _price);
}

// Return the total collateral ratio (TCR) of the system, based on the most recent oracle price
function _getTCR(): u128 {
  let price = getPrice();

  let activeColl = poolMgr.getActiveNEAR();
  let activeDebt = poolMgr.getActiveLQD();
  
  return _computeICR(activeColl, activeDebt, price); 
}

function _checkRecoveryMode(): bool {
  let price = getPrice();

  let activeColl = poolMgr.getActiveNEAR();
  let activeDebt = poolMgr.getActiveLQD();
  
  let TCR = _computeICR(activeColl, activeDebt, price); 
  
  return TCR < CCR;
}
