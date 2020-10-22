import * as nearAPI from "near-api-js";

import { BigNumber } from "@ethersproject/bignumber";

import { Decimal, Decimalish } from "@liquity/decimal";
import {
  ReadableLiquity,
  StabilityDeposit,
  TransactableLiquity,
  Trove,
  TroveChange,
  TroveWithPendingRewards
} from "@liquity/lib-base";

enum CDPStatus {
  nonExistent,
  active,
  closed
}

type BNLike = string | number;

interface LiquityViewMethods {
  get_cdp(args: {
    owner_id: string;
  }): Promise<{
    debt: string;
    coll: string;
    stake: string;
    status: string;
    arrayIndex: string;
  }>;

  getPrice(): Promise<string>;

  getActiveColl(): Promise<string>;

  getActiveDebt(): Promise<string>;

  getLiquidatedColl(): Promise<string>;

  getClosedDebt(): Promise<string>;

  initialDeposits(args: { _user: string }): Promise<string>;

  getCompoundedCLVDeposit(args: { _user: string }): Promise<string>;

  getCurrentETHGain(args: { _user: string }): Promise<string>;

  getStabilityPoolCLV(): Promise<string>;

  getCDPs(): Promise<{
    [owner: string]: {
      debt: string;
      coll: string;
      stake: string;
      status: string;
      arrayIndex: string;
    };
  }>;
}

interface LiquityChangeMethods {
  openLoan(args: { _CLVAmount: BNLike }, gas: BNLike, amount: BNLike): Promise<void>;

  closeLoan(args: {}, gas: BNLike): Promise<void>;

  addColl(args: { _user: string }, gas: BNLike, amount: BNLike): Promise<void>;

  withdrawColl(args: { _amount: BNLike }, gas: BNLike): Promise<void>;

  withdrawCLV(args: { _amount: BNLike }, gas: BNLike): Promise<void>;

  repayCLV(args: { _amount: BNLike }, gas: BNLike): Promise<void>;

  adjustLoan(
    args: { _collWithdrawal: BNLike; _debtChange: BNLike; _isDebtIncrease: boolean },
    gas: BNLike,
    amount: BNLike
  ): Promise<void>;

  setPrice(args: { _price: BNLike }, gas: BNLike): Promise<void>;

  updatePrice_Testnet(args: {}, gas: BNLike): Promise<void>;

  liquidate(args: { _user: string }, gas: BNLike): Promise<void>;

  liquidateCDPs(args: { _n: BNLike }, gas: BNLike): Promise<void>;

  provideToSP(args: { _amount: BNLike }, gas: BNLike): Promise<void>;

  withdrawFromSP(args: { _amount: BNLike }, gas: BNLike): Promise<void>;

  withdrawFromSPtoCDP(args: { _user: string }, gas: BNLike): Promise<void>;

  redeemCollateral(args: { _CLVamount: BNLike }, gas: BNLike): Promise<void>;
}

type LiquityContract = nearAPI.Contract & LiquityViewMethods & LiquityChangeMethods;

const liquityMethods: {
  viewMethods: (keyof LiquityViewMethods)[];
  changeMethods: (keyof LiquityChangeMethods)[];
} = {
  viewMethods: [
    "get_cdp",
    "getPrice",
    "getActiveColl",
    "getActiveDebt",
    "getLiquidatedColl",
    "getClosedDebt",
    "initialDeposits",
    "getCompoundedCLVDeposit",
    "getCurrentETHGain",
    "getStabilityPoolCLV",
    "getCDPs"
  ],

  changeMethods: [
    "openLoan",
    "closeLoan",
    "addColl",
    "withdrawColl",
    "withdrawCLV",
    "repayCLV",
    "adjustLoan",
    "setPrice",
    "updatePrice_Testnet",
    "liquidate",
    "liquidateCDPs",
    "provideToSP",
    "withdrawFromSP",
    "withdrawFromSPtoCDP",
    "redeemCollateral"
  ]
};

interface TokenViewMethods {
  get_balance(args: { owner_id: string }): Promise<string>;
}

interface TokenChangeMethods {
  transfer(args: { new_owner_id: string; amount: BNLike }, gas: BNLike): Promise<void>;
}

type TokenContract = nearAPI.Contract & TokenViewMethods & TokenChangeMethods;

const tokenMethods: {
  viewMethods: (keyof TokenViewMethods)[];
  changeMethods: (keyof TokenChangeMethods)[];
} = {
  viewMethods: ["get_balance"],
  changeMethods: ["transfer"]
};

export class WrappedNearTransaction {
  private promise: Promise<void>;

  constructor(promise: Promise<void>) {
    this.promise = promise;
  }

  wait() {
    return this.promise;
  }
}

const AMPLE_GAS = "30000000000000";

const decimalify = (bigNumberString: string) => new Decimal(BigNumber.from(bigNumberString));
const numberify = (numberString: string) => parseInt(numberString, 10);

export class NearLiquity implements ReadableLiquity, TransactableLiquity<WrappedNearTransaction> {
  private contract: LiquityContract;
  private token: TokenContract;
  private userAddress: string;

