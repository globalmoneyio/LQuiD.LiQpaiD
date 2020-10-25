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
  getCDP(args: {
    owner_id: string;
  }): Promise<{
    debt: string;
    coll: string;
    stake: string;
    status: string;
    arrayIndex: string;
  }>;

  getPrice(): Promise<string>;

  getTotalColl(): Promise<string>;

  getTotalDebt(): Promise<string>;

  getSPdep(args: { owner: string }): Promise<string>;

  getSPdebt(): Promise<string>;

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
  openLoan(args: { _LQDAmount: BNLike }, gas: BNLike, amount: BNLike): Promise<void>;

  closeLoan(args: {}, gas: BNLike): Promise<void>;

  addColl(args: { _user: string }, gas: BNLike, amount: BNLike): Promise<void>;

  withdrawColl(args: { _amount: BNLike }, gas: BNLike): Promise<void>;

  withdrawLQD(args: { _amount: BNLike }, gas: BNLike): Promise<void>;

  repayLQD(args: { _amount: BNLike }, gas: BNLike): Promise<void>;

  adjustLoan(
    args: { _collWithdrawal: BNLike; _debtChange: BNLike; _isDebtIncrease: BNLike },
    gas: BNLike,
    amount: BNLike
  ): Promise<void>;

  setPrice(args: { newPrice: BNLike }, gas: BNLike): Promise<void>;

  liquidate(args: { _user: string }, gas: BNLike): Promise<void>;

  provideToSP(args: { _amount: BNLike }, gas: BNLike): Promise<void>;

  withdrawFromSP(args: { _amount: BNLike }, gas: BNLike): Promise<void>;

  redeemCollateral(args: { _LQDamount: BNLike }, gas: BNLike): Promise<void>;
}

type LiquityContract = nearAPI.Contract & LiquityViewMethods & LiquityChangeMethods;

