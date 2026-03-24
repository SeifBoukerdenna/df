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
    /// Category-specific overrides. Missing = use session defaults.
    #[serde(default)]
    pub category: CategoryConfigs,
}

/// Per-category configuration overrides.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CategoryConfigs {
    #[serde(default)]
    pub directional: Option<CategoryOverrides>,
    #[serde(default)]
    pub arbitrage: Option<CategoryOverrides>,
}

/// Category-specific overrides — any field set here takes precedence over session defaults.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CategoryOverrides {
    /// Max slippage in bps for this category.
    pub max_slippage_bps: Option<Decimal>,
    /// Max position fraction for this category.
    pub max_position_fraction: Option<Decimal>,
    /// Arrival delay override in ms.
    pub arrival_delay_ms: Option<u64>,
    /// Max detection age in ms — skip trades older than this (realism guard).
    /// Default: None (no limit). Arbitrage should be tight (e.g., 10000ms).
    pub max_detection_age_ms: Option<u64>,
    /// Fee unavailable policy override for this category.
    pub fee_unavailable_policy: Option<FeeUnavailablePolicy>,
}

impl AppConfig {
    /// Get effective max_slippage_bps for a category.
    pub fn max_slippage_for(&self, cat: crate::core::types::WalletCategory) -> Decimal {
        use crate::core::types::WalletCategory;
        let overrides = match cat {
            WalletCategory::Directional => self.category.directional.as_ref(),
            WalletCategory::Arbitrage => self.category.arbitrage.as_ref(),
        };
        overrides
            .and_then(|o| o.max_slippage_bps)
            .unwrap_or(self.session.max_slippage_bps)
    }

    /// Get effective max_position_fraction for a category.
    pub fn max_position_fraction_for(&self, cat: crate::core::types::WalletCategory) -> Decimal {
        use crate::core::types::WalletCategory;
        let overrides = match cat {
            WalletCategory::Directional => self.category.directional.as_ref(),
            WalletCategory::Arbitrage => self.category.arbitrage.as_ref(),
        };
        overrides
            .and_then(|o| o.max_position_fraction)
            .unwrap_or(self.session.max_position_fraction)
    }

    /// Get effective arrival_delay_ms for a category.
    pub fn arrival_delay_for(&self, cat: crate::core::types::WalletCategory) -> u64 {
        use crate::core::types::WalletCategory;
        let overrides = match cat {
            WalletCategory::Directional => self.category.directional.as_ref(),
            WalletCategory::Arbitrage => self.category.arbitrage.as_ref(),
        };
        overrides
            .and_then(|o| o.arrival_delay_ms)
            .unwrap_or(self.latency.arrival_delay_ms)
    }

    /// Get max_detection_age_ms for a category (None = no limit).
    pub fn max_detection_age_for(&self, cat: crate::core::types::WalletCategory) -> Option<u64> {
        use crate::core::types::WalletCategory;
        let overrides = match cat {
            WalletCategory::Directional => self.category.directional.as_ref(),
            WalletCategory::Arbitrage => self.category.arbitrage.as_ref(),
        };
        overrides.and_then(|o| o.max_detection_age_ms)
    }

    /// Get fee_unavailable_policy for a category.
    pub fn fee_policy_for(&self, cat: crate::core::types::WalletCategory) -> FeeUnavailablePolicy {
        use crate::core::types::WalletCategory;
        let overrides = match cat {
            WalletCategory::Directional => self.category.directional.as_ref(),
            WalletCategory::Arbitrage => self.category.arbitrage.as_ref(),
        };
        overrides
            .and_then(|o| o.fee_unavailable_policy)
            .unwrap_or(self.fees.unavailable_policy)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionConfig {
    #[serde(default = "default_starting_capital")]
    pub starting_capital: Decimal,
    #[serde(default = "default_max_position_fraction")]
    pub max_position_fraction: Decimal,
    #[serde(default = "default_max_slippage_bps")]
    pub max_slippage_bps: Decimal,
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
    #[serde(default = "default_directional_path")]
    pub directional_file: PathBuf,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LatencyConfig {
    #[serde(default)]
    pub polling_mode: PollingMode,
    #[serde(default = "default_arrival_delay_ms")]
    pub arrival_delay_ms: u64,
    #[serde(default)]
    pub directional_interval_ms: Option<u64>,
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
    #[serde(default = "default_fee_cache_ttl_secs")]
    pub cache_ttl_secs: u64,
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
    #[serde(default = "default_metadata_refresh_secs")]
    pub metadata_refresh_secs: u64,
    #[serde(default = "default_stale_threshold_secs")]
    pub stale_threshold_secs: u64,
    #[serde(default = "default_market_prune_secs")]
    pub market_prune_secs: u64,
    /// Optional Polygon WebSocket RPC URL for on-chain trade detection.
    /// Enables ~2-4s detection latency via OrderFilled events.
    /// Example: "wss://polygon-mainnet.g.alchemy.com/v2/YOUR_KEY"
    /// If not set, falls back to REST Data API polling (~10-30s).
    #[serde(default)]
    pub polygon_rpc_ws: Option<String>,
}

impl Default for IngestionConfig {
    fn default() -> Self {
        Self {
            metadata_refresh_secs: default_metadata_refresh_secs(),
            stale_threshold_secs: default_stale_threshold_secs(),
            market_prune_secs: default_market_prune_secs(),
            polygon_rpc_ws: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StorageConfig {
    #[serde(default = "default_db_path")]
    pub db_path: PathBuf,
    #[serde(default = "default_snapshot_interval_secs")]
    pub snapshot_interval_secs: u64,
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
    Decimal::new(10_000, 0)
}

fn default_max_position_fraction() -> Decimal {
    Decimal::new(10, 2) // 10%
}

fn default_max_slippage_bps() -> Decimal {
    Decimal::new(300, 0) // 300 bps
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
    3600
}

fn default_metadata_refresh_secs() -> u64 {
    300
}

fn default_stale_threshold_secs() -> u64 {
    30
}

fn default_market_prune_secs() -> u64 {
    1800
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

    pub fn default() -> Self {
        Self {
            session: SessionConfig::default(),
            wallets: WalletConfig::default(),
            latency: LatencyConfig::default(),
            fees: FeeConfig::default(),
            ingestion: IngestionConfig::default(),
            storage: StorageConfig::default(),
            reporting: ReportingConfig::default(),
            category: CategoryConfigs::default(),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config_is_valid() {
        let config = AppConfig::default();
        config.validate().unwrap();
    }

    #[test]
    fn category_overrides_work() {
        use crate::core::types::WalletCategory;
        let mut config = AppConfig::default();
        config.category.arbitrage = Some(CategoryOverrides {
            max_slippage_bps: Some(Decimal::new(100, 0)),
            max_position_fraction: Some(Decimal::new(5, 2)),
            arrival_delay_ms: Some(200),
            max_detection_age_ms: Some(10_000),
            fee_unavailable_policy: None,
        });

        assert_eq!(
            config.max_slippage_for(WalletCategory::Arbitrage),
            Decimal::new(100, 0)
        );
        assert_eq!(
            config.max_slippage_for(WalletCategory::Directional),
            Decimal::new(300, 0) // session default
        );
        assert_eq!(config.arrival_delay_for(WalletCategory::Arbitrage), 200);
        assert_eq!(config.arrival_delay_for(WalletCategory::Directional), 500);
        assert_eq!(
            config.max_detection_age_for(WalletCategory::Arbitrage),
            Some(10_000)
        );
        assert_eq!(
            config.max_detection_age_for(WalletCategory::Directional),
            None
        );
    }
}
