
import { u128, PersistentVector, PersistentMap, 
         ContractPromiseBatch, ContractPromise } from "near-sdk-as";
import { ERR_USER_EXISTS, ERR_WITHDRAW_TOO_MUCH } from './errors'

export type AccountId = string
export type Amount = u128

// Store the necessary data for a Collateralized Debt Position (CDP)
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
  // TODO
  // gasComp: Amount;
}
@nearBindgen
export class RewardSnapshot { coll: Amount; debt: Amount }

export const PCT = u128.from(1000000000000000000); // 100% 1e18
export const LOGIC_CONTRACT = "globalmoney.testnet"
const LINK_CONTRACT = "chainlink.globalmoney.testnet";
const TOKEN_CONTRACT = "LQD.testnet"

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
export const epochToScaleToSum = new PersistentMap<string, u128>("ess");
export const CDPOwners = new PersistentVector<AccountId>("owners");
export const CDPs = new PersistentMap<AccountId, CDP>("cdps");
export const rewardSnapshots = new PersistentMap<AccountId, RewardSnapshot>("rewards");
export const stableLQDeposits = new PersistentMap<AccountId, Amount>("deposits");

@nearBindgen
export class TroveMgr { 
  // snapshot of the value of totalStakes immediately after the last liquidation
  private totalStakes: u128;  

  // snapshot of the total collateral in ActivePool and DefaultPool, immediately after the last liquidation.
  private totalCollateral: Amount;

  /* TODO
   * Track accumulated liquidation rewards per unit staked. 
   * During it's lifetime, each stake earns:
   *  An ETH gain of ( stake * [L_Coll - L_Coll(0)] ) 
   *  A debt penalty  of ( stake * [L_Debt - L_Debt(0)] )
   * Where L_Coll(0) and L_Debt(0) are snapshots of L_Coll and L_Debt
   * for an active CDP when the stake was made 
  */
  private L_Coll: Amount;
  private L_Debt: Amount;

