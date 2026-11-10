#![no_std]
//! Minimal non-SAC SEP-41 token for tests, written in-repo (no third-party token code). Used by
//! the `upto-proxy` unit tests and deployed to testnet for its e2e suite (0004).
//!
//! Allowances follow SEP-41: `approve` overwrites, carries an expiration ledger, and an
//! expired allowance reads as 0. `mint` is unauthenticated test scaffolding: anyone can mint, so
//! never deploy it outside testnet.
//!
//! Events follow SEP-41 too: `transfer` with topics `[from, to]` and the amount as data, `approve`
//! with `[from, spender]` and `[amount, expiration_ledger]`, and `mint` with `[to]` and the
//! amount. The Stellar Asset Contract adds the SEP-11 asset as a fourth topic; a non-SAC token has
//! none. Upstream's `exact` verifier reads the simulated `transfer` event (its first three topics
//! and the bare amount), so a token without it can't be paid in (0021).

use soroban_sdk::{contract, contractevent, contractimpl, contracttype, Address, Env, String};

#[contractevent(topics = ["transfer"], data_format = "single-value")]
struct Transfer {
    #[topic]
    from: Address,
    #[topic]
    to: Address,
    amount: i128,
}

#[contractevent(topics = ["approve"], data_format = "vec")]
struct Approve {
    #[topic]
    from: Address,
    #[topic]
    spender: Address,
    amount: i128,
    expiration_ledger: u32,
}

#[contractevent(topics = ["mint"], data_format = "single-value")]
struct Mint {
    #[topic]
    to: Address,
    amount: i128,
}

#[contracttype]
#[derive(Clone)]
enum TokenKey {
    Balance(Address),
    Allowance(Address, Address),
}

#[contracttype]
#[derive(Clone)]
struct AllowanceValue {
    amount: i128,
    expiration_ledger: u32,
}

#[contract]
pub struct TestToken;

fn read_balance(env: &Env, id: &Address) -> i128 {
    env.storage()
        .persistent()
        .get(&TokenKey::Balance(id.clone()))
        .unwrap_or(0)
}

fn write_balance(env: &Env, id: &Address, amount: i128) {
    env.storage()
        .persistent()
        .set(&TokenKey::Balance(id.clone()), &amount);
}

fn read_allowance(env: &Env, from: &Address, spender: &Address) -> i128 {
    let key = TokenKey::Allowance(from.clone(), spender.clone());
    match env.storage().temporary().get::<_, AllowanceValue>(&key) {
        Some(a) if a.expiration_ledger >= env.ledger().sequence() => a.amount,
        _ => 0,
    }
}

fn move_balance(env: &Env, from: &Address, to: &Address, amount: i128) {
    assert!(amount >= 0, "negative amount");
    let from_balance = read_balance(env, from);
    assert!(from_balance >= amount, "insufficient balance");
    write_balance(env, from, from_balance - amount);
    write_balance(env, to, read_balance(env, to) + amount);
    Transfer {
        from: from.clone(),
        to: to.clone(),
        amount,
    }
    .publish(env);
}

#[contractimpl]
impl TestToken {
    pub fn mint(env: Env, to: Address, amount: i128) {
        write_balance(&env, &to, read_balance(&env, &to) + amount);
        Mint { to, amount }.publish(&env);
    }

    pub fn balance(env: Env, id: Address) -> i128 {
        read_balance(&env, &id)
    }

    pub fn allowance(env: Env, from: Address, spender: Address) -> i128 {
        read_allowance(&env, &from, &spender)
    }

    pub fn approve(
        env: Env,
        from: Address,
        spender: Address,
        amount: i128,
        expiration_ledger: u32,
    ) {
        from.require_auth();
        assert!(amount >= 0, "negative amount");
        let seq = env.ledger().sequence();
        assert!(
            amount == 0 || expiration_ledger >= seq,
            "expiration_ledger is in the past"
        );
        let key = TokenKey::Allowance(from.clone(), spender.clone());
        env.storage().temporary().set(
            &key,
            &AllowanceValue {
                amount,
                expiration_ledger,
            },
        );
        if amount > 0 {
            let live_for = expiration_ledger - seq;
            if live_for > 0 {
                env.storage()
                    .temporary()
                    .extend_ttl(&key, live_for, live_for);
            }
        }
        Approve {
            from,
            spender,
            amount,
            expiration_ledger,
        }
        .publish(&env);
    }

    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
        from.require_auth();
        move_balance(&env, &from, &to, amount);
    }

    pub fn transfer_from(env: Env, spender: Address, from: Address, to: Address, amount: i128) {
        spender.require_auth();
        let key = TokenKey::Allowance(from.clone(), spender.clone());
        let allowance = read_allowance(&env, &from, &spender);
        assert!(allowance >= amount, "insufficient allowance");
        if amount > 0 {
            let mut value: AllowanceValue = env.storage().temporary().get(&key).unwrap();
            value.amount = allowance - amount;
            env.storage().temporary().set(&key, &value);
        }
        move_balance(&env, &from, &to, amount);
    }

    pub fn decimals(_env: Env) -> u32 {
        7
    }

    pub fn name(env: Env) -> String {
        String::from_str(&env, "Test Token")
    }

    pub fn symbol(env: Env) -> String {
        String::from_str(&env, "TEST")
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{
        testutils::Address as _, testutils::Events as _, vec, IntoVal, Symbol, Val, Vec,
    };

    /// The event as upstream's `exact` verifier reads it: literal topics and data, not this
    /// crate's own structs, so a change to their shape fails here.
    fn event(
        env: &Env,
        token: &Address,
        topics: Vec<Val>,
        data: Val,
    ) -> Vec<(Address, Vec<Val>, Val)> {
        vec![env, (token.clone(), topics, data)]
    }

    #[test]
    fn publishes_sep41_events_for_mint_approve_and_transfers() {
        let env = Env::default();
        env.mock_all_auths();
        let token = env.register(TestToken, ());
        let client = TestTokenClient::new(&env, &token);
        let (from, spender, to) = (
            Address::generate(&env),
            Address::generate(&env),
            Address::generate(&env),
        );
        let amount = |n: i128| -> Val { n.into_val(&env) };

        client.mint(&from, &100);
        assert_eq!(
            env.events().all().filter_by_contract(&token),
            event(
                &env,
                &token,
                (Symbol::new(&env, "mint"), from.clone()).into_val(&env),
                amount(100)
            )
        );
        client.transfer(&from, &to, &30);
        assert_eq!(
            env.events().all().filter_by_contract(&token),
            event(
                &env,
                &token,
                (Symbol::new(&env, "transfer"), from.clone(), to.clone()).into_val(&env),
                amount(30)
            )
        );
        client.approve(&from, &spender, &50, &1_000);
        assert_eq!(
            env.events().all().filter_by_contract(&token),
            event(
                &env,
                &token,
                (Symbol::new(&env, "approve"), from.clone(), spender.clone()).into_val(&env),
                vec![&env, amount(50), 1_000u32.into_val(&env)].into_val(&env)
            )
        );
        // `transfer_from` moves `from`'s tokens, so its event names `from`, not the spender.
        client.transfer_from(&spender, &from, &to, &20);
        assert_eq!(
            env.events().all().filter_by_contract(&token),
            event(
                &env,
                &token,
                (Symbol::new(&env, "transfer"), from, to).into_val(&env),
                amount(20)
            )
        );
    }
}
