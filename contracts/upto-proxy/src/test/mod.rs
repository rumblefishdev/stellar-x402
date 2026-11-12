//! Unit tests for `UptoProxy`. Invariant tags (I1–I7) refer to spec §8.
//!
//! Tests here use `mock_auths` with the exact trees from spec §3.1/§3.2, which the host still
//! matches node by node. `real_signatures` repeats the auth properties with ed25519 signatures.

extern crate std;

mod adversarial;
mod amount_properties;
mod real_signatures;
mod settlement_properties;
mod signing;
mod ttl;
mod wasm;

use super::*;
use soroban_sdk::{
    testutils::{
        Address as _, AuthorizedFunction, AuthorizedInvocation, Events, Ledger, MockAuth,
        MockAuthInvoke,
    },
    token::{StellarAssetClient, TokenClient},
    xdr::ScVal,
    Event, InvokeError, Symbol, TryFromVal, Val, Vec,
};
use test_token::{TestToken, TestTokenClient};

const NOW: u64 = 1_500;
const SEQ: u32 = 100;
const VALID_AFTER: u64 = 1_000;
const DEADLINE: u64 = 2_000;
const EXP_LEDGER: u32 = 500;
const MAX: i128 = 1_000;
const MINTED: i128 = 10_000;

#[derive(Clone, Copy, Debug)]
enum TokenKind {
    /// The built-in Stellar Asset Contract.
    Sac,
    /// The in-repo non-SAC SEP-41 token.
    Sep41,
}

const TOKEN_KINDS: [TokenKind; 2] = [TokenKind::Sac, TokenKind::Sep41];

/// Everything a client signs or a facilitator submits, except `actual_amount`.
#[derive(Clone)]
struct Payment {
    token: Address,
    from: Address,
    to: Address,
    receiver_authorizer: Address,
    max_amount: i128,
    nonce: BytesN<32>,
    valid_after: u64,
    deadline: u64,
    exp_ledger: u32,
}

struct Setup {
    env: Env,
    proxy: Address,
    p: Payment,
}

fn new_env() -> Env {
    let env = Env::default();
    env.ledger().with_mut(|l| {
        l.timestamp = NOW;
        l.sequence_number = SEQ;
    });
    env
}

fn register_token(env: &Env, kind: TokenKind) -> Address {
    match kind {
        TokenKind::Sac => env
            .register_stellar_asset_contract_v2(Address::generate(env))
            .address(),
        TokenKind::Sep41 => env.register(TestToken, ()),
    }
}

fn mint(env: &Env, token: &Address, kind: TokenKind, to: &Address, amount: i128) {
    match kind {
        TokenKind::Sac => {
            env.mock_all_auths();
            StellarAssetClient::new(env, token).mint(to, &amount);
            env.set_auths(&[]);
        }
        TokenKind::Sep41 => TestTokenClient::new(env, token).mint(to, &amount),
    }
}

fn setup(kind: TokenKind) -> Setup {
    let env = new_env();
    let token = register_token(&env, kind);
    let from = Address::generate(&env);
    mint(&env, &token, kind, &from, MINTED);
    let p = Payment {
        token,
        from,
        to: Address::generate(&env),
        receiver_authorizer: Address::generate(&env),
        max_amount: MAX,
        nonce: BytesN::from_array(&env, &[7; 32]),
        valid_after: VALID_AFTER,
        deadline: DEADLINE,
        exp_ledger: EXP_LEDGER,
    };
    Setup {
        proxy: env.register(UptoProxy, ()),
        p,
        env,
    }
}

/// The §3 vector: what `from.require_auth_for_args` receives.
fn signed_args(env: &Env, p: &Payment) -> Vec<Val> {
    (
        p.token.clone(),
        p.to.clone(),
        p.receiver_authorizer.clone(),
        p.max_amount,
        p.nonce.clone(),
        p.valid_after,
        p.deadline,
    )
        .into_val(env)
}

