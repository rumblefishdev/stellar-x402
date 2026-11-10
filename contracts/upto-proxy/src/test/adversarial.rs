//! Attacks from the 0035 security review: what a facilitator, a token or a payer could try beyond
//! the spec's own cases. Each test names the attack and pins the outcome.

use super::*;
use soroban_sdk::{contract, contractimpl, contracttype};

/// A facilitator alone settles with the proxy itself as payer, to take tokens sent to the proxy
/// by mistake. The proxy can't authorize itself as `from`, so the host refuses.
#[test]
fn proxy_as_payer_cannot_drain_its_balance() {
    let s = setup(TokenKind::Sac);
    mint(&s.env, &s.p.token, TokenKind::Sac, &s.proxy, 500);
    let p = Payment {
        from: s.proxy.clone(),
        ..s.p.clone()
    };
    s.env.mock_auths(&[MockAuth {
        address: &p.facilitator,
        invoke: &MockAuthInvoke {
            contract: &s.proxy,
            fn_name: "settle_upto",
            args: full_args(&s.env, &p, 500),
            sub_invokes: &[],
        },
    }]);
    assert_host_error(try_settle(&s, &p, 500));
    assert_eq!(balance(&s, &s.proxy), 500);
}

/// The leftover allowance (`max - actual`) can't be spent without a new client signature: not by
/// the facilitator through the proxy, not by anyone calling `transfer_from` directly.
#[test]
fn leftover_allowance_needs_a_new_client_signature() {
    let s = setup(TokenKind::Sac);
    settle(&s, &s.p.clone(), 10).unwrap().unwrap();
    let token = TokenClient::new(&s.env, &s.p.token);
    assert_eq!(token.allowance(&s.p.from, &s.proxy), MAX - 10);

    let p = Payment {
        nonce: BytesN::from_array(&s.env, &[9; 32]),
        ..s.p.clone()
    };
    s.env.mock_auths(&[MockAuth {
        address: &p.facilitator,
        invoke: &MockAuthInvoke {
            contract: &s.proxy,
            fn_name: "settle_upto",
            args: full_args(&s.env, &p, MAX - 10),
            sub_invokes: &[],
        },
    }]);
    assert_host_error(try_settle(&s, &p, MAX - 10));

    s.env.set_auths(&[]);
    let thief = Address::generate(&s.env);
    assert!(token
        .try_transfer_from(&s.proxy, &s.p.from, &thief, &1)
        .is_err());
    assert_eq!(balance(&s, &s.p.from), MINTED - 10);
}

/// A token whose `approve` makes one more `settle_upto` call, on `target`, with its own valid
/// arguments: another token (so the inner call doesn't come back into this one), distinct
/// recipient and facilitator, a fresh nonce. Records the inner call's
/// outcome: 0 settled, 1 contract error, 2 host error.
#[contract]
pub struct ReentrantToken;

#[contracttype]
#[derive(Clone)]
enum ReentryKey {
    Armed,
    Outcome,
}

#[contractimpl]
impl ReentrantToken {
    pub fn arm(env: Env, target: Address, token: Address, to: Address, facilitator: Address) {
        env.storage()
            .instance()
            .set(&ReentryKey::Armed, &(target, token, to, facilitator));
    }

    pub fn approve(env: Env, from: Address, _spender: Address, amount: i128, expiration: u32) {
        let armed: Option<(Address, Address, Address, Address)> =
            env.storage().instance().get(&ReentryKey::Armed);
        let Some((target, token, to, facilitator)) = armed else {
            return;
        };
        env.storage().instance().remove(&ReentryKey::Armed);
        let outcome: u32 = match UptoProxyClient::new(&env, &target).try_settle_upto(
            &token,
            &from,
            &to,
            &facilitator,
            &amount,
            &0,
            &BytesN::from_array(&env, &[1; 32]),
            &0,
            &u64::MAX,
            &expiration,
        ) {
            Ok(_) => 0,
            Err(Ok(_)) => 1,
            Err(Err(_)) => 2,
        };
        env.storage().instance().set(&ReentryKey::Outcome, &outcome);
    }

    pub fn outcome(env: Env) -> Option<u32> {
        env.storage().instance().get(&ReentryKey::Outcome)
    }
}

/// The token's inner call settles when it targets another proxy instance, so its arguments and
/// auth are valid; aimed at the proxy already on the call stack, the same call fails with a host
/// error. Re-entry is the only difference.
#[test]
fn a_token_cannot_reenter_the_proxy() {
    for reenter in [false, true] {
        let s = setup(TokenKind::Sac);
        let token = s.env.register(ReentrantToken, ());
        let target = if reenter {
            s.proxy.clone()
        } else {
            s.env.register(UptoProxy, ())
        };
        let client = ReentrantTokenClient::new(&s.env, &token);
        client.arm(
            &target,
            &s.p.token,
            &Address::generate(&s.env),
            &Address::generate(&s.env),
        );
        let p = Payment {
            token: token.clone(),
            ..s.p.clone()
        };
        s.env.mock_all_auths_allowing_non_root_auth();
        assert_eq!(try_settle(&s, &p, 0), Ok(Ok(())));
        assert_eq!(
            client.outcome(),
            Some(if reenter { 2 } else { 0 }),
            "reenter = {reenter}"
        );
    }
}

