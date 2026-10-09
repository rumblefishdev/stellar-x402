//! Property tests over the settlement window (I5) and over sequences of settlements (I1, I4).

use super::*;
use proptest::prelude::*;

proptest! {
    #![proptest_config(ProptestConfig::with_cases(256))]

    /// Any time window and expiry ledger gives exactly the result of the spec's check order
    /// (§4 steps 6–7), and the nonce and allowance are written only on success.
    #[test]
    fn window_follows_the_check_order(
        now in 0u64..4_000,
        valid_after in 0u64..4_000,
        deadline in 0u64..4_000,
        exp_offset in -50i64..5_000,
    ) {
        let s = setup(TokenKind::Sac);
        s.env.ledger().set_timestamp(now);
        let max_live = s.env.ledger().max_live_until_ledger();
        let exp = (i64::from(SEQ) + exp_offset).clamp(0, i64::from(max_live) + 1) as u32;
        let p = Payment { valid_after, deadline, exp_ledger: exp, ..s.p.clone() };

        let expected = if now < valid_after {
            Err(Ok(UptoError::NotYetValid))
        } else if now > deadline || exp < SEQ {
            Err(Ok(UptoError::Expired))
        } else if exp > max_live {
            Err(Ok(UptoError::InvalidAllowanceExpiration))
        } else {
            Ok(Ok(()))
        };
        let settled = expected.is_ok();
        prop_assert_eq!(settle(&s, &p, 5), expected);
        prop_assert_eq!(nonce_used(&s, &p), settled);
        prop_assert_eq!(balance(&s, &p.to), if settled { 5 } else { 0 });
        let allowance = TokenClient::new(&s.env, &p.token).allowance(&p.from, &s.proxy);
        prop_assert_eq!(allowance, if settled { MAX - 5 } else { 0 });
    }

    /// Whatever sequence of (nonce, amount) a facilitator submits for one payer, each nonce pays
    /// at most once, the seller gets exactly the sum of the successful amounts, no value is
    /// created or lost, and the proxy never holds funds.
    #[test]
    fn settlement_sequences_conserve_value(
        ops in proptest::collection::vec((0u8..4, 0i128..=1_200), 1..12),
    ) {
        let s = setup(TokenKind::Sac);
        let mut used = std::collections::BTreeSet::new();
        let mut paid = 0;
        for (n, actual) in ops {
            let p = Payment { nonce: BytesN::from_array(&s.env, &[n; 32]), ..s.p.clone() };
            let result = settle(&s, &p, actual);
            if !used.contains(&n) && actual <= MAX && paid + actual <= MINTED {
                prop_assert_eq!(result, Ok(Ok(())));
                used.insert(n);
                paid += actual;
            } else {
                prop_assert!(result.is_err());
            }
            prop_assert_eq!(balance(&s, &s.p.from) + balance(&s, &s.p.to), MINTED);
            prop_assert_eq!(balance(&s, &s.p.to), paid);
            prop_assert_eq!(balance(&s, &s.proxy), 0);
        }
    }
}
