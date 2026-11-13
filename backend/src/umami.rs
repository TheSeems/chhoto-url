// SPDX-License-Identifier: MIT

// Anonymous hit events for Umami (https://umami.is). Every hit becomes a pageview of the short link's public URL.
// Nothing from the visitor is ever forwarded: no IP address, user agent, language or referrer.

use log::{error, info, warn};
use openidconnect::reqwest;
use serde::Serialize;
use std::env::var;
use tokio::{spawn, sync::mpsc, time::Duration};
use url::Url;

use crate::config::{remove_surrounding_quotes, remove_trailing_slash};

// Umami drops events whose user agent looks like a bot, so every hit is sent with this fixed one
const USER_AGENT: &str = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

// Hits waiting to be sent; more than this are dropped rather than slowing anything down
const QUEUE_SIZE: usize = 1024;

#[derive(Clone)]
pub(crate) struct UmamiConfig {
    pub(crate) endpoint: String,
    pub(crate) website_id: String,
    pub(crate) site_url: Option<String>,
}

// A page as Umami records it
#[derive(Debug, PartialEq)]
pub(crate) struct UmamiPage {
    pub(crate) hostname: Option<String>,
    pub(crate) path: String,
}

impl UmamiConfig {
    // Reads CHHOTO_UMAMI_URL and CHHOTO_UMAMI_WEBSITE_ID. Umami is off unless both are set and the URL is valid.
    pub(crate) fn from_env(site_url: &Option<String>) -> Option<Self> {
        let read = |name: &str| {
            var(name)
                .ok()
                .map(|s| remove_surrounding_quotes(s.trim()))
                .map(|s| remove_trailing_slash(&s))
                .filter(|s| !s.is_empty())
        };
        match (read("CHHOTO_UMAMI_URL"), read("CHHOTO_UMAMI_WEBSITE_ID")) {
            (Some(url), Some(website_id)) => {
                if Url::parse(&url).is_ok_and(|u| ["http", "https"].contains(&u.scheme())) {
                    info!("Sending anonymous hit events to Umami at {url}.");
                    Some(Self {
                        endpoint: format!("{url}/api/send"),
                        website_id,
                        site_url: site_url.clone(),
                    })
                } else {
                    warn!("Invalid Umami URL was provided. Ignoring the config.");
                    None
                }
            }
            (None, None) => None,
            _ => {
                warn!("Both CHHOTO_UMAMI_URL and CHHOTO_UMAMI_WEBSITE_ID are needed for Umami.");
                None
            }
        }
    }

    // The page a hit is recorded as: the short link's public URL, i.e. CHHOTO_SITE_URL/<shortlink> (what the API
    // returns for new links), split into Umami's hostname and path. Without a site URL, only the path is known.
    pub(crate) fn page(&self, shortlink: &str) -> UmamiPage {
        self.site_url
            .as_deref()
            .and_then(|site| {
                Url::parse(&format!("{}/{shortlink}", site.trim_end_matches('/'))).ok()
            })
            .map(|url| UmamiPage {
                hostname: url.host_str().map(str::to_owned),
                path: url.path().to_owned(),
            })
            .unwrap_or_else(|| UmamiPage {
                hostname: None,
                path: format!("/{shortlink}"),
            })
    }
}

// Body of Umami's /api/send
#[derive(Serialize)]
struct Event<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    payload: Payload<'a>,
}
#[derive(Serialize)]
struct Payload<'a> {
    website: &'a str,
    url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    hostname: Option<String>,
}

// Sends hits to Umami from a task of its own, so a slow or unreachable Umami never holds up the caller
pub(crate) struct Reporter {
    tx: mpsc::Sender<String>,
}

impl Reporter {
    pub(crate) fn spawn(config: UmamiConfig) -> Self {
        let (tx, rx) = mpsc::channel(QUEUE_SIZE);
        spawn(run(config, rx));
        Self { tx }
    }

    // Never waits; the hit is dropped if the queue is full
    pub(crate) fn hit(&self, shortlink: &str) {
        if let Err(err) = self.tx.try_send(shortlink.to_owned()) {
            warn!("Dropped Umami hit for {shortlink}: {err}");
        }
    }
}

async fn run(config: UmamiConfig, mut rx: mpsc::Receiver<String>) {
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .user_agent(USER_AGENT)
        .build()
    {
        Ok(client) => client,
        Err(e) => {
            error!("Error building HTTP client for Umami, no hits will be sent: {e}");
            return;
        }
    };
    while let Some(shortlink) = rx.recv().await {
        send(&client, &config, &shortlink).await;
    }
}

async fn send(client: &reqwest::Client, config: &UmamiConfig, shortlink: &str) {
    let page = config.page(shortlink);
    let event = Event {
        kind: "event",
        payload: Payload {
            website: &config.website_id,
            url: page.path,
            hostname: page.hostname,
        },
    };
    let body = match serde_json::to_string(&event) {
        Ok(body) => body,
        Err(e) => {
            warn!("Unable to encode the Umami event for {shortlink}: {e}");
            return;
        }
    };
    match client
        .post(&config.endpoint)
        .header("Content-Type", "application/json")
        .body(body)
        .send()
        .await
    {
        Ok(res) if res.status().is_success() => {
            // Umami answers with this when it silently discards an event as a bot
            if res.text().await.is_ok_and(|t| t.contains("beep")) {
                warn!("Umami discarded the hit for {shortlink} as bot traffic.");
            }
        }
        Ok(res) => warn!("Umami rejected the hit for {shortlink}: {}", res.status()),
        Err(e) => warn!("Unable to send the hit for {shortlink} to Umami: {e}"),
    }
}
