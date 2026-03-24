use std::collections::HashMap;

use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use tracing::error;

use crate::core::book::OrderBook;
use crate::core::types::{FeeSource, MarkingMode, TokenId, WalletAddr, WalletCategory};
use crate::sim::fill::FillOutput;

/// A single position in the session portfolio.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Position {
    pub token_id: TokenId,
    pub market_id: String,
    pub qty: Decimal,
    pub cost_basis: Decimal,
    pub avg_entry_price: Decimal,
    pub source_wallet: WalletAddr,
    pub source_category: WalletCategory,
}

/// The singleton session portfolio.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Portfolio {
    pub starting_capital: Decimal,
    pub cash: Decimal,
    pub positions: HashMap<TokenId, Position>,
    pub realized_pnl_gross: Decimal,
    pub realized_fees: Decimal,
    pub turnover: Decimal,
    pub fill_count: u64,
    pub partial_fill_count: u64,
    pub miss_count: u64,
    pub degraded_fill_count: u64,
}

#[derive(Debug, thiserror::Error)]
pub enum PortfolioError {
    #[error("accounting invariant violated: {0}")]
    InvariantViolation(String),
}

impl Portfolio {
    pub fn new(starting_capital: Decimal) -> Self {
        Self {
            starting_capital,
            cash: starting_capital,
            positions: HashMap::new(),
            realized_pnl_gross: Decimal::ZERO,
            realized_fees: Decimal::ZERO,
            turnover: Decimal::ZERO,
            fill_count: 0,
            partial_fill_count: 0,
            miss_count: 0,
            degraded_fill_count: 0,
        }
    }

    /// Apply a simulated buy fill to the portfolio.
    pub fn apply_buy(
        &mut self,
        token_id: &TokenId,
        market_id: &str,
        fill: &FillOutput,
        wallet: &WalletAddr,
        category: WalletCategory,
    ) -> Result<(), PortfolioError> {
        if fill.filled_qty == Decimal::ZERO {
            return Ok(());
        }

        let total_cost = fill.cost + fill.fee_amount;
        self.cash -= total_cost;
        self.realized_fees += fill.fee_amount;
        self.turnover += fill.cost;

        if fill.fee_source == FeeSource::Unavailable {
            self.degraded_fill_count += 1;
        }

        let position = self
            .positions
            .entry(token_id.clone())
            .or_insert_with(|| Position {
                token_id: token_id.clone(),
                market_id: market_id.to_string(),
                qty: Decimal::ZERO,
                cost_basis: Decimal::ZERO,
                avg_entry_price: Decimal::ZERO,
                source_wallet: wallet.clone(),
                source_category: category,
            });

        position.cost_basis += fill.cost;
        position.qty += fill.filled_qty;
        position.avg_entry_price = if position.qty > Decimal::ZERO {
            (position.cost_basis / position.qty).round_dp(6)
        } else {
            Decimal::ZERO
        };

        self.check_invariants(None)?;
        Ok(())
    }

    /// Apply a simulated sell fill to the portfolio.
    pub fn apply_sell(
        &mut self,
        token_id: &TokenId,
        fill: &FillOutput,
    ) -> Result<(), PortfolioError> {
        if fill.filled_qty == Decimal::ZERO {
            return Ok(());
        }

        let Some(position) = self.positions.get_mut(token_id) else {
            return Err(PortfolioError::InvariantViolation(
                format!("sell on non-existent position {token_id}"),
            ));
        };

        if fill.filled_qty > position.qty {
            return Err(PortfolioError::InvariantViolation(
                format!(
                    "sell qty {} exceeds position qty {} for {token_id}",
                    fill.filled_qty, position.qty
                ),
            ));
        }

        let proceeds = fill.cost; // For sells, cost = filled_qty * avg_price = what we receive
        let cost_of_sold = position.avg_entry_price * fill.filled_qty;
        let gross_pnl = proceeds - cost_of_sold;

        self.cash += proceeds - fill.fee_amount;
        self.realized_pnl_gross += gross_pnl;
        self.realized_fees += fill.fee_amount;
        self.turnover += proceeds;

        if fill.fee_source == FeeSource::Unavailable {
            self.degraded_fill_count += 1;
        }

        position.qty -= fill.filled_qty;
        position.cost_basis -= cost_of_sold;

        if position.qty == Decimal::ZERO {
            self.positions.remove(token_id);
        }

        self.check_invariants(None)?;
        Ok(())
    }

    /// Record a missed trade (no portfolio change, just stats).
    pub fn record_miss(&mut self) {
        self.miss_count += 1;
    }

