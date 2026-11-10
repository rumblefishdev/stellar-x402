//! Authorization with real ed25519 signatures, verified by the host (I2, I3). The payer and
//! the facilitator are classic accounts; the token is the in-repo SEP-41 token so the payer
//! can hold a balance without a trustline. Spike S1–S8 covered the SAC on testnet.

extern crate std;

use super::signing::{invocation, Signer};
use super::*;
use soroban_sdk::xdr::{ContractId, Hash, ScAddress, SorobanAuthorizationEntry};
use soroban_sdk::TryIntoVal;

struct Real {
    s: Setup,
    client: Signer,
    facilitator: Signer,
}

fn contract_address(env: &Env, id: u8) -> Address {
    ScAddress::Contract(ContractId(Hash([id; 32])))
        .try_into_val(env)
        .unwrap()
}

/// Deterministic: every call yields the same addresses and keys, so an auth entry signed
/// in one `Env` is valid in another.
fn setup_real() -> Real {
    let env = new_env();
    let proxy = contract_address(&env, 0xA0);
    let token = contract_address(&env, 0xA1);
    env.register_at(&proxy, UptoProxy, ());
    env.register_at(&token, TestToken, ());
    let client = Signer::new(&env, 1);
    let facilitator = Signer::new(&env, 2);
    let to = Signer::new(&env, 3).address;
    TestTokenClient::new(&env, &token).mint(&client.address, &MINTED);
    let p = Payment {
        token,
        from: client.address.clone(),
        to,
        facilitator: facilitator.address.clone(),
        max_amount: MAX,
        nonce: BytesN::from_array(&env, &[7; 32]),
        valid_after: VALID_AFTER,
        deadline: DEADLINE,
        exp_ledger: EXP_LEDGER,
    };
    Real {
        s: Setup { env, proxy, p },
        client,
        facilitator,
    }
}

/// The client's entry (§3.1): signature expiration equals the allowance expiration.
fn client_entry(r: &Real, p: &Payment) -> SorobanAuthorizationEntry {
    let env = &r.s.env;
    let approve = invocation(
        env,
        &p.token,
        "approve",
        approve_args(env, &r.s.proxy, p),
        std::vec![],
    );
    let root = invocation(
        env,
        &r.s.proxy,
        "settle_upto",
        signed_args(env, p),
        std::vec![approve],
    );
    r.client.sign(env, 1, p.exp_ledger, root)
}

/// The facilitator's entry (§3.2): all 10 args, no sub-invocations.
fn facilitator_entry(r: &Real, p: &Payment, actual: i128) -> SorobanAuthorizationEntry {
    let env = &r.s.env;
    let root = invocation(
        env,
        &r.s.proxy,
        "settle_upto",
        full_args(env, p, actual),
        std::vec![],
    );
    r.facilitator.sign(env, 2, SEQ + 100, root)
}

fn submit(r: &Real, p: &Payment, actual: i128, auths: &[SorobanAuthorizationEntry]) -> TryResult {
    r.s.env.set_auths(auths);
    try_settle(&r.s, p, actual)
}

#[test]
fn one_signed_entry_settles_any_amount_up_to_max() {
    let first = setup_real();
    let signed = client_entry(&first, &first.s.p);
    for actual in [0, 1, 400, MAX] {
        let r = setup_real();
        let p = r.s.p.clone();
        // The very same signed entry, reused byte for byte for every amount.
        let auths = [signed.clone(), facilitator_entry(&r, &p, actual)];
        assert_eq!(
            submit(&r, &p, actual, &auths),
            Ok(Ok(())),
            "actual = {actual}"
        );
        assert_eq!(balance(&r.s, &p.to), actual);
        assert_eq!(balance(&r.s, &p.from), MINTED - actual);
        assert_eq!(balance(&r.s, &r.s.proxy), 0);
    }
}

/// A fresh deterministic setup plus `signed` with `field` changed. A second test token is
/// registered for the `token` field.
fn setup_tampered(field: &str) -> (Real, Payment, Payment) {
    let r = setup_real();
    let other_token = contract_address(&r.s.env, 0xA2);
    r.s.env.register_at(&other_token, TestToken, ());
    TestTokenClient::new(&r.s.env, &other_token).mint(&r.s.p.from, &MINTED);
    let signed = r.s.p.clone();
    let t = tampered(&r.s.env, &signed, field, &other_token);
    (r, signed, t)
}

