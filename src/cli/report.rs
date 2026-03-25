use std::path::PathBuf;

use crate::config::schema::AppConfig;
use crate::config::wallets;
use crate::report::analytics;
use crate::report::html;
use crate::storage::db::Store;

pub fn execute(session_id: Option<String>, config_path: &PathBuf) {
    let config = match AppConfig::load(config_path) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("error loading config: {e}");
            std::process::exit(1);
        }
    };

    let store = match Store::open(&config.storage.db_path) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("error opening database: {e}");
            std::process::exit(1);
        }
    };

    let session = match session_id {
        Some(id) => id,
        None => match store.latest_session_id() {
            Ok(Some(id)) => {
                println!("Using latest session: {id}");
                id
            }
            Ok(None) => {
                eprintln!("error: no sessions found in database. Run `df run` first.");
                std::process::exit(1);
            }
            Err(e) => {
                eprintln!("error finding latest session: {e}");
                std::process::exit(1);
            }
        },
    };

    let loaded_wallets = wallets::load_wallets(
        &config.wallets.directional_file,
        &config.wallets.arbitrage_file,
    )
    .unwrap_or_else(|_| Vec::new());
    let wallet_names = wallets::build_wallet_name_map(&loaded_wallets);
    let wallet_profiles = wallets::build_wallet_profile_map(&loaded_wallets);

    // Cold report: no live portfolio state.
    // Unrealized PnL will show as "N/A" in the report.
    // For live unrealized, generate the report from `df run` at session end.
    let a = match analytics::compute_analytics(
        &store,
        &session,
        config.session.starting_capital,
        &wallet_names,
        &wallet_profiles,
        None, // no live state for cold reports
        Vec::new(), // no timeline for cold reports
    ) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("error computing analytics: {e}");
            std::process::exit(1);
        }
    };

    let output_path = config
        .storage
        .sessions_dir
        .join(format!("{session}.html"));

    match html::generate_html_report(&a, &output_path) {
        Ok(()) => {
            println!("Report written to {}", output_path.display());
        }
        Err(e) => {
            eprintln!("error writing report: {e}");
            std::process::exit(1);
        }
    }
}
