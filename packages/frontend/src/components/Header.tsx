import React from "react";
import { Container, Flex, Box, Heading, Link } from "theme-ui";

import { LiquityLogo, LiquityLogoSmall } from "./LiquityLogo";
import { Abbreviation } from "./Abbreviation";

const logoHeight = "32px";

export const Header: React.FC = ({ children }) => (
  <Container variant="header">
    <Flex sx={{ alignItems: "center" }}>
      <Heading>LQuiD.LiQpaiD</Heading>

      <Box
        sx={{
          mx: [2, 3],
          width: "0px",
          height: "100%",
          borderLeft: ["none", "1px solid lightgrey"]
        }}
      />

      <Heading sx={{ fontWeight: "body", fontSize: [3, null, 4, null] }}>
        <Abbreviation short="Dev UI">Developer UI</Abbreviation>
      </Heading>
    </Flex>

    {children}
  </Container>
);
