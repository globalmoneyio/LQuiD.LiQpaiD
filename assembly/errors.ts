export const ERR_INVALID_AMOUNT = 'Amount must be greater than zero'
export const ERR_INVALID_ACCOUNT = 'Account not found in registry'
export const ERR_INVALID_ACCOUNT_ID = 'Account Id is not valid'
export const ERR_USER_EXISTS = "CDP already exists for this user, use adjustLoan"
export const ERR_CDP_INACTIVE = "Trove does not exist or is closed"
export const ERR_IN_RECOVERY = "Operation not permitted during Recovery Mode"
export const ERR_ICR_BELOW_MCR = "An operation that would result in ICR < MCR is not permitted"
export const ERR_CCR_BELOW_TCR = "An operation that would result in TCR < CCR is not permitted"
export const ERR_OVERDRAW_ETH = "Insufficient balance for ETH withdrawal"
export const ERR_COL_VAL_BELOW_MIN = "Remaining collateral must have $USD value >= 20, or be zero"
export const ERR_AMT_BELOW_ZERO = "Amount must be larger than 0"
export const ERR_REPAY_OVER = "Amount repaid must not be larger than the CDP's debt"