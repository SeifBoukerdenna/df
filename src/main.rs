mod cli;
mod config;
mod core;
mod ingestion;
mod report;
mod sim;
mod storage;

use std::path::PathBuf;

use clap::{Parser, Subcommand};
use rust_decimal::Decimal;

#[derive(Parser)]
#[command(name = "df", about = "Polymarket paper-trading copy engine")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Start a live paper-trading session
    Run {
        /// Path to config TOML file
        #[arg(short, long, default_value = "config/default.toml")]
        config: PathBuf,
        /// Override starting capital (USDC)
        #[arg(long)]
        capital: Option<Decimal>,
    },
    /// Show current session state
    Status {
        /// Output as JSON
        #[arg(long)]
        json: bool,
    },
    /// Generate HTML report from a session
    Report {
        /// Session ID (defaults to latest)
        #[arg(long)]
        session: Option<String>,
        /// Path to config TOML file
        #[arg(short, long, default_value = "config/default.toml")]
        config: PathBuf,
    },
    /// Deterministic replay of a past session
    Replay {
        /// Session ID to replay
        #[arg(long)]
        session: String,
        /// Path to config TOML file
        #[arg(short, long, default_value = "config/default.toml")]
        config: PathBuf,
    },
    /// Validate and list tracked wallets
    Wallets {
        /// Path to config TOML file
        #[arg(short, long, default_value = "config/default.toml")]
        config: PathBuf,
        /// Validate wallet addresses via Polymarket API
        #[arg(long)]
        check: bool,
    },
    /// Validate and dump effective configuration
    Config {
        /// Path to config TOML file
        #[arg(short, long, default_value = "config/default.toml")]
        config: PathBuf,
    },
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("df=info".parse().unwrap()),
        )
        .with_target(false)
        .init();

    let cli = Cli::parse();

    match cli.command {
        Commands::Run { config, capital } => {
            cli::run::execute(&config, capital).await;
        }
        Commands::Status { json } => {
            cli::status::execute(json);
        }
        Commands::Report { session, config } => {
            cli::report::execute(session, &config);
        }
        Commands::Replay { session, config } => {
            cli::replay::execute(session, &config);
        }
        Commands::Wallets { config, check } => {
            cli::wallets::execute(&config, check);
        }
        Commands::Config { config } => {
            execute_config(&config);
        }
    }
}

fn execute_config(config_path: &PathBuf) {
    match crate::config::schema::AppConfig::load(config_path) {
        Ok(c) => {
            println!("Effective configuration:");
            println!();
            match toml::to_string_pretty(&c) {
                Ok(s) => print!("{s}"),
                Err(e) => eprintln!("error serializing config: {e}"),
            }
        }
        Err(e) => {
            eprintln!("error: {e}");
            std::process::exit(1);
        }
    }
}
