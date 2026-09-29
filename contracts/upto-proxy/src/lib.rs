#![no_std]
//! `UptoProxy`: authorizes a payment ceiling and settles the actual amount for the
//! x402 `upto` scheme. Placeholder: the design is reviewed before implementation.

use soroban_sdk::contract;

#[contract]
pub struct UptoProxy;
