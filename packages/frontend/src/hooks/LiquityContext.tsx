import React, { createContext, useContext } from "react";
import * as nearAPI from "near-api-js";

import { NearLiquity } from "@liquity/lib-near";

import nearConfig from "../nearConfig";

type LiquityContext = {
  walletConnection: nearAPI.WalletConnection;
  account: string;
  liquity: NearLiquity;
  oracleAvailable: boolean;
};

const LiquityContext = createContext<LiquityContext | undefined>(undefined);

type LiquityProviderProps = {
  walletConnection: nearAPI.WalletConnection;
};

export const LiquityProvider: React.FC<LiquityProviderProps> = ({ children, walletConnection }) => {
  const liquity = new NearLiquity(walletConnection.account(), nearConfig.contractId);

  return (
    <LiquityContext.Provider
      value={{
        walletConnection,
        account: walletConnection.getAccountId(),
        liquity,
        oracleAvailable: true
      }}
    >
      {children}
    </LiquityContext.Provider>
  );
};

export const useLiquity = () => {
  const liquityContext = useContext(LiquityContext);

  if (!liquityContext) {
    throw new Error("You must provide a LiquityContext via LiquityProvider");
  }

  return liquityContext;
};
