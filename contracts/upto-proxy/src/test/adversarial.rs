//! Attacks from the 0035 security review: what a facilitator, a token or a payer could try beyond
//! the spec's own cases. Each test names the attack and pins the outcome.

use super::*;
use soroban_sdk::{contract, contractimpl, testutils::Deployer as _};

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

/// A token whose `approve` calls `settle_upto` again. Soroban refuses re-entry into a contract
/// already on the call stack.
#[contract]
pub struct ReentrantToken;

#[contractimpl]
impl ReentrantToken {
    pub fn approve(env: Env, from: Address, spender: Address, amount: i128, expiration: u32) {
        let reentered = UptoProxyClient::new(&env, &spender)
            .try_settle_upto(
                &env.current_contract_address(),
                &from,
                &env.current_contract_address(),
                &from,
                &amount,
                &0,
                &BytesN::from_array(&env, &[1; 32]),
                &0,
                &u64::MAX,
                &expiration,
            )
            .is_ok();
        env.storage().instance().set(&(), &reentered);
    }

    pub fn reentered(env: Env) -> bool {
        env.storage().instance().get(&()).unwrap_or(false)
    }
}

#[test]
fn a_token_cannot_reenter_the_proxy() {
    let s = setup(TokenKind::Sac);
    let token = s.env.register(ReentrantToken, ());
    let p = Payment {
        token: token.clone(),
        ..s.p.clone()
    };
    s.env.mock_all_auths_allowing_non_root_auth();
    assert_eq!(try_settle(&s, &p, 0), Ok(Ok(())));
    assert!(!ReentrantTokenClient::new(&s.env, &token).reentered());
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
/// `allowance_expiration_ledger`, which the payer picks. Pins how much a far expiry costs, so the
/// window rule in the facilitator's `/verify` has a measured reason (threat model, "Fee inflation
/// by rent").
#[test]
fn a_far_allowance_expiration_costs_the_facilitator_rent() {
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
        settle(&s, &p, 10).unwrap().unwrap();
        assert_eq!(
            s.env.deployer().get_contract_instance_ttl(&s.proxy),
            TTL_EXTEND_TO
        );
        s.env.cost_estimate().fee().temporary_entry_rent
    };
    let short = rent(|_| SEQ + 12);
    let far = rent(|env| env.ledger().max_live_until_ledger());
    std::println!("temporary rent: {short} at SEQ + 12, {far} at max_live_until_ledger");
    // Mocked auth adds its own nonces to both runs; the difference is the two entries' rent.
    assert!(far - short > 1_000_000, "{far} - {short}");
}
