import React, { useEffect, useState } from "react";
import { Button, Flex, Box } from "theme-ui";
import * as nearAPI from "near-api-js";

import nearConfig from "../nearConfig";

import { LiquityProvider } from "../hooks/LiquityContext";

import { Icon } from "./Icon";

type WalletConnectorProps = {
  loader?: React.ReactNode;
};

export const WalletConnector: React.FC<WalletConnectorProps> = ({ children, loader }) => {
  const [near, setNear] = useState<nearAPI.Near>();

  useEffect(() => {
    nearAPI
      .connect({
        deps: { keyStore: new nearAPI.keyStores.BrowserLocalStorageKeyStore() },
        ...nearConfig
      } as any)
      .then(setNear);
  }, []);

  if (!near) {
    return <>{loader}</>;
  }

  const walletConnection = new nearAPI.WalletConnection(near, "liquity");

  if (walletConnection.isSignedIn()) {
    return <LiquityProvider {...{ walletConnection }}>{children}</LiquityProvider>;
  }

  return (
    <>
      <Flex sx={{ height: "100vh", justifyContent: "center", alignItems: "center" }}>
        <Button
          onClick={() =>
            walletConnection.requestSignIn(nearConfig.contractId, "Liquity Developer Interface")
          }
        >
          <Icon name="plug" size="lg" />
          <Box sx={{ ml: 2 }}>Connect wallet</Box>
        </Button>
      </Flex>
    </>
  );
};
