
import { 
  u128, PersistentVector, PersistentMap, storage,
  ContractPromiseBatch, ContractPromise 
} from "near-sdk-as";
import { 
  ERR_WITHDRAW_TOO_MUCH, ERR_REPAY_OVER, ERR_TROVE_STATUS
} from './errors'

export const SCALING_FACTOR = u128.from(1000000); // Collateral is 24 digits, so we need to
                                                  // divide by 10^6 to scale it down to 18
export const MCR = u128.from(1100000000000000000); // Minimal Collateral Ratio, 110%
// If the total system collateral (TCR) falls below the CCR, Recovery Mode is triggered.
export const CCR = u128.from(1500000000000000000); // Critical Collateral Ratio, 150% 
export const PCT = u128.from(1000000000000000000); // 100% 1e18

const LINK_CONTRACT = "link.globalmoney.testnet";
const TOKEN_CONTRACT = "lqd.globalmoney.testnet";
export const LOGIC_CONTRACT = "quid.globalmoney.testnet";

export enum Status { nonExistent, active, closed }
export type AccountId = string
export type Amount = u128

@nearBindgen
export class Trove {
  debt: Amount;
  collat: Amount;
  stake: u128;
  status: Status;
  arrayIndex: i32;
  constructor() {
    this.debt = u128.Zero;
    this.collat = u128.Zero;
    this.stake = u128.Zero;
    this.status = Status.nonExistent;
  }
}
@nearBindgen
export class LiquidationValues {
  debtToOffset: Amount;
  collatToSendToSP: Amount;
  debtToRedistribute: Amount;
  collatToRedistribute: Amount;
}
@nearBindgen
class MintBurnArgs {
  user: AccountId;
  tokens: Amount;
}
@nearBindgen
export class TokenApi {
  mint(user: AccountId, tokens: Amount): ContractPromise {
    let args: MintBurnArgs = { user, tokens };
    let promise = ContractPromise.create(
      TOKEN_CONTRACT, "mint", args.encode(), 100000000000000
    );
    return promise;
  }
  burn(user: AccountId, tokens: Amount): ContractPromise {
    let args: MintBurnArgs = { user, tokens };
    let promise = ContractPromise.create(
      TOKEN_CONTRACT, "burn", args.encode(), 100000000000000
    );
    return promise;
  }
}
export const stableLQDeposits = new PersistentMap<AccountId, Amount>("deposits");
export const Troves = new PersistentMap<AccountId, Trove>("troves");
export const TroveOwners = new PersistentVector<AccountId>("owners");

@nearBindgen
export class TroveMgr { 
  // private feePct: u128; // fee percentage points
  // issuanceFee(amount) = c * baseRate * amount
  // redemptionFee(amount) = d * baseRate * amount
  constructor() {}

  getTotalFees(): Amount {
    return storage.get<u128>("fees", u128.Zero);
  }

  getTotalStakes(): u128 {
    if (storage.contains("stakes"))
      return storage.getSome<u128>("stakes");
    else 
      return u128.Zero;
  }

  payFee( _usr: AccountId, _fee: Amount ): void {
    let trove = Troves.getSome(_usr);
    
    let totalFees = this.getTotalFees();
    storage.set<u128>( "fees",  u128.add( totalFees, _fee ) );
    
    trove.debt = u128.add( trove.debt, _fee );
    Troves.set( _usr, trove );
  }

  addOwnerToArray( _usr: AccountId ): i32 {
    let index = TroveOwners.length;
    let trove = Troves.getSome(_usr);
    TroveOwners.push(_usr);
    trove.arrayIndex = index;
    Troves.set( _usr, trove );
    return index;
  }

  getStatus( _usr: AccountId ): u16 {
    let trove: Trove;
    if( Troves.contains(_usr) ) {
      trove = Troves.getSome(_usr);
      return <u16> trove.status;
    }
    return <u16> Status.nonExistent;
  }
  
  setStatus( _usr: AccountId, _num: u16 ): void {
    let trove = this.getTrove(_usr);
    
    if ( _num == 1 ) trove.status = Status.active;
    else if ( _num == 2 ) trove.status = Status.closed;
    else assert( true, ERR_TROVE_STATUS );

    Troves.set( _usr, trove );
  }

  increaseCollat( _user: AccountId, _collatIncrease: Amount ): Amount  {
    let trove = Troves.getSome(_user);
    trove.collat = u128.add( trove.collat, _collatIncrease );
    Troves.set( _user, trove );
    return trove.collat;
  }
  
