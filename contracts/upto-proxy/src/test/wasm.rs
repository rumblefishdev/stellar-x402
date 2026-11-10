//! Tests against the release WASM. They are `#[ignore]`d because they need it built first:
//!
//! ```sh
//! pnpm contracts:test:wasm   # builds the WASM, then runs these tests
//! ```

extern crate std;

use super::*;
use soroban_sdk::xdr::{Limited, Limits, ReadXdr, ScSpecEntry};
use std::{string::String, vec::Vec as StdVec};

fn release_wasm() -> StdVec<u8> {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../target/wasm32v1-none/release/upto_proxy.wasm"
    );
    std::fs::read(path).unwrap_or_else(|e| panic!("{path}: {e}; build the WASM first"))
}

fn read_leb_u32(bytes: &[u8], pos: &mut usize) -> u32 {
    let (mut result, mut shift) = (0u32, 0);
    loop {
        let b = bytes[*pos];
        *pos += 1;
        result |= u32::from(b & 0x7f) << shift;
        if b & 0x80 == 0 {
            return result;
        }
        shift += 7;
    }
}

/// The contents of the WASM custom section `name`.
fn custom_section<'a>(wasm: &'a [u8], name: &str) -> &'a [u8] {
    let mut pos = 8; // magic + version
    while pos < wasm.len() {
        let id = wasm[pos];
        pos += 1;
        let size = read_leb_u32(wasm, &mut pos) as usize;
        let end = pos + size;
        if id == 0 {
            let mut p = pos;
            let name_len = read_leb_u32(wasm, &mut p) as usize;
            if &wasm[p..p + name_len] == name.as_bytes() {
                return &wasm[p + name_len..end];
            }
        }
        pos = end;
    }
    panic!("no custom section {name}");
}

/// I7: the deployed interface is exactly the two spec functions, with no admin or upgrade
/// entry point.
#[test]
#[ignore = "needs the release WASM: pnpm contracts:test:wasm"]
fn wasm_interface_has_only_the_spec_functions() {
    let wasm = release_wasm();
    let spec = custom_section(&wasm, "contractspecv0");
    let mut functions: StdVec<String> = ScSpecEntry::read_xdr_iter(&mut Limited::new(
        std::io::Cursor::new(spec),
        Limits::none(),
    ))
    .filter_map(|e| match e.unwrap() {
        ScSpecEntry::FunctionV0(f) => Some(f.name.to_utf8_string().unwrap()),
        _ => None,
    })
    .collect();
    functions.sort();
    assert_eq!(functions, ["is_nonce_used", "settle_upto"]);
}

/// Resource cost of one settlement through the WASM with the SAC (recorded for 0005).
/// Auth is mocked, so signature verification is not included. Rent is not meaningful here:
/// mocked auth writes its nonces with `max_live_until_ledger`, while a real client entry
/// expires at `allowance_expiration_ledger`. The fee is therefore reported without rent.
#[test]
#[ignore = "needs the release WASM: pnpm contracts:test:wasm"]
fn wasm_settlement_cost() {
    let wasm = release_wasm();
    std::println!("wasm size: {} bytes", wasm.len());
    for actual in [MAX / 2, 0] {
        let env = new_env();
        let token = register_token(&env, TokenKind::Sac);
        let from = Address::generate(&env);
        mint(&env, &token, TokenKind::Sac, &from, MINTED);
        let proxy = env.register(wasm.as_slice(), ());
        let p = Payment {
            token,
            from,
            to: Address::generate(&env),
            facilitator: Address::generate(&env),
            max_amount: MAX,
            nonce: BytesN::from_array(&env, &[7; 32]),
            valid_after: VALID_AFTER,
            deadline: DEADLINE,
            exp_ledger: EXP_LEDGER,
        };
        let s = Setup { env, proxy, p };
        let p = s.p.clone();
        assert_eq!(settle(&s, &p, actual), Ok(Ok(())));
        let estimate = s.env.cost_estimate();
        let r = estimate.resources();
        let fee = estimate.fee();
        std::println!(
            "actual = {actual}: instructions {}, mem {} B, reads {} disk + {} memory, \
             writes {} entries / {} B, events {} B, fee without rent {} stroops",
            r.instructions,
            r.mem_bytes,
            r.disk_read_entries,
            r.memory_read_entries,
            r.write_entries,
            r.write_bytes,
            r.contract_events_size_bytes,
            fee.total - fee.persistent_entry_rent - fee.temporary_entry_rent,
        );
    }
}
