import React, { useState, useEffect } from "react";
import { Button, Box, Flex, Spinner, Card, Heading } from "theme-ui";

import { Decimal } from "@liquity/decimal";
import { NearLiquity } from "@liquity/lib-near";
import { Transaction, useMyTransactionState } from "./Transaction";
import { LoadingOverlay } from "./LoadingOverlay";
import { EditableRow } from "./Editor";
import { Icon } from "./Icon";

type RedemptionActionProps = {
  liquity: NearLiquity;
  price: Decimal;
  exchangedQui: Decimal;
  setExchangedQui: (exchangedQui: Decimal) => void;
  changePending: boolean;
  setChangePending: (isPending: boolean) => void;
  quiBalance: Decimal;
  numberOfTroves: number;
};

const RedemptionAction: React.FC<RedemptionActionProps> = ({
  liquity,
  price,
  exchangedQui,
  setExchangedQui,
  changePending,
  setChangePending,
  quiBalance,
  numberOfTroves
}) => {
  const myTransactionId = "redemption";
  const myTransactionState = useMyTransactionState(myTransactionId);
  const tentativelyConfirmed = myTransactionState.type === "confirmed";

  useEffect(() => {
    if (myTransactionState.type === "waitingForApproval") {
      setChangePending(true);
    } else if (myTransactionState.type === "failed" || myTransactionState.type === "cancelled") {
      setChangePending(false);
    } else if (tentativelyConfirmed) {
      setExchangedQui(Decimal.from(0));
      setChangePending(false);
    }
  }, [myTransactionState.type, setChangePending, setExchangedQui, tentativelyConfirmed]);

  if (exchangedQui.isZero) {
    return null;
  }

  const send = liquity.redeemCollateral.bind(liquity, exchangedQui, { price, numberOfTroves });

  return myTransactionState.type === "waitingForApproval" ? (
    <Flex variant="layout.actions">
      <Button disabled sx={{ mx: 2 }}>
        <Spinner sx={{ mr: 2, color: "white" }} size="20px" />
        Waiting for your approval
      </Button>
    </Flex>
  ) : changePending ? null : (
    <Flex variant="layout.actions">
      <Transaction
        id={myTransactionId}
        requires={[[quiBalance.gte(exchangedQui), "You don't have enough LQD"]]}
        {...{ send }}
      >
        <Button sx={{ mx: 2 }}>Exchange {exchangedQui.prettify()} LQD</Button>
      </Transaction>
    </Flex>
  );
};

type RedemptionManagerProps = {
  liquity: NearLiquity;
  price: Decimal;
  quiBalance: Decimal;
  numberOfTroves: number;
};

export const RedemptionManager: React.FC<RedemptionManagerProps> = ({
  liquity,
  price,
  quiBalance,
  numberOfTroves
}) => {
  const zero = Decimal.from(0);
  const [exchangedQui, setExchangedQui] = useState(zero);
  const [changePending, setChangePending] = useState(false);

  const editingState = useState<string>();

  const edited = exchangedQui.nonZero !== undefined;

  return (
    <>
      <Card>
        <Heading>
          Redeem Collateral with LQD
          {edited && !changePending && (
            <Button
              variant="titleIcon"
              sx={{ ":enabled:hover": { color: "danger" } }}
              onClick={() => setExchangedQui(zero)}
            >
              <Icon name="history" size="lg" />
            </Button>
          )}
        </Heading>

        {changePending && <LoadingOverlay />}

        <Box>
          <EditableRow
            label="Exchange"
            inputId="redeem-exchange"
            amount={exchangedQui.prettify()}
            unit="LQD"
            {...{ editingState }}
            editedAmount={exchangedQui.toString(2)}
            setEditedAmount={editedQui => setExchangedQui(Decimal.from(editedQui))}
          ></EditableRow>

          <EditableRow
            label="Redeem"
            inputId="redeem-eth"
            amount={exchangedQui.div(price).prettify(4)}
            unit="NEAR"
            {...{ editingState }}
            editedAmount={exchangedQui.div(price).toString(4)}
            setEditedAmount={editedEth => setExchangedQui(Decimal.from(editedEth).mul(price))}
          ></EditableRow>
        </Box>
      </Card>

      <RedemptionAction
        {...{
          liquity,
          price,
          exchangedQui,
          setExchangedQui,
          changePending,
          setChangePending,
          quiBalance,
          numberOfTroves
        }}
      />
    </>
  );
};