/// All 10 real arguments of `settle_upto`, as the receiver authorizer authorizes them.
fn full_args(env: &Env, p: &Payment, actual: i128) -> Vec<Val> {
    (
        p.token.clone(),
        p.from.clone(),
        p.to.clone(),
        p.receiver_authorizer.clone(),
        p.max_amount,
        actual,
        p.nonce.clone(),
        p.valid_after,
        p.deadline,
        p.exp_ledger,
    )
        .into_val(env)
}

fn approve_args(env: &Env, proxy: &Address, p: &Payment) -> Vec<Val> {
    (p.from.clone(), proxy.clone(), p.max_amount, p.exp_ledger).into_val(env)
}

/// Mocks exactly the client tree (§3.1) and the receiver authorizer entry (§3.2).
fn mock_auth(s: &Setup, client: &Payment, authorizer: &Payment, actual: i128) {
    let env = &s.env;
    let approve = MockAuthInvoke {
        contract: &client.token,
        fn_name: "approve",
        args: approve_args(env, &s.proxy, client),
        sub_invokes: &[],
    };
    let client_root = MockAuthInvoke {
        contract: &s.proxy,
        fn_name: "settle_upto",
        args: signed_args(env, client),
        sub_invokes: core::slice::from_ref(&approve),
    };
    let authorizer_root = MockAuthInvoke {
        contract: &s.proxy,
        fn_name: "settle_upto",
        args: full_args(env, authorizer, actual),
        sub_invokes: &[],
    };
    env.mock_auths(&[
        MockAuth {
            address: &client.from,
            invoke: &client_root,
        },
        MockAuth {
            address: &authorizer.receiver_authorizer,
            invoke: &authorizer_root,
        },
    ]);
}

type TryResult = Result<Result<(), soroban_sdk::ConversionError>, Result<UptoError, InvokeError>>;

fn try_settle(s: &Setup, p: &Payment, actual: i128) -> TryResult {
    UptoProxyClient::new(&s.env, &s.proxy).try_settle_upto(
        &p.token,
        &p.from,
        &p.to,
        &p.receiver_authorizer,
        &p.max_amount,
        &actual,
        &p.nonce,
        &p.valid_after,
        &p.deadline,
        &p.exp_ledger,
    )
}

/// Settles `p` with the exact client and receiver authorizer trees mocked.
fn settle(s: &Setup, p: &Payment, actual: i128) -> TryResult {
    mock_auth(s, p, p, actual);
    try_settle(s, p, actual)
}

/// The proxy's allowance from `p.from`: 0 means a failed settlement left nothing behind.
fn allowance(s: &Setup, p: &Payment) -> i128 {
    TokenClient::new(&s.env, &p.token).allowance(&p.from, &s.proxy)
}

fn balance(s: &Setup, id: &Address) -> i128 {
    TokenClient::new(&s.env, &s.p.token).balance(id)
}

fn assert_contract_error(r: TryResult, expected: UptoError) {
    assert_eq!(r, Err(Ok(expected)));
}

/// Auth failures are host errors, not contract errors (§5).
fn assert_host_error(r: TryResult) {
    assert!(matches!(r, Err(Err(_))), "expected a host error, got {r:?}");
}

fn expected_event(p: &Payment, actual: i128) -> UptoSettled {
    UptoSettled {
        token: p.token.clone(),
        from: p.from.clone(),
        to: p.to.clone(),
        receiver_authorizer: p.receiver_authorizer.clone(),
        max_amount: p.max_amount,
        actual_amount: actual,
        nonce: p.nonce.clone(),
    }
}

// ---- Happy path (I1) ----

