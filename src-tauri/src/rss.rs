//! Arbitrary RSS/Atom feeds.
//!
//! yt-dlp already handles channel and playlist URLs, and does it better than a
//! feed parser could — it knows each site's pagination and metadata. What it
//! cannot do is read a podcast or torrent feed, where the thing to download is
//! an `<enclosure>` (a file or a magnet) rather than a page.
//!
//! So this returns the same `PlaylistInfo` shape `parse_playlist` does. The
//! whole subscription pipeline downstream — the seen set, the keyword rules,
//! the category — is unchanged and doesn't need to know which fetcher ran.

use crate::errors::{ErrorCode, PrismError};
use crate::{PlaylistEntry, PlaylistInfo};
use std::time::Duration;
use tauri::AppHandle;

/// Feeds are text. Two megabytes is far past any real one, and the cap is what
/// stops a hostile or broken URL from being read into memory forever.
const MAX_FEED_BYTES: u64 = 2 * 1024 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);

/// The feed's own network settings, matching the rest of the app: a feed poll
/// should go through the same proxy and address family as the downloads it
/// queues, or a user behind a proxy gets subscriptions that silently never
/// update.
fn client_for(app: &AppHandle) -> Result<reqwest::Client, PrismError> {
    let mut builder = reqwest::Client::builder()
        .user_agent(concat!("Prism/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(REQUEST_TIMEOUT)
        .redirect(reqwest::redirect::Policy::limited(10));
    if crate::force_ipv4(app) {
        builder = builder.local_address(std::net::IpAddr::V4(std::net::Ipv4Addr::UNSPECIFIED));
    }
    if let Some(proxy) = crate::proxy_url(app) {
        if proxy.starts_with("http://") || proxy.starts_with("https://") {
            let proxy = reqwest::Proxy::all(&proxy).map_err(|e| {
                PrismError::new(ErrorCode::InvalidInput, format!("Invalid proxy: {e}"))
            })?;
            builder = builder.proxy(proxy);
        }
        // A SOCKS proxy is left alone rather than refused: it applies to video
        // downloads, and failing the whole subscription over it would be worse
        // than fetching the feed directly.
    }
    builder
        .build()
        .map_err(|e| PrismError::new(ErrorCode::Unknown, format!("Couldn't create HTTP client: {e}")))
}

/// GET the feed, refusing anything past the cap. Content-Length is checked up
/// front and the body again while it streams, since the header can be absent
/// or simply wrong.
async fn fetch_capped(client: &reqwest::Client, url: &str) -> Result<Vec<u8>, PrismError> {
    let mut resp = client.get(url).send().await.map_err(|e| {
        let code = if e.is_timeout() { ErrorCode::Timeout } else { ErrorCode::Network };
        PrismError::new(code, format!("Couldn't reach the feed: {e}"))
    })?;
    if !resp.status().is_success() {
        let code = match resp.status().as_u16() {
            401 | 403 => ErrorCode::Forbidden,
            404 | 410 => ErrorCode::NotFound,
            429 => ErrorCode::RateLimited,
            _ => ErrorCode::Network,
        };
        return Err(PrismError::new(
            code,
            format!("The feed returned HTTP {}", resp.status().as_u16()),
        ));
    }
    let too_big = || {
        PrismError::new(
            ErrorCode::InvalidInput,
            format!("That feed is larger than the {} MB limit", MAX_FEED_BYTES / 1_048_576),
        )
    };
    if resp.content_length().is_some_and(|len| len > MAX_FEED_BYTES) {
        return Err(too_big());
    }
    let mut buf =
        Vec::with_capacity(resp.content_length().unwrap_or(0).min(MAX_FEED_BYTES) as usize);
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| PrismError::new(ErrorCode::Network, format!("The feed stopped sending: {e}")))?
    {
        if (buf.len() as u64).saturating_add(chunk.len() as u64) > MAX_FEED_BYTES {
            return Err(too_big());
        }
        buf.extend_from_slice(&chunk);
    }
    Ok(buf)
}

/// What to download for one feed entry.
///
/// An enclosure wins over the entry's own link: the link is the episode's web
/// page, the enclosure is the actual file (or magnet).
///
/// The catch is that the two feed formats put enclosures in different places,
/// and feed-rs preserves that difference rather than papering over it:
///
/// * Atom writes `<link rel="enclosure">`, so it lands in `links`.
/// * RSS 2.0's `<enclosure>` is treated as a MediaRSS content element and is
///   wrapped in a `MediaObject` — it never appears in `links` at all.
///
/// Reading only the first of those is a quiet failure, not a loud one: every
/// podcast and torrent feed still parses, and every entry queues the web page
/// instead of the file.
///
/// Falling back to a plain link keeps feeds that carry no enclosure working;
/// those entries are pages, and yt-dlp is the right engine for a page.
fn entry_url(entry: &feed_rs::model::Entry) -> Option<String> {
    let clean = |s: &str| {
        let t = s.trim();
        (!t.is_empty()).then(|| t.to_string())
    };

    // Atom: stated outright.
    let atom = entry
        .links
        .iter()
        .find(|l| l.rel.as_deref() == Some("enclosure"))
        .and_then(|l| clean(&l.href));
    if atom.is_some() {
        return atom;
    }

    // RSS 2.0: the same idea, parsed as media content.
    let media = entry
        .media
        .iter()
        .flat_map(|m| m.content.iter())
        .find_map(|c| c.url.as_ref().and_then(|u| clean(u.as_str())));
    if media.is_some() {
        return media;
    }

    // No enclosure — the entry's own page.
    entry.links.iter().find_map(|l| clean(&l.href))
}

/// Map a parsed feed onto the shape the subscription pipeline already speaks.
///
/// Separate from the fetch so the mapping — which is where the real decisions
/// are — can be tested against fixture XML without touching the network.
fn feed_to_playlist(feed: feed_rs::model::Feed, limit: Option<u32>) -> PlaylistInfo {
    let title = feed
        .title
        .map(|t| t.content.trim().to_string())
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| "RSS feed".to_string());

    let mut entries: Vec<PlaylistEntry> = feed
        .entries
        .iter()
        .filter_map(|e| {
            let url = entry_url(e)?;
            let entry_title = e
                .title
                .as_ref()
                .map(|t| t.content.trim().to_string())
                .filter(|t| !t.is_empty())
                .unwrap_or_else(|| file_name_of(&url));
            Some(PlaylistEntry {
                url,
                title: entry_title,
                // A flat feed carries neither reliably, and the engine fills
                // both in once the item actually starts.
                duration: 0.0,
                thumbnail: String::new(),
            })
        })
        .collect();

    // Same window as a channel poll, off the top. Feeds are newest-first by
    // convention; entries are left in feed order either way, because the seen
    // set depends on that order being stable.
    if let Some(n) = limit.filter(|n| *n > 0) {
        entries.truncate(n as usize);
    }
    PlaylistInfo { title, entries }
}