/// A token that ignores `approve` and `transfer_from`: the settlement succeeds and emits its event
/// with no value moved. The contract can't tell; the facilitator must take the token from the
/// seller's requirements and check balance changes in its simulation (threat model, "Malicious or
/// non-standard token").
#[contract]
pub struct NoopToken;

#[contractimpl]
impl NoopToken {
    pub fn approve(_env: Env, _from: Address, _spender: Address, _amount: i128, _exp: u32) {}
    pub fn transfer_from(_env: Env, _spender: Address, _from: Address, _to: Address, _a: i128) {}
}

#[test]
fn a_noop_token_settles_without_moving_value() {
    let s = setup(TokenKind::Sac);
    let p = Payment {
        token: s.env.register(NoopToken, ()),
        ..s.p.clone()
    };
    assert_eq!(settle(&s, &p, 10), Ok(Ok(())));
    assert_eq!(s.env.events().all().events().len(), 1);
    assert!(nonce_used(&s, &p));
}

/// The facilitator can't also be the payer: the same address would authorize twice in one call,
/// which the host refuses. Paying the facilitator itself is fine.
#[test]
fn the_facilitator_cannot_be_the_payer() {
    let s = setup(TokenKind::Sac);
    let p = Payment {
        facilitator: s.p.from.clone(),
        ..s.p.clone()
    };
    s.env.mock_all_auths();
    assert_host_error(try_settle(&s, &p, 10));

    let s = setup(TokenKind::Sac);
    let p = Payment {
        to: s.p.facilitator.clone(),
        ..s.p.clone()
    };
    assert_eq!(settle(&s, &p, 10), Ok(Ok(())));
}

/// A nonce is unique only while its entry lives (I4). Once the entry has expired, the same nonce
/// settles again under a new signature with a later expiry; the old signed tree can't, because
/// its `allowance_expiration_ledger` is in the past.
#[test]
fn a_nonce_is_reusable_only_after_its_entry_expired() {
    let s = setup(TokenKind::Sac);
    let first = Payment {
        exp_ledger: SEQ + 20,
        ..s.p.clone()
    };
    settle(&s, &first, 10).unwrap().unwrap();
    s.env.ledger().set_sequence_number(SEQ + 40);
    assert!(!nonce_used(&s, &first));

    assert_contract_error(settle(&s, &first, 10), UptoError::Expired);
    let renewed = Payment {
        exp_ledger: SEQ + 60,
        ..first
    };
    assert_eq!(settle(&s, &renewed, 10), Ok(Ok(())));
}

/// The facilitator pays temporary rent on the nonce and the allowance until
/// `allowance_expiration_ledger`, which the payer picks. The contract caps it at
/// `MAX_ALLOWANCE_LEDGERS` past the current ledger, so the furthest expiry the network allows is
/// refused and the costliest accepted one pays a bounded rent (threat model, "Fee inflation by
/// rent").
#[test]
fn a_far_allowance_expiration_is_capped() {
    let rent = |exp_of: fn(&Env) -> u32| {
        let s = setup(TokenKind::Sac);
        // At the target already, so no instance extension in the measurement.
        s.env.as_contract(&s.proxy, || {
            s.env
                .storage()
                .instance()
                .extend_ttl(TTL_EXTEND_TO, TTL_EXTEND_TO)
        });
        let p = Payment {
            exp_ledger: exp_of(&s.env),
            ..s.p.clone()
        };
        let result = settle(&s, &p, 10);
        (result, s.env.cost_estimate().fee().temporary_entry_rent)
    };
    let (far, _) = rent(|env| env.ledger().max_live_until_ledger());
    assert_contract_error(far, UptoError::InvalidAllowanceExpiration);

    let (short, short_rent) = rent(|_| SEQ + 12);
    let (capped, capped_rent) = rent(|_| SEQ + MAX_ALLOWANCE_LEDGERS);
    assert_eq!((short, capped), (Ok(Ok(())), Ok(Ok(()))));
    // Mocked auth adds its own nonces to both runs; the difference is the two entries' rent for
    // the cap, a fraction of what the far expiry would cost (about 14 million here).
    std::println!("temporary rent: {short_rent} at SEQ + 12, {capped_rent} at the cap");
    assert!(capped_rent > short_rent && capped_rent - short_rent < 1_000_000);
}
