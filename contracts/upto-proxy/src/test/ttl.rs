//! The contract keeps its own instance and code alive (task 0035): every successful settlement
//! calls `extend_ttl_with_limits(TTL_EXTEND_TO, TTL_MIN_EXTENSION, TTL_MAX_EXTENSION)`.

use super::*;
use soroban_sdk::testutils::Deployer as _;

fn ttls(s: &Setup) -> (u32, u32) {
    let d = s.env.deployer();
    (
        d.get_contract_instance_ttl(&s.proxy),
        d.get_contract_code_ttl(&s.proxy),
    )
}

/// Sets the instance and code TTL to `ttl`, as a deploy-time extension would.
fn set_ttl(s: &Setup, ttl: u32) {
    s.env
        .as_contract(&s.proxy, || s.env.storage().instance().extend_ttl(ttl, ttl));
    assert_eq!(ttls(s), (ttl, ttl));
}

/// `s.p` with its own nonce, so each call is a fresh settlement.
fn fresh(s: &Setup, n: u8) -> Payment {
    Payment {
        nonce: BytesN::from_array(&s.env, &[n; 32]),
        ..s.p.clone()
    }
}

#[test]
fn settlement_extends_instance_and_code_by_at_most_the_cap() {
    for actual in [10, 0] {
        let s = setup(TokenKind::Sac);
        let (instance, code) = ttls(&s);
        assert!(instance + TTL_MAX_EXTENSION < TTL_EXTEND_TO);

        settle(&s, &s.p.clone(), actual).unwrap().unwrap();
        assert_eq!(
            ttls(&s),
            (instance + TTL_MAX_EXTENSION, code + TTL_MAX_EXTENSION)
        );
    }
}

#[test]
fn extension_stops_at_the_target() {
    let s = setup(TokenKind::Sac);
    set_ttl(&s, TTL_EXTEND_TO - TTL_MAX_EXTENSION - 200);

    settle(&s, &fresh(&s, 1), 10).unwrap().unwrap();
    assert_eq!(ttls(&s).0, TTL_EXTEND_TO - 200);
    // 200 >= TTL_MIN_EXTENSION: the last gap is closed, up to the target and no further.
    settle(&s, &fresh(&s, 2), 10).unwrap().unwrap();
    assert_eq!(ttls(&s), (TTL_EXTEND_TO, TTL_EXTEND_TO));
    settle(&s, &fresh(&s, 3), 10).unwrap().unwrap();
    assert_eq!(ttls(&s), (TTL_EXTEND_TO, TTL_EXTEND_TO));
}

#[test]
fn gains_under_the_minimum_are_skipped() {
    let s = setup(TokenKind::Sac);
    set_ttl(&s, TTL_EXTEND_TO);
    // TTL_MIN_EXTENSION - 1 ledgers later the possible gain is too small: no extension, no rent.
    let later = SEQ + TTL_MIN_EXTENSION - 1;
    s.env.ledger().set_sequence_number(later);
    let p = Payment {
        exp_ledger: later + 10,
        ..fresh(&s, 1)
    };
    settle(&s, &p, 10).unwrap().unwrap();
    let left = TTL_EXTEND_TO - (TTL_MIN_EXTENSION - 1);
    assert_eq!(ttls(&s), (left, left));

    // One ledger more and the gain reaches the minimum.
    s.env.ledger().set_sequence_number(later + 1);
    let p = Payment {
        exp_ledger: later + 10,
        ..fresh(&s, 2)
    };
    settle(&s, &p, 10).unwrap().unwrap();
    assert_eq!(ttls(&s), (TTL_EXTEND_TO, TTL_EXTEND_TO));
}

#[test]
fn failed_settlement_extends_nothing() {
    let s = setup(TokenKind::Sac);
    let before = ttls(&s);
    assert_contract_error(
        settle(&s, &s.p.clone(), MAX + 1),
        UptoError::AmountExceedsMax,
    );
    assert_eq!(ttls(&s), before);
}
