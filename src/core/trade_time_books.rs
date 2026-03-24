//! Trade-time book snapshot ring buffer.
//!
//! When the CLOB WS fires `last_trade_price`, we snapshot the current book state
//! for that token. Later, when REST polling detects a tracked wallet trade, we look
//! up the closest matching snapshot to simulate against the book as it existed at
//! trade time — not minutes later after other participants have changed it.
//!
//! This eliminates hindsight bias without needing Alchemy or any RPC provider.

use std::collections::VecDeque;
use std::time::Instant;

use rust_decimal::Decimal;

use super::book::OrderBook;
use super::types::TokenId;

/// A snapshot of a book captured at the moment a trade happened on the WS feed.
#[derive(Debug, Clone)]
pub struct TradeTimeSnapshot {
    pub token_id: TokenId,
    pub price: Decimal,
    pub size: Option<Decimal>,
    pub captured_at: Instant,
    pub book: OrderBook,
}

/// Ring buffer of trade-time book snapshots.
/// Bounded by max entries and max age to prevent unbounded memory growth.
pub struct TradeTimeBooks {
    snapshots: VecDeque<TradeTimeSnapshot>,
    max_entries: usize,
    max_age_secs: u64,
}

impl TradeTimeBooks {
    pub fn new(max_entries: usize, max_age_secs: u64) -> Self {
        Self {
            snapshots: VecDeque::with_capacity(max_entries.min(4096)),
            max_entries,
            max_age_secs,
        }
    }

    /// Record a book snapshot at the moment a trade is observed on the WS feed.
    /// Called from handle_ws_event when `last_trade_price` arrives.
    pub fn record(
        &mut self,
        token_id: &TokenId,
        price: Decimal,
        size: Option<Decimal>,
        book: &OrderBook,
    ) {
        // Evict old entries
        self.evict_stale();

        // Evict oldest if at capacity
        while self.snapshots.len() >= self.max_entries {
            self.snapshots.pop_front();
        }

        self.snapshots.push_back(TradeTimeSnapshot {
            token_id: token_id.clone(),
            price,
            size,
            captured_at: Instant::now(),
            book: book.clone(),
        });
    }

    /// Look up the best matching trade-time snapshot for a detected wallet trade.
    ///
    /// Matching criteria:
    /// 1. Same token_id
    /// 2. Not older than 120 seconds
    /// 3. Price within 1% of the trade's price
    /// 4. If size available, prefer exact size match; accept any size as fallback
    /// 5. Most recent match wins
    pub fn lookup(
        &self,
        token_id: &TokenId,
        trade_price: Decimal,
        trade_size: Option<Decimal>,
    ) -> Option<&OrderBook> {
        let tolerance = trade_price * Decimal::new(1, 2); // 1%

        let mut best: Option<&TradeTimeSnapshot> = None;

        for snap in self.snapshots.iter().rev() {
            if &snap.token_id != token_id {
                continue;
            }
            if snap.captured_at.elapsed().as_secs() > 120 {
                continue;
            }
            let diff = (snap.price - trade_price).abs();
            if diff > tolerance {
                continue;
            }

            // If we have size info, prefer exact match
            if let (Some(ts), Some(ss)) = (trade_size, snap.size) {
                if ts == ss {
                    return Some(&snap.book); // perfect match
                }
            }

            // Accept as fallback (most recent price-match)
            if best.is_none() {
                best = Some(snap);
            }
        }

        best.map(|s| &s.book)
    }

    /// Remove entries older than max_age_secs.
    fn evict_stale(&mut self) {
        let cutoff_secs = self.max_age_secs;
        while let Some(front) = self.snapshots.front() {
            if front.captured_at.elapsed().as_secs() > cutoff_secs {
                self.snapshots.pop_front();
            } else {
                break;
            }
        }
    }

    pub fn len(&self) -> usize {
        self.snapshots.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::types::BookLevel;
    use rust_decimal_macros::dec;

    fn make_book(token: &str, bid: &str, ask: &str) -> OrderBook {
        let mut book = OrderBook::new(token.into());
        book.apply_snapshot(
            &[BookLevel {
                price: bid.parse().unwrap(),
                size: dec!(100),
            }],
            &[BookLevel {
                price: ask.parse().unwrap(),
                size: dec!(100),
            }],
        );
        book
    }

    #[test]
    fn record_and_lookup_match() {
        let mut ttb = TradeTimeBooks::new(100, 60);
        let book = make_book("t1", "0.49", "0.51");

        ttb.record(&"t1".into(), dec!(0.50), Some(dec!(10)), &book);

        // Exact price match
        let found = ttb.lookup(&"t1".into(), dec!(0.50), Some(dec!(10)));
        assert!(found.is_some());
        assert_eq!(found.unwrap().best_bid(), Some(dec!(0.49)));
    }

    #[test]
    fn lookup_within_tolerance() {
        let mut ttb = TradeTimeBooks::new(100, 60);
        let book = make_book("t1", "0.49", "0.51");

        ttb.record(&"t1".into(), dec!(0.50), None, &book);

        // 0.5% off — should still match (within 1% tolerance)
        let found = ttb.lookup(&"t1".into(), dec!(0.5025), None);
        assert!(found.is_some());
    }

    #[test]
    fn lookup_wrong_token_returns_none() {
        let mut ttb = TradeTimeBooks::new(100, 60);
        let book = make_book("t1", "0.49", "0.51");
        ttb.record(&"t1".into(), dec!(0.50), None, &book);

        assert!(ttb.lookup(&"t2".into(), dec!(0.50), None).is_none());
    }

    #[test]
    fn lookup_too_far_price_returns_none() {
        let mut ttb = TradeTimeBooks::new(100, 60);
        let book = make_book("t1", "0.49", "0.51");
        ttb.record(&"t1".into(), dec!(0.50), None, &book);

        // 10% off — should NOT match
        assert!(ttb.lookup(&"t1".into(), dec!(0.55), None).is_none());
    }

    #[test]
    fn most_recent_match_wins() {
        let mut ttb = TradeTimeBooks::new(100, 60);

        let book_old = make_book("t1", "0.40", "0.60");
        ttb.record(&"t1".into(), dec!(0.50), None, &book_old);

        let book_new = make_book("t1", "0.48", "0.52");
        ttb.record(&"t1".into(), dec!(0.50), None, &book_new);

        let found = ttb.lookup(&"t1".into(), dec!(0.50), None).unwrap();
        // Should get the newer book (bid 0.48, not 0.40)
        assert_eq!(found.best_bid(), Some(dec!(0.48)));
    }

    #[test]
    fn eviction_by_capacity() {
        let mut ttb = TradeTimeBooks::new(3, 60);
        let book = make_book("t1", "0.49", "0.51");

        ttb.record(&"t1".into(), dec!(0.10), None, &book);
        ttb.record(&"t1".into(), dec!(0.20), None, &book);
        ttb.record(&"t1".into(), dec!(0.30), None, &book);
        assert_eq!(ttb.len(), 3);

        // Adding a 4th should evict the oldest
        ttb.record(&"t1".into(), dec!(0.40), None, &book);
        assert_eq!(ttb.len(), 3);

        // The oldest (price=0.10) should be gone
        assert!(ttb.lookup(&"t1".into(), dec!(0.10), None).is_none());
        // The newest should be there
        assert!(ttb.lookup(&"t1".into(), dec!(0.40), None).is_some());
    }
}
