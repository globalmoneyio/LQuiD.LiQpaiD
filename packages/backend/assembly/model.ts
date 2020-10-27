
import { ERR_USER_EXISTS, ERR_WITHDRAW_TOO_MUCH, ERR_REPAY_OVER } from './errors'
import { u128, PersistentVector, PersistentMap, 
         ContractPromiseBatch, ContractPromise } from "near-sdk-as";

export type AccountId = string
export type Amount = u128
// export type Stake = u128
// export type Ratio = u128
export const MCR = u128.from(1100000000000000000); // Minimal Collateral Ratio, 110%
// If the total system collateral (TCR) falls below the CCR, Recovery Mode is triggered.
export const CCR = u128.from(1500000000000000000); // Critical Collateral Ratio, 150% 
export const PCT = u128.from(1000000000000000000); // 100% 1e18

// TODO 
// const LINK_CONTRACT = "chainlink.globalmoney.testnet";
const TOKEN_CONTRACT = "lqd.globalmoney.testnet";
export const LOGIC_CONTRACT = "quid.globalmoney.testnet";

export enum Status { nonExistent, active, closed }
@nearBindgen
export class CDP {
  debt: Amount;
  coll: Amount;
  stake: u128;
  status: Status;
  arrayIndex: usize;
  constructor() {
    this.debt = u128.Zero;
    this.coll = u128.Zero;
    this.stake = u128.Zero;
    this.status = Status.nonExistent;
  }
}
@nearBindgen
export class LiquidationValues {
  debtToOffset: Amount;
  collToSendToSP: Amount;
  debtToRedistribute: Amount;
  collToRedistribute: Amount;
}
@nearBindgen
export class RewardSnapshot { coll: Amount; debt: Amount }
export class TokenApi {
  mint(user: AccountId, tokens: Amount): ContractPromise {
    let args: MintBurnArgs = { user, tokens };
    let promise = ContractPromise.create(TOKEN_CONTRACT, "mint", args.encode(), 100000000000000);
    return promise;
  }
  burn(user: AccountId, tokens: Amount): ContractPromise {
    let args: MintBurnArgs = { user, tokens };
    let promise = ContractPromise.create(TOKEN_CONTRACT, "burn", args.encode(), 100000000000000);
    return promise;
  }
}
/*  
 * During it's lifetime, each deposit d(0) earns a collateral gain of 
 * ( d(0) * [S - S(0)] )/P(0), where S(0) is the snapshot of S taken 
 * at the instant the deposit was made. The 'S' sums are stored in a
 * nested mapping (epoch => scale => sum), where the key is a composite
 * as follows: "scaleIndex,epochIndex"
*/

export const CDPOwners = new PersistentVector<AccountId>("owners");
export const CDPs = new PersistentMap<AccountId, CDP>("cdps");
export const stableLQDeposits = new PersistentMap<AccountId, Amount>("deposits");

@nearBindgen
export class TroveMgr { 
  // snapshot of the value of totalStakes immediately after the last liquidation
  private totalStakes: u128;  

  // fee revenue from redemptions and issuance 
  private totalFees: Amount;

  constructor() {
    this.totalStakes = u128.Zero;
    this.totalFees = u128.Zero;
  }

  payFee(_user: AccountId, _fee: Amount): void {
    let cdp = CDPs.getSome(_user);
    this.totalFees = u128.add(this.totalFees, _fee);
    cdp.debt = u128.add(cdp.debt, _fee);
    CDPs.set(_user, cdp); 
  }

