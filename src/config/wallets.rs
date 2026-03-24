use std::collections::{HashMap, HashSet};
use std::path::Path;

use serde::Deserialize;

use crate::core::types::{WalletAddr, WalletCategory};

/// A tracked wallet with rich metadata.
#[derive(Debug, Clone)]
pub struct TrackedWallet {
    pub address: WalletAddr,
    pub category: WalletCategory,
    /// Human-readable display name (shown in terminal + reports).
    pub name: Option<String>,
    /// Optional Polymarket profile URL.
    pub profile_url: Option<String>,
    /// Optional notes/tags for this wallet. Stored for operator reference.
    #[allow(dead_code)]
    pub notes: Option<String>,
}

impl TrackedWallet {
    /// Short display name: name if set, otherwise abbreviated address.
    pub fn display_name(&self) -> String {
        if let Some(ref name) = self.name {
            name.clone()
        } else if self.address.len() > 10 {
            format!("{}…{}", &self.address[..6], &self.address[self.address.len() - 4..])
        } else {
            self.address.clone()
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum WalletError {
    #[error("failed to read wallet file {path}: {source}")]
    ReadFile {
        path: String,
        source: std::io::Error,
    },
    #[error("invalid address on line {line} of {file}: {address}")]
    InvalidAddress {
        file: String,
        line: usize,
        address: String,
    },
    #[error("duplicate address {address} found in {first_file} and {second_file}")]
    Duplicate {
        address: String,
        first_file: String,
        second_file: String,
    },
    #[error("no wallets loaded from any file")]
    Empty,
    #[error("failed to parse TOML wallet file {path}: {source}")]
    TomlParse {
        path: String,
        source: toml::de::Error,
    },
}

// --- TOML wallet file format ---

#[derive(Debug, Deserialize)]
struct TomlWalletFile {
    wallet: Vec<TomlWalletEntry>,
}

#[derive(Debug, Deserialize)]
struct TomlWalletEntry {
    address: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    profile_url: Option<String>,
    #[serde(default)]
    notes: Option<String>,
}

/// Parse a TOML wallet file with rich metadata.
fn parse_toml_wallet_file(
    path: &Path,
    category: WalletCategory,
) -> Result<Vec<TrackedWallet>, WalletError> {
    let contents = std::fs::read_to_string(path).map_err(|e| WalletError::ReadFile {
        path: path.display().to_string(),
        source: e,
    })?;

    let parsed: TomlWalletFile = toml::from_str(&contents).map_err(|e| WalletError::TomlParse {
        path: path.display().to_string(),
        source: e,
    })?;

    let mut wallets = Vec::new();
    let mut seen = HashSet::new();

    for (i, entry) in parsed.wallet.iter().enumerate() {
        let addr = entry.address.trim().to_lowercase();

        if !addr.starts_with("0x") || addr.len() != 42 {
            return Err(WalletError::InvalidAddress {
                file: path.display().to_string(),
                line: i + 1,
                address: entry.address.clone(),
            });
        }

        if !addr[2..].chars().all(|c| c.is_ascii_hexdigit()) {
            return Err(WalletError::InvalidAddress {
                file: path.display().to_string(),
                line: i + 1,
                address: entry.address.clone(),
            });
        }

        if !seen.insert(addr.clone()) {
            continue; // skip duplicates within file
        }

        wallets.push(TrackedWallet {
            address: addr,
            category,
            name: entry.name.clone(),
            profile_url: entry.profile_url.clone(),
            notes: entry.notes.clone(),
        });
    }

    Ok(wallets)
}

/// Parse a legacy plain-text wallet file. One address per line.
/// Lines starting with '#' are comments. Blank lines ignored.
fn parse_txt_wallet_file(
    path: &Path,
    category: WalletCategory,
) -> Result<Vec<TrackedWallet>, WalletError> {
    let contents = std::fs::read_to_string(path).map_err(|e| WalletError::ReadFile {
        path: path.display().to_string(),
        source: e,
    })?;

    let mut wallets = Vec::new();
    let mut seen_in_file = HashSet::new();

    for (i, raw_line) in contents.lines().enumerate() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }

        let addr = line.to_lowercase();

        if !addr.starts_with("0x") || addr.len() != 42 {
            return Err(WalletError::InvalidAddress {
                file: path.display().to_string(),
                line: i + 1,
                address: line.to_string(),
            });
        }

        if !addr[2..].chars().all(|c| c.is_ascii_hexdigit()) {
            return Err(WalletError::InvalidAddress {
                file: path.display().to_string(),
                line: i + 1,
                address: line.to_string(),
            });
        }

        if !seen_in_file.insert(addr.clone()) {
            continue;
        }

        wallets.push(TrackedWallet {
            address: addr,
            category,
            name: None,
            profile_url: None,
            notes: None,
        });
    }

    Ok(wallets)
}

/// Parse a wallet file — auto-detects TOML vs legacy .txt format.
fn parse_wallet_file(
    path: &Path,
    category: WalletCategory,
) -> Result<Vec<TrackedWallet>, WalletError> {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
    if ext == "toml" {
        parse_toml_wallet_file(path, category)
    } else {
        parse_txt_wallet_file(path, category)
    }
}

/// Try to find the wallet file — prefers .toml, falls back to .txt.
fn find_wallet_file(configured_path: &Path) -> Option<std::path::PathBuf> {
    // If the configured path exists, use it directly
    if configured_path.exists() {
        return Some(configured_path.to_path_buf());
    }
    // If configured path is .txt, try .toml variant
    if configured_path.extension().and_then(|e| e.to_str()) == Some("txt") {
        let toml_path = configured_path.with_extension("toml");
        if toml_path.exists() {
            return Some(toml_path);
        }
    }
    // If configured path is .toml, try .txt variant
    if configured_path.extension().and_then(|e| e.to_str()) == Some("toml") {
        let txt_path = configured_path.with_extension("txt");
        if txt_path.exists() {
            return Some(txt_path);
        }
    }
    None
}

/// Load and validate wallets from both category files.
/// Supports both TOML (rich metadata) and legacy .txt (plain addresses).
/// Returns error if:
/// - An address appears in both files.
/// - No wallets are loaded at all.
pub fn load_wallets(
    directional_path: &Path,
    arbitrage_path: &Path,
) -> Result<Vec<TrackedWallet>, WalletError> {
    let directional = match find_wallet_file(directional_path) {
        Some(path) => parse_wallet_file(&path, WalletCategory::Directional)?,
        None => {
            tracing::warn!(
                path = %directional_path.display(),
                "directional wallet file not found, continuing with none"
            );
            Vec::new()
        }
    };

    let arbitrage = match find_wallet_file(arbitrage_path) {
        Some(path) => parse_wallet_file(&path, WalletCategory::Arbitrage)?,
        None => {
            tracing::warn!(
                path = %arbitrage_path.display(),
                "arbitrage wallet file not found, continuing with none"
            );
            Vec::new()
        }
    };

    // Check for cross-file duplicates.
    let directional_addrs: HashSet<&str> =
        directional.iter().map(|w| w.address.as_str()).collect();
    for w in &arbitrage {
        if directional_addrs.contains(w.address.as_str()) {
            return Err(WalletError::Duplicate {
                address: w.address.clone(),
                first_file: directional_path.display().to_string(),
                second_file: arbitrage_path.display().to_string(),
            });
        }
    }

    let mut all = directional;
    all.extend(arbitrage);

    if all.is_empty() {
        return Err(WalletError::Empty);
    }

    Ok(all)
}

/// Build a lookup map from address -> display name for fast access.
pub fn build_wallet_name_map(wallets: &[TrackedWallet]) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for w in wallets {
        map.insert(w.address.clone(), w.display_name());
    }
    map
}