    /// Record a partial fill (stats only — the actual fill is applied via apply_buy/apply_sell).
    pub fn record_partial(&mut self) {
        self.partial_fill_count += 1;
    }

    /// Record a full fill (stats only).
    pub fn record_full(&mut self) {
        self.fill_count += 1;
    }

    /// Get the position qty for a token (0 if no position).
    pub fn position_qty(&self, token_id: &TokenId) -> Decimal {
        self.positions
            .get(token_id)
            .map(|p| p.qty)
            .unwrap_or(Decimal::ZERO)
    }

    /// Compute unrealized PnL using the specified marking mode.
    pub fn unrealized_pnl(
        &self,
        books: &HashMap<TokenId, OrderBook>,
        marking_mode: MarkingMode,
    ) -> Decimal {
        let mut total = Decimal::ZERO;
        for (token_id, pos) in &self.positions {
            let mark_price = match books.get(token_id) {
                Some(book) => match marking_mode {
                    MarkingMode::Conservative => book.best_bid().unwrap_or(Decimal::ZERO),
                    MarkingMode::Midpoint => book.midpoint().unwrap_or(Decimal::ZERO),
                    MarkingMode::LastTrade => {
                        book.last_trade_price.unwrap_or(Decimal::ZERO)
                    }
                },
                None => Decimal::ZERO,
            };
            let market_value = pos.qty * mark_price;
            total += market_value - pos.cost_basis;
        }
        total
    }

    /// Compute total market value of open positions.
    pub fn market_value(
        &self,
        books: &HashMap<TokenId, OrderBook>,
        marking_mode: MarkingMode,
    ) -> Decimal {
        let mut total = Decimal::ZERO;
        for (token_id, pos) in &self.positions {
            let mark_price = match books.get(token_id) {
                Some(book) => match marking_mode {
                    MarkingMode::Conservative => book.best_bid().unwrap_or(Decimal::ZERO),
                    MarkingMode::Midpoint => book.midpoint().unwrap_or(Decimal::ZERO),
                    MarkingMode::LastTrade => {
                        book.last_trade_price.unwrap_or(Decimal::ZERO)
                    }
                },
                None => Decimal::ZERO,
            };
            total += pos.qty * mark_price;
        }
        total
    }

    /// Account value = cash + market_value(open_positions).
    pub fn account_value(
        &self,
        books: &HashMap<TokenId, OrderBook>,
        marking_mode: MarkingMode,
    ) -> Decimal {
        self.cash + self.market_value(books, marking_mode)
    }

    /// Net PnL = realized_pnl_gross - realized_fees + unrealized_pnl.
    pub fn net_pnl(
        &self,
        books: &HashMap<TokenId, OrderBook>,
        marking_mode: MarkingMode,
    ) -> Decimal {
        self.realized_pnl_gross - self.realized_fees + self.unrealized_pnl(books, marking_mode)
    }

    /// Realized net PnL = realized_pnl_gross - realized_fees.
    pub fn realized_pnl_net(&self) -> Decimal {
        self.realized_pnl_gross - self.realized_fees
    }

    /// Check accounting invariants. Panics on violation in debug mode.
    /// In release mode, logs an error and returns Err.
    fn check_invariants(
        &self,
        books: Option<&HashMap<TokenId, OrderBook>>,
    ) -> Result<(), PortfolioError> {
        // Cash must never go negative
        if self.cash < Decimal::ZERO {
            let msg = format!("cash is negative: {}", self.cash);
            error!("{msg}");
            return Err(PortfolioError::InvariantViolation(msg));
        }

        // If we have books, check the full identity:
        // starting_capital + net_pnl = account_value
        if let Some(books) = books {
            let mode = MarkingMode::Conservative;
            let account_val = self.account_value(books, mode);
            let net = self.net_pnl(books, mode);
            let expected = self.starting_capital + net;
            let diff = (expected - account_val).abs();
            // Allow tiny rounding differences (< 0.01 USDC)
            if diff > Decimal::new(1, 2) {
                let msg = format!(
                    "identity violated: starting({}) + net_pnl({}) = {} != account_value({}), diff={}",
                    self.starting_capital, net, expected, account_val, diff
                );
                error!("{msg}");
                return Err(PortfolioError::InvariantViolation(msg));
            }
        }

        Ok(())
    }

    /// Serialize to JSON for snapshots.
    pub fn to_json(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string(self)
    }

