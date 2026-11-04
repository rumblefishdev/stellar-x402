#![no_std]
//! A SEP-41 token that misbehaves on demand, for the facilitator's testnet spend matrix (0024).
//! **Testnet only: never deploy it anywhere else.** Anyone can mint it and anyone can set its
//! mode, so its balances mean nothing.
//!
//! `set_mode` picks how `transfer` behaves:
//! - 0: like `test-token`, the payer's auth is required.
//! - 1: no `require_auth` on `from`, so anyone can move anyone's balance. A facilitator that trusts
//!   the `transfer` event's `from` settles a payment the payer never signed.
//! - 2: the payer's auth is required, then the call fails on an odd ledger. A simulation on an even
//!   ledger passes and the same transaction fails if it is included a ledger later, which charges
//!   the fee. Whether it does is up to timing: a simulation runs as the next ledger, where the
//!   transaction usually lands (none of 19 did in one testnet run).
//! - 3: the payer's auth is required, then only the ledger's first `transfer` succeeds. Each
//!   payment simulated alone passes; of several included in one ledger, all but the first fail
//!   and are charged.
//!
//! Its `transfer` event is `test-token`'s (SEP-41: topics `[transfer, from, to]`, the amount as
//! data), so upstream's `exact` verifier accepts it. It has no allowances: `exact` only calls
//! `transfer`.

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error, Address,
    Env, String,
};

#[contractevent(topics = ["transfer"], data_format = "single-value")]
struct Transfer {
    #[topic]
    from: Address,
    #[topic]
    to: Address,
    amount: i128,
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
    Mode,
    /// The ledger of the last mode-3 `transfer`.
    LastTransfer,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum HostileError {
    /// Mode 2 on an odd ledger.
    OddLedger = 1,
    /// `set_mode` with a mode other than 0 to 3.
    UnknownMode = 2,
    /// Mode 3: another `transfer` already ran in this ledger.
    SecondInLedger = 3,
}

pub const MODE_NORMAL: u32 = 0;
pub const MODE_NO_AUTH: u32 = 1;
pub const MODE_FAIL_ON_ODD_LEDGER: u32 = 2;
pub const MODE_ONE_PER_LEDGER: u32 = 3;

#[contract]
pub struct HostileToken;

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

fn read_mode(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&TokenKey::Mode)
        .unwrap_or(MODE_NORMAL)
}

#[contractimpl]
impl HostileToken {
    /// Unauthenticated, like `test-token`'s.
    pub fn mint(env: Env, to: Address, amount: i128) {
        assert!(amount >= 0, "negative amount");
        write_balance(&env, &to, read_balance(&env, &to) + amount);
        Mint { to, amount }.publish(&env);
    }

    /// Unauthenticated: anyone can switch the token's behaviour.
    pub fn set_mode(env: Env, mode: u32) {
        if mode > MODE_ONE_PER_LEDGER {
            panic_with_error!(&env, HostileError::UnknownMode);
        }
        env.storage().instance().set(&TokenKey::Mode, &mode);
    }

    pub fn mode(env: Env) -> u32 {
        read_mode(&env)
    }

