#![no_std]
//! Throwaway spike for task 0002. It proves the auth mechanics of the UptoProxy design on
//! testnet. It is not the production contract: validation, storage and events are minimal.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, token, vec, Address,
    BytesN, Env, IntoVal,
};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum SpikeError {
    AmountExceedsMax = 1,
    InvalidAmount = 2,
    NotYetValid = 3,
    Expired = 4,
    NonceUsed = 5,
}

#[contracttype]
enum DataKey {
    Nonce(Address, BytesN<32>),
}

#[contract]
pub struct UptoSpike;

#[contractimpl]
impl UptoSpike {
    /// Candidate `settle_upto`, with `token` and the approve expiration ledger added.
    #[allow(clippy::too_many_arguments)]
    pub fn settle_upto(
        env: Env,
        token: Address,
        from: Address,
        to: Address,
        facilitator: Address,
        max_amount: i128,
        actual_amount: i128,
        nonce: BytesN<32>,
        valid_after: u64,
        deadline: u64,
        allowance_expiration_ledger: u32,
    ) {
        if max_amount <= 0 || actual_amount < 0 {
            panic_with_error!(&env, SpikeError::InvalidAmount);
        }
        if actual_amount > max_amount {
            panic_with_error!(&env, SpikeError::AmountExceedsMax);
        }

        // The client signs everything except actual_amount.
        from.require_auth_for_args(vec![
            &env,
            token.into_val(&env),
            to.into_val(&env),
            facilitator.into_val(&env),
            max_amount.into_val(&env),
            nonce.into_val(&env),
            valid_after.into_val(&env),
            deadline.into_val(&env),
        ]);
        facilitator.require_auth();

        let now = env.ledger().timestamp();
        if now < valid_after {
            panic_with_error!(&env, SpikeError::NotYetValid);
        }
        if now > deadline {
            panic_with_error!(&env, SpikeError::Expired);
        }

        let key = DataKey::Nonce(from.clone(), nonce);
        if env.storage().temporary().has(&key) {
            panic_with_error!(&env, SpikeError::NonceUsed);
        }
        env.storage().temporary().set(&key, &());

        let proxy = env.current_contract_address();
        let client = token::Client::new(&env, &token);
        // Sub-invocation of the client's auth entry: all args are known at signing time.
        client.approve(&from, &proxy, &max_amount, &allowance_expiration_ledger);
        if actual_amount > 0 {
            // The proxy is the spender, so this needs no client signature.
            client.transfer_from(&proxy, &from, &to, &actual_amount);
        }
    }

    /// Same as `settle_upto` but calls `approve` before `require_auth_for_args`.
    /// Used only to check whether call order matters for auth-tree matching.
    #[allow(clippy::too_many_arguments)]
    pub fn settle_wrong_order(
        env: Env,
        token: Address,
        from: Address,
        to: Address,
        facilitator: Address,
        max_amount: i128,
        actual_amount: i128,
        nonce: BytesN<32>,
        valid_after: u64,
        deadline: u64,
        allowance_expiration_ledger: u32,
    ) {
        let proxy = env.current_contract_address();
        let client = token::Client::new(&env, &token);
        client.approve(&from, &proxy, &max_amount, &allowance_expiration_ledger);
        from.require_auth_for_args(vec![
            &env,
            token.into_val(&env),
            to.into_val(&env),
            facilitator.into_val(&env),
            max_amount.into_val(&env),
            nonce.into_val(&env),
            valid_after.into_val(&env),
            deadline.into_val(&env),
        ]);
        facilitator.require_auth();
        client.transfer_from(&proxy, &from, &to, &actual_amount);
    }

    pub fn is_nonce_used(env: Env, from: Address, nonce: BytesN<32>) -> bool {
        env.storage().temporary().has(&DataKey::Nonce(from, nonce))
    }
}

#[cfg(test)]
mod test;