  constructor() {
    this.totalStakes = u128.Zero;
    this.totalCollateral = u128.Zero;
    this.L_Coll = u128.Zero;
    this.L_Debt = u128.Zero;
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
    var cdp: CDP = CDPs.get(address, new CDP());

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
  increaseCDPDebt(_user: AccountId, _debtIncrease: Amount): Amount {
    var cdp: CDP = CDPs.getSome(_user);
    let newDebt = u128.add(cdp.debt, _debtIncrease);
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

  updateStakeAndTotalStakes(_user: AccountId): u128 {
    var cdp: CDP = CDPs.getSome(_user);
    var newStake = cdp.coll; 
    
    if (this.totalCollateral > u128.Zero) {
      newStake = u128.mul(cdp.coll, this.totalStakes);
      newStake = u128.div(newStake, this.totalCollateral);
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
    CDPOwners.swap_remove(cdp.arrayIndex);
  }
  
  // Redeem as much collateral as possible from _cdpUser's CDP in exchange for LQD up to _maxLQDamount
  redeemCollateralFromCDP(_cdpUser: AccountId, _maxLQD: Amount, _price: u128): Amount {
    // Determine the remaining amount (lot) to be redeemed, capped by the entire debt of the CDP
    let cdp: CDP = CDPs.getSome(_cdpUser);
    let LQDLot = min(_maxLQD, cdp.debt); 
    // TODO
    return u128.Zero;
  }

  // Remove use's stake from the totalStakes sum, and set their stake to 0
  removeStake(_user: AccountId): void {
    let cdp: CDP = CDPs.getSome(_user);
    this.totalStakes = u128.sub(this.totalStakes, cdp.stake);
    cdp.stake = u128.Zero;
    CDPs.set(_user, cdp);
  }

  hasPendingFunds(_user: AccountId): bool {
    
    return false;
  }
  getPendingCollateralGain(_user: AccountId): Amount {
    let snapshot: RewardSnapshot = rewardSnapshots.getSome(_user);
    let rewardPerUnitStaked = u128.sub(this.L_Coll, snapshot.coll); 
    if (!rewardPerUnitStaked) return u128.Zero;
    return u128.div(
      u128.mul(this.getCDPStake(_user), rewardPerUnitStaked), PCT
    );
  }
  getPendingLQDebtPenalty(_user: AccountId): Amount {
    let snapshot: RewardSnapshot = rewardSnapshots.getSome(_user);
    let rewardPerUnitStaked = u128.sub(this.L_Debt, snapshot.debt); 
    if (!rewardPerUnitStaked) return u128.Zero;
    return u128.div(
      u128.mul(this.getCDPStake(_user), rewardPerUnitStaked), PCT
    );
  }
  // Return the current collateral ratio (ICR) of a given CDP
  getCurrentICR(_user: AccountId, _price: u128): u128 {  
    return _computeICR (this.getCDPColl(_user), this.getCDPDebt(_user), _price);      
  }
  getCDPColl(_user: AccountId): Amount { // TODO
    // let pendingNEAReward: Amount = this._computePendingNEAReward(_user);
    // let cdpColl: Amount = u128.add(this.getCDP(_user).coll, pendingNEAReward);
    return this.getCDP(_user).coll;
    // return cdpColl;
  }
  getCDPStake(_user: AccountId): Amount {
    return this.getCDP(_user).stake;
  }
  getCDPDebt(_user: AccountId): Amount { // TODO
    // let pendingDebtReward: Amount = this._computePendingDebtReward(_user);
    // let cdpDebt: Amount = u128.add(this.getCDP(_user).debt, pendingDebtReward);
    return this.getCDP(_user).debt;
    // return cdpDebt;
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
  private NEAR: Amount;  // deposited ether tracker
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
  defaultPool: Pool;
  /* 
   * Running product by which to multiply an initial deposit, in order to find the
   * current compounded deposit, given a series of liquidations, each of which cancel
   * some LQD debt with the deposit. During its lifetime, a deposit's value evolves 
   * from d(0) to (d(0) * P / P(0) ), where P(0)is the snapshot of P taken at the 
   * instant the deposit was made. 18 DP decimal.  
  */
  private product: u128;
  // Each time the scale of P shifts by 1e18, the scale is incremented by 1
  private scale: u128; 
  // With each offset that fully empties the Pool, the epoch is incremented by 1
  private epoch: u128;  

  constructor() {
    this.activePool = new Pool();
    this.stablePool = new Pool();
    this.defaultPool = new Pool();
  }
  getStableLQD(): Amount {
    return this.stablePool.getLQD();
  }
  getActiveLQD(): Amount {
    return this.activePool.getLQD();
  }
  getTotalLQD(): Amount {
    return u128.add(this.activePool.getLQD(), this.defaultPool.getLQD());
  }
  getStableNEAR(): Amount {
    return this.stablePool.getNEAR();
  }
  getActiveNEAR(): Amount {
    return this.activePool.getNEAR();
  }
  getTotalNEAR(): Amount {
    return u128.add(this.activePool.getNEAR(), this.defaultPool.getNEAR());
  }
  getDebtPenaltyPerUnitStaked(_debtToOffset: Amount, stableLQD): Amount {
    return u128.div(u128.mul(_debtToOffset, PCT), stableLQD);
  }
  getCollateralRewardPerUnitStaked(_collToAdd, stableLQD): Amount {
    return u128.div(u128.mul(_collToAdd, PCT), stableLQD); 
  }

  depositStableLQD(_account: AccountId, _LQD: Amount): void {
    this.stablePool.increaseLQD(_LQD);

    var deposit = stableLQDeposits.get(_account, u128.Zero);
    deposit = u128.add(deposit, _LQD);
    stableLQDeposits.set(_account, deposit);

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
  // Transfer the specified amount of ETH to _account
  withdrawColl(_account: AccountId, _NEAR: Amount): void { // TODOs
    this.activePool.sendNEAR(_account, _NEAR);
  }
  // Burn the calculated lot of LQD and send the corresponding ETH to to _account
  redeemCollateral(_account: AccountId, _LQD: Amount, _NEAR: Amount): void {
    // Update Active Pool LQD, and send ETH to account
    this.activePool.decreaseLQD(_LQD);  
    this.activePool.sendNEAR(_account, _NEAR); 

    this.activePool.decreaseLQD(_LQD);
    let token = new TokenApi();
    let promise = token.burn(_account, _LQD);
    promise.returnAsResult();
  }
  moveTroveRepoToActivePool(debtPenalty: Amount, collateralReward: Amount): void {
    this.defaultPool.decreaseLQD(debtPenalty);
    this.activePool.increaseLQD(debtPenalty);
    this.defaultPool.recapNEAR(collateralReward);
    this.activePool.receiveNEAR(collateralReward);
  }
  /* Cancel out the specified _debt against the CLV contained in the Stability Pool (as far as possible)  
    and transfers the CDP's ETH collateral from ActivePool to StabilityPool. 
    Only called from liquidation functions in CDPManager. */
  offset(_debtToOffset: Amount, _collToAdd: Amount): void {
    let stableLQD = this.getStableLQD(); 
    if (!stableLQD || !_debtToOffset) return; 
    this.updateRewardSumAndProduct(
      this.getDebtPenaltyPerUnitStaked(_debtToOffset, stableLQD),
      this.getCollateralRewardPerUnitStaked(_collToAdd, stableLQD)
    );
    this.moveOffsetCollAndDebt(_collToAdd, _debtToOffset);
  } 
  updateRewardSumAndProduct(_NEARgain: Amount, _LQDloss: Amount): void {
    // Make product factor 0 if there was a pool-emptying. 
    // Otherwise, it is (1 - LQDLossPerUnitStaked)
    var newProductFactor: u128;
    if (_LQDloss >= PCT) 
      newProductFactor = u128.Zero;
    else 
      newProductFactor = u128.sub(PCT, _LQDloss);
      
    // Update the NEAR reward sum at the current scale and current epoch
    let marginalGain = u128.mul(_NEARgain, this.product);
    let key: string = this.epoch.toString() + "," + this.scale.toString();
    let oldESS: u128 = epochToScaleToSum.getSome(key);
    
    epochToScaleToSum.set(key, u128.add(oldESS, marginalGain));
    // If the Pool was emptied, increment the epoch and reset the scale and product P
    if (!newProductFactor) {
        this.epoch = u128.add(this.epoch, u128.One);
        this.scale = u128.Zero;
        this.product = PCT;
    } 
    else {
      // If multiplying P by a non-zero product factor would round P to zero, increment the scale 
      let newProduct = u128.mul(this.product, newProductFactor);
      if (newProduct < PCT) {
          this.product = newProduct;
          this.scale = u128.add(this.scale, u128.One);
      } else {
          this.product = u128.div(newProduct, PCT); 
      }
    }
  }
  moveOffsetCollAndDebt(_collToAdd: Amount, _debtToOffset: Amount): void {
     // Cancel the liquidated CLV debt with the CLV in the stability pool
     this.activePool.decreaseLQD(_debtToOffset);  
     this.stablePool.decreaseLQD(_debtToOffset); 
    
     // Send ETH from Active Pool to Stability Pool
     this.activePool.recapNEAR(_collToAdd);
     this.stablePool.receiveNEAR(_collToAdd);
     
     let token = new TokenApi();
     let promise = token.burn(LOGIC_CONTRACT, _debtToOffset);
     promise.returnAsResult(); // Burn the debt that was successfully offset
  }
  // Update the Active Pool and the Default Pool when a CDP gets closed
  liquidate(_LQD: Amount, _NEAR: Amount) {
    // Transfer the debt & coll from the Active Pool to the Default Pool
    this.activePool.decreaseLQD(_LQD);
    this.defaultPool.increaseLQD(_LQD);
    this.activePool.recapNEAR( _NEAR);
    this.defaultPool.receiveNEAR(_NEAR);
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

// TODO Oracle Cross Contract Call
// https://www.crowdcast.io/e/hacktherainbow/register?session=14
// https://github.com/smartcontractkit/near-protocol-contracts
export function getPrice(): u128 {
  return u128.from(Math.floor(Math.random() * Math.floor(500)));
}
