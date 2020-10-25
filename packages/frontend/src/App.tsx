import React from "react";
import { Flex, Spinner, Heading, Text, ThemeProvider, Container } from "theme-ui";

import { Decimal, Difference, Percent } from "@liquity/decimal";
import { Trove, StabilityDeposit } from "@liquity/lib-base";
import { NearLiquity as Liquity } from "@liquity/lib-near";

import { useLiquity } from "./hooks/LiquityContext";
import { useLiquityStore } from "./hooks/NearLiquityStore";
import { WalletConnector } from "./components/WalletConnector";
import { TransactionProvider, TransactionMonitor } from "./components/Transaction";
import { TroveManager } from "./components/TroveManager";
import { UserAccount } from "./components/UserAccount";
import { SystemStats } from "./components/SystemStats";
import { SystemStatsPopup } from "./components/SystemStatsPopup";
import { StabilityDepositManager } from "./components/StabilityDepositManager";
import { RiskiestTroves } from "./components/RiskiestTroves";
import { PriceManager } from "./components/PriceManager";
import { RedemptionManager } from "./components/RedemptionManager";
import { LiquidationManager } from "./components/LiquidationManager";
import { Header } from "./components/Header";
import { Footer } from "./components/Footer";
import theme from "./theme";

type LiquityFrontendProps = {
  loader?: React.ReactNode;
};

const LiquityFrontend: React.FC<LiquityFrontendProps> = ({ loader }) => {
  const { account, liquity, walletConnection } = useLiquity();
  const storeState = useLiquityStore(walletConnection, account, liquity);

  if (!storeState.loaded) {
    return <>{loader}</>;
  }

  // For console tinkering ;-)
  Object.assign(window, {
    liquity,
    store: storeState.value,
    Liquity,
    Trove,
    StabilityDeposit,
    Decimal,
    Difference,
    Percent
  });

  const {
    etherBalance,
    quiBalance,
    numberOfTroves,
    price,
    troveWithoutRewards,
    totalRedistributed,
    trove,
    total,
    deposit,
    quiInStabilityPool
  } = storeState.value;

  return (
    <>
      <Header>
        <UserAccount {...{ account, etherBalance, quiBalance }} />

        <SystemStatsPopup
          {...{
            numberOfTroves,
            price,
            total,
            quiInStabilityPool,
            etherBalance,
            quiBalance
          }}
        />
      </Header>

      <Container variant="main">
        <Container variant="columns">
          <Container variant="left">
            <TroveManager
              {...{ liquity, troveWithoutRewards, trove, price, total, quiBalance, numberOfTroves }}
            />
            <StabilityDepositManager
              {...{ liquity, deposit, trove, price, quiBalance, numberOfTroves }}
            />
            <RedemptionManager {...{ liquity, price, quiBalance, numberOfTroves }} />
          </Container>

          <Container variant="right">
            <SystemStats
              {...{
                numberOfTroves,
                price,
                total,
                quiInStabilityPool
              }}
            />
            <PriceManager {...{ liquity, price }} />
            <LiquidationManager {...{ liquity }} />
          </Container>
        </Container>

        <RiskiestTroves pageSize={10} {...{ liquity, price, totalRedistributed, numberOfTroves }} />
      </Container>

      <Footer>
        <Text>:)</Text>
      </Footer>

      <TransactionMonitor />
    </>
  );
};

const App = () => {
  const loader = (
    <Flex sx={{ alignItems: "center", justifyContent: "center", height: "100vh" }}>
      <Spinner sx={{ m: 2, color: "text" }} size="32px" />
      <Heading>Loading...</Heading>
    </Flex>
  );

  return (
    <ThemeProvider theme={theme}>
      <WalletConnector {...{ loader }}>
        <TransactionProvider>
          <LiquityFrontend {...{ loader }} />
        </TransactionProvider>
      </WalletConnector>
    </ThemeProvider>
  );
};

export default App;
