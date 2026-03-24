use serde::Deserialize;
use tracing::{debug, warn};

use crate::storage::db::Store;

const GAMMA_API_BASE: &str = "https://gamma-api.polymarket.com";

#[derive(Debug, Deserialize)]
pub struct GammaMarket {
    #[serde(rename = "conditionId")]
    pub condition_id: Option<String>,
    pub question: Option<String>,
    pub slug: Option<String>,
    #[serde(rename = "clobTokenIds")]
    pub clob_token_ids: Option<String>, // JSON array as string: "[\"id1\",\"id2\"]"
    #[serde(rename = "negRisk")]
    pub neg_risk: Option<bool>,
    pub active: Option<bool>,
    #[serde(rename = "endDate")]
    pub end_date: Option<String>,
    pub closed: Option<bool>,
}

#[derive(Debug, thiserror::Error)]
pub enum MetadataError {
    #[error("http error: {0}")]
    Http(#[from] reqwest::Error),
}

/// Fetch active markets from Gamma API and store them.
pub async fn refresh_markets(
    client: &reqwest::Client,
    store: &Store,
) -> Result<usize, MetadataError> {
    let mut count = 0;
    let mut offset = 0;
    let limit = 100;

    loop {
        let url = format!(
            "{GAMMA_API_BASE}/markets?limit={limit}&offset={offset}&active=true&closed=false"
        );
        let resp: Vec<GammaMarket> = client.get(&url).send().await?.json().await?;

        if resp.is_empty() {
            break;
        }

        for m in &resp {
            let Some(cid) = &m.condition_id else {
                continue;
            };
            if cid.is_empty() {
                continue;
            }

            let (token_yes, token_no) = parse_clob_token_ids(m.clob_token_ids.as_deref());

            if let Err(e) = store.upsert_market(
                cid,
                m.question.as_deref(),
                m.slug.as_deref(),
                token_yes.as_deref(),
                token_no.as_deref(),
                m.neg_risk.unwrap_or(false),
                m.active.unwrap_or(true) && !m.closed.unwrap_or(false),
                m.end_date.as_deref(),
            ) {
                warn!(condition_id = %cid, error = %e, "failed to store market");
            } else {
                count += 1;
            }
        }

        offset += resp.len();
        if resp.len() < limit {
            break;
        }
    }

    debug!(count, "refreshed market metadata");
    Ok(count)
}

fn parse_clob_token_ids(raw: Option<&str>) -> (Option<String>, Option<String>) {
    let Some(s) = raw else {
        return (None, None);
    };
    // Format: "[\"id1\",\"id2\"]"
    match serde_json::from_str::<Vec<String>>(s) {
        Ok(ids) => {
            let yes = ids.first().cloned();
            let no = ids.get(1).cloned();
            (yes, no)
        }
        Err(_) => (None, None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_token_ids_valid() {
        let (yes, no) = parse_clob_token_ids(Some(r#"["123","456"]"#));
        assert_eq!(yes.as_deref(), Some("123"));
        assert_eq!(no.as_deref(), Some("456"));
    }

    #[test]
    fn parse_token_ids_single() {
        let (yes, no) = parse_clob_token_ids(Some(r#"["123"]"#));
        assert_eq!(yes.as_deref(), Some("123"));
        assert!(no.is_none());
    }

    #[test]
    fn parse_token_ids_empty() {
        let (yes, no) = parse_clob_token_ids(None);
        assert!(yes.is_none());
        assert!(no.is_none());
    }

    #[test]
    fn parse_token_ids_malformed() {
        let (yes, no) = parse_clob_token_ids(Some("not json"));
        assert!(yes.is_none());
        assert!(no.is_none());
    }
}
