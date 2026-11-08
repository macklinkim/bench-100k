//! Cloudflare Turnstile gate (bot check) to limit egress cost.
//!
//! POST /api/session verifies a Turnstile token with Cloudflare siteverify and
//! returns a short-lived ticket; the data endpoints reject requests without one.
//! Fail-closed: if TURNSTILE_SECRET is unset no ticket is ever issued, so the
//! data endpoints stay locked. Local dev uses Cloudflare's test secret
//! `1x0000000000000000000000000000000AA` (always passes).

use std::collections::hash_map::RandomState;
use std::collections::HashMap;
use std::hash::{BuildHasher, Hasher};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use serde::Deserialize;

pub const TICKET_TTL: Duration = Duration::from_secs(3600);
const SITEVERIFY_URL: &str = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

static SECRET: LazyLock<Option<String>> =
    LazyLock::new(|| std::env::var("TURNSTILE_SECRET").ok().filter(|s| !s.is_empty()));
static HTTP: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder().timeout(Duration::from_secs(10)).build().expect("http client")
});

// ponytail: tickets live in this process's memory, which is correct only while
// Cloud Run runs max-instances=1 (a restart just makes clients re-verify).
// Multi-instance upgrade: HMAC-signed stateless tickets with a shared key.
static TICKETS: LazyLock<Mutex<HashMap<String, Instant>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

// SipHash keyed from the OS RNG (RandomState) over a counter: unpredictable
// without the process-local keys, and needs no extra crate.
static KEYS: LazyLock<RandomState> = LazyLock::new(RandomState::new);
static COUNTER: AtomicU64 = AtomicU64::new(0);

pub fn configured() -> bool {
    SECRET.is_some()
}

#[derive(Deserialize)]
struct SiteverifyResponse {
    success: bool,
}

/// Ok(true) = human, Ok(false) = rejected by Cloudflare, Err = could not ask.
pub async fn verify(token: &str) -> Result<bool, String> {
    let secret = SECRET.as_deref().ok_or("turnstile not configured")?;
    let res: SiteverifyResponse = HTTP
        .post(SITEVERIFY_URL)
        .form(&[("secret", secret), ("response", token)])
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    Ok(res.success)
}

pub fn issue() -> String {
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let part = |salt: u8| {
        let mut h = KEYS.build_hasher();
        h.write_u64(n);
        h.write_u8(salt);
        h.finish()
    };
    let ticket = format!("{:016x}{:016x}", part(1), part(2));
    let now = Instant::now();
    let mut map = TICKETS.lock().unwrap();
    map.retain(|_, exp| *exp > now); // tickets only exist after a passed check, so this stays small
    map.insert(ticket.clone(), now + TICKET_TTL);
    ticket
}

pub fn check(ticket: Option<&str>) -> bool {
    let Some(t) = ticket else { return false };
    TICKETS.lock().unwrap().get(t).is_some_and(|exp| *exp > Instant::now())
}
