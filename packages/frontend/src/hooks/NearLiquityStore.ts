import { useCallback } from "react";
import { BigNumber } from "@ethersproject/bignumber";
import * as nearAPI from "near-api-js";

import { Decimal } from "@liquity/decimal";
import { Trove, StabilityDeposit } from "@liquity/lib-base";
import { ReadableLiquity } from "@liquity/lib-base";
import { useAsyncValue } from "./AsyncValue";

type Resolved<T> = T extends Promise<infer U> ? U : T;
type ResolvedValues<T> = { [P in keyof T]: Resolved<T[P]> };

const promiseAllValues = <T>(object: T): Promise<ResolvedValues<T>> => {
  const keys = Object.keys(object);
  return Promise.all(Object.values(object)).then(values =>
    Object.fromEntries(values.map((value, i) => [keys[i], value]))
  ) as Promise<ResolvedValues<T>>;
};

const decimalify = ({ amount }: { amount: string }) => new Decimal(BigNumber.from(amount));

export const useLiquityStore = (
  walletConnection: nearAPI.WalletConnection,
  account: string,
  liquity: ReadableLiquity
) => {
  const get = useCallback(async () => {
    const store = await promiseAllValues({
      etherBalance: walletConnection
        .account()
        .state()
        .then(amount => decimalify(amount).div(1000000)),
      quiBalance: liquity.getQuiBalance(account),
      price: liquity.getPrice(),
      numberOfTroves: liquity.getNumberOfTroves(),
      troveWithoutRewards: liquity.getTroveWithoutRewards(account),
      totalRedistributed: liquity.getTotalRedistributed(),
      deposit: liquity.getStabilityDeposit(account),
      total: liquity.getTotal(),
      quiInStabilityPool: liquity.getQuiInStabilityPool()
    });

    return {
      ...store,
      trove: store.troveWithoutRewards.applyRewards(store.totalRedistributed)
    };
  }, [walletConnection, account, liquity]);

  type Values = Resolved<ReturnType<typeof get>> & {
    [prop: string]: number | Decimal | Trove | StabilityDeposit | undefined;
  };

  const watch = useCallback(
    (updateValues: (values: Values) => void) => {
      const updater = setInterval(() => {
        get().then(updateValues);
      }, 4000);

      return () => clearInterval(updater);
    },
    [get]
  );

  const reduce = useCallback(
    (previous: Values, neuu: Values) =>
      Object.fromEntries(
        Object.keys(previous).map(key => {
          const previousValue = previous[key];
          const newValue = neuu[key];

          const equals =
            previousValue === newValue ||
            (previousValue instanceof Decimal && previousValue.eq(newValue as Decimal)) ||
            (previousValue instanceof Trove && previousValue.equals(newValue as Trove)) ||
            (previousValue instanceof StabilityDeposit &&
              previousValue.equals(newValue as StabilityDeposit));

          return [key, equals ? previousValue : newValue];
        })
      ) as Values,
    []
  );

  return useAsyncValue(get, watch, reduce);
};
