//! The desktop window around the work log.
//!
//! The work log is a local web server — the same one `bun run ui` starts — so
//! this app does three things and no more: start that server as a sidecar,
//! wait for it to say which port it bound, and point the window at it.
//! Nothing here reimplements a view; a desktop build that drifted from the
//! browser one would be two products to keep honest instead of one.
//!
//! The page it loads is served over plain HTTP from 127.0.0.1 and is given no
//! Tauri capabilities at all. It cannot call into Rust, which is the point: the
//! server it came from already has everything it needs, and a page with IPC
//! access is a page that can be talked into using it.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{Manager, RunEvent, Url};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// The running server, so exit can stop it.
///
/// Tauri does not kill a sidecar when the app quits. Without this the server
/// outlives the window, holds its port, and the next launch starts a second
/// one beside it.
struct Server(Mutex<Option<CommandChild>>);

/// The repository the launch named: `--repo`, then `ANVC_REPO`. Without one,
/// start() opens the one opened last time, or asks with a folder picker.
fn named_repo() -> Option<PathBuf> {
    let args: Vec<String> = std::env::args().collect();
    let from_arg = args
        .iter()
        .position(|a| a == "--repo")
        .and_then(|i| args.get(i + 1).cloned())
        .or_else(|| args.iter().find_map(|a| a.strip_prefix("--repo=").map(String::from)));
    from_arg.or_else(|| std::env::var("ANVC_REPO").ok()).map(PathBuf::from)
}

fn remembered_repo(app: &tauri::AppHandle) -> Option<PathBuf> {
    remembered_file(app)
        .and_then(|f| std::fs::read_to_string(f).ok())
        .map(|s| PathBuf::from(s.trim()))
        .filter(|p| p.join(".git").exists())
}

fn remember(app: &tauri::AppHandle, repo: &Path) {
    if let Some(file) = remembered_file(app) {
        if let Some(dir) = file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(file, repo.to_string_lossy().as_bytes());
    }
}

fn remembered_file(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("last-repository"))
}

/// The ports the server tries in order, before any free port.
///
/// It has to be stable. The page keeps what it remembers — the sidebar's width,
/// a chosen filter — in browser storage, which is keyed by origin, and the port
/// is part of the origin. The range stays clear of `bun run ui`'s 7451-7470.
///
/// The server binds it and says which one it got. This app used to find a
/// free port, let it go and pass the number on, and in between another
/// process could take it and have the window load its page.
const PORTS: &str = "7431-7450";

/// A new token each launch: the server refuses any request without it.
fn new_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| e.to_string())?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// Says what went wrong on whichever page the window shows. #msg and #detail
/// are only on desktop/index.html; once the window is on the work log, the
/// page is replaced with one that has them.
fn show_failure(window: &tauri::WebviewWindow, message: &str, detail: &str) {
    let script = format!(
        "if (!document.getElementById('msg')) document.body.innerHTML = \
           '<main style=\"padding:24px;font:16px/1.5 system-ui,sans-serif\"><div id=\"msg\" role=\"status\"></div><div id=\"detail\"></div></main>';\
         document.body.classList.add('failed');\
         document.getElementById('msg').textContent = {};\
         document.getElementById('detail').textContent = {};",
        serde_json::to_string(message).unwrap_or_default(),
        serde_json::to_string(detail).unwrap_or_default(),
    );
    let _ = window.eval(&script);
}

fn start(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle().clone();
    if let Some(repo) = named_repo() {
        return open(&handle, repo, false);
    }
    // Launched with nothing named, as from a menu: the last project, or the
    // list of them when another window already has the first port.
    if let Some(repo) = remembered_repo(&handle) {
        return open(&handle, repo, true);
    }
    // Setup runs on the main thread, and tauri-plugin-dialog says its blocking
    // picker isn't for use there, so this one answers in a callback.
    app.dialog().file().set_title("Choose a repository to open").pick_folder(move |folder| {
        let Some(repo) = folder.and_then(|f| f.into_path().ok()) else {
            // Cancelling the picker is a decision, not a crash.
            handle.exit(0);
            return;
        };
        remember(&handle, &repo);
        if let Err(error) = open(&handle, repo, false) {
            if let Some(window) = handle.get_webview_window("main") {
                show_failure(&window, "The work log did not start.", &error.to_string());
            }
        }
    });
    Ok(())
}

