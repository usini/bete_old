use std::fs;
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use std::thread;

use tauri::Manager;

// Fixed port for the local (LAN) static file server — only used when the user
// picks "Local network" sharing in Settings. Arbitrary, just needs to be
// unlikely to collide with anything else running on the machine.
const LAN_PORT: u16 = 47821;
// Fixed port the main window itself is always loaded from (see tauri.conf.json's
// window "url") -- serving our own UI over local HTTP instead of the built-in
// tauri://localhost asset protocol is what lets check_web_update() below swap
// in freshly downloaded web assets with just a page reload, no MSI reinstall.
const UI_PORT: u16 = 47822;
const WEB_MANIFEST_URL: &str = "https://bete.usini.eu/manifest.json";

// Where the BUNDLED static web app (index.html, css/, js/, assets/) lives:
// in dev it's the desktop/dist/ folder next to src-tauri; once bundled it's
// shipped as a resource (see tauri.conf.json's bundle.resources). This is the
// fallback whenever no (or no valid) hot-updated web cache is present.
fn bundled_dist_dir(app: &tauri::AppHandle) -> PathBuf {
    if cfg!(debug_assertions) && !cfg!(mobile) {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../dist")
    } else {
        app.path()
            .resource_dir()
            .expect("resource dir")
            .join("dist")
    }
}

// Root folder (in the app's own writable data dir) where check_web_update()
// stores hot-downloaded web asset sets, one subfolder per version, plus a
// "current.txt" pointer flipped only after a full successful download.
fn web_cache_root(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .expect("app data dir")
        .join("web_cache")
}

// The directory actually served to the main window right now: the hot-updated
// cache if present and valid, otherwise the assets bundled in the installer.
fn dist_dir(app: &tauri::AppHandle) -> PathBuf {
    let root = web_cache_root(app);
    if let Ok(current) = fs::read_to_string(root.join("current.txt")) {
        let dir = root.join(current.trim());
        if dir.join("index.html").exists() {
            return dir;
        }
    }
    bundled_dist_dir(app)
}

// Reads the ?v=<version> stamp off whichever index.html is currently being
// served (bundled or hot-updated) -- same stamp cachebust.mjs writes on every
// deploy, compared against manifest.json's version to decide if an update
// is needed.
fn local_version(app: &tauri::AppHandle) -> Option<String> {
    let html = fs::read_to_string(dist_dir(app).join("index.html")).ok()?;
    let idx = html.find("main.js?v=")?;
    let rest = &html[idx + "main.js?v=".len()..];
    let end = rest.find(|c: char| c == '"' || c == '\'')?;
    Some(rest[..end].to_string())
}

// Checks bete.usini.eu's manifest.json; if its version differs from what's
// currently being served, downloads every listed file into a fresh
// web_cache/<version>/ folder and only THEN flips current.txt to it -- so a
// network hiccup mid-download never leaves a half-updated, broken UI. Offline
// or any request failure is treated the same as "already up to date": we just
// keep serving whatever we already have.
//
// The actual work is synchronous (blocking ureq calls, one per file), so it
// MUST run off the main/event-loop thread via spawn_blocking -- otherwise the
// whole window freezes (no repaint, no input) for as long as ~35 sequential
// HTTP round trips take, which is exactly what happened before this was async.
#[tauri::command]
async fn check_web_update(app: tauri::AppHandle) -> Result<bool, String> {
    // Mobile has no local server to hot-swap into (see run()'s setup()) --
    // those platforms update by reinstalling the app anyway.
    if cfg!(mobile) {
        return Ok(false);
    }
    tauri::async_runtime::spawn_blocking(move || check_web_update_blocking(&app))
        .await
        .map_err(|e| e.to_string())?
}

