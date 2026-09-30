extern crate std;

use super::*;
use soroban_sdk::{
    testutils::{
        Address as _, AuthorizedFunction, AuthorizedInvocation, Ledger, MockAuth, MockAuthInvoke,
    },
    token::{StellarAssetClient, TokenClient},
    IntoVal, Symbol, Val, Vec,
};

struct Setup {
    env: Env,
    proxy: Address,
    token: Address,
    from: Address,
    to: Address,
    facilitator: Address,
    nonce: BytesN<32>,
}

const MAX: i128 = 1_000;
const VALID_AFTER: u64 = 1_000;
const DEADLINE: u64 = 2_000;
const EXP_LEDGER: u32 = 500;

fn setup() -> Setup {
    let env = Env::default();
    env.ledger().with_mut(|l| {
        l.timestamp = 1_500;
        l.sequence_number = 100;
    });
    let admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(admin);
    let token = sac.address();
    let from = Address::generate(&env);
    env.mock_all_auths();
    StellarAssetClient::new(&env, &token).mint(&from, &10_000);
    env.set_auths(&[]);
    Setup {
        proxy: env.register(UptoSpike, ()),
        to: Address::generate(&env),
        facilitator: Address::generate(&env),
        nonce: BytesN::from_array(&env, &[7; 32]),
        token,
        from,
        env,
    }
}

fn signed_args(s: &Setup) -> Vec<Val> {
    (
        s.token.clone(),
        s.to.clone(),
        s.facilitator.clone(),
        MAX,
        s.nonce.clone(),
        VALID_AFTER,
        DEADLINE,
    )
        .into_val(&s.env)
}

fn full_args(s: &Setup, actual: i128) -> Vec<Val> {
    (
        s.token.clone(),
        s.from.clone(),
        s.to.clone(),
        s.facilitator.clone(),
        MAX,
        actual,
        s.nonce.clone(),
        VALID_AFTER,
        DEADLINE,
        EXP_LEDGER,
    )
        .into_val(&s.env)
}

/// Enforce exactly the tree a client signs: root = settle_upto(signed args),
/// one sub-invocation = token.approve(from, proxy, MAX, EXP_LEDGER).
fn mock_client_and_facilitator(s: &Setup, fn_name: &str, actual: i128) {
    let approve_args = (s.from.clone(), s.proxy.clone(), MAX, EXP_LEDGER).into_val(&s.env);
    let approve = MockAuthInvoke {
        contract: &s.token,
        fn_name: "approve",
        args: approve_args,
        sub_invokes: &[],
    };
    let client_root = MockAuthInvoke {
        contract: &s.proxy,
        fn_name,
        args: signed_args(s),
        sub_invokes: core::slice::from_ref(&approve),
    };
    let facilitator_root = MockAuthInvoke {
        contract: &s.proxy,
        fn_name,
        args: full_args(s, actual),
        sub_invokes: &[],
    };
    s.env.mock_auths(&[
        MockAuth {
            address: &s.from,
            invoke: &client_root,
        },
        MockAuth {
            address: &s.facilitator,
            invoke: &facilitator_root,
        },
    ]);
}

type TryResult = Result<
    Result<(), soroban_sdk::ConversionError>,
    Result<soroban_sdk::Error, soroban_sdk::InvokeError>,
>;

fn try_settle(s: &Setup, actual: i128) -> TryResult {
    let c = UptoSpikeClient::new(&s.env, &s.proxy);
    c.try_settle_upto(
        &s.token,
        &s.from,
        &s.to,
        &s.facilitator,
        &MAX,
        &actual,
        &s.nonce,
        &VALID_AFTER,
        &DEADLINE,
        &EXP_LEDGER,
    )
}

fn settle(s: &Setup, actual: i128) -> Result<(), ()> {
    try_settle(s, actual).map(|_| ()).map_err(|_| ())
}

