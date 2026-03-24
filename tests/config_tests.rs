use std::io::Write;
use tempfile::NamedTempFile;

// We test the config module through its public API by importing the crate.
// Since these are integration tests, we use `df::` prefix.

#[test]
fn load_default_config_file() {
    let config = df::config::schema::AppConfig::load(std::path::Path::new("config/default.toml"))
        .expect("default config should parse");
    assert_eq!(
        config.session.starting_capital,
        rust_decimal::Decimal::new(10_000, 0)
    );
    assert_eq!(config.latency.arrival_delay_ms, 500);
}

#[test]
fn load_missing_file_returns_defaults() {
    let config =
        df::config::schema::AppConfig::load(std::path::Path::new("nonexistent.toml")).unwrap();
    assert_eq!(
        config.session.starting_capital,
        rust_decimal::Decimal::new(10_000, 0)
    );
}

#[test]
fn partial_config_merges_with_defaults() {
    let mut f = NamedTempFile::new().unwrap();
    f.write_all(
        b"[session]\nstarting_capital = \"50000\"\n[latency]\npolling_mode = \"aggressive\"\n",
    )
    .unwrap();
    let config = df::config::schema::AppConfig::load(f.path()).unwrap();
    assert_eq!(
        config.session.starting_capital,
        rust_decimal::Decimal::new(50_000, 0)
    );
    assert_eq!(
        config.latency.polling_mode,
        df::core::types::PollingMode::Aggressive
    );
    // Other fields should be default.
    assert_eq!(config.latency.arrival_delay_ms, 500);
}

#[test]
fn reject_zero_capital() {
    let mut f = NamedTempFile::new().unwrap();
    f.write_all(b"[session]\nstarting_capital = \"0\"\n")
        .unwrap();
    let err = df::config::schema::AppConfig::load(f.path()).unwrap_err();
    assert!(err.to_string().contains("starting_capital"));
}

#[test]
fn reject_negative_slippage() {
    let mut f = NamedTempFile::new().unwrap();
    f.write_all(b"[session]\nmax_slippage_bps = \"-10\"\n")
        .unwrap();
    let err = df::config::schema::AppConfig::load(f.path()).unwrap_err();
    assert!(err.to_string().contains("max_slippage_bps"));
}

#[test]
fn marking_mode_parsing() {
    for (input, expected) in [
        ("conservative", df::core::types::MarkingMode::Conservative),
        ("midpoint", df::core::types::MarkingMode::Midpoint),
        ("last_trade", df::core::types::MarkingMode::LastTrade),
    ] {
        let mut f = NamedTempFile::new().unwrap();
        write!(f, "[session]\nmarking_mode = \"{input}\"\n").unwrap();
        let config = df::config::schema::AppConfig::load(f.path()).unwrap();
        assert_eq!(config.session.marking_mode, expected);
    }
}