    /// Deserialize from JSON snapshot.
    pub fn from_json(json: &str) -> Result<Self, serde_json::Error> {
        serde_json::from_str(json)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::book::OrderBook;
    use crate::core::types::{BookLevel, DataQuality, FillResult, LatencyComponents, Side};
    use rust_decimal_macros::dec;

    fn make_fill(side: Side, qty: Decimal, price: Decimal, fee: Decimal) -> FillOutput {
        let cost = qty * price;
        FillOutput {
            result: FillResult::Full,
            avg_price: Some(price),
            filled_qty: qty,
            cost,
            fee_amount: fee,
            fee_rate_bps: Some(dec!(25)),
            fee_source: FeeSource::Live,
            slippage_bps: Some(Decimal::ZERO),
            book_quality: DataQuality::Good,
            exit_actionability: None,
            latency: LatencyComponents {
                detection_delay_ms: Some(3000),
                processing_delay_ms: Some(1),
                arrival_delay_ms: 500,
            },
        }
    }

    fn make_book_with_price(token_id: &str, bid: &str, ask: &str) -> OrderBook {
        let mut book = OrderBook::new(token_id.into());
        book.apply_snapshot(
            &[BookLevel { price: bid.parse().unwrap(), size: dec!(10000) }],
            &[BookLevel { price: ask.parse().unwrap(), size: dec!(10000) }],
        );
        book
    }

    #[test]
    fn new_portfolio() {
        let p = Portfolio::new(dec!(10000));
        assert_eq!(p.cash, dec!(10000));
        assert_eq!(p.starting_capital, dec!(10000));
        assert!(p.positions.is_empty());
    }

    #[test]
    fn buy_creates_position() {
        let mut p = Portfolio::new(dec!(10000));
        let fill = make_fill(Side::Buy, dec!(100), dec!(0.50), dec!(0.03));
        p.apply_buy(&"t1".into(), "m1", &fill, &"0xw".into(), WalletCategory::Directional)
            .unwrap();

        assert_eq!(p.cash, dec!(10000) - dec!(50) - dec!(0.03));
        assert_eq!(p.positions.len(), 1);
        assert_eq!(p.positions["t1"].qty, dec!(100));
        assert_eq!(p.positions["t1"].avg_entry_price, dec!(0.500000));
        assert_eq!(p.realized_fees, dec!(0.03));
        assert_eq!(p.turnover, dec!(50));
    }

    #[test]
    fn sell_closes_position() {
        let mut p = Portfolio::new(dec!(10000));
        let buy_fill = make_fill(Side::Buy, dec!(100), dec!(0.50), dec!(0.03));
        p.apply_buy(&"t1".into(), "m1", &buy_fill, &"0xw".into(), WalletCategory::Directional)
            .unwrap();

        let sell_fill = make_fill(Side::Sell, dec!(100), dec!(0.60), dec!(0.02));
        p.apply_sell(&"t1".into(), &sell_fill).unwrap();

        // Position should be closed
        assert!(p.positions.is_empty());
        // Cash: started 10000, bought at 50+0.03, sold at 60-0.02 = 10009.95
        assert_eq!(p.cash, dec!(10000) - dec!(50) - dec!(0.03) + dec!(60) - dec!(0.02));
        // Gross PnL: sold for 60, cost basis was 50, so +10
        assert_eq!(p.realized_pnl_gross, dec!(10));
        assert_eq!(p.realized_fees, dec!(0.05));
    }

    #[test]
    fn partial_sell() {
        let mut p = Portfolio::new(dec!(10000));
        let buy_fill = make_fill(Side::Buy, dec!(100), dec!(0.50), dec!(0.03));
        p.apply_buy(&"t1".into(), "m1", &buy_fill, &"0xw".into(), WalletCategory::Directional)
            .unwrap();

        let sell_fill = make_fill(Side::Sell, dec!(40), dec!(0.60), dec!(0.01));
        p.apply_sell(&"t1".into(), &sell_fill).unwrap();

        assert_eq!(p.positions["t1"].qty, dec!(60));
        // Cost basis of 40 shares at 0.50 = 20, gross pnl = 24 - 20 = 4
        assert_eq!(p.realized_pnl_gross, dec!(4));
    }

    #[test]
    fn sell_without_position_errors() {
        let mut p = Portfolio::new(dec!(10000));
        let sell_fill = make_fill(Side::Sell, dec!(100), dec!(0.60), dec!(0.02));
        let err = p.apply_sell(&"t1".into(), &sell_fill).unwrap_err();
        assert!(err.to_string().contains("non-existent"));
    }

    #[test]
    fn sell_more_than_owned_errors() {
        let mut p = Portfolio::new(dec!(10000));
        let buy_fill = make_fill(Side::Buy, dec!(50), dec!(0.50), dec!(0));
        p.apply_buy(&"t1".into(), "m1", &buy_fill, &"0xw".into(), WalletCategory::Directional)
            .unwrap();

        let sell_fill = make_fill(Side::Sell, dec!(100), dec!(0.60), dec!(0));
        let err = p.apply_sell(&"t1".into(), &sell_fill).unwrap_err();
        assert!(err.to_string().contains("exceeds"));
    }

    #[test]
    fn unrealized_pnl_conservative() {
        let mut p = Portfolio::new(dec!(10000));
        let buy_fill = make_fill(Side::Buy, dec!(100), dec!(0.50), dec!(0));
        p.apply_buy(&"t1".into(), "m1", &buy_fill, &"0xw".into(), WalletCategory::Directional)
            .unwrap();

        let mut books = HashMap::new();
        books.insert("t1".to_string(), make_book_with_price("t1", "0.55", "0.60"));

        // Conservative uses best bid = 0.55
        let unrealized = p.unrealized_pnl(&books, MarkingMode::Conservative);
        // market value = 100 * 0.55 = 55, cost = 50, unrealized = 5
        assert_eq!(unrealized, dec!(5));
    }

    #[test]
    fn unrealized_pnl_midpoint() {
        let mut p = Portfolio::new(dec!(10000));
        let buy_fill = make_fill(Side::Buy, dec!(100), dec!(0.50), dec!(0));
        p.apply_buy(&"t1".into(), "m1", &buy_fill, &"0xw".into(), WalletCategory::Directional)
            .unwrap();

        let mut books = HashMap::new();
        books.insert("t1".to_string(), make_book_with_price("t1", "0.55", "0.65"));

        let unrealized = p.unrealized_pnl(&books, MarkingMode::Midpoint);
        // Midpoint = 0.60, market value = 60, cost = 50, unrealized = 10
        assert_eq!(unrealized, dec!(10));
    }

    #[test]
    fn account_value_identity() {
        let mut p = Portfolio::new(dec!(10000));
        let buy_fill = make_fill(Side::Buy, dec!(100), dec!(0.50), dec!(1));
        p.apply_buy(&"t1".into(), "m1", &buy_fill, &"0xw".into(), WalletCategory::Directional)
            .unwrap();

        let mut books = HashMap::new();
        books.insert("t1".to_string(), make_book_with_price("t1", "0.55", "0.60"));

        let mode = MarkingMode::Conservative;
        let av = p.account_value(&books, mode);
        let net = p.net_pnl(&books, mode);

        // starting_capital + net_pnl should equal account_value
        let expected = p.starting_capital + net;
        let diff = (expected - av).abs();
        assert!(diff < dec!(0.01), "identity violated: {expected} != {av}");
    }

    #[test]
    fn snapshot_round_trip() {
        let mut p = Portfolio::new(dec!(10000));
        let buy_fill = make_fill(Side::Buy, dec!(100), dec!(0.50), dec!(0.03));
        p.apply_buy(&"t1".into(), "m1", &buy_fill, &"0xw".into(), WalletCategory::Directional)
            .unwrap();

        let json = p.to_json().unwrap();
        let p2 = Portfolio::from_json(&json).unwrap();
        assert_eq!(p2.cash, p.cash);
        assert_eq!(p2.positions.len(), 1);
        assert_eq!(p2.positions["t1"].qty, dec!(100));
    }

    #[test]
    fn multiple_buys_average_entry() {
        let mut p = Portfolio::new(dec!(10000));
        let fill1 = make_fill(Side::Buy, dec!(100), dec!(0.50), dec!(0));
        p.apply_buy(&"t1".into(), "m1", &fill1, &"0xw".into(), WalletCategory::Directional)
            .unwrap();

        let fill2 = make_fill(Side::Buy, dec!(100), dec!(0.60), dec!(0));
        p.apply_buy(&"t1".into(), "m1", &fill2, &"0xw".into(), WalletCategory::Directional)
            .unwrap();

        let pos = &p.positions["t1"];
        assert_eq!(pos.qty, dec!(200));
        // cost = 50 + 60 = 110, avg = 110/200 = 0.55
        assert_eq!(pos.avg_entry_price, dec!(0.550000));
    }

    #[test]
    fn degraded_fill_counted() {
        let mut p = Portfolio::new(dec!(10000));
        let mut fill = make_fill(Side::Buy, dec!(100), dec!(0.50), dec!(0));
        fill.fee_source = FeeSource::Unavailable;
        p.apply_buy(&"t1".into(), "m1", &fill, &"0xw".into(), WalletCategory::Directional)
            .unwrap();
        assert_eq!(p.degraded_fill_count, 1);
    }
}
