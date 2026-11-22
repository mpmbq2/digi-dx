use axum::body::Body;
use axum::http::{header, HeaderValue, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::Json;
use rust_embed::RustEmbed;
use serde_json::json;

#[derive(RustEmbed)]
#[folder = "ui/dist"]
pub struct UiAssets;

pub async fn serve_embedded_ui(uri: Uri) -> impl IntoResponse {
    let raw_path = uri.path().trim_start_matches('/');
    if raw_path.starts_with("api/") || raw_path == "api" {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({
                "error": "NOT_FOUND",
                "message": "Unknown API endpoint"
            })),
        )
            .into_response();
    }

    let candidate = if raw_path.is_empty() {
        "index.html"
    } else {
        raw_path
    };

    if let Some(asset) = UiAssets::get(candidate) {
        return asset_response(candidate, asset.data.into_owned());
    }

    // SPA client-side route fallback when no explicit asset extension is requested
    if !candidate.contains('.') {
        if let Some(index) = UiAssets::get("index.html") {
            return asset_response("index.html", index.data.into_owned());
        }
    }

    (
        StatusCode::NOT_FOUND,
        [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
        "404 Not Found",
    )
        .into_response()
}

fn asset_response(path: &str, bytes: Vec<u8>) -> Response {
    let mime = mime_guess::from_path(path).first_or_octet_stream();
    let cache_control = if path == "index.html" {
        "no-cache"
    } else if path.starts_with("assets/") {
        "public, max-age=31536000, immutable"
    } else {
        "public, max-age=300"
    };

    let mut resp = Response::new(Body::from(bytes));
    *resp.status_mut() = StatusCode::OK;
    if let Ok(ct) = HeaderValue::from_str(mime.as_ref()) {
        resp.headers_mut().insert(header::CONTENT_TYPE, ct);
    }
    resp.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(cache_control),
    );
    resp
}
