use serde::Serialize;

/// A Stellar network, written on the wire as its CAIP-2 name.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
pub enum Network {
    #[serde(rename = "stellar:testnet")]
    Testnet,
    #[serde(rename = "stellar:pubnet")]
    Pubnet,
}

impl Network {
    /// The CAIP-2 name: `stellar:testnet` or `stellar:pubnet`.
    pub fn as_str(self) -> &'static str {
        match self {
            Network::Testnet => "stellar:testnet",
            Network::Pubnet => "stellar:pubnet",
        }
    }

    /// The USDC token contract on this network, as upstream's `@x402/stellar` names it.
    pub(crate) fn usdc(self) -> &'static str {
        match self {
            Network::Testnet => "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
            Network::Pubnet => "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
        }
    }
}

impl std::fmt::Display for Network {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}
