use rust_embed::RustEmbed;
use std::{env, process, sync::Arc, thread};
use tiny_http::{Header, Method, Request, Response, Server};

/// 构建时由 workflow 将前端产物复制到 `dist/`，编译期嵌入二进制。
#[derive(RustEmbed)]
#[folder = "dist/"]
struct Assets;

const NAME: &str = "zashboard";
const DEFAULT_PORT: &str = "3000";

fn parse_port() -> String {
    let mut port = String::new();
    let mut args = env::args().skip(1);
    while let Some(a) = args.next() {
        // 与 Go flag 包一致：-port / --port，值可用空格或 = 分隔
        let a = a.trim_start_matches('-');
        if a == "h" || a == "help" {
            println!("Usage: {NAME} [--port <port>]\n  port defaults to {DEFAULT_PORT}, or the PORT env var");
            process::exit(0);
        } else if a == "port" {
            port = args.next().unwrap_or_default();
        } else if let Some(v) = a.strip_prefix("port=") {
            port = v.to_string();
        } else {
            eprintln!("unknown argument: {a}");
            process::exit(2);
        }
    }
    if port.is_empty() {
        port = env::var("PORT").unwrap_or_default();
    }
    if port.is_empty() {
        port = DEFAULT_PORT.to_string();
    }
    port
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).unwrap()
}

fn content_type(mime: &str) -> String {
    let textual = mime.starts_with("text/")
        || matches!(
            mime,
            "application/javascript" | "application/json" | "image/svg+xml"
        );
    if textual {
        format!("{mime}; charset=utf-8")
    } else {
        mime.to_string()
    }
}

fn handle(req: Request) {
    if !matches!(req.method(), Method::Get | Method::Head) {
        let _ = req.respond(Response::empty(405).with_header(header("Allow", "GET, HEAD")));
        return;
    }

    let raw = req.url().split(['?', '#']).next().unwrap_or("/");
    let mut path = percent_decode(raw.trim_start_matches('/'));
    if path.is_empty() || path.ends_with('/') {
        path.push_str("index.html");
    }

    // 命中文件则直接返回；否则 SPA 回退到 index.html
    let file = Assets::get(&path).or_else(|| Assets::get("index.html"));
    let Some(file) = file else {
        let _ = req.respond(Response::from_string("not found").with_status_code(404));
        return;
    };

    let etag = format!(
        "\"{}\"",
        file.metadata
            .sha256_hash()
            .iter()
            .take(8)
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    );
    let not_modified = req
        .headers()
        .iter()
        .any(|h| h.field.equiv("If-None-Match") && h.value.as_str() == etag);

    let mut resp = if not_modified {
        Response::from_data(Vec::new()).with_status_code(304)
    } else {
        Response::from_data(file.data.into_owned())
            .with_header(header("Content-Type", &content_type(file.metadata.mimetype())))
    };
    resp = resp
        .with_header(header("ETag", &etag))
        .with_header(header("Cache-Control", "no-cache"));
    let _ = req.respond(resp);
}

fn main() {
    let port = parse_port();
    let server = Server::http(format!("0.0.0.0:{port}")).unwrap_or_else(|e| {
        eprintln!("failed to listen on port {port}: {e}");
        process::exit(1);
    });
    let server = Arc::new(server);

    println!("{NAME} running at http://0.0.0.0:{port}");

    let workers = thread::available_parallelism().map(|n| n.get()).unwrap_or(4).max(4);
    let handles: Vec<_> = (0..workers)
        .map(|_| {
            let server = Arc::clone(&server);
            thread::spawn(move || {
                for req in server.incoming_requests() {
                    handle(req);
                }
            })
        })
        .collect();
    for h in handles {
        let _ = h.join();
    }
}
