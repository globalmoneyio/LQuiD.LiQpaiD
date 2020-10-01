import React, { useState, useContext, useEffect, useCallback } from "react";
import { Flex, Text, Box } from "theme-ui";

import { buildStyles, CircularProgressbarWithChildren } from "react-circular-progressbar";
import "react-circular-progressbar/dist/styles.css";

import { Tooltip, TooltipProps, Hoverable } from "./Tooltip";
import { Icon } from "./Icon";
import { WrappedNearTransaction } from "@liquity/lib-near";

const strokeWidth = 10;

const circularProgressbarStyle = {
  strokeLinecap: "butt",
  pathColor: "white",
  trailColor: "rgba(255, 255, 255, 0.33)"
};

const slowProgress = {
  strokeWidth,
  styles: buildStyles({
    ...circularProgressbarStyle,
    pathTransitionDuration: 30
  })
};

const fastProgress = {
  strokeWidth,
  styles: buildStyles({
    ...circularProgressbarStyle,
    pathTransitionDuration: 0.75
  })
};

type TransactionIdle = {
  type: "idle";
};

type TransactionFailed = {
  type: "failed";
  id: string;
  error: Error;
};

type TransactionWaitingForApproval = {
  type: "waitingForApproval";
  id: string;
};

type TransactionCancelled = {
  type: "cancelled";
  id: string;
};

type TransactionWaitingForConfirmations = {
  type: "waitingForConfirmation";
  id: string;
  tx: WrappedNearTransaction;
};

type TransactionConfirmed = {
  type: "confirmed";
  id: string;
};

type TransactionState =
  | TransactionIdle
  | TransactionFailed
  | TransactionWaitingForApproval
  | TransactionCancelled
  | TransactionWaitingForConfirmations
  | TransactionConfirmed;

const TransactionContext = React.createContext<
  [TransactionState, (state: TransactionState) => void] | undefined
>(undefined);

export const TransactionProvider: React.FC = ({ children }) => {
  const transactionState = useState<TransactionState>({ type: "idle" });
  return (
    <TransactionContext.Provider value={transactionState}>{children}</TransactionContext.Provider>
  );
};

const useTransactionState = () => {
  const transactionState = useContext(TransactionContext);

  if (!transactionState) {
    throw new Error("You must provide a TransactionContext via TransactionProvider");
  }

  return transactionState;
};

export const useMyTransactionState = (myId: string | RegExp): TransactionState => {
  const [transactionState] = useTransactionState();

  return transactionState.type !== "idle" &&
    (typeof myId === "string" ? transactionState.id === myId : transactionState.id.match(myId))
    ? transactionState
    : { type: "idle" };
};

const hasMessage = (error: unknown): error is { message: string } =>
  typeof error === "object" &&
  error !== null &&
  "message" in error &&
  typeof (error as { message: unknown }).message === "string";

type ButtonlikeProps = {
  disabled?: boolean;
  variant?: string;
  onClick?: () => void;
};

export type TransactionFunction = () => Promise<WrappedNearTransaction>;

type TransactionProps<C> = {
  id: string;
  tooltip?: string;
  tooltipPlacement?: TooltipProps<C>["placement"];
  requires?: readonly (readonly [boolean, string])[];
  send: TransactionFunction;
  children: C;
};

export function Transaction<C extends React.ReactElement<ButtonlikeProps & Hoverable>>({
  id,
  tooltip,
  tooltipPlacement,
  requires,
  send,
  children
}: TransactionProps<C>) {
  const [transactionState, setTransactionState] = useTransactionState();
  const trigger = React.Children.only<C>(children);

  const sendTransaction = useCallback(async () => {
    setTransactionState({ type: "waitingForApproval", id });

    try {
      const tx = await send();

      setTransactionState({
        type: "waitingForConfirmation",
        id,
        tx
      });
    } catch (error) {
      if (hasMessage(error) && error.message.includes("User denied transaction signature")) {
        setTransactionState({ type: "cancelled", id });
      } else {
        // console.error(error);

        setTransactionState({
          type: "failed",
          id,
          error: new Error("Failed to send transaction (try again)")
        });
      }
    }
  }, [send, id, setTransactionState]);

  const failureReasons = (requires || [])
    .filter(([requirement]) => !requirement)
    .map(([, reason]) => reason);

  if (
    transactionState.type === "waitingForApproval" ||
    transactionState.type === "waitingForConfirmation"
  ) {
    failureReasons.push("You must wait for confirmation");
  }

  const showFailure = failureReasons.length > 0 && (tooltip ? "asTooltip" : "asChildText");

  const clonedTrigger =
    showFailure === "asChildText"
      ? React.cloneElement(
          trigger,
          {
            disabled: true,
            variant: "danger"
          },
          failureReasons[0]
        )
      : showFailure === "asTooltip"
      ? React.cloneElement(trigger, { disabled: true })
      : React.cloneElement(trigger, { onClick: sendTransaction });

  if (showFailure === "asTooltip") {
    tooltip = failureReasons[0];
  }

  return tooltip ? (
    <>
      <Tooltip message={tooltip} placement={tooltipPlacement || "right"}>
        {clonedTrigger}
      </Tooltip>
    </>
  ) : (
    clonedTrigger
  );
}

