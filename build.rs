use std::fs;
use std::path::Path;

fn emit_rerun_recursive(dir: &Path) {
    println!("cargo:rerun-if-changed={}", dir.display());
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                emit_rerun_recursive(&path);
            } else {
                println!("cargo:rerun-if-changed={}", path.display());
            }
        }
    }
}

fn main() {
    let dist_dir = Path::new("ui/dist");
    if !dist_dir.exists() {
        fs::create_dir_all(dist_dir).expect("failed to create placeholder ui/dist directory");
    }
    emit_rerun_recursive(dist_dir);
    println!("cargo:rerun-if-changed=src/store/migrations");
}
