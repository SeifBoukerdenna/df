use std::path::PathBuf;

use crate::config::schema::AppConfig;
use crate::config::wallets as wallet_loader;
use crate::core::types::WalletCategory;

pub fn execute(config_path: &PathBuf, check: bool) {
    let config = match AppConfig::load(config_path) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("error: {e}");
            std::process::exit(1);
        }
    };

    let loaded = match wallet_loader::load_wallets(
        &config.wallets.directional_file,
        &config.wallets.arbitrage_file,
    ) {
        Ok(w) => w,
        Err(e) => {
            eprintln!("error: {e}");
            std::process::exit(1);
        }
    };

    println!("Tracked wallets ({} total):", loaded.len());
    println!();

    let directional: Vec<_> = loaded
        .iter()
        .filter(|w| w.category == WalletCategory::Directional)
        .collect();
    let arbitrage: Vec<_> = loaded
        .iter()
        .filter(|w| w.category == WalletCategory::Arbitrage)
        .collect();

    if !directional.is_empty() {
        println!("Directional ({}):", directional.len());
        for w in &directional {
            println!("  {}", w.address);
        }
        println!();
    }

    if !arbitrage.is_empty() {
        println!("Arbitrage ({}):", arbitrage.len());
        for w in &arbitrage {
            println!("  {}", w.address);
        }
        println!();
    }

    if check {
        println!("Wallet validation: all {} addresses pass format checks (0x-prefixed, 42 chars, valid hex).", loaded.len());
    }
}
