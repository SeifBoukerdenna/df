use std::collections::HashMap;
use std::path::Path;

use rusqlite::Connection;

use crate::core::event::NormalizedEvent;

const SCHEMA_VERSION: i32 = 1;

#[derive(Debug, thiserror::Error)]
pub enum StorageError {
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("serialization error: {0}")]
    Serde(#[from] serde_json::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("no snapshot found")]
    NoSnapshot,
    #[error("schema version mismatch: expected {expected}, got {got}")]
    SchemaMismatch { expected: i32, got: i32 },
}

pub struct Store {
    conn: Connection,
}

impl Store {
    /// Open or create a SQLite database at the given path with WAL mode.
    pub fn open(path: &Path) -> Result<Self, StorageError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(path)?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA busy_timeout = 5000;
             PRAGMA foreign_keys = ON;",
        )?;
        let mut store = Self { conn };
        store.migrate()?;
        Ok(store)
    }

    /// Open an in-memory database (for testing).
    pub fn open_memory() -> Result<Self, StorageError> {
        let conn = Connection::open_in_memory()?;
        let mut store = Self { conn };
        store.migrate()?;
        Ok(store)
    }

    fn migrate(&mut self) -> Result<(), StorageError> {
        let current_version: i32 = self
            .conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))?;

        if current_version == 0 {
            self.conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    ts_ms INTEGER NOT NULL,
                    kind TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    payload TEXT NOT NULL
                );

                CREATE INDEX IF NOT EXISTS idx_events_session
                    ON events(session_id, id);

                CREATE TABLE IF NOT EXISTS snapshots (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    ts_ms INTEGER NOT NULL,
                    session_id TEXT NOT NULL,
                    last_event_id INTEGER NOT NULL,
                    state TEXT NOT NULL
                );

                CREATE INDEX IF NOT EXISTS idx_snapshots_session
                    ON snapshots(session_id, ts_ms DESC);

                CREATE TABLE IF NOT EXISTS fee_cache (
                    token_id TEXT PRIMARY KEY,
                    fee_rate_bps TEXT NOT NULL,
                    fetched_at_ms INTEGER NOT NULL,
                    source TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS markets (
                    condition_id TEXT PRIMARY KEY,
                    question TEXT,
                    slug TEXT,
                    token_id_yes TEXT,
                    token_id_no TEXT,
                    neg_risk INTEGER NOT NULL DEFAULT 0,
                    active INTEGER NOT NULL DEFAULT 1,
                    end_date TEXT,
                    updated_at_ms INTEGER NOT NULL
                );",
            )?;
            self.conn
                .execute_batch(&format!("PRAGMA user_version = {SCHEMA_VERSION};"))?;
        } else if current_version != SCHEMA_VERSION {
            return Err(StorageError::SchemaMismatch {
                expected: SCHEMA_VERSION,
                got: current_version,
            });
        }

        Ok(())
    }

    // --- Events ---

    pub fn append_event(
        &self,
        session_id: &str,
        event: &NormalizedEvent,
    ) -> Result<i64, StorageError> {
        let ts_ms = chrono::Utc::now().timestamp_millis();
        let kind = event.kind_str();
        let payload = serde_json::to_string(event)?;
        self.conn.execute(
            "INSERT INTO events (ts_ms, kind, session_id, payload) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![ts_ms, kind, session_id, payload],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn load_events_after(
        &self,
        session_id: &str,
        after_id: i64,
    ) -> Result<Vec<(i64, NormalizedEvent)>, StorageError> {
        let mut stmt = self.conn.prepare(
            "SELECT id, payload FROM events WHERE session_id = ?1 AND id > ?2 ORDER BY id",
        )?;
        let rows = stmt.query_map(rusqlite::params![session_id, after_id], |row| {
            let id: i64 = row.get(0)?;
            let payload: String = row.get(1)?;
            Ok((id, payload))
        })?;

        let mut events = Vec::new();
        for row in rows {
            let (id, payload) = row?;
            let event: NormalizedEvent = serde_json::from_str(&payload)
                .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
            events.push((id, event));
        }
        Ok(events)
    }

    pub fn event_count(&self, session_id: &str) -> Result<i64, StorageError> {
        let count: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM events WHERE session_id = ?1",
            rusqlite::params![session_id],
            |row| row.get(0),
        )?;
        Ok(count)
    }

    // --- Snapshots ---

    pub fn save_snapshot(
        &self,
        session_id: &str,
        last_event_id: i64,
        state: &str,
    ) -> Result<i64, StorageError> {
        let ts_ms = chrono::Utc::now().timestamp_millis();
        self.conn.execute(
            "INSERT INTO snapshots (ts_ms, session_id, last_event_id, state) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![ts_ms, session_id, last_event_id, state],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn load_latest_snapshot(
        &self,
        session_id: &str,
    ) -> Result<(i64, i64, String), StorageError> {
        self.conn
            .query_row(
                "SELECT id, last_event_id, state FROM snapshots
                 WHERE session_id = ?1 ORDER BY id DESC LIMIT 1",
                rusqlite::params![session_id],
                |row| {
                    let id: i64 = row.get(0)?;
                    let last_event_id: i64 = row.get(1)?;
                    let state: String = row.get(2)?;
                    Ok((id, last_event_id, state))
                },
            )
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => StorageError::NoSnapshot,
                other => StorageError::Sqlite(other),
            })
    }

    // --- Fee cache ---

    pub fn get_cached_fee(
        &self,
        token_id: &str,
        max_age_ms: i64,
    ) -> Result<Option<(String, String)>, StorageError> {
        let now_ms = chrono::Utc::now().timestamp_millis();
        let cutoff = now_ms - max_age_ms;
        let result = self.conn.query_row(
            "SELECT fee_rate_bps, source FROM fee_cache
             WHERE token_id = ?1 AND fetched_at_ms > ?2",
            rusqlite::params![token_id, cutoff],
            |row| {
                let rate: String = row.get(0)?;
                let source: String = row.get(1)?;
                Ok((rate, source))
            },
        );
        match result {
            Ok(v) => Ok(Some(v)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(StorageError::Sqlite(e)),
        }
    }

    pub fn get_cached_fee_any_age(
        &self,
        token_id: &str,
    ) -> Result<Option<String>, StorageError> {
        let result = self.conn.query_row(
            "SELECT fee_rate_bps FROM fee_cache WHERE token_id = ?1",
            rusqlite::params![token_id],
            |row| row.get::<_, String>(0),
        );
        match result {
            Ok(v) => Ok(Some(v)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(StorageError::Sqlite(e)),
        }
    }

    pub fn set_cached_fee(
        &self,
        token_id: &str,
        fee_rate_bps: &str,
        source: &str,
    ) -> Result<(), StorageError> {
        let now_ms = chrono::Utc::now().timestamp_millis();
        self.conn.execute(
            "INSERT OR REPLACE INTO fee_cache (token_id, fee_rate_bps, fetched_at_ms, source)
             VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![token_id, fee_rate_bps, now_ms, source],
        )?;
        Ok(())
    }

    // --- Markets ---

    pub fn upsert_market(
        &self,
        condition_id: &str,
        question: Option<&str>,
        slug: Option<&str>,
        token_yes: Option<&str>,
        token_no: Option<&str>,
        neg_risk: bool,
        active: bool,
        end_date: Option<&str>,
    ) -> Result<(), StorageError> {
        let now_ms = chrono::Utc::now().timestamp_millis();
        self.conn.execute(
            "INSERT OR REPLACE INTO markets
             (condition_id, question, slug, token_id_yes, token_id_no, neg_risk, active, end_date, updated_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            rusqlite::params![
                condition_id,
                question,
                slug,
                token_yes,
                token_no,
                neg_risk as i32,
                active as i32,
                end_date,
                now_ms
            ],
        )?;
        Ok(())
    }

    pub fn get_active_markets(
        &self,
    ) -> Result<Vec<MarketRow>, StorageError> {
        let mut stmt = self.conn.prepare(
            "SELECT condition_id, question, slug, token_id_yes, token_id_no, neg_risk, end_date
             FROM markets WHERE active = 1",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(MarketRow {
                condition_id: row.get(0)?,
                question: row.get(1)?,
                slug: row.get(2)?,
                token_id_yes: row.get(3)?,
                token_id_no: row.get(4)?,
                neg_risk: row.get::<_, i32>(5)? != 0,
                end_date: row.get(6)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(StorageError::Sqlite)
    }

    /// List all sessions with their event counts, ordered by most recent first.
    pub fn list_sessions(&self) -> Result<Vec<(String, i64)>, StorageError> {
        let mut stmt = self.conn.prepare(
            "SELECT session_id, COUNT(*) as cnt FROM events GROUP BY session_id ORDER BY MAX(id) DESC",
        )?;
        let rows = stmt.query_map([], |row| {
            let session_id: String = row.get(0)?;
            let count: i64 = row.get(1)?;
            Ok((session_id, count))
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(StorageError::Sqlite)
    }

    /// Get the latest session ID (by most recent event).
    pub fn latest_session_id(&self) -> Result<Option<String>, StorageError> {
        let result = self.conn.query_row(
            "SELECT session_id FROM events ORDER BY id DESC LIMIT 1",
            [],
            |row| row.get::<_, String>(0),
        );
        match result {
            Ok(id) => Ok(Some(id)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(StorageError::Sqlite(e)),
        }
    }

    /// Look up market question and outcome label for a token_id.
    /// Returns (question, outcome) e.g. ("Will X happen?", "Yes") or None.
    pub fn lookup_token_market(&self, token_id: &str) -> Option<(String, String)> {
        // Try as Yes token
        let result = self.conn.query_row(
            "SELECT question FROM markets WHERE token_id_yes = ?1",
            rusqlite::params![token_id],
            |row| row.get::<_, Option<String>>(0),
        );
        if let Ok(Some(q)) = result {
            return Some((q, "Yes".into()));
        }
        // Try as No token
        let result = self.conn.query_row(
            "SELECT question FROM markets WHERE token_id_no = ?1",
            rusqlite::params![token_id],
            |row| row.get::<_, Option<String>>(0),
        );
        if let Ok(Some(q)) = result {
            return Some((q, "No".into()));
        }
        None
    }

    /// Build a lookup table for all known tokens → (question, outcome).
    pub fn build_token_name_map(&self) -> HashMap<String, (String, String)> {
        let mut map = HashMap::new();
        let mut stmt = match self.conn.prepare(
            "SELECT question, token_id_yes, token_id_no FROM markets WHERE question IS NOT NULL",
        ) {
            Ok(s) => s,
            Err(_) => return map,
        };
        let rows = match stmt.query_map([], |row| {
            let q: String = row.get(0)?;
            let yes: Option<String> = row.get(1)?;
            let no: Option<String> = row.get(2)?;
            Ok((q, yes, no))
        }) {
            Ok(r) => r,
            Err(_) => return map,
        };
        for row in rows {
            if let Ok((q, yes, no)) = row {
                if let Some(y) = yes {
                    map.insert(y, (q.clone(), "Yes".into()));
                }
                if let Some(n) = no {
                    map.insert(n, (q, "No".into()));
                }
            }
        }
        map
    }

    pub fn conn(&self) -> &Connection {
        &self.conn
    }
}

#[derive(Debug, Clone)]
pub struct MarketRow {
    pub condition_id: String,
    pub question: Option<String>,
    pub slug: Option<String>,
    pub token_id_yes: Option<String>,
    pub token_id_no: Option<String>,
    pub neg_risk: bool,
    pub end_date: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::event::NormalizedEvent;
    use crate::core::types::DataQuality;
    use chrono::Utc;

    #[test]
    fn open_memory_and_migrate() {
        let store = Store::open_memory().unwrap();
        let version: i32 = store
            .conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
    }

    #[test]
    fn append_and_load_events() {
        let store = Store::open_memory().unwrap();
        let event = NormalizedEvent::HealthEvent {
            kind: "test".into(),
            message: "hello".into(),
            ts: Utc::now(),
        };
        let id1 = store.append_event("s1", &event).unwrap();
        let id2 = store.append_event("s1", &event).unwrap();
        assert_eq!(id2, id1 + 1);

        let events = store.load_events_after("s1", 0).unwrap();
        assert_eq!(events.len(), 2);

        let events_after = store.load_events_after("s1", id1).unwrap();
        assert_eq!(events_after.len(), 1);
        assert_eq!(events_after[0].0, id2);
    }

    #[test]
    fn event_count() {
        let store = Store::open_memory().unwrap();
        let event = NormalizedEvent::HealthEvent {
            kind: "test".into(),
            message: "msg".into(),
            ts: Utc::now(),
        };
        assert_eq!(store.event_count("s1").unwrap(), 0);
        store.append_event("s1", &event).unwrap();
        store.append_event("s1", &event).unwrap();
        store.append_event("s2", &event).unwrap();
        assert_eq!(store.event_count("s1").unwrap(), 2);
        assert_eq!(store.event_count("s2").unwrap(), 1);
    }

    #[test]
    fn snapshot_round_trip() {
        let store = Store::open_memory().unwrap();
        store.save_snapshot("s1", 42, r#"{"cash":"10000"}"#).unwrap();
        let (_, last_id, state) = store.load_latest_snapshot("s1").unwrap();
        assert_eq!(last_id, 42);
        assert_eq!(state, r#"{"cash":"10000"}"#);
    }

    #[test]
    fn snapshot_latest_wins() {
        let store = Store::open_memory().unwrap();
        store.save_snapshot("s1", 10, "state1").unwrap();
        store.save_snapshot("s1", 20, "state2").unwrap();
        let (_, last_id, state) = store.load_latest_snapshot("s1").unwrap();
        assert_eq!(last_id, 20);
        assert_eq!(state, "state2");
    }

    #[test]
    fn no_snapshot_returns_error() {
        let store = Store::open_memory().unwrap();
        let err = store.load_latest_snapshot("s1").unwrap_err();
        assert!(matches!(err, StorageError::NoSnapshot));
    }

    #[test]
    fn fee_cache_ttl() {
        let store = Store::open_memory().unwrap();
        store.set_cached_fee("token1", "25", "live").unwrap();

        // Within TTL
        let result = store.get_cached_fee("token1", 60_000).unwrap();
        assert!(result.is_some());
        let (rate, source) = result.unwrap();
        assert_eq!(rate, "25");
        assert_eq!(source, "live");

        // Expired TTL (0ms)
        let result = store.get_cached_fee("token1", 0).unwrap();
        assert!(result.is_none());

        // Any-age still returns it
        let result = store.get_cached_fee_any_age("token1").unwrap();
        assert_eq!(result.unwrap(), "25");
    }

    #[test]
    fn fee_cache_miss() {
        let store = Store::open_memory().unwrap();
        assert!(store.get_cached_fee("nonexistent", 60_000).unwrap().is_none());
        assert!(store.get_cached_fee_any_age("nonexistent").unwrap().is_none());
    }

    #[test]
    fn market_upsert_and_query() {
        let store = Store::open_memory().unwrap();
        store
            .upsert_market("0xabc", Some("Will X happen?"), Some("will-x"), Some("t1"), Some("t2"), false, true, None)
            .unwrap();
        let markets = store.get_active_markets().unwrap();
        assert_eq!(markets.len(), 1);
        assert_eq!(markets[0].condition_id, "0xabc");
        assert_eq!(markets[0].question.as_deref(), Some("Will X happen?"));
        assert!(!markets[0].neg_risk);
    }

    #[test]
    fn list_sessions_and_latest() {
        let store = Store::open_memory().unwrap();
        assert!(store.list_sessions().unwrap().is_empty());
        assert!(store.latest_session_id().unwrap().is_none());

        let event = NormalizedEvent::HealthEvent {
            kind: "test".into(),
            message: "msg".into(),
            ts: Utc::now(),
        };
        store.append_event("s1", &event).unwrap();
        store.append_event("s1", &event).unwrap();
        store.append_event("s2", &event).unwrap();

        let sessions = store.list_sessions().unwrap();
        assert_eq!(sessions.len(), 2);
        // Most recent first (s2 has the highest event id)
        assert_eq!(sessions[0].0, "s2");
        assert_eq!(sessions[0].1, 1);
        assert_eq!(sessions[1].0, "s1");
        assert_eq!(sessions[1].1, 2);

        assert_eq!(store.latest_session_id().unwrap(), Some("s2".into()));
    }

    #[test]
    fn market_inactive_filtered() {
        let store = Store::open_memory().unwrap();
        store
            .upsert_market("0x1", None, None, None, None, false, true, None)
            .unwrap();
        store
            .upsert_market("0x2", None, None, None, None, false, false, None)
            .unwrap();
        let markets = store.get_active_markets().unwrap();
        assert_eq!(markets.len(), 1);
        assert_eq!(markets[0].condition_id, "0x1");
    }
}