/// Last path segment of a URL, for an entry with no title of its own.
fn file_name_of(url: &str) -> String {
    let path = url.split(['?', '#']).next().unwrap_or(url);
    path.rsplit('/')
        .find(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| "Untitled".to_string())
}

#[tauri::command]
pub async fn rss_fetch(
    app: AppHandle,
    url: String,
    limit: Option<u32>,
) -> Result<PlaylistInfo, PrismError> {
    let client = client_for(&app)?;
    let body = fetch_capped(&client, &url).await?;
    let feed = feed_rs::parser::parse(&body[..]).map_err(|e| {
        PrismError::new(
            ErrorCode::InvalidInput,
            format!("That URL doesn't look like an RSS or Atom feed: {e}"),
        )
    })?;
    let info = feed_to_playlist(feed, limit);
    if info.entries.is_empty() {
        return Err(PrismError::new(
            ErrorCode::NotFound,
            "That feed parsed, but has no entries with a link to download",
        ));
    }
    log::info!("rss: {} ({} entries)", info.title, info.entries.len());
    Ok(info)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(xml: &str) -> PlaylistInfo {
        feed_to_playlist(feed_rs::parser::parse(xml.as_bytes()).expect("fixture parses"), None)
    }

    #[test]
    fn an_enclosure_wins_over_the_entrys_web_page() {
        let info = parse(
            r#"<?xml version="1.0"?>
            <rss version="2.0"><channel>
              <title>Example Cast</title>
              <item>
                <title>Episode One</title>
                <link>https://example.com/episodes/1</link>
                <enclosure url="https://example.com/files/ep1.mp3" length="9" type="audio/mpeg"/>
              </item>
            </channel></rss>"#,
        );
        assert_eq!(info.title, "Example Cast");
        assert_eq!(info.entries.len(), 1);
        assert_eq!(info.entries[0].title, "Episode One");
        // The file, not the page it is described on.
        assert_eq!(info.entries[0].url, "https://example.com/files/ep1.mp3");
    }

    #[test]
    fn an_atom_enclosure_is_found_too() {
        // Atom puts the enclosure in links with a rel, where RSS 2.0 does not
        // put it at all. Both paths are covered because handling only one of
        // them fails silently — every entry just queues its web page.
        let info = parse(
            r#"<?xml version="1.0"?>
            <feed xmlns="http://www.w3.org/2005/Atom">
              <title>Atom Cast</title>
              <entry>
                <title>Episode One</title>
                <link rel="alternate" href="https://example.com/episodes/1"/>
                <link rel="enclosure" type="audio/mpeg" href="https://example.com/files/ep1.mp3"/>
              </entry>
            </feed>"#,
        );
        assert_eq!(info.entries[0].url, "https://example.com/files/ep1.mp3");
    }

    #[test]
    fn a_magnet_enclosure_survives_parsing() {
        // The headline case for a torrent feed. Worth asserting because the
        // enclosure URL goes through a real URL parse on the way in, and a
        // scheme it rejected would degrade quietly to the entry's page.
        let info = parse(
            r#"<?xml version="1.0"?>
            <rss version="2.0"><channel>
              <title>Releases</title>
              <item>
                <title>Some Release</title>
                <link>https://example.com/details/1</link>
                <enclosure url="magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&amp;dn=Some.Release"
                           length="0" type="application/x-bittorrent"/>
              </item>
            </channel></rss>"#,
        );
        assert!(
            info.entries[0].url.starts_with("magnet:?xt=urn:btih:"),
            "expected the magnet, got {}",
            info.entries[0].url
        );
    }

    #[test]
    fn an_entry_without_an_enclosure_falls_back_to_its_link() {
        let info = parse(
            r#"<?xml version="1.0"?>
            <rss version="2.0"><channel>
              <title>Blog</title>
              <item><title>A post</title><link>https://example.com/watch/abc</link></item>
            </channel></rss>"#,
        );
        assert_eq!(info.entries[0].url, "https://example.com/watch/abc");
    }

    #[test]
    fn an_untitled_entry_is_named_after_its_file() {
        let info = parse(
            r#"<?xml version="1.0"?>
            <rss version="2.0"><channel>
              <title>Releases</title>
              <item>
                <link>https://example.com/d/Some.Release.720p.mkv?token=x</link>
              </item>
            </channel></rss>"#,
        );
        assert_eq!(info.entries[0].title, "Some.Release.720p.mkv");
    }

    #[test]
    fn the_limit_takes_a_window_off_the_top() {
        let items: String = (1..=5)
            .map(|i| format!("<item><title>E{i}</title><link>https://e.com/{i}</link></item>"))
            .collect();
        let xml = format!(
            r#"<?xml version="1.0"?><rss version="2.0"><channel><title>F</title>{items}</channel></rss>"#
        );
        let feed = feed_rs::parser::parse(xml.as_bytes()).unwrap();
        let info = feed_to_playlist(feed, Some(2));
        assert_eq!(info.entries.len(), 2);
        assert_eq!(info.entries[0].title, "E1");
    }

    #[test]
    fn a_feed_with_no_usable_links_produces_nothing() {
        let info = parse(
            r#"<?xml version="1.0"?>
            <rss version="2.0"><channel><title>Empty</title>
              <item><title>No link at all</title></item>
            </channel></rss>"#,
        );
        assert!(info.entries.is_empty());
    }
}