/// Build a lookup map from address -> profile_url for report display.
pub fn build_wallet_profile_map(wallets: &[TrackedWallet]) -> HashMap<String, Option<String>> {
    let mut map = HashMap::new();
    for w in wallets {
        map.insert(w.address.clone(), w.profile_url.clone());
    }
    map
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::NamedTempFile;

    fn write_temp(contents: &str, ext: &str) -> tempfile::NamedTempFile {
        let suffix = format!(".{ext}");
        let mut f = tempfile::Builder::new().suffix(&suffix).tempfile().unwrap();
        f.write_all(contents.as_bytes()).unwrap();
        f
    }

    fn write_txt(contents: &str) -> NamedTempFile {
        let mut f = NamedTempFile::new().unwrap();
        f.write_all(contents.as_bytes()).unwrap();
        f
    }

    #[test]
    fn parse_valid_txt_file() {
        let f = write_txt(
            "# This is a comment\n\
             0xAbC1230000000000000000000000000000000001\n\
             \n\
             0xdef4560000000000000000000000000000000002\n",
        );
        let wallets = parse_txt_wallet_file(f.path(), WalletCategory::Directional).unwrap();
        assert_eq!(wallets.len(), 2);
        assert_eq!(
            wallets[0].address,
            "0xabc1230000000000000000000000000000000001"
        );
        assert_eq!(wallets[0].category, WalletCategory::Directional);
        assert!(wallets[0].name.is_none());
    }

    #[test]
    fn parse_valid_toml_file() {
        let f = write_temp(
            r#"
[[wallet]]
address = "0xAbC1230000000000000000000000000000000001"
name = "whale-01"
profile_url = "https://polymarket.com/profile/0xabc"
notes = "very active"

[[wallet]]
address = "0xdef4560000000000000000000000000000000002"
name = "whale-02"
"#,
            "toml",
        );
        let wallets = parse_toml_wallet_file(f.path(), WalletCategory::Arbitrage).unwrap();
        assert_eq!(wallets.len(), 2);
        assert_eq!(wallets[0].name.as_deref(), Some("whale-01"));
        assert_eq!(
            wallets[0].profile_url.as_deref(),
            Some("https://polymarket.com/profile/0xabc")
        );
        assert_eq!(wallets[0].category, WalletCategory::Arbitrage);
        assert_eq!(wallets[1].name.as_deref(), Some("whale-02"));
        assert!(wallets[1].profile_url.is_none());
    }

    #[test]
    fn dedup_within_file() {
        let f = write_txt(
            "0xabc1230000000000000000000000000000000001\n\
             0xABC1230000000000000000000000000000000001\n",
        );
        let wallets = parse_txt_wallet_file(f.path(), WalletCategory::Arbitrage).unwrap();
        assert_eq!(wallets.len(), 1);
    }

    #[test]
    fn reject_invalid_address_short() {
        let f = write_txt("0xabc123\n");
        let err = parse_txt_wallet_file(f.path(), WalletCategory::Directional).unwrap_err();
        assert!(matches!(err, WalletError::InvalidAddress { .. }));
    }

    #[test]
    fn reject_invalid_address_no_prefix() {
        let f = write_txt("abc1230000000000000000000000000000000001aa\n");
        let err = parse_txt_wallet_file(f.path(), WalletCategory::Directional).unwrap_err();
        assert!(matches!(err, WalletError::InvalidAddress { .. }));
    }

    #[test]
    fn reject_invalid_hex() {
        let f = write_txt("0xZZZ1230000000000000000000000000000000001\n");
        let err = parse_txt_wallet_file(f.path(), WalletCategory::Directional).unwrap_err();
        assert!(matches!(err, WalletError::InvalidAddress { .. }));
    }

    #[test]
    fn cross_file_duplicate_detected() {
        let f1 = write_txt("0xabc1230000000000000000000000000000000001\n");
        let f2 = write_txt("0xabc1230000000000000000000000000000000001\n");
        let err = load_wallets(f1.path(), f2.path()).unwrap_err();
        assert!(matches!(err, WalletError::Duplicate { .. }));
    }

    #[test]
    fn empty_files_returns_error() {
        let f1 = write_txt("# only comments\n");
        let f2 = write_txt("\n");
        let err = load_wallets(f1.path(), f2.path()).unwrap_err();
        assert!(matches!(err, WalletError::Empty));
    }

    #[test]
    fn missing_file_treated_as_empty() {
        let f1 = write_txt("0xabc1230000000000000000000000000000000001\n");
        let missing = Path::new("/tmp/nonexistent_wallet_file_df_test.txt");
        let wallets = load_wallets(f1.path(), missing).unwrap();
        assert_eq!(wallets.len(), 1);
    }

    #[test]
    fn load_both_categories() {
        let f1 = write_txt("0xabc1230000000000000000000000000000000001\n");
        let f2 = write_txt("0xdef4560000000000000000000000000000000002\n");
        let wallets = load_wallets(f1.path(), f2.path()).unwrap();
        assert_eq!(wallets.len(), 2);
        assert_eq!(wallets[0].category, WalletCategory::Directional);
        assert_eq!(wallets[1].category, WalletCategory::Arbitrage);
    }

    #[test]
    fn display_name_uses_name_if_set() {
        let w = TrackedWallet {
            address: "0xabc1230000000000000000000000000000000001".into(),
            category: WalletCategory::Directional,
            name: Some("whale".into()),
            profile_url: None,
            notes: None,
        };
        assert_eq!(w.display_name(), "whale");
    }

    #[test]
    fn display_name_abbreviates_address() {
        let w = TrackedWallet {
            address: "0xabc1230000000000000000000000000000000001".into(),
            category: WalletCategory::Directional,
            name: None,
            profile_url: None,
            notes: None,
        };
        assert_eq!(w.display_name(), "0xabc1…0001");
    }
}