  decreaseCollat( _usr: AccountId, _collatDecrease: Amount ): Amount {
    let trove = Troves.getSome( _usr );
    trove.collat = u128.sub( trove.collat, _collatDecrease );
    Troves.set( _usr, trove );
    if ( trove.collat == u128.Zero ) {
      this.close(_usr); 
      return u128.Zero; 
    }
    return trove.collat;
  }
  
  mintDebt( _user: AccountId, _debtIncrease: Amount, _fee: Amount ): void {
    let debtPlusFee = u128.add( _debtIncrease, _fee );
    
    let totalFees = this.getTotalFees();
    storage.set<u128>( "fees", u128.add( totalFees, _fee ) );

    let trove = Troves.getSome(_user);
    trove.debt = u128.add( trove.debt, debtPlusFee );
    Troves.set( _user, trove );
    /*
     * We don't mint the issuance fee amount
     * because the user must obtain that by 
     * selling some collateral or other means
     * to close her debt against the system
    */ 
    let token = new TokenApi();
    let promise = token.mint( _user, _debtIncrease );
    promise.returnAsResult();
  } 
  
  burnDebt( _user: AccountId, _debtDecrease: Amount ): void {
    let trove = Troves.getSome(_user);
    assert( _debtDecrease < trove.debt, ERR_REPAY_OVER );
  
    trove.debt = u128.sub( trove.debt, _debtDecrease );
    Troves.set( _user, trove );
    
    let token = new TokenApi();
    let promise = token.burn( _user, _debtDecrease );
    promise.returnAsResult();
  }

  updateStakes( _user: AccountId, _totalCollateral: Amount ): u128 { // TODO wtf does it do
    let trove = Troves.getSome(_user);
    let oldStake = trove.stake;
    
    let totalStakes = this.getTotalStakes();
    if ( _totalCollateral > u128.Zero ) {
      trove.stake = u128.mul( trove.collat, totalStakes );
      trove.stake = u128.div( trove.stake, _totalCollateral );
    }    
    storage.set<u128>( "stakes", u128.add(trove.stake, u128.sub(
      totalStakes, oldStake)
    ));
    return trove.stake;
  }

  close( _user: AccountId ): void {
    let trove = Troves.getSome(_user);
    trove.status = Status.closed;
    trove.collat = u128.Zero;
    trove.debt = u128.Zero;
    
    let totalStakes = this.getTotalStakes();
    storage.set<u128>( "stakes", u128.sub(
      totalStakes, trove.stake
    ));
    trove.stake = u128.Zero;
    Troves.set( _user, trove );
    TroveOwners.swap_remove(trove.arrayIndex);
  }
  
  // Redeem as much collateral as possible from _user's 
  // Trove in exchange for LQD up to _maxLQDamount
  redeemCollateralFrom( _user: AccountId,
    _totalCollat: Amount, _totalDebt: Amount, 
    _maxLQD: Amount, _price: u128 ): string {
    // Determine the remaining amount (lot) to be redeemed, 
    // capped by the entire debt of the Trove
    let trove = Troves.getSome(_user);
    let TCRwith = _computeICR( _totalCollat, _totalDebt, _price );
    
    let totalCollatWithout: Amount = u128.sub( _totalCollat, trove.collat );
    let totalDebtWithout: Amount = u128.sub( _totalDebt, trove.debt );
    let TCRwithout = _computeICR(
      totalCollatWithout,
      totalDebtWithout,
      _price
    );
    let TCRdelta = u128.sub( TCRwithout, TCRwith );
    let TCRshare = u128.div( TCRdelta, TCRwith );
    let debtToRedeem = min( u128.mul( _maxLQD, TCRshare ), trove.debt );
    let debtShare = u128.div( debtToRedeem, trove.debt );
    let collatToRedeem = u128.mul( debtShare, trove.collat );
    trove.debt = u128.sub( trove.debt, debtToRedeem );
    trove.collat = u128.sub( trove.collat, collatToRedeem );
    if ( trove.debt == u128.Zero && trove.collat == u128.Zero )
      this.close(_user);
    else
      Troves.set(_user, trove);

    return trove.debt.toString() + "," + trove.collat.toString();
  }
  
  // Remove use's stake from the totalStakes sum, and set their stake to 0
  removeStake( _usr: AccountId ): void {
    let trove = Troves.getSome(_usr);
    let totalStakes = this.getTotalStakes();
    storage.set<u128>( "stakes", u128.add( 
      totalStakes, u128.sub( totalStakes, 
                            trove.stake )
    )); 
    trove.stake = u128.Zero;
    Troves.set(_usr, trove);
  }
  
