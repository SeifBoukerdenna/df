use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::core::types::{FeeUnavailablePolicy, MarkingMode, PollingMode};

/// Top-level configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    #[serde(default)]
    pub session: SessionConfig,
    #[serde(default)]
    pub wallets: WalletConfig,
    #[serde(default)]
    pub latency: LatencyConfig,
    #[serde(default)]
    pub fees: FeeConfig,
    #[serde(default)]
    pub ingestion: IngestionConfig,
    #[serde(default)]
    pub storage: StorageConfig,
    #[serde(default)]
    pub reporting: ReportingConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionConfig {
    /// Starting capital in USDC.
    #[serde(default = "default_starting_capital")]
    pub starting_capital: Decimal,
    /// Maximum fraction of capital to allocate to a single copy trade.
    #[serde(default = "default_max_position_fraction")]
    pub max_position_fraction: Decimal,
    /// Maximum slippage in bps before a fill is skipped.
    #[serde(default = "default_max_slippage_bps")]
    pub max_slippage_bps: Decimal,
    /// How to value open positions for unrealized PnL.
    #[serde(default)]
    pub marking_mode: MarkingMode,
}

impl Default for SessionConfig {
    fn default() -> Self {
        Self {
            starting_capital: default_starting_capital(),
            max_position_fraction: default_max_position_fraction(),
            max_slippage_bps: default_max_slippage_bps(),
            marking_mode: MarkingMode::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WalletConfig {
    /// Path to directional wallets file.
    #[serde(default = "default_directional_path")]
    pub directional_file: PathBuf,
    /// Path to arbitrage wallets file.
    #[serde(default = "default_arbitrage_path")]
    pub arbitrage_file: PathBuf,
}

impl Default for WalletConfig {
    fn default() -> Self {
        Self {
            directional_file: default_directional_path(),
            arbitrage_file: default_arbitrage_path(),
        }
    }
}

/// Latency model — each component is explicit and independently configurable.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LatencyConfig {
    /// How often we poll for wallet trades. Determines detection delay floor.
    #[serde(default)]
    pub polling_mode: PollingMode,
    /// Additional simulated arrival delay in ms (models our order reaching the exchange).
    #[serde(default = "default_arrival_delay_ms")]
    pub arrival_delay_ms: u64,
    /// Polling interval override for directional wallets in ms.
    /// Defaults: baseline=5000, aggressive=2000.
    #[serde(default)]
    pub directional_interval_ms: Option<u64>,
    /// Polling interval override for arbitrage wallets in ms.
    /// Defaults: baseline=5000, aggressive=5000.
    #[serde(default)]
    pub arbitrage_interval_ms: Option<u64>,
}

impl Default for LatencyConfig {
    fn default() -> Self {
        Self {
            polling_mode: PollingMode::default(),
            arrival_delay_ms: default_arrival_delay_ms(),
            directional_interval_ms: None,
            arbitrage_interval_ms: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FeeConfig {
    /// TTL for cached fee rates in seconds.
    #[serde(default = "default_fee_cache_ttl_secs")]
    pub cache_ttl_secs: u64,
    /// What to do when fee data is unavailable and no cache exists.
    /// "skip" = miss the trade (default, honest). "degrade" = fill with zero fee, mark degraded.
    #[serde(default = "default_fee_unavailable_policy")]
    pub unavailable_policy: FeeUnavailablePolicy,
}

impl Default for FeeConfig {
    fn default() -> Self {
        Self {
            cache_ttl_secs: default_fee_cache_ttl_secs(),
            unavailable_policy: default_fee_unavailable_policy(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IngestionConfig {
    /// Interval in seconds between market metadata refreshes.
    #[serde(default = "default_metadata_refresh_secs")]
    pub metadata_refresh_secs: u64,
    /// Seconds of book silence before marking a token as stale.
    #[serde(default = "default_stale_threshold_secs")]
    pub stale_threshold_secs: u64,
    /// Seconds of inactivity before unsubscribing from a market's book data.
    #[serde(default = "default_market_prune_secs")]
    pub market_prune_secs: u64,
}

impl Default for IngestionConfig {
    fn default() -> Self {
        Self {
            metadata_refresh_secs: default_metadata_refresh_secs(),
            stale_threshold_secs: default_stale_threshold_secs(),
            market_prune_secs: default_market_prune_secs(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StorageConfig {
    /// Path to the SQLite database file.
    #[serde(default = "default_db_path")]
    pub db_path: PathBuf,
    /// Interval in seconds between automatic snapshots.
    #[serde(default = "default_snapshot_interval_secs")]
    pub snapshot_interval_secs: u64,
    /// Directory for session outputs (HTML reports, etc.).
    #[serde(default = "default_sessions_dir")]
    pub sessions_dir: PathBuf,
}

impl Default for StorageConfig {
    fn default() -> Self {
        Self {
            db_path: default_db_path(),
            snapshot_interval_secs: default_snapshot_interval_secs(),
            sessions_dir: default_sessions_dir(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReportingConfig {
    /// Mark-to-market interval in seconds for live unrealized PnL updates.
    #[serde(default = "default_mark_interval_secs")]
    pub mark_interval_secs: u64,
}

impl Default for ReportingConfig {
    fn default() -> Self {
        Self {
            mark_interval_secs: default_mark_interval_secs(),
        }
    }
}

// --- Default value functions ---

fn default_starting_capital() -> Decimal {
    Decimal::new(10_000, 0) // $10,000
}

fn default_max_position_fraction() -> Decimal {
    Decimal::new(10, 2) // 10%
}

fn default_max_slippage_bps() -> Decimal {
    Decimal::new(200, 0) // 200 bps
}

fn default_directional_path() -> PathBuf {
    PathBuf::from("config/tracked_wallets/directional_wallets.txt")
}

fn default_arbitrage_path() -> PathBuf {
    PathBuf::from("config/tracked_wallets/arbitrage_wallets.txt")
}

fn default_arrival_delay_ms() -> u64 {
    500
}

fn default_fee_cache_ttl_secs() -> u64 {
    3600 // 1 hour
}

fn default_metadata_refresh_secs() -> u64 {
    300 // 5 minutes
}

fn default_stale_threshold_secs() -> u64 {
    30
}

fn default_market_prune_secs() -> u64 {
    1800 // 30 minutes
}

fn default_fee_unavailable_policy() -> FeeUnavailablePolicy {
    FeeUnavailablePolicy::Skip
}

fn default_db_path() -> PathBuf {
    PathBuf::from("data/df.db")
}

fn default_snapshot_interval_secs() -> u64 {
    60
}

fn default_sessions_dir() -> PathBuf {
    PathBuf::from("sessions")
}

fn default_mark_interval_secs() -> u64 {
    5
}

// --- Loading ---

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("failed to read config file {path}: {source}")]
    ReadFile {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("failed to parse config: {0}")]
    Parse(#[from] toml::de::Error),
    #[error("validation error: {0}")]
    Validation(String),
}

impl AppConfig {
    /// Load from a TOML file. If the path doesn't exist, returns defaults.
    pub fn load(path: &Path) -> Result<Self, ConfigError> {
        if !path.exists() {
            return Ok(Self::default());
        }
        let contents =
            std::fs::read_to_string(path).map_err(|e| ConfigError::ReadFile {
                path: path.to_owned(),
                source: e,
            })?;
        let config: Self = toml::from_str(&contents)?;
        config.validate()?;
        Ok(config)
    }

    /// Load defaults (no file).
    pub fn default() -> Self {
        Self {
            session: SessionConfig::default(),
            wallets: WalletConfig::default(),
            latency: LatencyConfig::default(),
            fees: FeeConfig::default(),
            ingestion: IngestionConfig::default(),
            storage: StorageConfig::default(),
            reporting: ReportingConfig::default(),
        }
    }

    fn validate(&self) -> Result<(), ConfigError> {
        if self.session.starting_capital <= Decimal::ZERO {
            return Err(ConfigError::Validation(
                "starting_capital must be positive".into(),
            ));
        }
        if self.session.max_position_fraction <= Decimal::ZERO
            || self.session.max_position_fraction > Decimal::ONE
        {
            return Err(ConfigError::Validation(
                "max_position_fraction must be in (0, 1]".into(),
            ));
        }
        if self.session.max_slippage_bps < Decimal::ZERO {
            return Err(ConfigError::Validation(
                "max_slippage_bps must be non-negative".into(),
            ));
        }
        Ok(())
    }
}