#[test]
fn settles_any_amount_up_to_max() {
    for kind in TOKEN_KINDS {
        for actual in [0, 1, 400, MAX - 1, MAX] {
            let s = setup(kind);
            let p = s.p.clone();
            assert_eq!(settle(&s, &p, actual), Ok(Ok(())), "{kind:?} {actual}");

            // The event is emitted for zero settlements too (§6).
            assert_eq!(
                s.env.events().all().filter_by_contract(&s.proxy),
                [expected_event(&p, actual).to_xdr(&s.env, &s.proxy)],
                "{kind:?} {actual}"
            );
            assert_eq!(balance(&s, &p.to), actual);
            assert_eq!(balance(&s, &p.from), MINTED - actual);
            assert_eq!(balance(&s, &s.proxy), 0);
            // The leftover allowance is spendable only by the proxy, and only with a new
            // client signature, which carries a fresh Soroban auth nonce.
            assert_eq!(allowance(&s, &p), MAX - actual);
        }
    }
}

#[test]
fn event_has_the_spec_topics_and_map_data() {
    let s = setup(TokenKind::Sac);
    let p = s.p.clone();
    settle(&s, &p, 10).unwrap().unwrap();
    let topics: Vec<Val> = (
        Symbol::new(&s.env, "upto_settled"),
        p.token.clone(),
        p.from.clone(),
        p.to.clone(),
    )
        .into_val(&s.env);
    let data = soroban_sdk::map![
        &s.env,
        (
            Symbol::new(&s.env, "actual_amount"),
            IntoVal::<Env, Val>::into_val(&10i128, &s.env)
        ),
        (
            Symbol::new(&s.env, "max_amount"),
            IntoVal::<Env, Val>::into_val(&MAX, &s.env)
        ),
        (Symbol::new(&s.env, "nonce"), p.nonce.into_val(&s.env)),
        (
            Symbol::new(&s.env, "receiver_authorizer"),
            p.receiver_authorizer.into_val(&s.env)
        ),
    ];
    assert_eq!(
        s.env.events().all().filter_by_contract(&s.proxy),
        soroban_sdk::vec![&s.env, (s.proxy.clone(), topics, data.into_val(&s.env))]
    );
}

#[test]
fn max_above_balance_settles_when_actual_is_covered() {
    for kind in TOKEN_KINDS {
        let s = setup(kind);
        let p = Payment {
            max_amount: MINTED * 2,
            ..s.p.clone()
        };
        assert_eq!(settle(&s, &p, MINTED), Ok(Ok(())), "{kind:?}");
        assert_eq!(balance(&s, &p.to), MINTED);
    }
}

#[test]
fn insufficient_balance_fails_without_side_effects() {
    for kind in TOKEN_KINDS {
        let s = setup(kind);
        let p = Payment {
            max_amount: MINTED * 2,
            ..s.p.clone()
        };
        assert_host_error(settle(&s, &p, MINTED + 1));
        assert_eq!(balance(&s, &p.from), MINTED);
        assert_eq!(allowance(&s, &p), 0, "{kind:?}: approve must roll back");
    }
}

// ---- Input validation (§4 steps 1–3) ----

#[test]
fn rejects_invalid_amounts() {
    let s = setup(TokenKind::Sac);
    for (max, actual, err) in [
        (0, 0, UptoError::InvalidAmount),
        (-1, 0, UptoError::InvalidAmount),
        (i128::MIN, 0, UptoError::InvalidAmount),
        (MAX, -1, UptoError::InvalidAmount),
        (MAX, i128::MIN, UptoError::InvalidAmount),
        (MAX, MAX + 1, UptoError::AmountExceedsMax),
        (1, i128::MAX, UptoError::AmountExceedsMax),
    ] {
        let p = Payment {
            max_amount: max,
            ..s.p.clone()
        };
        assert_contract_error(settle(&s, &p, actual), err);
        assert_eq!(allowance(&s, &p), 0);
    }
}

#[test]
fn rejects_self_payment() {
    let s = setup(TokenKind::Sac);
    let p = Payment {
        to: s.p.from.clone(),
        ..s.p.clone()
    };
    assert_contract_error(settle(&s, &p, 10), UptoError::SelfPayment);
}

