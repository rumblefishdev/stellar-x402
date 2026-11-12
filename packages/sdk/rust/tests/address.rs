//! Terms are refused when an address in them could never be paid.

use stellar_x402::{AddressError, Network, PaymentRequirements, Price};

const ACCOUNT: &str = "GDPBXAO27ZR2M2TM6DVG5IVJ5D3C6DLHPE5FXYXKAUTM6XKPIACDAIH3";
const CONTRACT: &str = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

fn terms(pay_to: &str, price: Price) -> Result<PaymentRequirements, AddressError> {
    PaymentRequirements::exact(Network::Testnet, pay_to, price)
}

fn usdc() -> Price {
    Price::usdc("0.001").unwrap()
}

#[test]
fn an_account_a_muxed_account_and_a_contract_can_be_paid() {
    let muxed = stellar_strkey::ed25519::MuxedAccount {
        ed25519: [7; 32],
        id: 42,
    }
    .to_string()
    .as_str()
    .to_owned();

    assert!(terms(ACCOUNT, usdc()).is_ok());
    assert!(terms(&muxed, usdc()).is_ok());
    assert!(terms(CONTRACT, usdc()).is_ok());
}

#[test]
fn a_mistyped_account_is_refused() {
    // The last character changed: the checksum no longer holds.
    let typo = "GDPBXAO27ZR2M2TM6DVG5IVJ5D3C6DLHPE5FXYXKAUTM6XKPIACDAIH4";

    assert_eq!(terms(typo, usdc()), Err(AddressError::PayTo));
}

#[test]
fn a_secret_key_is_refused_as_the_account_to_pay() {
    let secret = stellar_strkey::ed25519::PrivateKey([7; 32])
        .to_string()
        .as_str()
        .to_owned();

    assert_eq!(terms(&secret, usdc()), Err(AddressError::PayTo));
}

#[test]
fn a_token_that_is_not_a_contract_is_refused() {
    assert_eq!(
        terms(ACCOUNT, Price::token(ACCOUNT, 1)),
        Err(AddressError::Token)
    );
    assert_eq!(
        terms(ACCOUNT, Price::token("USDC", 1)),
        Err(AddressError::Token)
    );
}

#[test]
fn the_error_never_repeats_the_address() {
    // A secret key pasted by mistake must not reach a log through the error.
    let secret = stellar_strkey::ed25519::PrivateKey([7; 32])
        .to_string()
        .as_str()
        .to_owned();

    let error = terms(&secret, usdc()).unwrap_err();

    assert!(!error.to_string().contains(&secret));
    assert!(!format!("{error:?}").contains(&secret));
}