const liquityMethods: {
  viewMethods: (keyof LiquityViewMethods)[];
  changeMethods: (keyof LiquityChangeMethods)[];
} = {
  viewMethods: [
    "getCDP",
    "getPrice",
    "getTotalColl",
    "getTotalDebt",
    "getSPdep",
    "getSPdebt",
    "getCDPs"
  ],

  changeMethods: [
    "openLoan",
    "closeLoan",
    "addColl",
    "withdrawColl",
    "withdrawLQD",
    "repayLQD",
    "adjustLoan",
    "setPrice",
    "liquidate",
    "provideToSP",
    "withdrawFromSP",
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
const NEAR_SCALING_FACTOR = Decimal.from("1000000"); // Quick hack: NEAR uses 6 more decimals

const numberify = (numberString: string) => parseInt(numberString, 10);
const decimalify = (bigNumberString?: string | null) =>
  new Decimal(BigNumber.from(bigNumberString ?? 0));

export class NearLiquity implements ReadableLiquity, TransactableLiquity<WrappedNearTransaction> {
  private contract: LiquityContract;
  private token: TokenContract;
  private userAddress: string;

  constructor(
    account: nearAPI.Account,
    contractId = "globalmoney.testnet",
    tokenId = "quid.globalmoney.testnet"
  ) {
    this.contract = new nearAPI.Contract(account, contractId, liquityMethods) as LiquityContract;
    this.token = new nearAPI.Contract(account, tokenId, tokenMethods) as TokenContract;
    this.userAddress = account.accountId;
  }

  async openTrove(trove: Trove) {
    return new WrappedNearTransaction(
      this.contract.openLoan(
        { _LQDAmount: `${trove.debt.bigNumber}` },
        AMPLE_GAS,
        `${trove.collateral.mul(NEAR_SCALING_FACTOR).bigNumber}`
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
        `${Decimal.from(depositedEther).mul(NEAR_SCALING_FACTOR).bigNumber}`
      )
    );
  }

  async withdrawEther(withdrawnEther: Decimalish) {
    return new WrappedNearTransaction(
      this.contract.withdrawColl(
        { _amount: `${Decimal.from(withdrawnEther).mul(NEAR_SCALING_FACTOR).bigNumber}` },
        AMPLE_GAS
      )
    );
  }

  async borrowQui(borrowedQui: Decimalish) {
    return new WrappedNearTransaction(
      this.contract.withdrawLQD({ _amount: `${Decimal.from(borrowedQui).bigNumber}` }, AMPLE_GAS)
    );
  }

  async repayQui(repaidQui: Decimalish) {
    return new WrappedNearTransaction(
      this.contract.repayLQD({ _amount: `${Decimal.from(repaidQui).bigNumber}` }, AMPLE_GAS)
    );
  }

  async changeTrove(change: TroveChange) {
    return new WrappedNearTransaction(
      this.contract.adjustLoan(
        {
          _collWithdrawal: `${
            change.collateralDifference?.negative?.absoluteValue?.mul(NEAR_SCALING_FACTOR)
              .bigNumber || 0
          }`,
          _debtChange: `${change.debtDifference?.absoluteValue?.bigNumber || 0}`,
          _isDebtIncrease: change.debtDifference?.positive ? 1 : 0
        },
        AMPLE_GAS,
        `${
          change.collateralDifference?.positive?.absoluteValue?.mul(NEAR_SCALING_FACTOR).bigNumber ||
          0
        }`
      )
    );
  }

  async setPrice(price: Decimalish) {
    return new WrappedNearTransaction(
      this.contract.setPrice({ newPrice: `${Decimal.from(price).bigNumber}` }, AMPLE_GAS)
    );
  }

  updatePrice(): Promise<WrappedNearTransaction> {
    throw new Error("Method not implemented.");
  }

  async liquidate(_user: string) {
    return new WrappedNearTransaction(this.contract.liquidate({ _user }, AMPLE_GAS));
  }

  liquidateUpTo(_n: number): Promise<WrappedNearTransaction> {
    throw new Error("Method not implemented.");
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

  async transferCollateralGainToTrove(): Promise<WrappedNearTransaction> {
    throw new Error("Method not implemented.");
  }

  async sendQui(new_owner_id: string, amount: Decimalish) {
    return new WrappedNearTransaction(
      this.token.transfer({ new_owner_id, amount: `${Decimal.from(amount).bigNumber}` }, AMPLE_GAS)
    );
  }

  async redeemCollateral(exchangedQui: Decimalish) {
    return new WrappedNearTransaction(
      this.contract.redeemCollateral(
        { _LQDamount: `${Decimal.from(exchangedQui).bigNumber}` },
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
    const cdp = await this.contract.getCDP({ owner_id });

    if (numberify(cdp.status) === CDPStatus.active) {
      return new TroveWithPendingRewards({
        collateral: decimalify(cdp.coll).div(NEAR_SCALING_FACTOR),
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
    const [collateral, debt] = await Promise.all(
      [this.contract.getTotalColl(), this.contract.getTotalDebt()].map(getBigNumber =>
        getBigNumber.then(decimalify)
      )
    );

    return new Trove({
      collateral: collateral.div(NEAR_SCALING_FACTOR),
      debt,
      virtualDebt: 0
    });
  }

  watchTotal(onTotalChanged: (total: Trove) => void): () => void {
    throw new Error("Method not implemented.");
  }

  async getStabilityDeposit(owner = this.userAddress) {
    const deposit = Decimal.from(await this.contract.getSPdep({ owner }));

    return new StabilityDeposit({ deposit, depositAfterLoss: deposit, pendingCollateralGain: 0 });
  }

  watchStabilityDeposit(
    onStabilityDepositChanged: (deposit: StabilityDeposit) => void,
    address?: string
  ): () => void {
    throw new Error("Method not implemented.");
  }

  getQuiInStabilityPool() {
    return this.contract.getSPdebt().then(decimalify);
  }

  watchQuiInStabilityPool(
    onQuiInStabilityPoolChanged: (quiInStabilityPool: Decimal) => void
  ): () => void {
    throw new Error("Method not implemented.");
  }

  getQuiBalance(owner_id = this.userAddress) {
    return this.token.get_balance({ owner_id }).then(decimalify).catch(() => Decimal.from(0));
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
          collateral: decimalify(coll).div(NEAR_SCALING_FACTOR),
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