#[test]
fn rejects_the_proxy_as_recipient() {
    let s = setup(TokenKind::Sac);
    let p = Payment {
        to: s.proxy.clone(),
        ..s.p.clone()
    };
    assert_contract_error(settle(&s, &p, 10), UptoError::InvalidRecipient);
}

// ---- Time bounds (I5) ----

#[test]
fn time_window_is_inclusive() {
    for (now, expected) in [
        (VALID_AFTER - 1, Err(Ok(UptoError::NotYetValid))),
        (VALID_AFTER, Ok(Ok(()))),
        (DEADLINE, Ok(Ok(()))),
        (DEADLINE + 1, Err(Ok(UptoError::Expired))),
    ] {
        let s = setup(TokenKind::Sac);
        s.env.ledger().set_timestamp(now);
        let p = s.p.clone();
        assert_eq!(settle(&s, &p, 10), expected, "now = {now}");
    }
}

#[test]
fn allowance_expiration_ledger_bounds() {
    let cap = SEQ + MAX_ALLOWANCE_LEDGERS;
    assert!(cap < setup(TokenKind::Sac).env.ledger().max_live_until_ledger());
    for kind in TOKEN_KINDS {
        for (exp, expected) in [
            (SEQ - 1, Err(Ok(UptoError::Expired))),
            (SEQ, Ok(Ok(()))),
            (SEQ + 1, Ok(Ok(()))),
            (cap, Ok(Ok(()))),
            (cap + 1, Err(Ok(UptoError::InvalidAllowanceExpiration))),
        ] {
            let s = setup(kind);
            let p = Payment {
                exp_ledger: exp,
                ..s.p.clone()
            };
            assert_eq!(settle(&s, &p, 10), expected, "{kind:?} exp = {exp}");
        }
    }
}

/// On a network whose `max_entry_ttl` is shorter than the cap, the network limit applies.
#[test]
fn allowance_expiration_ledger_stops_at_the_network_limit() {
    let s = setup(TokenKind::Sac);
    s.env.ledger().with_mut(|l| l.max_entry_ttl = 1_000);
    let max_live = s.env.ledger().max_live_until_ledger();
    assert!(max_live < SEQ + MAX_ALLOWANCE_LEDGERS);
    for (exp, expected) in [
        (max_live, Ok(Ok(()))),
        (max_live + 1, Err(Ok(UptoError::InvalidAllowanceExpiration))),
    ] {
        let p = Payment {
            exp_ledger: exp,
            nonce: BytesN::from_array(&s.env, &[exp as u8; 32]),
            ..s.p.clone()
        };
        assert_eq!(settle(&s, &p, 10), expected, "exp = {exp}");
    }
}

// ---- Single use (I4) ----
//
// Single use is Soroban's auth nonce: the host refuses the same signed entry twice
// (`real_signatures::a_signed_entry_cannot_be_replayed`). The contract stores no nonce of its own,
// so `nonce` is only a signed payment ID.

#[test]
fn the_same_payment_id_settles_again_under_a_new_signature() {
    // Mocked auth gives every call a fresh auth nonce, as a client signing a second entry does.
    let s = setup(TokenKind::Sac);
    let p = s.p.clone();
    settle(&s, &p, 10).unwrap().unwrap();
    assert_eq!(settle(&s, &p, 10), Ok(Ok(())));
    assert_eq!(balance(&s, &p.to), 20);
    assert_eq!(allowance(&s, &p), MAX - 10);
}

// ---- Authorization (I2, I3, I6) ----

