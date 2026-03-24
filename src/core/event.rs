use chrono::{DateTime, Utc};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};

use super::types::{
    BookLevel, DataQuality, ExitActionability, FeeSource, FillResult, LatencyComponents, MarketId,
    Side, TokenId, WalletAddr, WalletCategory,
};

/// Every event that flows through the engine. Append-only to the event log.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum NormalizedEvent {
    BookUpdate {
        token_id: TokenId,
        bids: Vec<BookLevel>,
        asks: Vec<BookLevel>,
        ts: DateTime<Utc>,
        quality: DataQuality,
    },

    WalletTrade {
        wallet: WalletAddr,
        category: WalletCategory,
        token_id: TokenId,
        market_id: MarketId,
        side: Side,
        price: Decimal,
        size: Decimal,
        tx_hash: String,
        detected_at: DateTime<Utc>,
        source_ts: DateTime<Utc>,
    },

    SimulatedFill {
        wallet_trade_ref: String,
        our_side: Side,
        fill_result: FillResult,
        avg_price: Option<Decimal>,
        filled_qty: Decimal,
        fee_rate: Option<Decimal>,
        fee_amount: Decimal,
        fee_source: FeeSource,
        slippage_bps: Option<Decimal>,
        latency: LatencyComponents,
        book_quality: DataQuality,
        exit_actionability: Option<ExitActionability>,
    },

    QualityChange {
        token_id: TokenId,
        old: DataQuality,
        new: DataQuality,
        reason: String,
        ts: DateTime<Utc>,
    },

    HealthEvent {
        kind: String,
        message: String,
        ts: DateTime<Utc>,
    },
}

impl NormalizedEvent {
    pub fn kind_str(&self) -> &'static str {
        match self {
            Self::BookUpdate { .. } => "book_update",
            Self::WalletTrade { .. } => "wallet_trade",
            Self::SimulatedFill { .. } => "simulated_fill",
            Self::QualityChange { .. } => "quality_change",
            Self::HealthEvent { .. } => "health_event",
        }
    }
}
