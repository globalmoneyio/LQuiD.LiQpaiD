import React, { useState, useEffect } from "react";
import { Card, Box, Heading, Flex, Button, Label, Input } from "theme-ui";
import { Transaction } from "./Transaction";

import { Decimal } from "@liquity/decimal";
import { NearLiquity } from "@liquity/lib-near";
import { useLiquity } from "../hooks/LiquityContext";
import { Icon } from "./Icon";

type PriceManagerProps = {
  liquity: NearLiquity;
  price: Decimal;
};

export const PriceManager: React.FC<PriceManagerProps> = ({ liquity, price }) => {
  const { oracleAvailable } = useLiquity();
  const [editedPrice, setEditedPrice] = useState(price.toString(2));

  useEffect(() => {
    setEditedPrice(price.toString(2));
  }, [price]);

  return (
    <Card>
      <Heading>Price</Heading>

      <Box>
        <Flex sx={{ alignItems: "stretch" }}>
          <Label>ETH</Label>

          <Label variant="unit">$</Label>

          <Input
            type="number"
            step="any"
            value={editedPrice}
            onChange={e => setEditedPrice(e.target.value)}
          />

          <Flex sx={{ ml: 2, alignItems: "center" }}>
            <Transaction
              id="set-price"
              tooltip="Set"
              tooltipPlacement="bottom"
              send={() => {
                if (!editedPrice) {
                  throw new Error("Invalid price");
                }
                return liquity.setPrice(Decimal.from(editedPrice));
              }}
            >
              <Button variant="icon">
                <Icon name="chart-line" size="lg" />
              </Button>
            </Transaction>

            <Transaction
              id="update-price"
              tooltip="Update from Oracle"
              tooltipPlacement="bottom"
              requires={[[oracleAvailable, "Only available on Ropsten"]]}
              send={liquity.updatePrice.bind(liquity)}
            >
              <Button variant="icon">
                <Icon name="redo" size="lg" />
              </Button>
            </Transaction>
          </Flex>
        </Flex>
      </Box>
    </Card>
  );
};
