#![no_std]
//! Minimal non-SAC SEP-41 token for tests, written in-repo (no third-party token code). Used by
//! the `upto-proxy` unit tests and deployed to testnet for its e2e suite (0004).
//!
//! Allowances follow SEP-41: `approve` overwrites, carries an expiration ledger, and an
//! expired allowance reads as 0. `mint` is unauthenticated test scaffolding: anyone can mint, so
//! never deploy it outside testnet.

use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, String};

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
}

#[contractimpl]
impl TestToken {
    pub fn mint(env: Env, to: Address, amount: i128) {
        write_balance(&env, &to, read_balance(&env, &to) + amount);
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
        let key = TokenKey::Allowance(from, spender);
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