  addCDPOwnerToArray(_user: AccountId): usize {
    let index = CDPOwners.length;
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
      return <u16>cdp.status;
    }
    return 0;
  }
  setCDPStatus(address: AccountId, _num: u16): void {
    var cdp: CDP;
    if (!CDPs.contains(address))
      cdp = new CDP();
    else 
      cdp = CDPs.getSome(address);
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
    let newColl = u128.add(cdp.coll, _collIncrease);
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
  mintDebt(_user: AccountId, _debtIncrease: Amount, _fee: Amount): Amount {
    let debtPlusFee = u128.add(_debtIncrease, _fee);
    this.totalFees = u128.add(this.totalFees, _fee);
    var cdp: CDP = CDPs.getSome(_user);
    let newDebt = u128.add(cdp.debt, debtPlusFee);
    cdp.debt = newDebt;
    CDPs.set(_user, cdp);
    /*
     * We don't mint the issuance fee amount
     * because the user must obtain that by 
     * selling some collateral or other means
     * to close her debt against the system
    */ let token = new TokenApi(); 
    let promise = token.mint(_user, _debtIncrease);
    promise.returnAsResult();
    return newDebt; // TODO can't return two things at the same time
  }
  // TODO another method for the cross contract call 
  burnDebt(_user: AccountId, _debtDecrease: Amount): Amount {
    var cdp: CDP = CDPs.getSome(_user);
    assert(_debtDecrease < cdp.debt, ERR_REPAY_OVER);
    let newDebt: u128 = u128.sub(cdp.debt, _debtDecrease);
    cdp.debt = newDebt;
    CDPs.set(_user, cdp);
    return newDebt;
  }

  updateStakeAndTotalStakes(_user: AccountId, _totalCollateral: Amount): u128 {
    var cdp: CDP = CDPs.getSome(_user);
    var newStake = cdp.coll; 
    
    if (_totalCollateral > u128.Zero) {
      newStake = u128.mul(cdp.coll, this.totalStakes);
      newStake = u128.div(newStake, _totalCollateral);
    }
    let oldStake = cdp.stake;
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
    let shot: RewardSnapshot = rewardSnapshots.getSome(_user);
    shot.debt = u128.Zero;
    shot.coll = u128.Zero;
    rewardSnapshots.set(_user, shot);
    this.totalStakes = u128.sub(this.totalStakes, cdp.stake);
    cdp.stake = u128.Zero;
    CDPs.set(_user, cdp);
    CDPOwners.swap_remove(<i32>cdp.arrayIndex);
  }
  // Redeem as much collateral as possible from _cdpUser's CDP in exchange for LQD up to _maxLQDamount
  redeemCollateralFromCDP(_totalColl: Amount, _totalDebt: Amount, _maxLQD: Amount, _price: u128, _user: AccountId): string {
    // Determine the remaining amount (lot) to be redeemed, capped by the entire debt of the CDP
    let cdp: CDP = CDPs.getSome(_user);
    let TCRwith = _computeICR(_totalColl, _totalDebt, _price);
    let totalCollWithout: Amount = u128.sub(_totalColl, cdp.coll);
    let totalDebtWithout: Amount = u128.sub(_totalDebt, cdp.debt);
    let TCRwithout = _computeICR(
      totalCollWithout,
      totalDebtWithout,
      _price
    );
    let TCRdelta = u128.sub(TCRwith, TCRwithout);
    let TCRshare = u128.div(TCRdelta, TCRwith);
    
    let debtToRedeem = min(u128.mul(_maxLQD, TCRshare), cdp.debt);
    let debtShare = u128.div(debtToRedeem, cdp.debt);
    let collToRedeem = u128.mul(debtShare, cdp.coll);
    
    cdp.debt = u128.sub(cdp.debt, debtToRedeem);
    cdp.coll = u128.sub(cdp.coll, collToRedeem);
    if (cdp.debt == u128.Zero && cdp.coll == u128.Zero)
      this.closeCDP(_user);
    else
      CDPs.set(_user, cdp);

    return cdp.debt.toString() + "," + cdp.coll.toString();
  }
  // Remove use's stake from the totalStakes sum, and set their stake to 0
  removeStake(_user: AccountId): void {
    let cdp: CDP = CDPs.getSome(_user);
    this.totalStakes = u128.sub(this.totalStakes, cdp.stake);
    cdp.stake = u128.Zero;
    CDPs.set(_user, cdp);
  }
  // Return the current collateral ratio (ICR) of a given CDP
  getCurrentICR(_user: AccountId, _price: u128): u128 {  
    return _computeICR(this.getCDPColl(_user), this.getCDPDebt(_user), _price);      
  }
  getCDPColl(_user: AccountId): Amount {
    return this.getCDP(_user).coll;
  }
  getCDPStake(_user: AccountId): Amount {
    return this.getCDP(_user).stake;
  }
  getCDPDebt(_user: AccountId): Amount {
    return this.getCDP(_user).debt;
  }
  getCDP(_user: AccountId): CDP {
    return CDPs.getSome(_user);
  }
}

