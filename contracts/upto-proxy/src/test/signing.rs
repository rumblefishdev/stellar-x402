//! Real ed25519 authorization for tests: a classic `G...` account in the ledger and
//! `SorobanAuthorizationEntry` values signed the way a wallet signs them. The host verifies
//! these signatures, unlike `mock_auths`/`mock_all_auths`.

extern crate std;

use ed25519_dalek::{Signer as _, SigningKey};
use soroban_sdk::{
    xdr::{
        self, AccountEntry, AccountEntryExt, AccountId, HashIdPreimage,
        HashIdPreimageSorobanAuthorization, InvokeContractArgs, LedgerEntry, LedgerEntryData,
        LedgerEntryExt, LedgerKey, LedgerKeyAccount, Limits, PublicKey, ScAddress, ScMap,
        ScMapEntry, ScSymbol, ScVal, ScVec, SequenceNumber, SorobanAddressCredentials,
        SorobanAuthorizationEntry, SorobanAuthorizedFunction, SorobanAuthorizedInvocation,
        SorobanCredentials, Thresholds, Uint256, WriteXdr,
    },
    Address, Bytes, Env, TryFromVal, TryIntoVal, Val,
};
use std::{rc::Rc, vec::Vec};

/// A classic account controlled by one ed25519 key.
pub struct Signer {
    key: SigningKey,
    pub address: Address,
}

impl Signer {
    /// Creates the account entry (master weight 1, all thresholds 1) in the test ledger.
    pub fn new(env: &Env, seed: u8) -> Self {
        let key = SigningKey::from_bytes(&[seed; 32]);
        let account_id = AccountId(PublicKey::PublicKeyTypeEd25519(Uint256(
            key.verifying_key().to_bytes(),
        )));
        let ledger_key = Rc::new(LedgerKey::Account(LedgerKeyAccount {
            account_id: account_id.clone(),
        }));
        let entry = Rc::new(LedgerEntry {
            data: LedgerEntryData::Account(AccountEntry {
                account_id: account_id.clone(),
                balance: 100_000_000,
                flags: 0,
                home_domain: Default::default(),
                inflation_dest: None,
                num_sub_entries: 0,
                seq_num: SequenceNumber(0),
                thresholds: Thresholds([1, 1, 1, 1]),
                signers: Default::default(),
                ext: AccountEntryExt::V0,
            }),
            last_modified_ledger_seq: 0,
            ext: LedgerEntryExt::V0,
        });
        env.host()
            .add_ledger_entry(&ledger_key, &entry, None)
            .unwrap();
        let address = ScAddress::Account(account_id).try_into_val(env).unwrap();
        Self { key, address }
    }

    /// Signs `invocation` with `ADDRESS` credentials, as a wallet does.
    pub fn sign(
        &self,
        env: &Env,
        nonce: i64,
        signature_expiration_ledger: u32,
        invocation: SorobanAuthorizedInvocation,
    ) -> SorobanAuthorizationEntry {
        let preimage = HashIdPreimage::SorobanAuthorization(HashIdPreimageSorobanAuthorization {
            network_id: xdr::Hash(env.ledger().network_id().to_array()),
            nonce,
            signature_expiration_ledger,
            invocation: invocation.clone(),
        });
        let preimage = preimage.to_xdr(Limits::none()).unwrap();
        let payload = env
            .crypto()
            .sha256(&Bytes::from_slice(env, &preimage))
            .to_array();
        let signature = self.key.sign(&payload).to_bytes();

        let sig_entry = ScVal::Map(Some(
            ScMap::sorted_from(std::vec![
                ScMapEntry {
                    key: ScVal::Symbol(ScSymbol("public_key".try_into().unwrap())),
                    val: ScVal::Bytes(
                        self.key
                            .verifying_key()
                            .to_bytes()
                            .to_vec()
                            .try_into()
                            .unwrap(),
                    ),
                },
                ScMapEntry {
                    key: ScVal::Symbol(ScSymbol("signature".try_into().unwrap())),
                    val: ScVal::Bytes(signature.to_vec().try_into().unwrap()),
                },
            ])
            .unwrap(),
        ));
        SorobanAuthorizationEntry {
            credentials: SorobanCredentials::Address(SorobanAddressCredentials {
                address: (&self.address).into(),
                nonce,
                signature_expiration_ledger,
                signature: ScVal::Vec(Some(ScVec(std::vec![sig_entry].try_into().unwrap()))),
            }),
            root_invocation: invocation,
        }
    }
}

/// A contract-function node of an auth tree.
pub fn invocation(
    env: &Env,
    contract: &Address,
    function: &str,
    args: soroban_sdk::Vec<Val>,
    sub_invocations: Vec<SorobanAuthorizedInvocation>,
) -> SorobanAuthorizedInvocation {
    let args: Vec<ScVal> = args
        .iter()
        .map(|v| ScVal::try_from_val(env, &v).unwrap())
        .collect();
    SorobanAuthorizedInvocation {
        function: SorobanAuthorizedFunction::ContractFn(InvokeContractArgs {
            contract_address: contract.into(),
            function_name: ScSymbol(function.try_into().unwrap()),
            args: args.try_into().unwrap(),
        }),
        sub_invocations: sub_invocations.try_into().unwrap(),
    }
}