#[test]
fn recorded_auth_tree_matches_the_spec() {
    for kind in TOKEN_KINDS {
        let s = setup(kind);
        let p = s.p.clone();
        s.env.mock_all_auths();
        try_settle(&s, &p, 123).unwrap().unwrap();

        let client = AuthorizedInvocation {
            function: AuthorizedFunction::Contract((
                s.proxy.clone(),
                Symbol::new(&s.env, "settle_upto"),
                signed_args(&s.env, &p),
            )),
            sub_invocations: std::vec![AuthorizedInvocation {
                function: AuthorizedFunction::Contract((
                    p.token.clone(),
                    Symbol::new(&s.env, "approve"),
                    approve_args(&s.env, &s.proxy, &p),
                )),
                sub_invocations: std::vec![],
            }],
        };
        let authorizer = AuthorizedInvocation {
            function: AuthorizedFunction::Contract((
                s.proxy.clone(),
                Symbol::new(&s.env, "settle_upto"),
                full_args(&s.env, &p, 123),
            )),
            sub_invocations: std::vec![],
        };
        // Exactly two authorizers. `transfer_from` by the proxy needs nobody's signature,
        // and the token is the only contract the client authorizes calls on (I6).
        assert_eq!(
            s.env.auths(),
            std::vec![
                (p.from.clone(), client),
                (p.receiver_authorizer.clone(), authorizer)
            ],
            "{kind:?}"
        );
    }
}

/// Converts recorded contract-call args to XDR, which, unlike `Val`s, outlive their `Env`.
fn args_to_xdr(env: &Env, args: &Vec<Val>) -> std::vec::Vec<ScVal> {
    args.iter()
        .map(|v| ScVal::try_from_val(env, &v).unwrap())
        .collect()
}

fn args_from_xdr(env: &Env, args: &[ScVal]) -> Vec<Val> {
    let mut out = Vec::new(env);
    for v in args {
        out.push_back(Val::try_from_val(env, v).unwrap());
    }
    out
}

#[test]
fn client_payload_excludes_actual_amount() {
    // Record the client tree the contract asks for while settling actual = 400.
    let recorded = setup(TokenKind::Sac);
    let p = recorded.p.clone();
    recorded.env.mock_all_auths();
    try_settle(&recorded, &p, 400).unwrap().unwrap();
    let (_, client) = recorded
        .env
        .auths()
        .into_iter()
        .find(|(addr, _)| *addr == p.from)
        .unwrap();
    let call_args = |inv: &AuthorizedInvocation| match &inv.function {
        AuthorizedFunction::Contract((_, _, args)) => args_to_xdr(&recorded.env, args),
        _ => panic!("expected a contract call"),
    };
    let root_args = call_args(&client);
    let approve = call_args(&client.sub_invocations[0]);

    // In a fresh, identical setup, the client authorizes exactly that recorded tree, and
    // the receiver authorizer authorizes actual = 10. The settlement must still go through.
    let s = setup(TokenKind::Sac);
    let p = s.p.clone();
    let approve = MockAuthInvoke {
        contract: &p.token,
        fn_name: "approve",
        args: args_from_xdr(&s.env, &approve),
        sub_invokes: &[],
    };
    let client_root = MockAuthInvoke {
        contract: &s.proxy,
        fn_name: "settle_upto",
        args: args_from_xdr(&s.env, &root_args),
        sub_invokes: core::slice::from_ref(&approve),
    };
    let authorizer_root = MockAuthInvoke {
        contract: &s.proxy,
        fn_name: "settle_upto",
        args: full_args(&s.env, &p, 10),
        sub_invokes: &[],
    };
    s.env.mock_auths(&[
        MockAuth {
            address: &p.from,
            invoke: &client_root,
        },
        MockAuth {
            address: &p.receiver_authorizer,
            invoke: &authorizer_root,
        },
    ]);
    assert_eq!(try_settle(&s, &p, 10), Ok(Ok(())));
    assert_eq!(balance(&s, &p.to), 10);
}

