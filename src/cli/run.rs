use std::path::PathBuf;
use std::sync::Arc;

use rust_decimal::Decimal;
use tracing::info;

use crate::config::schema::AppConfig;
use crate::config::wallets;
use crate::sim::engine;
use crate::storage::db::Store;

pub async fn execute(config_path: &PathBuf, capital_override: Option<Decimal>) {
    let mut config = match AppConfig::load(config_path) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("error: {e}");
            std::process::exit(1);
        }
    };

    if let Some(capital) = capital_override {
        config.session.starting_capital = capital;
    }

    let loaded_wallets = match wallets::load_wallets(
        &config.wallets.directional_file,
        &config.wallets.arbitrage_file,
    ) {
        Ok(w) => w,
        Err(e) => {
            eprintln!("error loading wallets: {e}");
            std::process::exit(1);
        }
    };

    info!(
        wallets = loaded_wallets.len(),
        capital = %config.session.starting_capital,
        "starting session"
    );

    let store = match Store::open(&config.storage.db_path) {
        Ok(s) => Arc::new(s),
        Err(e) => {
            eprintln!("error opening database: {e}");
            std::process::exit(1);
        }
    };

    if let Err(e) = engine::run_session(config, loaded_wallets, store).await {
        eprintln!("engine error: {e}");
        std::process::exit(1);
    }
}
