//! A USDC price written as a decimal becomes whole base units, 7 decimals, without floats.

use stellar_x402::{Network, PaymentRequirements, Price, PriceError};

fn base_units(price: &str) -> String {
    let terms = PaymentRequirements::exact(
        Network::Testnet,
        "GDPBXAO27ZR2M2TM6DVG5IVJ5D3C6DLHPE5FXYXKAUTM6XKPIACDAIH3",
        Price::usdc(price).unwrap(),
    )
    .unwrap();
    serde_json::to_value(terms).unwrap()["amount"]
        .as_str()
        .unwrap()
        .to_owned()
}

#[test]
fn a_fraction_is_scaled_to_seven_decimals() {
    assert_eq!(base_units("0.001"), "10000");
}

#[test]
fn the_smallest_unit_is_one() {
    assert_eq!(base_units("0.0000001"), "1");
}

#[test]
fn a_whole_number_needs_no_point() {
    assert_eq!(base_units("12"), "120000000");
}

#[test]
fn an_amount_above_what_a_float_holds_exactly_is_kept() {
    assert_eq!(
        base_units("9007199254740993.0000001"),
        "90071992547409930000001"
    );
}

#[test]
fn more_than_seven_decimals_are_refused() {
    assert_eq!(Price::usdc("0.00000001"), Err(PriceError::TooManyDecimals));
}

#[test]
fn zero_is_refused() {
    assert_eq!(Price::usdc("0"), Err(PriceError::Zero));
    assert_eq!(Price::usdc("0.0000000"), Err(PriceError::Zero));
}

#[test]
fn anything_but_digits_and_one_point_is_refused() {
    for text in [
        "", "-1", "+1", "1e3", "1,5", "1.2.3", ".5", "5.", " 1", "$1",
    ] {
        assert_eq!(Price::usdc(text), Err(PriceError::NotANumber), "{text:?}");
    }
}

#[test]
fn an_amount_too_large_for_a_token_is_refused() {
    // SEP-41 amounts are i128.
    let text = format!("{}", u128::MAX);
    assert_eq!(Price::usdc(&text), Err(PriceError::TooLarge));
}