#[test]
fn missing_receiver_authorizer_auth_is_rejected() {
    let s = setup(TokenKind::Sac);
    let p = s.p.clone();
    let approve = MockAuthInvoke {
        contract: &p.token,
        fn_name: "approve",
        args: approve_args(&s.env, &s.proxy, &p),
        sub_invokes: &[],
    };
    s.env.mock_auths(&[MockAuth {
        address: &p.from,
        invoke: &MockAuthInvoke {
            contract: &s.proxy,
            fn_name: "settle_upto",
            args: signed_args(&s.env, &p),
            sub_invokes: core::slice::from_ref(&approve),
        },
    }]);
    assert_host_error(try_settle(&s, &p, 10));
    assert_eq!(balance(&s, &p.to), 0);
}

#[test]
fn a_different_receiver_authorizer_cannot_settle() {
    let s = setup(TokenKind::Sac);
    let signed = s.p.clone();
    let rogue = Payment {
        receiver_authorizer: Address::generate(&s.env),
        ..signed.clone()
    };
    // The rogue authorizer authorizes its own call; the client signed the original one.
    mock_auth(&s, &signed, &rogue, 10);
    assert_host_error(try_settle(&s, &rogue, 10));
    assert_eq!(balance(&s, &signed.to), 0);
}

/// Self-managed mode rests on this: the receiver authorizer signs `actual_amount`, so whoever
/// submits the transaction can't charge more than it signed.
#[test]
fn the_receiver_authorizer_signs_the_actual_amount() {
    let s = setup(TokenKind::Sac);
    let p = s.p.clone();
    mock_auth(&s, &p, &p, 10);
    assert_host_error(try_settle(&s, &p, 50));
    assert_eq!(balance(&s, &p.to), 0);
    assert_eq!(settle(&s, &p, 10), Ok(Ok(())));
}

/// Names of the fields `tampered` changes, one per signed value.
const SIGNED_FIELDS: [&str; 7] = [
    "token",
    "to",
    "max_amount",
    "nonce",
    "valid_after",
    "deadline",
    "exp_ledger",
];

/// `signed` with one signed field changed. `other_token` replaces the token.
fn tampered(env: &Env, signed: &Payment, field: &str, other_token: &Address) -> Payment {
    let mut t = signed.clone();
    match field {
        "token" => t.token = other_token.clone(),
        "to" => t.to = Address::generate(env),
        "max_amount" => t.max_amount += 1,
        "nonce" => t.nonce = BytesN::from_array(env, &[9; 32]),
        "valid_after" => t.valid_after -= 1,
        "deadline" => t.deadline += 1,
        "exp_ledger" => t.exp_ledger += 1,
        _ => unreachable!("{field}"),
    }
    t
}

#[test]
fn changing_any_signed_field_fails_client_auth() {
    for field in SIGNED_FIELDS {
        let s = setup(TokenKind::Sac);
        let signed = s.p.clone();
        let other_token = register_token(&s.env, TokenKind::Sac);
        mint(&s.env, &other_token, TokenKind::Sac, &signed.from, MINTED);
        let t = tampered(&s.env, &signed, field, &other_token);

        // Only the client tree carries the original value, so only it can fail.
        mock_auth(&s, &signed, &t, 10);
        assert_host_error(try_settle(&s, &t, 10));
        // Control: with the client tree on the same value, the same call settles.
        mock_auth(&s, &t, &t, 10);
        assert_eq!(try_settle(&s, &t, 10), Ok(Ok(())), "control for {field}");
    }
}

#[test]
fn approve_sub_invocation_is_required() {
    let s = setup(TokenKind::Sac);
    let p = s.p.clone();
    s.env.mock_auths(&[
        MockAuth {
            address: &p.from,
            invoke: &MockAuthInvoke {
                contract: &s.proxy,
                fn_name: "settle_upto",
                args: signed_args(&s.env, &p),
                sub_invokes: &[],
            },
        },
        MockAuth {
            address: &p.receiver_authorizer,
            invoke: &MockAuthInvoke {
                contract: &s.proxy,
                fn_name: "settle_upto",
                args: full_args(&s.env, &p, 10),
                sub_invokes: &[],
            },
        },
    ]);
    assert_host_error(try_settle(&s, &p, 10));
}
