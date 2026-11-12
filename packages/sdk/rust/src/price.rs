use crate::Network;

/// USDC has 7 decimals on Stellar.
const USDC_DECIMALS: usize = 7;

/// What a route costs: an amount of one token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Price {
    asset: Asset,
    /// In the token's base units.
    amount: u128,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Asset {
    /// The network's USDC, chosen when the terms name a network.
    Usdc,
    /// Any SEP-41 token, by its contract address.
    Token(String),
}

/// Why a decimal price was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum PriceError {
    #[error("a price is digits with at most one point between them, as in 0.001")]
    NotANumber,
    #[error("USDC has 7 decimals; the price has more")]
    TooManyDecimals,
    #[error("a price must be above zero")]
    Zero,
    #[error("the price is above what a token amount holds")]
    TooLarge,
}

impl Price {
    /// A price in USDC, written as a decimal: `"0.001"`, `"12"`.
    ///
    /// The text is read digit by digit, never as a float, so every amount is exact.
    pub fn usdc(decimal: &str) -> Result<Self, PriceError> {
        let (whole, fraction) = match decimal.split_once('.') {
            Some((whole, fraction)) => (whole, Some(fraction)),
            None => (decimal, None),
        };
        let digits = |part: &str| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit());
        if !digits(whole) || fraction.is_some_and(|part| !digits(part)) {
            return Err(PriceError::NotANumber);
        }
        let fraction = fraction.unwrap_or("");
        if fraction.len() > USDC_DECIMALS {
            return Err(PriceError::TooManyDecimals);
        }
        // Both parts are digits only, so a failed parse is an overflow.
        let scaled = format!("{whole}{fraction:0<USDC_DECIMALS$}");
        let amount: u128 = scaled.parse().map_err(|_| PriceError::TooLarge)?;
        if amount > i128::MAX as u128 {
            return Err(PriceError::TooLarge);
        }
        if amount == 0 {
            return Err(PriceError::Zero);
        }
        Ok(Self {
            asset: Asset::Usdc,
            amount,
        })
    }

    /// A price in any SEP-41 token: its contract address and an amount in its base units.
    pub fn token(contract: impl Into<String>, base_units: u128) -> Self {
        Self {
            asset: Asset::Token(contract.into()),
            amount: base_units,
        }
    }

    pub(crate) fn asset_on(&self, network: Network) -> String {
        match &self.asset {
            Asset::Usdc => network.usdc().to_owned(),
            Asset::Token(contract) => contract.clone(),
        }
    }

    pub(crate) fn amount(&self) -> u128 {
        self.amount
    }
}
