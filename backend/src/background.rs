// SPDX-FileCopyrightText: 2023-2026 Sayantan Santra <sayantan.santra689@gmail.com>
// SPDX-License-Identifier: MIT

use actix_web::web;
use chrono::{Local, Timelike};
use log::{error, info, warn};
use openidconnect::reqwest;
use serde_json::json;
use std::{collections::HashMap, sync::Arc};
use tokio::{
    spawn,
    sync::{AcquireError, OwnedSemaphorePermit, Semaphore, mpsc},
    task::spawn_blocking,
    time::{Duration, Instant, interval, sleep, sleep_until, timeout},
};

use crate::{AppState, config::UmamiConfig, database};

// Umami drops events whose user agent looks like a bot, so every hit is sent with this fixed one.
// Nothing from the actual visitor is ever forwarded.
const UMAMI_USER_AGENT: &str = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

// Send one anonymous pageview to Umami for every hit
fn spawn_umami_worker(
    umami: UmamiConfig,
    mut umami_rx: mpsc::Receiver<String>,
) -> tokio::task::JoinHandle<()> {
    spawn({
        async move {
            let client = match reqwest::Client::builder()
                .timeout(Duration::from_secs(5))
                .user_agent(UMAMI_USER_AGENT)
                .build()
            {
                Ok(client) => client,
                Err(e) => {
                    error!("Error building HTTP client for Umami, no hits will be sent: {e}");
                    return;
                }
            };
            while let Some(shortlink) = umami_rx.recv().await {
                let mut payload = json!({
                    "website": umami.website_id,
                    "url": format!("/{shortlink}"),
                });
                if let Some(hostname) = &umami.hostname {
                    payload["hostname"] = json!(hostname);
                }
                let body = json!({"type": "event", "payload": payload}).to_string();
                match client
                    .post(&umami.endpoint)
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
        }
    })
}

pub(crate) enum HitUpdate {
    Hit(String),
    Reset(String),
}

// Run hit updates every 500ms or once 500 distinct links are pending.
pub(crate) fn spawn_hits_worker(
    data: web::Data<AppState>,
    mut hits_rx: mpsc::Receiver<HitUpdate>,
) -> tokio::task::JoinHandle<()> {
    spawn({
        async move {
            let mut pending = HashMap::new();
            // Every hit that passes through here is also forwarded to Umami, if configured
            let umami_tx = data.config.umami.clone().map(|umami| {
                let (umami_tx, umami_rx) = mpsc::channel::<String>(1024);
                spawn_umami_worker(umami, umami_rx);
                umami_tx
            });
            let update_count = |update: HitUpdate, pending: &mut HashMap<String, i64>| match update
            {
                HitUpdate::Hit(link) => {
                    // Never wait on Umami; the hit is dropped if its queue is full
                    if let Some(umami_tx) = &umami_tx
                        && let Err(err) = umami_tx.try_send(link.clone())
                    {
                        warn!("Dropped Umami hit for {link}: {err}");
                    }
                    *pending.entry(link).or_insert(0) += 1;
                }
                HitUpdate::Reset(link) => {
                    pending.remove(&link);
                }
            };
            loop {
                let Some(first) = hits_rx.recv().await else {
                    break;
                };
                update_count(first, &mut pending);
                let deadline = Instant::now() + Duration::from_millis(500);

                while pending.len() < 500 {
                    tokio::select! {
                        Some(update) = hits_rx.recv() => update_count(update, &mut pending),
                        _ = sleep_until(deadline) => break,
                        else => break,
                    }
                }
                if !pending.is_empty() {
                    let data = data.clone();
                    let batch = std::mem::take(&mut pending);
                    spawn_blocking(move || {
                        let Ok(mut writer) = data.writer.lock() else {
                            error!("{}", crate::DB_MUTEX_ERROR);
                            return;
                        };
                        database::add_hits(batch, &mut writer);
                    })
                    .await
                    .unwrap_or_else(|err| error!("Hits worker task failed: {err}"));
                }
            }
        }
    })
}

// Do database cleanup once every hour
pub(crate) fn spawn_cleaner(
    data: web::Data<AppState>,
    use_wal_mode: bool,
    disable_backups: bool,
) -> tokio::task::JoinHandle<()> {
    spawn({
        async move {
            let db_path = &data.config.db_location;

            info!("Starting hourly database cleanup service.");
            let mut interval = interval(Duration::from_hours(1));
            let mut first_run = true;
            loop {
                interval.tick().await;
                let hour = Local::now().hour();

                info!("Starting database cleanup task.");
                for attempt in 0..3 {
                    let data = data.clone();
                    let result = tokio::task::spawn_blocking(move || {
                        let Ok(mut db) = data.writer.lock() else {
                            error!("{}", crate::DB_MUTEX_ERROR);
                            return Err(crate::DB_MUTEX_ERROR.to_string());
                        };
                        database::cleanup(&mut db, use_wal_mode, first_run, attempt)
                    })
                    .await;
                    match result {
                        Ok(Ok(true)) => {
                            if attempt < 2 {
                                info!("Expired links remain; will try again in 10 seconds.");
                            } else {
                                info!(
                                    "Expired links remain; they will be tried again during a later cleanup."
                                );
                                info!("Cleanup task complete.");
                            };
                        }
                        Ok(Ok(false)) => {
                            info!("No expired links remain.");
                            break;
                        }
                        Ok(Err(e)) => {
                            warn!("Cleanup issue: {e}");
                            break;
                        }
                        Err(e) => {
                            warn!("Cleanup task failed: {e}");
                            break;
                        }
                    };
                    if attempt < 2 {
                        sleep(Duration::from_secs(10)).await;
                    }
                }
                first_run = false;
                if hour == 3 {
                    info!("Doing a scheduled daily backup.");
                    let path = db_path.clone();
                    match tokio::task::spawn_blocking(move || {
                        database::manage_backups(
                            &path,
                            disable_backups,
                            database::BackupType::Daily,
                        )
                    })
                    .await
                    {
                        Ok(Ok(())) => {}
                        Ok(Err(e)) => warn!("Scheduled backup error: {e}"),
                        Err(e) => warn!("Scheduled backup task failed: {e}"),
                    }
                }
            }
        }
    })
}

pub(crate) enum AcquirePermitError {
    Timeout,
    Closed(AcquireError),
}
pub(crate) async fn acquire_permit(
    semaphore: Arc<Semaphore>,
) -> Result<OwnedSemaphorePermit, AcquirePermitError> {
    match timeout(Duration::from_secs(1), semaphore.acquire_owned()).await {
        Ok(Ok(permit)) => Ok(permit),
        Ok(Err(err)) => Err(AcquirePermitError::Closed(err)),
        Err(_) => Err(AcquirePermitError::Timeout),
    }
}