/////////////////////////////////    Pool Stuff     /////////////////////////////////
@nearBindgen
class MintBurnArgs {
  user: AccountId;
  tokens: Amount;
}
@nearBindgen
class Pool {
  // TODO storage
  private NEAR: Amount;  // deposited collateral tracker
  private LQD: Amount;  // total outstanding CDP debt
  
  constructor() {
    this.NEAR = u128.Zero;
    this.LQD = u128.Zero;
  }
  
  receiveNEAR(_amount: Amount): void {
    this.NEAR = u128.add(this.NEAR, _amount);
  }
  recapNEAR(_amount: Amount): void {
    this.NEAR = u128.sub(this.NEAR, _amount);
  }
  sendNEAR(_account: AccountId, _amount: Amount): void {
    this.NEAR = u128.sub(this.NEAR, _amount);
    ContractPromiseBatch.create(_account).transfer(_amount);
  }
  increaseLQD(_amount: Amount): void {
    this.LQD = u128.add(this.LQD, _amount);
  }
  decreaseLQD(_amount: Amount): void {
    this.LQD = u128.sub(this.LQD, _amount);
  }
  getNEAR(): Amount {
    return this.NEAR;
  }
  getLQD(): Amount {
    return this.LQD;
  }
}

@nearBindgen
export class PoolMgr {
  activePool: Pool;
  stablePool: Pool;

