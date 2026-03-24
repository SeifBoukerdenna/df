use crate::config::schema::AppConfig;
use crate::storage::db::Store;

pub fn execute(json: bool) {
    let config = AppConfig::default();
    let store = match Store::open(&config.storage.db_path) {
        Ok(s) => s,
        Err(_) => {
            if json {
                println!("{{\"status\": \"no_database\"}}");
            } else {
                println!("No database found at {}.", config.storage.db_path.display());
                println!("Run `df run` to start a session first.");
            }
            return;
        }
    };

    let sessions = match store.list_sessions() {
        Ok(s) => s,
        Err(e) => {
            eprintln!("error listing sessions: {e}");
            return;
        }
    };

    if sessions.is_empty() {
        if json {
            println!("{{\"status\": \"no_sessions\"}}");
        } else {
            println!("No sessions found. Run `df run` to start one.");
        }
        return;
    }

    if json {
        println!("{{\"status\": \"idle\", \"sessions\": [");
        for (i, (session_id, event_count)) in sessions.iter().enumerate() {
            let comma = if i + 1 < sessions.len() { "," } else { "" };
            println!("  {{\"session_id\": \"{session_id}\", \"events\": {event_count}}}{comma}");
        }
        println!("]}}");
    } else {
        println!("Sessions ({} total):", sessions.len());
        println!();
        println!("  {:<24} {:>8}", "SESSION ID", "EVENTS");
        println!("  {:<24} {:>8}", "------------------------", "--------");
        for (session_id, event_count) in &sessions {
            println!("  {:<24} {:>8}", session_id, event_count);
        }
        println!();
        println!("Use `df report --session <ID>` to generate an HTML report.");
        println!("Use `df replay --session <ID>` to replay a session.");
    }
}
