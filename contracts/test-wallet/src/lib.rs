#![no_std]
//! A minimal custom account for the facilitator's testnet spend matrix (0024): one ed25519 key
//! signs for the contract's C-address, in the style of soroban-examples' simple account.
//! **Testnet only: never deploy it anywhere else.** It checks no context, so whatever the key signs
//! the wallet authorizes.
//!
//! The signature is the bare 64-byte ed25519 signature of the auth payload. The host writes the
//! auth entry's nonce under the wallet's address before it calls `__check_auth`, as for any address.

use soroban_sdk::{
    auth::Context, contract, contractimpl, contracttype, crypto::Hash, BytesN, Env, Vec,
};

#[contracttype]
enum WalletKey {
    Owner,
}

#[contract]
pub struct TestWallet;

#[contractimpl]
impl TestWallet {
    pub fn __constructor(env: Env, owner: BytesN<32>) {
        env.storage().instance().set(&WalletKey::Owner, &owner);
    }

    #[allow(non_snake_case)]
    pub fn __check_auth(
        env: Env,
        signature_payload: Hash<32>,
        signature: BytesN<64>,
        _auth_contexts: Vec<Context>,
    ) {
        let owner: BytesN<32> = env.storage().instance().get(&WalletKey::Owner).unwrap();
        env.crypto()
            .ed25519_verify(&owner, &signature_payload.into(), &signature);
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use ed25519_dalek::{Signer as _, SigningKey};
    use soroban_sdk::{testutils::BytesN as _, vec, Bytes, IntoVal};

    #[test]
    fn accepts_its_owners_signature_only() {
        let env = Env::default();
        let owner = SigningKey::from_bytes(&[7; 32]);
        let wallet = env.register(
            TestWallet,
            (BytesN::from_array(&env, &owner.verifying_key().to_bytes()),),
        );
        let payload = BytesN::<32>::random(&env);
        let sign = |key: &SigningKey| -> BytesN<64> {
            let message = Bytes::from(payload.clone()).to_buffer::<32>();
            BytesN::from_array(&env, &key.sign(message.as_slice()).to_bytes())
        };
        let check = |signature: BytesN<64>| {
            env.try_invoke_contract_check_auth::<soroban_sdk::Error>(
                &wallet,
                &payload,
                signature.into_val(&env),
                &vec![&env],
            )
        };

        assert_eq!(check(sign(&owner)), Ok(()));
        assert!(check(sign(&SigningKey::from_bytes(&[8; 32]))).is_err());
    }
}
