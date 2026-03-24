use crate::config::schema::AppConfig;
use crate::sim::replay;
use crate::storage::db::Store;

pub fn execute(session_id: String, config_path: &std::path::PathBuf) {
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

    match replay::replay_session(&store, &session_id, &config) {
        Ok(summary) => {
            replay::print_replay_summary(&summary);
        }
        Err(e) => {
            eprintln!("replay error: {e}");
            std::process::exit(1);
        }
    }
}
