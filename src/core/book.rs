use std::collections::BTreeMap;
use std::time::Instant;

use rust_decimal::Decimal;
use super::types::{BookLevel, DataQuality, TokenId};

/// Local orderbook for a single token. Bids sorted descending, asks ascending.
#[derive(Debug, Clone)]
pub struct OrderBook {
    /// Token ID this book represents. Used for snapshot matching and logging.
    #[allow(dead_code)]
    pub token_id: TokenId,
    bids: BTreeMap<Decimal, Decimal>, // price → size
    asks: BTreeMap<Decimal, Decimal>,
    pub last_update: Instant,
    pub quality: DataQuality,
    pub last_trade_price: Option<Decimal>,
}

impl OrderBook {
    pub fn new(token_id: TokenId) -> Self {
        Self {
            token_id,
            bids: BTreeMap::new(),
            asks: BTreeMap::new(),
            last_update: Instant::now(),
            quality: DataQuality::Rebuilding,
            last_trade_price: None,
        }
    }

    /// Replace the entire book from a snapshot (WebSocket `book` event or REST response).
    pub fn apply_snapshot(&mut self, bids: &[BookLevel], asks: &[BookLevel]) {
        self.bids.clear();
        self.asks.clear();
        for level in bids {
            if level.size > Decimal::ZERO {
                self.bids.insert(level.price, level.size);
            }
        }
        for level in asks {
            if level.size > Decimal::ZERO {
                self.asks.insert(level.price, level.size);
            }
        }
        self.last_update = Instant::now();
        self.quality = DataQuality::Good;
    }

    /// Best bid price (highest).
    pub fn best_bid(&self) -> Option<Decimal> {
        self.bids.keys().next_back().copied()
    }

    /// Best ask price (lowest).
    pub fn best_ask(&self) -> Option<Decimal> {
        self.asks.keys().next().copied()
    }

    /// Midpoint of best bid and best ask. None if either side is empty.
    pub fn midpoint(&self) -> Option<Decimal> {
        match (self.best_bid(), self.best_ask()) {
            (Some(bid), Some(ask)) => Some((bid + ask) / Decimal::TWO),
            _ => None,
        }
    }

    /// Get ask levels sorted ascending by price (for buy-side depth walking).
    pub fn ask_levels(&self) -> Vec<BookLevel> {
        self.asks
            .iter()
            .map(|(&price, &size)| BookLevel { price, size })
            .collect()
    }

    /// Get bid levels sorted descending by price (for sell-side depth walking).
    pub fn bid_levels(&self) -> Vec<BookLevel> {
        self.bids
            .iter()
            .rev()
            .map(|(&price, &size)| BookLevel { price, size })
            .collect()
    }

    /// Total depth on the ask side. Used in tests and analytics.
    #[allow(dead_code)]
    pub fn total_ask_depth(&self) -> Decimal {
        self.asks.values().copied().sum()
    }

    /// Total depth on the bid side. Used in tests and analytics.
    #[allow(dead_code)]
    pub fn total_bid_depth(&self) -> Decimal {
        self.bids.values().copied().sum()
    }

    /// Check if the book should be marked stale based on time since last update.
    pub fn check_staleness(&mut self, stale_threshold: std::time::Duration) {
        if self.quality == DataQuality::Good && self.last_update.elapsed() > stale_threshold {
            self.quality = DataQuality::Stale;
        }
    }

    /// Mark as rebuilding (e.g., after reconnect).
    pub fn mark_rebuilding(&mut self) {
        self.quality = DataQuality::Rebuilding;
    }