const Donut = React.memo(
  CircularProgressbarWithChildren,
  ({ value: prev }, { value: next }) => prev === next
);

type TransactionProgressDonutProps = {
  state: TransactionState["type"];
  confirmations?: number;
  numberOfConfirmationsToWait?: number;
};

const TransactionProgressDonut: React.FC<TransactionProgressDonutProps> = ({
  state,
  confirmations,
  numberOfConfirmationsToWait
}) => {
  const [value, setValue] = useState(0);
  const maxValue = numberOfConfirmationsToWait || 1;
  const targetValue = (confirmations ?? 0) + 1;

  useEffect(() => {
    if (state === "confirmed") {
      setTimeout(() => setValue(maxValue), 40);
    } else {
      setTimeout(() => setValue(targetValue - 1 / 3), 20);
    }
  }, [state, targetValue, maxValue]);

  return state === "confirmed" ? (
    <Donut value={value} maxValue={maxValue} {...fastProgress}>
      <Icon name="check" color="white" size="lg" />
    </Donut>
  ) : state === "failed" || state === "cancelled" ? (
    <Donut value={0} maxValue={maxValue} {...fastProgress}>
      <Icon name="times" color="white" size="lg" />
    </Donut>
  ) : (
    <Donut {...{ value, maxValue, ...slowProgress }}>
      <Icon name="cog" color="white" size="lg" spin />
    </Donut>
  );
};

export const TransactionMonitor: React.FC = () => {
  const [transactionState, setTransactionState] = useTransactionState();

  const id = transactionState.type !== "idle" ? transactionState.id : undefined;
  const tx = transactionState.type === "waitingForConfirmation" ? transactionState.tx : undefined;

  const numberOfConfirmationsToWait = 1;
  const confirmations = transactionState.type === "waitingForConfirmation" ? 0 : undefined;

  useEffect(() => {
    if (id && tx && numberOfConfirmationsToWait) {
      let cancelled = false;
      let finished = false;

      const waitForConfirmation = async () => {
        try {
          await tx.wait();

          if (cancelled) {
            return;
          }

          setTransactionState({
            type: "confirmed",
            id
          });
        } catch (rawError) {
          if (cancelled) {
            return;
          }

          console.error(rawError);

          if (cancelled) {
            return;
          }

          setTransactionState({
            type: "failed",
            id,
            error: new Error("Failed")
          });
        }

        console.log(`Finish monitoring tx`);
        finished = true;
      };

      console.log(`Start monitoring tx`);
      waitForConfirmation();

      return () => {
        if (!finished) {
          setTransactionState({ type: "idle" });
          console.log(`Cancel monitoring tx`);
          cancelled = true;
        }
      };
    }
  }, [id, tx, numberOfConfirmationsToWait, setTransactionState]);

  useEffect(() => {
    if (
      transactionState.type === "confirmed" ||
      transactionState.type === "failed" ||
      transactionState.type === "cancelled"
    ) {
      let cancelled = false;

      setTimeout(() => {
        if (!cancelled) {
          setTransactionState({ type: "idle" });
        }
      }, 5000);

      return () => {
        cancelled = true;
      };
    }
  }, [transactionState.type, setTransactionState]);

  if (transactionState.type === "idle" || transactionState.type === "waitingForApproval") {
    return null;
  }

  return (
    <Flex
      sx={{
        alignItems: "center",
        bg:
          transactionState.type === "confirmed"
            ? "success"
            : transactionState.type === "cancelled"
            ? "warning"
            : transactionState.type === "failed"
            ? "danger"
            : "primary",
        p: 3,
        pl: 4,
        position: "fixed",
        width: "100vw",
        bottom: 0,
        overflow: "hidden",
        zIndex: 2
      }}
    >
      <Box sx={{ mr: 3, width: "40px", height: "40px" }}>
        <TransactionProgressDonut
          state={transactionState.type}
          {...{ confirmations, numberOfConfirmationsToWait }}
        />
      </Box>

      <Text sx={{ fontSize: 3, color: "white" }}>
        {transactionState.type === "waitingForConfirmation"
          ? "Waiting for confirmation"
          : transactionState.type === "cancelled"
          ? "Cancelled"
          : transactionState.type === "failed"
          ? transactionState.error.message
          : "Confirmed"}
      </Text>
    </Flex>
  );
};
