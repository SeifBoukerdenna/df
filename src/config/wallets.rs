use std::collections::HashSet;
use std::path::Path;

use crate::core::types::{WalletAddr, WalletCategory};

#[derive(Debug, Clone)]
pub struct TrackedWallet {
    pub address: WalletAddr,
    pub category: WalletCategory,
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
}

/// Parse a wallet file. One address per line. Lines starting with '#' are comments. Blank lines
/// ignored. Addresses must be 0x-prefixed and 42 chars.
fn parse_wallet_file(
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

        // Check hex validity (after 0x prefix).
        if !addr[2..].chars().all(|c| c.is_ascii_hexdigit()) {
            return Err(WalletError::InvalidAddress {
                file: path.display().to_string(),
                line: i + 1,
                address: line.to_string(),
            });
        }

        // Skip duplicates within the same file.
        if !seen_in_file.insert(addr.clone()) {
            continue;
        }

        wallets.push(TrackedWallet {
            address: addr,
            category,
        });
    }

    Ok(wallets)
}

/// Load and validate wallets from both category files.
/// Returns error if:
/// - Any file is unreadable (but missing files are treated as empty with a warning).
/// - An address appears in both files.
/// - No wallets are loaded at all.
pub fn load_wallets(
    directional_path: &Path,
    arbitrage_path: &Path,
) -> Result<Vec<TrackedWallet>, WalletError> {
    let directional = if directional_path.exists() {
        parse_wallet_file(directional_path, WalletCategory::Directional)?
    } else {
        tracing::warn!(
            path = %directional_path.display(),
            "directional wallet file not found, continuing with none"
        );
        Vec::new()
    };

    let arbitrage = if arbitrage_path.exists() {
        parse_wallet_file(arbitrage_path, WalletCategory::Arbitrage)?
    } else {
        tracing::warn!(
            path = %arbitrage_path.display(),
            "arbitrage wallet file not found, continuing with none"
        );
        Vec::new()
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::NamedTempFile;

    fn write_temp(contents: &str) -> NamedTempFile {
        let mut f = NamedTempFile::new().unwrap();
        f.write_all(contents.as_bytes()).unwrap();
        f
    }

    #[test]
    fn parse_valid_wallet_file() {
        let f = write_temp(
            "# This is a comment\n\
             0xAbC1230000000000000000000000000000000001\n\
             \n\
             0xdef4560000000000000000000000000000000002\n",
        );
        let wallets = parse_wallet_file(f.path(), WalletCategory::Directional).unwrap();
        assert_eq!(wallets.len(), 2);
        assert_eq!(
            wallets[0].address,
            "0xabc1230000000000000000000000000000000001"
        );
        assert_eq!(wallets[0].category, WalletCategory::Directional);
        assert_eq!(
            wallets[1].address,
            "0xdef4560000000000000000000000000000000002"
        );
    }

    #[test]
    fn dedup_within_file() {
        let f = write_temp(
            "0xabc1230000000000000000000000000000000001\n\
             0xABC1230000000000000000000000000000000001\n",
        );
        let wallets = parse_wallet_file(f.path(), WalletCategory::Arbitrage).unwrap();
        assert_eq!(wallets.len(), 1);
    }

    #[test]
    fn reject_invalid_address_short() {
        let f = write_temp("0xabc123\n");
        let err = parse_wallet_file(f.path(), WalletCategory::Directional).unwrap_err();
        assert!(matches!(err, WalletError::InvalidAddress { .. }));
    }

    #[test]
    fn reject_invalid_address_no_prefix() {
        let f = write_temp("abc1230000000000000000000000000000000001aa\n");
        let err = parse_wallet_file(f.path(), WalletCategory::Directional).unwrap_err();
        assert!(matches!(err, WalletError::InvalidAddress { .. }));
    }

    #[test]
    fn reject_invalid_hex() {
        let f = write_temp("0xZZZ1230000000000000000000000000000000001\n");
        let err = parse_wallet_file(f.path(), WalletCategory::Directional).unwrap_err();
        assert!(matches!(err, WalletError::InvalidAddress { .. }));
    }

    #[test]
    fn cross_file_duplicate_detected() {
        let f1 = write_temp("0xabc1230000000000000000000000000000000001\n");
        let f2 = write_temp("0xabc1230000000000000000000000000000000001\n");
        let err = load_wallets(f1.path(), f2.path()).unwrap_err();
        assert!(matches!(err, WalletError::Duplicate { .. }));
    }

    #[test]
    fn empty_files_returns_error() {
        let f1 = write_temp("# only comments\n");
        let f2 = write_temp("\n");
        let err = load_wallets(f1.path(), f2.path()).unwrap_err();
        assert!(matches!(err, WalletError::Empty));
    }

    #[test]
    fn missing_file_treated_as_empty() {
        let f1 = write_temp("0xabc1230000000000000000000000000000000001\n");
        let missing = Path::new("/tmp/nonexistent_wallet_file_df_test.txt");
        let wallets = load_wallets(f1.path(), missing).unwrap();
        assert_eq!(wallets.len(), 1);
    }

    #[test]
    fn load_both_categories() {
        let f1 = write_temp("0xabc1230000000000000000000000000000000001\n");
        let f2 = write_temp("0xdef4560000000000000000000000000000000002\n");
        let wallets = load_wallets(f1.path(), f2.path()).unwrap();
        assert_eq!(wallets.len(), 2);
        assert_eq!(wallets[0].category, WalletCategory::Directional);
        assert_eq!(wallets[1].category, WalletCategory::Arbitrage);
    }
}