  constructor(
    account: nearAPI.Account,
    contractId = "globalmoney.testnet",
    tokenId = "LQD.testnet"
  ) {
    this.contract = new nearAPI.Contract(account, contractId, liquityMethods) as LiquityContract;
    this.token = new nearAPI.Contract(account, tokenId, tokenMethods) as TokenContract;
    this.userAddress = account.accountId;
  }

  async openTrove(trove: Trove) {
    return new WrappedNearTransaction(
      this.contract.openLoan(
        { _CLVAmount: `${trove.debt.bigNumber}` },
        AMPLE_GAS,
        `${trove.collateral.bigNumber}`
      )
    );
  }

  async closeTrove() {
    return new WrappedNearTransaction(this.contract.closeLoan({}, AMPLE_GAS));
  }

  async depositEther(depositedEther: Decimalish) {
    return new WrappedNearTransaction(
      this.contract.addColl(
        { _user: this.userAddress },
        AMPLE_GAS,
        `${Decimal.from(depositedEther).bigNumber}`
      )
    );
  }

  async withdrawEther(withdrawnEther: Decimalish) {
    return new WrappedNearTransaction(
      this.contract.withdrawColl({ _amount: `${Decimal.from(withdrawnEther).bigNumber}` }, AMPLE_GAS)
    );
  }

  async borrowQui(borrowedQui: Decimalish) {
    return new WrappedNearTransaction(
      this.contract.withdrawCLV({ _amount: `${Decimal.from(borrowedQui).bigNumber}` }, AMPLE_GAS)
    );
  }

  async repayQui(repaidQui: Decimalish) {
    return new WrappedNearTransaction(
      this.contract.repayCLV({ _amount: `${Decimal.from(repaidQui).bigNumber}` }, AMPLE_GAS)
    );
  }

  async changeTrove(change: TroveChange) {
    return new WrappedNearTransaction(
      this.contract.adjustLoan(
        {
          _collWithdrawal: `${change.collateralDifference?.negative?.absoluteValue?.bigNumber || 0}`,
          _debtChange: `${change.debtDifference?.absoluteValue?.bigNumber || 0}`,
          _isDebtIncrease: !change.debtDifference?.negative
        },
        AMPLE_GAS,
        `${change.collateralDifference?.positive?.absoluteValue?.bigNumber || 0}`
      )
    );
  }

  async setPrice(price: Decimalish) {
    return new WrappedNearTransaction(
      this.contract.setPrice({ _price: `${Decimal.from(price).bigNumber}` }, AMPLE_GAS)
    );
  }

  async updatePrice() {
    return new WrappedNearTransaction(this.contract.updatePrice_Testnet({}, AMPLE_GAS));
  }

  async liquidate(_user: string) {
    return new WrappedNearTransaction(this.contract.liquidate({ _user }, AMPLE_GAS));
  }

  async liquidateUpTo(_n: number) {
    return new WrappedNearTransaction(this.contract.liquidateCDPs({ _n }, AMPLE_GAS));
  }

  async depositQuiInStabilityPool(depositedQui: Decimalish) {
    return new WrappedNearTransaction(
      this.contract.provideToSP({ _amount: `${Decimal.from(depositedQui).bigNumber}` }, AMPLE_GAS)
    );
  }

  async withdrawQuiFromStabilityPool(withdrawnQui: Decimalish) {
    return new WrappedNearTransaction(
      this.contract.withdrawFromSP({ _amount: `${Decimal.from(withdrawnQui).bigNumber}` }, AMPLE_GAS)
    );
  }

  async transferCollateralGainToTrove() {
    return new WrappedNearTransaction(
      this.contract.withdrawFromSPtoCDP({ _user: this.userAddress }, AMPLE_GAS)
    );
  }

  async sendQui(new_owner_id: string, amount: Decimalish) {
    return new WrappedNearTransaction(
      this.token.transfer({ new_owner_id, amount: `${Decimal.from(amount).bigNumber}` }, AMPLE_GAS)
    );
  }

  async redeemCollateral(exchangedQui: Decimalish) {
    return new WrappedNearTransaction(
      this.contract.redeemCollateral(
        { _CLVamount: `${Decimal.from(exchangedQui).bigNumber}` },
        AMPLE_GAS
      )
    );
  }

  async getTotalRedistributed() {
    return new Trove({ collateral: 0, debt: 0, virtualDebt: 0 });
  }

  watchTotalRedistributed(
    onTotalRedistributedChanged: (totalRedistributed: Trove) => void
  ): () => void {
    throw new Error("Method not implemented.");
  }

  async getTroveWithoutRewards(owner_id = this.userAddress) {
    const cdp = await this.contract.get_cdp({ owner_id });

    if (numberify(cdp.status) === CDPStatus.active) {
      return new TroveWithPendingRewards({
        collateral: decimalify(cdp.coll),
        debt: decimalify(cdp.debt),
        stake: decimalify(cdp.stake),

        snapshotOfTotalRedistributed: {
          collateral: 0,
          debt: 0
        }
      });
    } else {
      return new TroveWithPendingRewards();
    }
  }