#[test]
fn same_client_tree_settles_any_amount_up_to_max() {
    for actual in [0, 1, 400, MAX] {
        let s = setup();
        mock_client_and_facilitator(&s, "settle_upto", actual);
        settle(&s, actual).expect("settle");
        let t = TokenClient::new(&s.env, &s.token);
        assert_eq!(t.balance(&s.to), actual);
        assert_eq!(t.balance(&s.from), 10_000 - actual);
        // Leftover allowance is max - actual, spendable only by the proxy.
        assert_eq!(t.allowance(&s.from, &s.proxy), MAX - actual);
    }
}

#[test]
fn over_max_is_rejected() {
    let s = setup();
    mock_client_and_facilitator(&s, "settle_upto", MAX + 1);
    assert_eq!(
        try_settle(&s, MAX + 1),
        Err(Ok(SpikeError::AmountExceedsMax.into()))
    );
}

#[test]
fn replay_is_rejected() {
    let s = setup();
    mock_client_and_facilitator(&s, "settle_upto", 10);
    settle(&s, 10).expect("first settle");
    mock_client_and_facilitator(&s, "settle_upto", 10);
    assert_eq!(try_settle(&s, 10), Err(Ok(SpikeError::NonceUsed.into())));
}

#[test]
fn changed_recipient_does_not_match_client_tree() {
    let s = setup();
    mock_client_and_facilitator(&s, "settle_upto", 10);
    let other = Setup {
        to: Address::generate(&s.env),
        env: s.env.clone(),
        proxy: s.proxy.clone(),
        token: s.token.clone(),
        from: s.from.clone(),
        facilitator: s.facilitator.clone(),
        nonce: s.nonce.clone(),
    };
    assert!(settle(&other, 10).is_err());
}

#[test]
fn missing_facilitator_auth_is_rejected() {
    let s = setup();
    let approve_args = (s.from.clone(), s.proxy.clone(), MAX, EXP_LEDGER).into_val(&s.env);
    let approve = MockAuthInvoke {
        contract: &s.token,
        fn_name: "approve",
        args: approve_args,
        sub_invokes: &[],
    };
    s.env.mock_auths(&[MockAuth {
        address: &s.from,
        invoke: &MockAuthInvoke {
            contract: &s.proxy,
            fn_name: "settle_upto",
            args: signed_args(&s),
            sub_invokes: core::slice::from_ref(&approve),
        },
    }]);
    assert!(settle(&s, 10).is_err());
}

#[test]
fn approve_before_require_auth_does_not_match_the_same_tree() {
    let s = setup();
    mock_client_and_facilitator(&s, "settle_wrong_order", 10);
    let c = UptoSpikeClient::new(&s.env, &s.proxy);
    let r = c.try_settle_wrong_order(
        &s.token,
        &s.from,
        &s.to,
        &s.facilitator,
        &MAX,
        &10,
        &s.nonce,
        &VALID_AFTER,
        &DEADLINE,
        &EXP_LEDGER,
    );
    assert!(r.is_err(), "wrong call order unexpectedly matched the tree");
}

#[test]
fn recorded_tree_has_no_actual_amount() {
    let s = setup();
    s.env.mock_all_auths();
    settle(&s, 123).expect("settle");
    let auths = s.env.auths();
    let client = auths
        .iter()
        .find(|(a, _)| a == &s.from)
        .expect("client auth");
    let expected = AuthorizedInvocation {
        function: AuthorizedFunction::Contract((
            s.proxy.clone(),
            Symbol::new(&s.env, "settle_upto"),
            signed_args(&s),
        )),
        sub_invocations: std::vec![AuthorizedInvocation {
            function: AuthorizedFunction::Contract((
                s.token.clone(),
                Symbol::new(&s.env, "approve"),
                (s.from.clone(), s.proxy.clone(), MAX, EXP_LEDGER).into_val(&s.env),
            )),
            sub_invocations: std::vec![],
        }],
    };
    assert_eq!(client.1, expected);
    // transfer_from by the proxy produced no auth requirement for anyone.
    assert!(auths
        .iter()
        .all(|(a, _)| a == &s.from || a == &s.facilitator));
}
