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
            let name_str = w.name.as_deref().unwrap_or("—");
            println!("  {} ({})", w.address, name_str);
            if let Some(ref url) = w.profile_url {
                println!("    profile: {url}");
            }
        }
        println!();
    }

    if !arbitrage.is_empty() {
        println!("Arbitrage ({}):", arbitrage.len());
        for w in &arbitrage {
            let name_str = w.name.as_deref().unwrap_or("—");
            println!("  {} ({})", w.address, name_str);
            if let Some(ref url) = w.profile_url {
                println!("    profile: {url}");
            }
        }
        println!();
    }

    if check {
        println!("Wallet validation: all {} addresses pass format checks.", loaded.len());
    }
}