  watchTroveWithoutRewards(
    onTroveChanged: (trove: TroveWithPendingRewards) => void,
    address?: string
  ): () => void {
    throw new Error("Method not implemented.");
  }

  async getTrove(address = this.userAddress) {
    const [trove, totalRedistributed] = await Promise.all([
      this.getTroveWithoutRewards(address),
      this.getTotalRedistributed()
    ]);

    return trove.applyRewards(totalRedistributed);
  }

  async getNumberOfTroves() {
    // XXX shouldn't get every single CDP, but the backend has no function to return the number of CDPs
    const cdps = await this.contract.getCDPs();

    return Object.keys(cdps).length;
  }

  watchNumberOfTroves(onNumberOfTrovesChanged: (numberOfTroves: number) => void): () => void {
    throw new Error("Method not implemented.");
  }

  getPrice() {
    return this.contract.getPrice().then(decimalify);
  }

  watchPrice(onPriceChanged: (price: Decimal) => void): () => void {
    throw new Error("Method not implemented.");
  }

  async getTotal() {
    const [activeCollateral, activeDebt, liquidatedCollateral, closedDebt] = await Promise.all(
      [
        this.contract.getActiveColl(),
        this.contract.getActiveDebt(),
        this.contract.getLiquidatedColl(),
        this.contract.getClosedDebt()
      ].map(getBigNumber => getBigNumber.then(decimalify))
    );

    return new Trove({
      collateral: activeCollateral.add(liquidatedCollateral),
      debt: activeDebt.add(closedDebt),
      virtualDebt: 0
    });
  }

  watchTotal(onTotalChanged: (total: Trove) => void): () => void {
    throw new Error("Method not implemented.");
  }

  async getStabilityDeposit(_user = this.userAddress) {
    const [deposit, depositAfterLoss, pendingCollateralGain] = await Promise.all([
      this.contract.initialDeposits({ _user }).then(decimalify),
      this.contract.getCompoundedCLVDeposit({ _user }).then(decimalify),
      this.contract.getCurrentETHGain({ _user }).then(decimalify)
    ]);

    return new StabilityDeposit({ deposit, depositAfterLoss, pendingCollateralGain });
  }

  watchStabilityDeposit(
    onStabilityDepositChanged: (deposit: StabilityDeposit) => void,
    address?: string
  ): () => void {
    throw new Error("Method not implemented.");
  }

  getQuiInStabilityPool() {
    return this.contract.getStabilityPoolCLV().then(decimalify);
  }

  watchQuiInStabilityPool(
    onQuiInStabilityPoolChanged: (quiInStabilityPool: Decimal) => void
  ): () => void {
    throw new Error("Method not implemented.");
  }

  getQuiBalance(owner_id = this.userAddress) {
    return this.token.get_balance({ owner_id }).then(decimalify);
  }

  watchQuiBalance(onQuiBalanceChanged: (balance: Decimal) => void, address?: string): () => void {
    throw new Error("Method not implemented.");
  }

  async getLastTroves(startIdx: number, numberOfTroves: number) {
    // XXX shouldn't get every single CDP, but there's no way to get a slice from the backend
    const cdps = await this.contract.getCDPs();

    return mapCDPsToTroves(cdps)
      .sort(compareTrovesAscending)
      .slice(startIdx, startIdx + numberOfTroves);
  }

  async getFirstTroves(startIdx: number, numberOfTroves: number) {
    // XXX shouldn't get every single CDP, but there's no way to get a slice from the backend
    const cdps = await this.contract.getCDPs();

    return mapCDPsToTroves(cdps)
      .sort(compareTrovesDescending)
      .slice(startIdx, startIdx + numberOfTroves);
  }
}

type Resolved<T> = T extends Promise<infer U> ? U : T;
type CDPs = Resolved<ReturnType<LiquityViewMethods["getCDPs"]>>;

const mapCDPsToTroves = (cdps: CDPs) =>
  Object.entries(cdps).map(
    ([owner, { coll, debt, stake }]) =>
      [
        owner,

        new TroveWithPendingRewards({
          collateral: decimalify(coll),
          debt: decimalify(debt),
          stake: decimalify(stake),

          snapshotOfTotalRedistributed: {
            collateral: 0,
            debt: 0
          }
        })
      ] as const
  );

const compareTrovesAscending = (
  [, t1]: readonly [string, Trove],
  [, t2]: readonly [string, Trove]
) => {
  const r1 = t1.collateralRatio(1);
  const r2 = t2.collateralRatio(1);

  return r1.lt(r2) ? -1 : r1.gt(r2) ? 1 : 0;
};

const compareTrovesDescending = (
  [, t1]: readonly [string, Trove],
  [, t2]: readonly [string, Trove]
) => {
  const r1 = t1.collateralRatio(1);
  const r2 = t2.collateralRatio(1);

  return r1.lt(r2) ? 1 : r1.gt(r2) ? -1 : 0;
};