fn check_web_update_blocking(app: &tauri::AppHandle) -> Result<bool, String> {
    let manifest_text = ureq::get(WEB_MANIFEST_URL)
        .timeout(std::time::Duration::from_secs(6))
        .call()
        .map_err(|e| e.to_string())?
        .into_string()
        .map_err(|e| e.to_string())?;
    let manifest: serde_json::Value =
        serde_json::from_str(&manifest_text).map_err(|e| e.to_string())?;
    let remote_version = manifest["version"].as_str().ok_or("bad manifest")?;
    let files = manifest["files"]
        .as_array()
        .ok_or("bad manifest")?
        .iter()
        .filter_map(|v| v.as_str());

    if Some(remote_version.to_string()) == local_version(&app) {
        return Ok(false); // already up to date
    }

    let root = web_cache_root(&app);
    let target = root.join(remote_version);
    let _ = fs::remove_dir_all(&target); // clean slate if a previous attempt was left over
    for rel in files {
        let url = format!("https://bete.usini.eu/{rel}");
        let mut bytes = Vec::new();
        ureq::get(&url)
            .timeout(std::time::Duration::from_secs(15))
            .call()
            .map_err(|e| e.to_string())?
            .into_reader()
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        let dest = target.join(rel);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::write(&dest, bytes).map_err(|e| e.to_string())?;
    }

    fs::write(root.join("current.txt"), remote_version).map_err(|e| e.to_string())?;

    // Best-effort cleanup: drop older cached versions so this doesn't grow forever.
    if let Ok(entries) = fs::read_dir(&root) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            if name != "current.txt" && name.to_str() != Some(remote_version) {
                let _ = fs::remove_dir_all(entry.path());
            }
        }
    }

    Ok(true)
}

fn content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("js") | Some("mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") => "application/json",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("svg") => "image/svg+xml",
        Some("wav") => "audio/wav",
        Some("ico") => "image/x-icon",
        _ => "application/octet-stream",
    }
}

// Minimal static file server. Two instances are spawned (see run()):
// - one on 0.0.0.0:LAN_PORT, for other devices on the network (the "Local
//   network" sharing mode: tauri://localhost isn't reachable by anyone but
//   this window);
// - one on 127.0.0.1:UI_PORT, which the main window itself always loads from
//   instead of tauri://localhost, so check_web_update() can swap in fresh web
//   assets and a plain page reload is enough to pick them up.
// `resolve_dist` is re-invoked on every request (not captured once) so a
// version flip from check_web_update() takes effect immediately.
fn serve(bind: &str, port: u16, resolve_dist: impl Fn() -> PathBuf) {
    let server = match tiny_http::Server::http((bind, port)) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("static server: failed to bind {bind}:{port}: {e}");
            return;
        }
    };
    serve_requests(server, resolve_dist);
}

fn serve_requests(server: tiny_http::Server, resolve_dist: impl Fn() -> PathBuf) {
    for request in server.incoming_requests() {
        let dist = resolve_dist();
        let url_path = request.url().split('?').next().unwrap_or("/");
        // The app is a single-page static site: any path without a real file
        // extension (i.e. the board routes driven by ?id=/?peer= query
        // params) falls back to index.html.
        let rel = if url_path == "/" || !url_path.contains('.') {
            "index.html".to_string()
        } else {
            url_path.trim_start_matches('/').to_string()
        };
        let file_path = dist.join(&rel);
        let response = match fs::read(&file_path) {
            Ok(bytes) => {
                let header = tiny_http::Header::from_bytes(
                    &b"Content-Type"[..],
                    content_type(&file_path).as_bytes(),
                )
                .unwrap();
                tiny_http::Response::new(
                    tiny_http::StatusCode(200),
                    vec![header],
                    Cursor::new(bytes.clone()),
                    Some(bytes.len()),
                    None,
                )
            }
            Err(_) => tiny_http::Response::new(
                tiny_http::StatusCode(404),
                vec![],
                Cursor::new(Vec::new()),
                Some(0),
                None,
            ),
        };
        let _ = request.respond(response);
    }
}

#[tauri::command]
fn get_lan_url() -> Result<String, String> {
    let ip = local_ip_address::local_ip().map_err(|e| e.to_string())?;
    Ok(format!("http://{ip}:{LAN_PORT}/"))
}

// Fetches a .ics calendar feed for the app's calendar blocks (js/ics.js).
// Done in Rust (ureq) because a browser fetch is CORS-blocked by most
// calendar hosts (Google, iCloud...). Restricted to http(s) URLs that look
// like an ICS feed, size-capped -- this is not a general-purpose proxy.
const ICS_MAX_BYTES: u64 = 2 * 1024 * 1024;

#[tauri::command]
async fn fetch_ics(url: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || fetch_ics_blocking(&url))
        .await
        .map_err(|e| e.to_string())?
}