    pub fn balance(env: Env, id: Address) -> i128 {
        read_balance(&env, &id)
    }

    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
        let mode = read_mode(&env);
        if mode != MODE_NO_AUTH {
            from.require_auth();
        }
        if mode == MODE_FAIL_ON_ODD_LEDGER && env.ledger().sequence() % 2 == 1 {
            panic_with_error!(&env, HostileError::OddLedger);
        }
        if mode == MODE_ONE_PER_LEDGER {
            let ledger = env.ledger().sequence();
            let last = env.storage().temporary().get(&TokenKey::LastTransfer);
            if last == Some(ledger) {
                panic_with_error!(&env, HostileError::SecondInLedger);
            }
            env.storage()
                .temporary()
                .set(&TokenKey::LastTransfer, &ledger);
        }
        assert!(amount >= 0, "negative amount");
        let from_balance = read_balance(&env, &from);
        assert!(from_balance >= amount, "insufficient balance");
        write_balance(&env, &from, from_balance - amount);
        write_balance(&env, &to, read_balance(&env, &to) + amount);
        Transfer { from, to, amount }.publish(&env);
    }

    pub fn decimals(_env: Env) -> u32 {
        7
    }

    pub fn name(env: Env) -> String {
        String::from_str(&env, "Hostile Test Token")
    }

    pub fn symbol(env: Env) -> String {
        String::from_str(&env, "HOSTILE")
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger as _};

    struct Setup {
        env: Env,
        client: HostileTokenClient<'static>,
        from: Address,
        to: Address,
    }

    /// A token with 100 minted to `from`, in `mode`, and no auth mocked.
    fn setup(mode: u32) -> Setup {
        let env = Env::default();
        let token = env.register(HostileToken, ());
        let client = HostileTokenClient::new(&env, &token);
        let (from, to) = (Address::generate(&env), Address::generate(&env));
        client.mint(&from, &100);
        client.set_mode(&mode);
        Setup {
            env,
            client,
            from,
            to,
        }
    }

    #[test]
    fn mode_0_requires_the_payers_auth() {
        let s = setup(MODE_NORMAL);
        assert!(s.client.try_transfer(&s.from, &s.to, &10).is_err());
        s.env.mock_all_auths();
        s.client.transfer(&s.from, &s.to, &10);
        assert_eq!(s.env.auths()[0].0, s.from);
        assert_eq!(s.client.balance(&s.to), 10);
    }

    #[test]
    fn mode_1_moves_a_balance_its_owner_never_signed() {
        let s = setup(MODE_NO_AUTH);
        s.client.transfer(&s.from, &s.to, &10);
        assert!(s.env.auths().is_empty());
        assert_eq!(s.client.balance(&s.from), 90);
        assert_eq!(s.client.balance(&s.to), 10);
    }

    #[test]
    fn mode_2_requires_auth_and_fails_on_an_odd_ledger() {
        let s = setup(MODE_FAIL_ON_ODD_LEDGER);
        s.env.ledger().set_sequence_number(1_001);
        s.env.mock_all_auths();
        assert_eq!(
            s.client.try_transfer(&s.from, &s.to, &10),
            Err(Ok(HostileError::OddLedger.into()))
        );
        assert_eq!(s.client.balance(&s.from), 100);

        s.env.ledger().set_sequence_number(1_002);
        s.client.transfer(&s.from, &s.to, &10);
        assert_eq!(s.env.auths()[0].0, s.from);
        assert_eq!(s.client.balance(&s.to), 10);

        s.env.set_auths(&[]);
        assert!(s.client.try_transfer(&s.from, &s.to, &10).is_err());
    }

    #[test]
    fn mode_3_lets_one_transfer_through_per_ledger() {
        let s = setup(MODE_ONE_PER_LEDGER);
        s.env.mock_all_auths();
        s.env.ledger().set_sequence_number(2_000);
        s.client.transfer(&s.from, &s.to, &10);
        assert_eq!(s.env.auths()[0].0, s.from);
        assert_eq!(
            s.client.try_transfer(&s.from, &s.to, &10),
            Err(Ok(HostileError::SecondInLedger.into()))
        );
        s.env.ledger().set_sequence_number(2_001);
        s.client.transfer(&s.from, &s.to, &10);
        assert_eq!(s.client.balance(&s.to), 20);

        s.env.set_auths(&[]);
        s.env.ledger().set_sequence_number(2_002);
        assert!(s.client.try_transfer(&s.from, &s.to, &10).is_err());
    }

    #[test]
    fn refuses_an_unknown_mode() {
        let s = setup(MODE_NORMAL);
        assert_eq!(
            s.client.try_set_mode(&4),
            Err(Ok(HostileError::UnknownMode.into()))
        );
        assert_eq!(s.client.mode(), MODE_NORMAL);
    }
}
