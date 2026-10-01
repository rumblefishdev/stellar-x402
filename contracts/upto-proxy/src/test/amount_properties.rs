//! Property test over amount bounds (I1, §4 steps 1–2), with the payer's balance covering
//! any valid `actual_amount`.

use super::*;
use proptest::prelude::*;

fn amounts() -> impl Strategy<Value = (i128, i128)> {
    let max = prop_oneof![
        Just(i128::MIN),
        -1_000i128..=0,
        1i128..=1_000,
        1i128..=i128::MAX / 2,
        Just(i128::MAX),
    ];
    max.prop_flat_map(|max| {
        let actual = prop_oneof![
            Just(i128::MIN),
            -1_000i128..=0,
            Just(max),
            Just(max.saturating_add(1)),
            0..=max.max(0),
            Just(i128::MAX),
        ];
        (Just(max), actual)
    })
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(128))]

    #[test]
    fn amount_bounds((max, actual) in amounts()) {
        let s = setup(TokenKind::Sac);
        // The test mints its own balance so any valid actual is covered.
        let from = Address::generate(&s.env);
        mint(&s.env, &s.p.token, TokenKind::Sac, &from, i128::MAX);
        let p = Payment { from: from.clone(), max_amount: max, ..s.p.clone() };

        let result = settle(&s, &p, actual);
        let failed = result.is_err();
        if max <= 0 || actual < 0 {
            prop_assert_eq!(result, Err(Ok(UptoError::InvalidAmount)));
        } else if actual > max {
            prop_assert_eq!(result, Err(Ok(UptoError::AmountExceedsMax)));
        } else {
            prop_assert_eq!(result, Ok(Ok(())));
            prop_assert_eq!(balance(&s, &p.to), actual);
            prop_assert_eq!(balance(&s, &from), i128::MAX - actual);
            prop_assert_eq!(balance(&s, &s.proxy), 0);
            let t = TokenClient::new(&s.env, &p.token);
            prop_assert_eq!(t.allowance(&from, &s.proxy), max - actual);
        }
        if failed {
            prop_assert!(!nonce_used(&s, &p));
            prop_assert_eq!(balance(&s, &from), i128::MAX);
        }
    }
}