fn fetch_ics_blocking(url: &str) -> Result<String, String> {
    let parsed = url::Url::parse(url).map_err(|e| e.to_string())?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("unsupported scheme".into());
    }
    let path_and_query = format!(
        "{}?{}",
        parsed.path().to_lowercase(),
        parsed.query().unwrap_or("").to_lowercase()
    );
    if !path_and_query.contains(".ics") {
        return Err("not an ics url".into());
    }
    let mut text = String::new();
    ureq::get(url)
        .timeout(std::time::Duration::from_secs(15))
        .call()
        .map_err(|e| e.to_string())?
        .into_reader()
        .take(ICS_MAX_BYTES)
        .read_to_string(&mut text)
        .map_err(|e| e.to_string())?;
    Ok(text)
}

// Writes the "export all boards on exit" JSON straight to disk, given an
// absolute path (a directory the user picked once via the dialog plugin --
// see js/platform.js: pickExportFolder -- plus a dated filename built in JS).
// A plain Rust std::fs::write isn't bound by the webview fs plugin's path
// scope (that scope only auto-exempts a path just returned BY a dialog
// picker, not an arbitrary path built from a remembered one on a later run),
// so this is the straightforward way to silently write into a remembered
// folder without a fresh Save-As prompt on every single exit.
#[tauri::command]
fn write_export_file(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|e| e.to_string())
}

// WRY's default navigation policy (especially on Android) punts anything it
// doesn't recognize as "the same page" out to the system browser -- including
// a plain `location.href = ...` to another query string on the same origin,
// which is exactly how this app switches boards, joins a liaison as a P2P
// client, etc. (js/main.js, js/sync.js, js/settings.js all just reassign
// location.href, there's no SPA router). There are no real <a> elements
// anywhere in this app (the whole board is canvas-drawn) -- every navigation
// WRY ever sees originates from our own JS, which already decided for itself
// whether a link is internal (location.href) or external (js/platform.js:
// openExternal(), via the opener plugin). So it's safe, and necessary, to
// always allow navigation here and let that JS-side decision be the only gate.
fn allow_navigation() -> bool {
    true
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![get_lan_url, check_web_update, fetch_ics, write_export_file])
        .setup(|app| {
            // Desktop only: the hot-web-update trick (check_web_update) needs
            // the window to load over plain HTTP from our own local server
            // instead of the tauri://localhost asset protocol. On mobile,
            // Tauri's own asset pipeline embeds the frontend into the APK/IPA
            // in a way our resource_dir()-based file server can't see (it
            // 404s everything) -- and mobile apps update by reinstalling
            // anyway, so there's nothing to hot-swap there. Mobile just uses
            // the default tauri:// asset protocol via WebviewUrl::default().
            #[cfg(desktop)]
            {
                // The UI server MUST be listening before the window tries to
                // load it -- windows declared in tauri.conf.json get created
                // before .setup() runs, so this window is instead built
                // manually here, after a bind confirmation from the server
                // thread (near-instant, but this avoids a race that would
                // otherwise show a connection error on launch).
                let (tx, rx) = std::sync::mpsc::channel();
                let app_ui = app.handle().clone();
                thread::spawn(move || {
                    let server = match tiny_http::Server::http(("127.0.0.1", UI_PORT)) {
                        Ok(s) => s,
                        Err(e) => {
                            eprintln!("UI server: failed to bind 127.0.0.1:{UI_PORT}: {e}");
                            return;
                        }
                    };
                    let _ = tx.send(());
                    serve_requests(server, move || dist_dir(&app_ui));
                });
                let _ = rx.recv();

                let app_lan = app.handle().clone();
                thread::spawn(move || serve("0.0.0.0", LAN_PORT, move || dist_dir(&app_lan)));

                let ui_url = url::Url::parse(&format!("http://127.0.0.1:{UI_PORT}/")).unwrap();
                tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::External(ui_url))
                    .title("Bete")
                    .inner_size(1280.0, 800.0)
                    .min_inner_size(480.0, 360.0)
                    .on_navigation(|_url| allow_navigation())
                    // Without this, Tauri/WRY intercepts native file drops on
                    // Windows (WebView2) and the page never receives HTML5
                    // drag/drop events -- which is all the app uses to drop
                    // images onto the board (js/input.js: onDrop).
                    .disable_drag_drop_handler()
                    .build()?;
            }
            #[cfg(mobile)]
            {
                tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::default())
                    .on_navigation(|_url| allow_navigation())
                    .build()?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Bete desktop app");
}