#[test]
fn changing_any_signed_field_fails_the_signature() {
    for field in SIGNED_FIELDS {
        // The facilitator signs the tampered call; the client signed the original.
        let (r, signed, t) = setup_tampered(field);
        let auths = [client_entry(&r, &signed), facilitator_entry(&r, &t, 10)];
        assert_host_error(submit(&r, &t, 10, &auths));
        assert_eq!(
            TestTokenClient::new(&r.s.env, &t.token).balance(&t.to),
            0,
            "{field}"
        );

        // Control: once the client signs the same values, the call settles.
        let (r, _, t) = setup_tampered(field);
        let auths = [client_entry(&r, &t), facilitator_entry(&r, &t, 10)];
        assert_eq!(
            submit(&r, &t, 10, &auths),
            Ok(Ok(())),
            "control for {field}"
        );
    }
}

#[test]
fn missing_facilitator_signature_is_rejected() {
    let r = setup_real();
    let p = r.s.p.clone();
    assert_host_error(submit(&r, &p, 10, &[client_entry(&r, &p)]));
    assert_eq!(balance(&r.s, &p.to), 0);
}

#[test]
fn a_different_facilitator_cannot_use_the_client_signature() {
    let r = setup_real();
    let rogue = Signer::new(&r.s.env, 4);
    let p = Payment {
        facilitator: rogue.address.clone(),
        ..r.s.p.clone()
    };
    let rogue_entry = {
        let env = &r.s.env;
        let root = invocation(
            env,
            &r.s.proxy,
            "settle_upto",
            full_args(env, &p, 10),
            std::vec![],
        );
        rogue.sign(env, 3, SEQ + 100, root)
    };
    // The client signed the original facilitator.
    let auths = [client_entry(&r, &r.s.p), rogue_entry];
    assert_host_error(submit(&r, &p, 10, &auths));
    assert_eq!(balance(&r.s, &p.to), 0);
}

#[test]
fn a_signature_by_another_key_is_rejected() {
    let r = setup_real();
    let p = r.s.p.clone();
    let impostor = Real {
        s: Setup {
            env: r.s.env.clone(),
            proxy: r.s.proxy.clone(),
            p: p.clone(),
        },
        client: Signer::new(&r.s.env, 5),
        facilitator: Signer::new(&r.s.env, 6),
    };
    // A valid signature from the wrong key, presented for the client's address.
    let mut forged = client_entry(&impostor, &p);
    let genuine = client_entry(&r, &p);
    if let (
        soroban_sdk::xdr::SorobanCredentials::Address(f),
        soroban_sdk::xdr::SorobanCredentials::Address(g),
    ) = (&mut forged.credentials, &genuine.credentials)
    {
        f.address = g.address.clone();
    }
    let auths = [forged, facilitator_entry(&r, &p, 10)];
    assert_host_error(submit(&r, &p, 10, &auths));
}

#[test]
fn signed_entry_without_approve_is_rejected() {
    let r = setup_real();
    let p = r.s.p.clone();
    let env = &r.s.env;
    let root = invocation(
        env,
        &r.s.proxy,
        "settle_upto",
        signed_args(env, &p),
        std::vec![],
    );
    let auths = [
        r.client.sign(env, 1, p.exp_ledger, root),
        facilitator_entry(&r, &p, 10),
    ];
    assert_host_error(submit(&r, &p, 10, &auths));
}

#[test]
fn a_signed_entry_cannot_be_replayed() {
    let r = setup_real();
    let p = r.s.p.clone();
    let signed = client_entry(&r, &p);
    let auths = [signed.clone(), facilitator_entry(&r, &p, 10)];
    assert_eq!(submit(&r, &p, 10, &auths), Ok(Ok(())));
    // The host's native auth nonce stops the replay before the contract's nonce check.
    let auths = [
        signed,
        r.facilitator.sign(&r.s.env, 9, SEQ + 100, {
            let env = &r.s.env;
            invocation(
                env,
                &r.s.proxy,
                "settle_upto",
                full_args(env, &p, 10),
                std::vec![],
            )
        }),
    ];
    assert_host_error(submit(&r, &p, 10, &auths));
    assert_eq!(balance(&r.s, &p.to), 10);
}