    /// Consume liquidity from the book to model a prior trade.
    ///
    /// When a tracked wallet BUYs, they consumed asks (walking up from best ask).
    /// When they SELL, they consumed bids (walking down from best bid).
    /// We subtract `qty` from the relevant side so our fill simulation sees
    /// the reduced depth that would actually be available to us.
    pub fn consume_liquidity(&mut self, side: super::types::Side, mut qty: Decimal) {
        use super::types::Side;
        if qty <= Decimal::ZERO {
            return;
        }

        let levels = match side {
            Side::Buy => &mut self.asks,  // buyer consumed asks
            Side::Sell => &mut self.bids, // seller consumed bids
        };

        // Walk the levels and subtract qty
        let mut to_remove = Vec::new();
        // For asks: walk ascending (BTreeMap natural order = ascending)
        // For bids: walk descending (best bid first)
        let keys: Vec<Decimal> = match side {
            Side::Buy => levels.keys().copied().collect(),
            Side::Sell => levels.keys().rev().copied().collect(),
        };

        for price in keys {
            if qty <= Decimal::ZERO {
                break;
            }
            if let Some(size) = levels.get_mut(&price) {
                let consumed = qty.min(*size);
                *size -= consumed;
                qty -= consumed;
                if *size <= Decimal::ZERO {
                    to_remove.push(price);
                }
            }
        }

        for price in to_remove {
            levels.remove(&price);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(v: &str) -> Decimal {
        v.parse().unwrap()
    }

    fn levels(data: &[(& str, &str)]) -> Vec<BookLevel> {
        data.iter()
            .map(|(p, s)| BookLevel {
                price: d(p),
                size: d(s),
            })
            .collect()
    }

    #[test]
    fn empty_book() {
        let book = OrderBook::new("token1".into());
        assert!(book.best_bid().is_none());
        assert!(book.best_ask().is_none());
        assert!(book.midpoint().is_none());
        assert_eq!(book.total_ask_depth(), Decimal::ZERO);
        assert_eq!(book.total_bid_depth(), Decimal::ZERO);
    }

    #[test]
    fn snapshot_and_best_prices() {
        let mut book = OrderBook::new("t1".into());
        let bids = levels(&[("0.45", "100"), ("0.44", "200"), ("0.43", "300")]);
        let asks = levels(&[("0.55", "150"), ("0.56", "250")]);
        book.apply_snapshot(&bids, &asks);

        assert_eq!(book.best_bid(), Some(d("0.45")));
        assert_eq!(book.best_ask(), Some(d("0.55")));
        assert_eq!(book.midpoint(), Some(d("0.50")));
        assert_eq!(book.quality, DataQuality::Good);
    }

    #[test]
    fn bid_levels_descending() {
        let mut book = OrderBook::new("t1".into());
        let bids = levels(&[("0.43", "300"), ("0.45", "100"), ("0.44", "200")]);
        book.apply_snapshot(&bids, &[]);

        let lvls = book.bid_levels();
        assert_eq!(lvls.len(), 3);
        assert_eq!(lvls[0].price, d("0.45")); // highest first
        assert_eq!(lvls[1].price, d("0.44"));
        assert_eq!(lvls[2].price, d("0.43"));
    }

    #[test]
    fn ask_levels_ascending() {
        let mut book = OrderBook::new("t1".into());
        let asks = levels(&[("0.57", "50"), ("0.55", "150"), ("0.56", "250")]);
        book.apply_snapshot(&[], &asks);

        let lvls = book.ask_levels();
        assert_eq!(lvls.len(), 3);
        assert_eq!(lvls[0].price, d("0.55")); // lowest first
        assert_eq!(lvls[1].price, d("0.56"));
        assert_eq!(lvls[2].price, d("0.57"));
    }

    #[test]
    fn zero_size_levels_filtered() {
        let mut book = OrderBook::new("t1".into());
        let bids = levels(&[("0.45", "0"), ("0.44", "100")]);
        let asks = levels(&[("0.55", "0"), ("0.56", "200")]);
        book.apply_snapshot(&bids, &asks);

        assert_eq!(book.best_bid(), Some(d("0.44")));
        assert_eq!(book.best_ask(), Some(d("0.56")));
    }

    #[test]
    fn total_depth() {
        let mut book = OrderBook::new("t1".into());
        let bids = levels(&[("0.45", "100"), ("0.44", "200")]);
        let asks = levels(&[("0.55", "150"), ("0.56", "50")]);
        book.apply_snapshot(&bids, &asks);

        assert_eq!(book.total_bid_depth(), d("300"));
        assert_eq!(book.total_ask_depth(), d("200"));
    }

    #[test]
    fn snapshot_replaces_previous() {
        let mut book = OrderBook::new("t1".into());
        book.apply_snapshot(&levels(&[("0.45", "100")]), &levels(&[("0.55", "100")]));
        assert_eq!(book.total_bid_depth(), d("100"));

        book.apply_snapshot(&levels(&[("0.40", "50")]), &[]);
        assert_eq!(book.best_bid(), Some(d("0.40")));
        assert_eq!(book.total_bid_depth(), d("50"));
        assert!(book.best_ask().is_none()); // asks cleared
    }

    #[test]
    fn consume_liquidity_buy_removes_asks() {
        let mut book = OrderBook::new("t1".into());
        let asks = levels(&[("0.55", "100"), ("0.56", "200"), ("0.57", "300")]);
        book.apply_snapshot(&[], &asks);

        // A buyer consumed 150 shares: 100 at 0.55 (fully consumed) + 50 at 0.56
        book.consume_liquidity(crate::core::types::Side::Buy, d("150"));

        let lvls = book.ask_levels();
        assert_eq!(lvls.len(), 2); // 0.55 fully consumed, removed
        assert_eq!(lvls[0].price, d("0.56"));
        assert_eq!(lvls[0].size, d("150")); // 200 - 50 = 150
        assert_eq!(lvls[1].price, d("0.57"));
        assert_eq!(lvls[1].size, d("300")); // untouched
    }

    #[test]
    fn consume_liquidity_sell_removes_bids() {
        let mut book = OrderBook::new("t1".into());
        let bids = levels(&[("0.45", "100"), ("0.44", "200")]);
        book.apply_snapshot(&bids, &[]);

        // A seller consumed 100 shares from the best bid (0.45)
        book.consume_liquidity(crate::core::types::Side::Sell, d("100"));

        let lvls = book.bid_levels();
        assert_eq!(lvls.len(), 1); // 0.45 fully consumed
        assert_eq!(lvls[0].price, d("0.44"));
        assert_eq!(lvls[0].size, d("200")); // untouched
    }

    #[test]
    fn consume_more_than_available() {
        let mut book = OrderBook::new("t1".into());
        let asks = levels(&[("0.55", "50")]);
        book.apply_snapshot(&[], &asks);

        // Consume more than exists — should just drain the book
        book.consume_liquidity(crate::core::types::Side::Buy, d("100"));
        assert!(book.ask_levels().is_empty());
    }

    #[test]
    fn staleness_detection() {
        let mut book = OrderBook::new("t1".into());
        book.apply_snapshot(&[], &[]);
        assert_eq!(book.quality, DataQuality::Good);

        // Force the last_update to the past
        book.last_update = Instant::now() - std::time::Duration::from_secs(60);
        book.check_staleness(std::time::Duration::from_secs(30));
        assert_eq!(book.quality, DataQuality::Stale);
    }
}