/// Starts the server for `repo` and points the window at it once it's listening.
/// With `or_list`, a window that isn't the first opens on the project list.
fn open(app: &tauri::AppHandle, repo: PathBuf, or_list: bool) -> Result<(), Box<dyn std::error::Error>> {
    let window = app.get_webview_window("main").ok_or("no main window")?;
    if !repo.join(".git").exists() {
        show_failure(&window, "That folder is not a git repository.", &repo.to_string_lossy());
        return Ok(());
    }
    let _ = window.set_title(&format!(
        "ANVC | {}",
        repo.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
    ));

    let token = new_token()?;
    let (mut events, child) = app
        .shell()
        .sidecar("anvc-server")?
        // The server exits when this process's end of its stdin closes, which
        // happens however this app dies — the kill on a clean exit below
        // covers only the one way that runs any code.
        .args(["--repo", &repo.to_string_lossy(), "--port", PORTS, "--exit-with-parent"])
        .env("ANVC_UI_TOKEN", &token)
        // What the server starts for Ctrl+N. An AppImage runs from a mount
        // that goes when it exits, so the image itself is named.
        .env("ANVC_DESKTOP_APP", std::env::var_os("APPIMAGE").map(PathBuf::from).or_else(|| std::env::current_exe().ok()).unwrap_or_default())
        .spawn()?;
    app.state::<Server>().0.lock().unwrap().replace(child);

    // Navigate only when this child says where it is listening. Its stdout is
    // the one source no other process can speak through, and the line comes
    // after the bind, so the window never shows a connection error either.
    // Its stderr is kept for when something goes wrong: without it a failed
    // start is a spinner that never stops.
    let heard = Arc::new(AtomicBool::new(false));
    let (log_window, log_heard) = (window.clone(), heard.clone());
    tauri::async_runtime::spawn(async move {
        let mut last_error = String::new();
        while let Some(event) = events.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    let line = String::from_utf8_lossy(&line);
                    let port = line.trim().strip_prefix("anvc listening 127.0.0.1:").and_then(|p| p.parse::<u16>().ok());
                    // The first window gets the first port. One that didn't is
                    // another window, which opens on the project list.
                    let another = or_list && port.is_some() && port != PORTS.split('-').next().and_then(|p| p.parse().ok());
                    if another {
                        let _ = log_window.set_title("ANVC");
                    }
                    let page = if another { "&page=folders" } else { "" };
                    if let Some(url) = port.and_then(|p| Url::parse(&format!("http://127.0.0.1:{p}/?t={token}{page}")).ok()) {
                        log_heard.store(true, Ordering::SeqCst);
                        let _ = log_window.navigate(url);
                    }
                }
                CommandEvent::Stderr(line) => last_error = String::from_utf8_lossy(&line).into_owned(),
                CommandEvent::Terminated(status) => {
                    log_heard.store(true, Ordering::SeqCst);
                    show_failure(
                        &log_window,
                        "The work log stopped.",
                        &format!("exit {:?}. {}", status.code, last_error.trim()),
                    );
                }
                _ => {}
            }
        }
    });

    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(30));
        if !heard.load(Ordering::SeqCst) {
            show_failure(&window, "The work log did not start.", "It didn't say which port it was on within 30 seconds.");
        }
    });
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Server(Mutex::new(None)))
        .setup(|app| start(app))
        .build(tauri::generate_context!())
        .expect("error while building the anvc desktop app")
        .run(|app, event| {
            if let RunEvent::ExitRequested { .. } | RunEvent::Exit = event {
                if let Some(child) = app.state::<Server>().0.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
        });
}
