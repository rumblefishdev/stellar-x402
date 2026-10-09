#![no_std]
//! `UptoProxy`: settles an x402 `upto` payment on Soroban.
//!
//! The client signs a ceiling (`max_amount`) once; the bound facilitator then settles any
//! `actual_amount` between 0 and that ceiling. The contract is immutable: no admin, no
//! constructor arguments, no upgrade path and no funds held between calls.
//!
//! Normative spec: `lore/1-tasks/archive/0002_RESEARCH_upto-proxy-design-on-soroban/notes/
//! G-upto-proxy-contract-spec.md`. Section numbers in comments (§N) refer to it.

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, token, vec, Address,
    BytesN, Env, IntoVal,
};

/// Contract errors (§5). Auth failures surface as host `Error(Auth, …)` instead.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum UptoError {
    InvalidAmount = 1,
    AmountExceedsMax = 2,
    SelfPayment = 3,
    NotYetValid = 4,
    Expired = 5,
    InvalidAllowanceExpiration = 6,
    NonceUsed = 7,
    InvalidRecipient = 8,
}

/// Emitted on every successful settlement, including zero settlements (§6).
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UptoSettled {
    #[topic]
    pub token: Address,
    #[topic]
    pub from: Address,
    #[topic]
    pub to: Address,
    pub facilitator: Address,
    pub max_amount: i128,
    pub actual_amount: i128,
    pub nonce: BytesN<32>,
}

/// TTL that `settle_upto` keeps on the contract instance and its WASM code, in ledgers (task
/// 0035). At 5 s ledgers: extend toward 30 days, skip gains under about 10 minutes, add at most
/// about 1 hour per call. The facilitator pays the rent inside the settlement fee: 198.8 stroops
/// per ledger plus about 5,800 per extension on testnet. The cap keeps the costliest settlement
/// near 77% of the default 250,000-stroop fee ceiling, so a valid payment is never refused over
/// rent; the minimum keeps extensions to one per 10 minutes under steady traffic.
pub const TTL_EXTEND_TO: u32 = 518_400;
pub const TTL_MIN_EXTENSION: u32 = 120;
pub const TTL_MAX_EXTENSION: u32 = 720;

/// Storage keys (§7). Only temporary storage is used.
#[contracttype]
#[derive(Clone)]
enum DataKey {
    Nonce(Address, BytesN<32>),
}

#[contract]
pub struct UptoProxy;

#[contractimpl]
impl UptoProxy {
    /// Settles `actual_amount` (at most `max_amount`) of `token` from `from` to `to`.
    ///
    /// `from` signs every argument except `actual_amount` (and itself), plus the
    /// `token.approve` sub-invocation that binds `allowance_expiration_ledger` (§3).
    /// `facilitator` must authorize the full call (§3.2).
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
    ) -> Result<(), UptoError> {
        let proxy = env.current_contract_address();

        // §4 steps 1–3: input checks.
        if max_amount <= 0 || actual_amount < 0 {
            return Err(UptoError::InvalidAmount);
        }
        if actual_amount > max_amount {
            return Err(UptoError::AmountExceedsMax);
        }
        if from == to {
            return Err(UptoError::SelfPayment);
        }
        if to == proxy {
            return Err(UptoError::InvalidRecipient);
        }

        // §4 step 4: the client's signed payload (§3). It must come before `approve` so the
        // approve call matches the sub-invocation of the client's auth entry.
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

        // §4 step 5: facilitator binding.
        facilitator.require_auth();

        // §4 step 6: time window, unix seconds, inclusive.
        let now = env.ledger().timestamp();
        if now < valid_after {
            return Err(UptoError::NotYetValid);
        }
        if now > deadline {
            return Err(UptoError::Expired);
        }

        // §4 step 7: allowance expiration ledger.
        let seq = env.ledger().sequence();
        if allowance_expiration_ledger < seq {
            return Err(UptoError::Expired);
        }
        if allowance_expiration_ledger > env.ledger().max_live_until_ledger() {
            return Err(UptoError::InvalidAllowanceExpiration);
        }

        // §4 step 8: consume the nonce before any external call. The entry lives until at
        // least `allowance_expiration_ledger` (I4).
        let key = DataKey::Nonce(from.clone(), nonce.clone());
        let temporary = env.storage().temporary();
        if temporary.has(&key) {
            return Err(UptoError::NonceUsed);
        }
        temporary.set(&key, &());
        let live_for = allowance_expiration_ledger - seq;
        if live_for > 0 {
            temporary.extend_ttl(&key, live_for, live_for);
        }

        // §4 steps 9–10: the approve sub-invocation the client signed, then the transfer.
        // The proxy is the spender, so `transfer_from` needs no further client signature.
        let token_client = token::Client::new(&env, &token);
        token_client.approve(&from, &proxy, &max_amount, &allowance_expiration_ledger);
        if actual_amount > 0 {
            token_client.transfer_from(&proxy, &from, &to, &actual_amount);
        }

        // Keep the instance and code alive (task 0035). Without it, an archived proxy makes
        // every settlement pay for a restore first.
        env.storage().instance().extend_ttl_with_limits(
            TTL_EXTEND_TO,
            TTL_MIN_EXTENSION,
            TTL_MAX_EXTENSION,
        );

        // §4 step 11.
        UptoSettled {
            token,
            from,
            to,
            facilitator,
            max_amount,
            actual_amount,
            nonce,
        }
        .publish(&env);
        Ok(())
    }

    /// Returns whether `(from, nonce)` was consumed and its entry is still live (§7).
    pub fn is_nonce_used(env: Env, from: Address, nonce: BytesN<32>) -> bool {
        env.storage().temporary().has(&DataKey::Nonce(from, nonce))
    }
}

#[cfg(test)]
mod test;
