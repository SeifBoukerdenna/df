use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use std::fmt;

/// Polymarket condition_id (0x-prefixed hex, 66 chars).
pub type MarketId = String;

/// ERC1155 token_id (large integer as string).
pub type TokenId = String;

/// Ethereum address (0x-prefixed, 42 chars). May be EOA or proxy wallet.
pub type WalletAddr = String;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WalletCategory {
    Directional,
    Arbitrage,
}

impl fmt::Display for WalletCategory {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Directional => write!(f, "directional"),
            Self::Arbitrage => write!(f, "arbitrage"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    Buy,
    Sell,
}

impl fmt::Display for Side {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Buy => write!(f, "buy"),
            Self::Sell => write!(f, "sell"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MissReason {
    InsufficientDepth,
    MaxSlippageExceeded,
    StaleBook,
    NoSessionPosition,
    InsufficientCapital,
    Degraded,
    /// Trade detected too long after execution — stale for this category's latency budget.
    DetectionTooOld,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FillResult {
    Full,
    Partial { filled_qty: Decimal },
    Miss { reason: MissReason },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DataQuality {
    Good,
    Degraded,
    Stale,
    Rebuilding,
}

impl fmt::Display for DataQuality {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Good => write!(f, "good"),
            Self::Degraded => write!(f, "degraded"),
            Self::Stale => write!(f, "stale"),
            Self::Rebuilding => write!(f, "rebuilding"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExitActionability {
    Actionable,
    PartiallyActionable,
    NonActionable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FeeSource {
    Live,
    Cached,
    Unavailable,
}

impl fmt::Display for FeeSource {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Live => write!(f, "live"),
            Self::Cached => write!(f, "cached"),
            Self::Unavailable => write!(f, "unavailable"),
        }
    }
}

/// How to mark unrealized PnL for open positions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MarkingMode {
    /// Use the best bid for longs (what we could actually sell at). Most defensible.
    Conservative,
    /// Use the midpoint of best bid and best ask.
    Midpoint,
    /// Use the last trade price.
    LastTrade,
}

impl Default for MarkingMode {
    fn default() -> Self {
        Self::Conservative
    }
}

impl fmt::Display for MarkingMode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Conservative => write!(f, "conservative (best bid)"),
            Self::Midpoint => write!(f, "midpoint"),
            Self::LastTrade => write!(f, "last trade"),
        }
    }
}

/// Wallet polling aggressiveness.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PollingMode {
    /// 5s per wallet. Safe, well within rate limits.
    Baseline,
    /// 2s per wallet, parallel polling. More aggressive, closer to rate limits.
    Aggressive,
}

impl Default for PollingMode {
    fn default() -> Self {
        Self::Baseline
    }
}

impl fmt::Display for PollingMode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Baseline => write!(f, "baseline (5s/wallet)"),
            Self::Aggressive => write!(f, "aggressive (2s/wallet)"),
        }
    }
}

/// Latency components — each tracked and reported separately.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LatencyComponents {
    /// Time between the wallet's trade on-chain and when our poller detected it.
    pub detection_delay_ms: Option<u64>,
    /// Time for internal processing (event bus → fill simulation).
    pub processing_delay_ms: Option<u64>,
    /// Simulated time for our order to arrive at the exchange after we decide to copy.
    pub arrival_delay_ms: u64,
}

/// Policy when fee data is completely unavailable (no live, no cache).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FeeUnavailablePolicy {
    /// Skip the trade — miss it honestly rather than fake a zero-fee fill.
    Skip,
    /// Fill with zero fee but mark as degraded.
    Degrade,
}

impl Default for FeeUnavailablePolicy {
    fn default() -> Self {
        Self::Skip
    }
}

impl fmt::Display for FeeUnavailablePolicy {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Skip => write!(f, "skip"),
            Self::Degrade => write!(f, "degrade"),
        }
    }
}

/// A single level in an orderbook.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BookLevel {
    pub price: Decimal,
    pub size: Decimal,
}