  // Return the current collateral ratio (ICR) of a given CDP
  getCurrentICR( _usr: AccountId, _price: u128 ): u128 {  
    return _computeICR(
      this.getCollat(_usr), this.getDebt(_usr), _price
    );      
  }
  getCollat( _usr: AccountId ): Amount {
    return this.getTrove(_usr).collat;
  }
  getStake( _usr: AccountId ): Amount {
    return this.getTrove(_usr).stake;
  }
  getDebt( _usr: AccountId ): Amount {
    return this.getTrove(_usr).debt;
  }
  getTrove( _usr: AccountId ): Trove {
    return Troves.get( _usr, new Trove() ) as Trove;
  }
}

@nearBindgen
class Pool { // TODO storage for amounts
  // TODO storage
  private NEAR: Amount;  // deposited collateral tracker
  private LQD: Amount;  // total outstanding CDP debt
  
  constructor() {
    this.NEAR = u128.Zero;
    this.LQD = u128.Zero;
  }
  
  receiveNEAR( _amount: Amount ): void {
    this.NEAR = u128.add(this.NEAR, _amount);
  }
  recapNEAR( _amount: Amount ): void {
    this.NEAR = u128.sub(this.NEAR, _amount);
  }
  sendNEAR( _account: AccountId, _amount: Amount ): void {
    this.NEAR = u128.sub(this.NEAR, _amount);
    ContractPromiseBatch.create(_account).transfer(_amount);
  }
  increaseLQD( _amount: Amount ): void {
    this.LQD = u128.add(this.LQD, _amount);
  }
  decreaseLQD( _amount: Amount ): void {
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
    return u128.add( this.getActiveLQD(), this.getStableLQD() );
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
  getCollateralRewardPerUnitStaked(_collatToAdd: Amount, stableLQD: Amount): Amount {
    return u128.div(u128.mul(_collatToAdd, PCT), stableLQD); 
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
  addCollat(_amount: Amount): void {
    this.activePool.receiveNEAR(_amount);
  }
  // Transfer the specified amount of NEAR to _account
  withdrawCollat(_account: AccountId, _NEAR: Amount): void { // s
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
  offset(_debtToOffset: Amount, _collatToAdd: Amount): void {
    let stableLQD = this.getStableLQD(); 
    if (!stableLQD || !_debtToOffset) return; 
    //TODO
    this.moveOffsetCollatAndDebt(_collatToAdd, _debtToOffset);
  } 
  moveOffsetCollatAndDebt(_collatToAdd: Amount, _debtToOffset: Amount): void {
     // Cancel the liquidated CLV debt with the CLV in the stability pool
     this.activePool.decreaseLQD(_debtToOffset);  
     this.stablePool.decreaseLQD(_debtToOffset); 
    
     // Send NEAR from Active Pool to Stability Pool
     this.activePool.recapNEAR(_collatToAdd);
     this.stablePool.receiveNEAR(_collatToAdd);
     
     let token = new TokenApi();
     let promise = token.burn(LOGIC_CONTRACT, _debtToOffset);
     promise.returnAsResult(); // Burn the debt that was successfully offset
  }
  // Update the Active Pool and the Default Pool when a CDP gets closed
  liquidate(_LQD: Amount, _NEAR: Amount): void {
    // Transfer the debt & collat from the Active Pool to the Default Pool
    this.activePool.decreaseLQD(_LQD);
    this.stablePool.increaseLQD(_LQD);
    this.activePool.recapNEAR( _NEAR);
    this.stablePool.receiveNEAR(_NEAR);
  }
} 

////////////////////////////     Utility Functions     //////////////////////////////

export function min( a: u128, b: u128 ): u128 {
  if ( b > a ) return a;
  else return b;
}

export function _computeICR( _collat: u128, _debt: u128, _price: u128 ): u128 {
  if ( _collat == u128.Zero && _debt == u128.Zero ) {
    return u128.One;
  }
  else if ( _debt > u128.Zero ) {
      let collatPerDebt: u128 = u128.div( _collat, _debt );
      let collatRatio24Decimals = u128.mul( collatPerDebt, _price );
      return u128.div( collatRatio24Decimals, SCALING_FACTOR );
  }
  // Return the maximal value for uint256 if the CDP has a debt of 0
  else if ( _debt == u128.Zero ) {
      return u128.Max; 
  }
  return u128.Zero;
}