  constructor() {
    this.activePool = new Pool();
    this.stablePool = new Pool();
  }
  getStableLQD(): Amount {
    return this.stablePool.getLQD();
  }
  getActiveLQD(): Amount {
    return this.activePool.getLQD();
  }
  getTotalLQD(): Amount {
    return u128.add(this.getActiveLQD(), this.getStableLQD());
  }
  getStableNEAR(): Amount {
    return this.stablePool.getNEAR();
  }
  getActiveNEAR(): Amount {
    return this.activePool.getNEAR();
  }
  getTotalNEAR(): Amount {
    return u128.add(this.activePool.getNEAR(), this.getActiveNEAR());
  }
  getDebtPenaltyPerUnitStaked(_debtToOffset: Amount, stableLQD: Amount): Amount {
    return u128.div(u128.mul(_debtToOffset, PCT), stableLQD);
  }
  getCollateralRewardPerUnitStaked(_collToAdd: Amount, stableLQD: Amount): Amount {
    return u128.div(u128.mul(_collToAdd, PCT), stableLQD); 
  }
  getStabilityPoolDeposit(_account: AccountId): Amount {  
    if (stableLQDeposits.contains(_account)) {
      return stableLQDeposits.getSome(_account);
    } return u128.Zero;
  }
  getStabilityPoolNEARgain(_account: AccountId): Amount {  
    // TODO
    let stake = u128.div(this.getStabilityPoolDeposit(_account), this.getStableLQD());

    return u128.Zero;
  }
  depositStableLQD(_account: AccountId, _LQD: Amount): void {
    this.stablePool.increaseLQD(_LQD);
    var deposit: Amount;
    if (stableLQDeposits.contains(_account)) {
      deposit = stableLQDeposits.getSome(_account);
      deposit = u128.add(deposit, _LQD);
    } else deposit = _LQD;

    stableLQDeposits.set(_account, deposit);

    //TODO updateTotalStakes

    let token = new TokenApi();
    let promise = token.burn(_account, _LQD);
    promise.returnAsResult();
  }
  withdrawStableLQD(_account: AccountId, _LQD: Amount): void {
    this.stablePool.decreaseLQD(_LQD);

    var deposit = stableLQDeposits.getSome(_account);
    assert(deposit >= _LQD, ERR_WITHDRAW_TOO_MUCH);
    deposit = u128.sub(deposit, _LQD);
    stableLQDeposits.set(_account, deposit);

    let token = new TokenApi();
    let promise = token.mint(_account, _LQD);
    promise.returnAsResult();
  }
  withdrawLQD(_account: AccountId, _LQD: Amount): void {
    this.activePool.increaseLQD(_LQD);  
    let token = new TokenApi();
    let promise = token.mint(_account, _LQD);
    promise.returnAsResult();
  }
  repayLQD(_account: AccountId, _LQD: Amount): void {
    this.activePool.decreaseLQD(_LQD);
    let token = new TokenApi();
    let promise = token.burn(_account, _LQD);
    promise.returnAsResult();
  }
  addColl(_amount: Amount): void {
    this.activePool.receiveNEAR(_amount);
  }
  // Transfer the specified amount of NEAR to _account
  withdrawColl(_account: AccountId, _NEAR: Amount): void { // s
    this.activePool.sendNEAR(_account, _NEAR);
  }
  // Burn the calculated lot of LQD and send the corresponding NEAR to to _account
  redeemCollateral(_account: AccountId, _LQD: Amount, _NEAR: Amount): void {
    // Update Active Pool LQD, and send NEAR to account
    this.activePool.decreaseLQD(_LQD);  
    this.activePool.sendNEAR(_account, _NEAR); 

    this.activePool.decreaseLQD(_LQD);
    let token = new TokenApi();
    let promise = token.burn(_account, _LQD);
    promise.returnAsResult();
  }
  moveTroveRepoToActivePool(debtPenalty: Amount, collateralReward: Amount): void {
    this.stablePool.decreaseLQD(debtPenalty);
    this.activePool.increaseLQD(debtPenalty);
    this.stablePool.recapNEAR(collateralReward);
    this.activePool.receiveNEAR(collateralReward);
  }
  /* Cancel out the specified _debt against the CLV contained in the Stability Pool (as far as possible)  
    and transfers the CDP's NEAR collateral from ActivePool to StabilityPool. 
    Only called from liquidation functions in CDPManager. */
  offset(_debtToOffset: Amount, _collToAdd: Amount): void {
    let stableLQD = this.getStableLQD(); 
    if (!stableLQD || !_debtToOffset) return; 
    //TODO
    this.moveOffsetCollAndDebt(_collToAdd, _debtToOffset);
  } 
  moveOffsetCollAndDebt(_collToAdd: Amount, _debtToOffset: Amount): void {
     // Cancel the liquidated CLV debt with the CLV in the stability pool
     this.activePool.decreaseLQD(_debtToOffset);  
     this.stablePool.decreaseLQD(_debtToOffset); 
    
     // Send NEAR from Active Pool to Stability Pool
     this.activePool.recapNEAR(_collToAdd);
     this.stablePool.receiveNEAR(_collToAdd);
     
     let token = new TokenApi();
     let promise = token.burn(LOGIC_CONTRACT, _debtToOffset);
     promise.returnAsResult(); // Burn the debt that was successfully offset
  }
  // Update the Active Pool and the Default Pool when a CDP gets closed
  liquidate(_LQD: Amount, _NEAR: Amount): void {
    // Transfer the debt & coll from the Active Pool to the Default Pool
    this.activePool.decreaseLQD(_LQD);
    this.stablePool.increaseLQD(_LQD);
    this.activePool.recapNEAR( _NEAR);
    this.stablePool.receiveNEAR(_NEAR);
  }
} 

////////////////////////////     Utility Functions     //////////////////////////////

export function min( a: u128, b: u128 ): u128 {
  if ( b > a ) return b;
  else return a;
}

export function _computeICR( _coll: u128, _debt: u128, _price: u128 ): u128 {
  if ( _coll == u128.Zero && _debt == u128.Zero ) {
    return u128.One;
  }
  else if ( _debt > u128.Zero ) {
      let newCollRatio: u128 = u128.mul( _coll, _price );
      return u128.div( newCollRatio, _debt );
  }
  // Return the maximal value for uint256 if the CDP has a debt of 0
  else if ( _debt == u128.Zero ) {
      return u128.Max; 
  }
  return u128.Zero;
}
